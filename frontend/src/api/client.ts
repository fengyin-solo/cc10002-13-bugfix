/** 统一请求封装：拼后端地址、抛网络错误、给页脚留一句可读的说明。 */
const API_BASE = import.meta.env.VITE_API_BASE ?? ''

/**
 * 取消只表示"这位调用者不再需要结果"。透传 fetch 的 AbortSignal，
 * 被取消时抛出标准 AbortError，不套用普通网络错误的包装，方便上层静默丢弃。
 */
export function request(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`
  return fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  }).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    const detail = error instanceof Error ? error.message : '请求未送达'
    throw new Error(`接口请求失败：${detail}`)
  })
}

export async function fetchJson<T>(path: string): Promise<T> {
  const response = await request(path)
  if (!response.ok) {
    throw new Error(`接口返回 ${response.status}，数据未更新`)
  }
  return (await response.json()) as T
}

type SharedRead = {
  controller: AbortController
  subscribers: number
  settled: boolean
  promise: Promise<Response>
}

/**
 * 请求所有权管理者。
 *
 * 每个页面实例持有自己的 owner，负责三件事：
 * 1. 读取代次（generation）：每次发起读取递增代次，只有最新代次的回调有资格
 *    把结果提交给页面；旧代次无论成功失败都被忽略，重复读取也不会让旧代次
 *    重新取得资格。
 * 2. 共享读取合并：同一请求键（不含代次）的在途读取只发一次网络请求，多个
 *    调用者共享同一个 Promise 和 AbortController。
 * 3. 局部取消：某个调用者取消时只把自己从共享读取上摘除，只有所有调用者都
 *    不再需要时才真正 abort，不伤及仍需要该结果的其他调用者。
 */
export class RequestOwner {
  private generation = 0
  private reads = new Map<string, SharedRead>()
  private disposed = false

  /** 开始一次新的读取意图，返回它的代次；旧代次从此失去提交资格。 */
  nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  /** 当前有效代次，回调据此判断自己是否仍有权更新页面。 */
  get currentGeneration(): number {
    return this.generation
  }

  isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  /**
   * 发起一次受所有权管理的读取。
   *
   * - 相同 requestKey 已有在途读取时直接共享，不重复发请求；
   * - 返回的 cancel 只摘除当前调用者，最后一个调用者离开才真正中止网络请求；
   * - abort 后的读取以 AbortError reject，调用方应静默忽略，不写入页面状态。
   */
  read(requestKey: string, init?: RequestInit): { generation: number; promise: Promise<Response>; cancel: () => void } {
    const generation = this.nextGeneration()
    const shared = this.reads.get(requestKey)
    let entry: SharedRead
    let cancelled = false

    if (shared && !shared.settled) {
      shared.subscribers += 1
      entry = shared
    } else {
      const controller = new AbortController()
      const promise = request(requestKey, { ...init, signal: controller.signal })
      entry = { controller, subscribers: 1, settled: false, promise }
      this.reads.set(requestKey, entry)
      const finalize = () => {
        entry.settled = true
        // 结算后再到达的调用者应发起新请求，不再复用这一份。
        if (this.reads.get(requestKey) === entry) {
          this.reads.delete(requestKey)
        }
      }
      void promise.then(finalize, finalize)
    }

    const cancel = () => {
      if (cancelled || this.disposed) {
        return
      }
      cancelled = true
      entry.subscribers -= 1
      if (entry.subscribers <= 0 && !entry.settled) {
        // 立即结算并移出映射：随后同键的重读必须拿到全新控制器，
        // 不能复用到这份已经中止的读取。
        entry.settled = true
        if (this.reads.get(requestKey) === entry) {
          this.reads.delete(requestKey)
        }
        entry.controller.abort()
      }
    }

    return { generation, promise: entry.promise, cancel }
  }

  /** 页面卸载：作废所有代次并中止仍由本 owner 独占的在途读取。 */
  dispose(): void {
    this.disposed = true
    this.generation += 1
    for (const entry of this.reads.values()) {
      if (entry.subscribers > 0) {
        entry.controller.abort()
      }
    }
    this.reads.clear()
  }
}
