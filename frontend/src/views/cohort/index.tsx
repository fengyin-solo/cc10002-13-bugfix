import { useMemo, useState } from 'react'

import { request } from '@/api/client'
import { useListResource } from '@/api/useListResource'

const ENDPOINT = '/api/cohort'
const columns = [
  "分群编号",
  "分群名称",
  "筛选条件",
  "基准日期",
  "观测周期天数",
  "行为事件",
  "聚合指标",
  "刷新频率"
]
const actions = [
  "提交校验",
  "启用分群",
  "停用分群"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const stats = [
  {
    "label": "用户分群总数",
    "value": 0
  },
  {
    "label": "已启用分群",
    "value": 0
  },
  {
    "label": "待校验分群",
    "value": 0
  }
]

type Row = Record<string, string | number | null>

export default function CohortView() {
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const query = useMemo(() => new URLSearchParams(filters).toString(), [filters])

  const {
    rows,
    total,
    loading,
    errorMessage,
    isStale,
    reload,
    reportActionError,
  } = useListResource(ENDPOINT, query, {
    readErrorMessage: '用户分群列表读取失败',
    networkErrorMessage: '分群分析列表读取失败',
  })

  async function runAction(action: string, row: Row) {
    try {
      const response = await request(`${ENDPOINT}/${row.id}/actions`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      })
      if (!response.ok) {
        throw new Error('分群分析动作未生效，请稍后重试')
      }
      // 动作完成后的重载是一次全新的读取意图：动作前已发出的旧读取代次
      // 更低，其晚到结果没有资格覆盖本次重载。
      await reload()
    } catch (error) {
      // 动作失败不产生读取代次，只更新反馈；条目仍为最近一次成功内容。
      reportActionError(error instanceof Error ? error.message : '分群分析操作失败')
    }
  }

  return (
    <section className="page" data-module="cohort">
      <header className="page-head">
        <div>
          <h2>分群分析管理</h2>
          <p className="page-desc">维护用户分群的输入、执行约束与结果记录，为分群分析提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => reportActionError('用户分群登记入口尚未接入审批流')}>
            登记用户分群
          </button>
          <button className="btn" type="button" onClick={() => window.open(`${ENDPOINT}/export`, '_blank')}>
            导出分群分析清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); void reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => void runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 1}>暂无分群分析数据，可先登记用户分群</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>
          共 {total} 条分群分析记录
          {loading && <em className="loading-text">读取中…</em>}
          {isStale && !loading && <em className="stale-text">（当前为上一次成功读取的结果）</em>}
        </span>
        <span className="foot-feedback">
          {errorMessage && <span className="error-text">{errorMessage}</span>}
          {errorMessage && (
            <button className="btn retry-btn" type="button" onClick={() => void reload()}>
              重试当前读取
            </button>
          )}
        </span>
      </footer>
    </section>
  )
}
