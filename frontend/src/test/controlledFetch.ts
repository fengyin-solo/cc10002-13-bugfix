import { vi } from 'vitest'

/**
 * 送达次序可控的 mock fetch。
 *
 * 每个请求返回一个带 resolve/reject 的 deferred，测试可以按任意顺序决定谁先完成，
 * 用来复现"先发后到""旧失败晚到""新失败而旧成功"等真实竞争。
 */
export type PendingRequest = {
  url: string
  init: RequestInit | undefined
  signal: AbortSignal | null | undefined
  resolve: (response: Response) => void
  reject: (error: unknown) => void
  settled: boolean
}

type MockOptions = {
  /**
   * abort 时是否自动以 AbortError reject。
   * 浏览器真实行为为 true；需要验证"旧请求晚到仍无资格"的场景可关闭，
   * 手动控制旧请求的完成时机。
   */
  autoRejectOnAbort?: boolean
}

export class ControlledFetch {
  readonly pending: PendingRequest[] = []
  private autoRejectOnAbort: boolean

  constructor(options: MockOptions = {}) {
    this.autoRejectOnAbort = options.autoRejectOnAbort ?? true
  }

  fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const signal = init?.signal
    const request: PendingRequest = {
      url,
      init,
      signal,
      settled: false,
      resolve: () => undefined,
      reject: () => undefined,
    }

    const promise = new Promise<Response>((resolve, reject) => {
      request.resolve = (response) => {
        if (request.settled) {
          return
        }
        request.settled = true
        resolve(response)
      }
      request.reject = (error) => {
        if (request.settled) {
          return
        }
        request.settled = true
        reject(error)
      }
    })

    signal?.addEventListener('abort', () => {
      if (this.autoRejectOnAbort && !request.settled) {
        request.reject(new DOMException('Aborted', 'AbortError'))
      }
    })

    this.pending.push(request)
    return promise
  }

  get(urlFragment: string): PendingRequest {
    const match = this.pending
      .filter((request) => request.url.includes(urlFragment))
      .find((request) => !request.settled)
    if (!match) {
      throw new Error(`没有在途请求匹配：${urlFragment}（共 ${this.pending.length} 个请求）`)
    }
    return match
  }

  nth(urlFragment: string, index: number): PendingRequest {
    const matches = this.pending.filter((request) => request.url.includes(urlFragment))
    const target = matches[index]
    if (!target) {
      throw new Error(`第 ${index} 个匹配 ${urlFragment} 的请求不存在（共 ${matches.length} 个）`)
    }
    return target
  }

  jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      ...init,
    })
  }

  install(): void {
    vi.stubGlobal('fetch', this.fetch)
  }
}

export function jsonList(items: Record<string, unknown>[], total = items.length): Response {
  return new Response(JSON.stringify({ items, total }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

export function errorResponse(status = 500): Response {
  return new Response(JSON.stringify({ detail: 'mock failure' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
