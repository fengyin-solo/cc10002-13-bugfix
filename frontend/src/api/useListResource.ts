import { useCallback, useEffect, useRef, useState } from 'react'

import { RequestOwner } from '@/api/client'

export type ListRow = Record<string, string | number | null>

type ListPayload = {
  items?: ListRow[]
  total?: number
}

type ListResourceOptions = {
  /** HTTP 非 2xx 时展示的业务读取失败说明。 */
  readErrorMessage: string
  /** 连异常对象都拿不到时的兜底说明。 */
  networkErrorMessage: string
}

export type ListResource = {
  rows: ListRow[]
  total: number
  loading: boolean
  errorMessage: string
  /** 为 true 时页面上的条目来自上一次成功读取，而不是当前读取意图。 */
  isStale: boolean
  /** 手动查询、动作后重载共用同一个入口，都走最新代次校验。 */
  reload: () => Promise<void>
  /** 动作（POST）本身失败：动作不产生读取代次，只更新反馈并标注内容是否陈旧。 */
  reportActionError: (message: string) => void
}

/**
 * 列表读取的所有权 Hook。
 *
 * 不变量：条目、总数、错误说明、加载反馈只能由"当前有效代次"的读取一起提交，
 * 因此不会出现新条目旁残留旧异常、或旧内容遮住新读取结果的情况。
 *
 * - 自动请求（请求键变化）、手动查询按钮、动作后重载全部经由同一个 load；
 * - 旧代次的成功/失败/取消回调一律静默丢弃，重复读取不会让旧代次恢复资格；
 * - 卸载时 dispose 作废全部代次，重新进入的页面持有全新 owner，两个模块即使
 *   数字 ID 相同也互不相干；
 * - 最新读取失败但页面仍有上一次成功内容时，以 isStale 明确标注，可对当前
 *   意图重试；重试成功后旧失败被同代次的成功提交整体替换。
 */
export function useListResource(
  endpoint: string,
  query: string,
  options: ListResourceOptions,
): ListResource {
  const requestKey = query ? `${endpoint}?${query}` : endpoint

  const [rows, setRows] = useState<ListRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState('')
  const [isStale, setIsStale] = useState(false)

  const ownerRef = useRef<RequestOwner | null>(null)
  const requestKeyRef = useRef(requestKey)
  requestKeyRef.current = requestKey
  const optionsRef = useRef(options)
  optionsRef.current = options
  const hasSucceededRef = useRef(false)
  const previousCancelRef = useRef<(() => void) | null>(null)

  // 每次（重新）挂载都换一个全新 owner；旧 owner 立刻作废并中止其独占读取，
  // 离开页面后的任何完成事件都不可能再污染新页面。
  useEffect(() => {
    const owner = new RequestOwner()
    ownerRef.current = owner
    return () => {
      owner.dispose()
      if (ownerRef.current === owner) {
        ownerRef.current = null
      }
    }
  }, [])

  const load = useCallback(async () => {
    const owner = ownerRef.current
    if (!owner || owner.isDisposed) {
      return
    }

    // 被新意图取代的上一代读取在此摘除调用者：共享读取仍有其他调用者时
    // 只减少订阅，独占读取才真正 abort。
    previousCancelRef.current?.()

    const key = requestKeyRef.current
    const { generation, promise, cancel } = owner.read(key)
    previousCancelRef.current = cancel

    setLoading(true)
    setErrorMessage('')

    try {
      const response = await promise
      // 响应头到达后先校验所有权，再解析 body，期间也可能被更新的意图取代。
      if (!owner.isCurrent(generation)) {
        return
      }
      if (!response.ok) {
        throw new Error(optionsRef.current.readErrorMessage)
      }
      const payload = (await response.json()) as ListPayload
      if (!owner.isCurrent(generation)) {
        return
      }

      hasSucceededRef.current = true
      // 同一次有效读取内整体提交：成功结果与"非陈旧、无错误"的反馈绑定。
      setIsStale(false)
      setRows(payload.items ?? [])
      setTotal(payload.total ?? 0)
    } catch (error) {
      if (!owner.isCurrent(generation)) {
        return
      }
      // 取消意味着本调用者已不需要结果，不属于页面失败。
      if (error instanceof DOMException && error.name === 'AbortError') {
        return
      }
      // 失败时不清空已有条目：标注它们只是上一次成功结果，反馈与内容同属本代次。
      setIsStale(hasSucceededRef.current)
      setErrorMessage(error instanceof Error ? error.message : optionsRef.current.networkErrorMessage)
    } finally {
      cancel()
      if (previousCancelRef.current === cancel) {
        previousCancelRef.current = null
      }
      // 只有仍持提交资格的代次能关闭加载反馈，旧代次的收尾不碰页面状态。
      if (owner.isCurrent(generation) && !owner.isDisposed) {
        setLoading(false)
      }
    }
  }, [])

  // 请求键变化（首屏、筛选输入后的自动读取）自动发起新一代读取。
  useEffect(() => {
    void load()
  }, [load, requestKey])

  const reportActionError = useCallback((message: string) => {
    setIsStale(hasSucceededRef.current)
    setErrorMessage(message)
  }, [])

  return {
    rows,
    total,
    loading,
    errorMessage,
    isStale,
    reload: load,
    reportActionError,
  }
}
