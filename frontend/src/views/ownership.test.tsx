import { StrictMode, type ReactElement } from 'react'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ControlledFetch, errorResponse, jsonList } from '@/test/controlledFetch'
import CohortView from '@/views/cohort'
import DashboardView from '@/views/dashboard'

type PageSpec = {
  name: string
  endpoint: string
  View: () => ReactElement
  placeholder: string
  readError: string
  actionError: string
  actionLabel: string
  footerPattern: RegExp
  labelColumn: string
}

const SPECS: PageSpec[] = [
  {
    name: '分析看板 dashboard',
    endpoint: '/api/dashboard',
    View: DashboardView,
    placeholder: '按看板编号检索',
    readError: '看板配置列表读取失败',
    actionError: '分析看板动作未生效，请稍后重试',
    actionLabel: '提交发布',
    footerPattern: /条分析看板记录/,
    labelColumn: '看板名称',
  },
  {
    name: '分群分析 cohort',
    endpoint: '/api/cohort',
    View: CohortView,
    placeholder: '按分群编号检索',
    readError: '用户分群列表读取失败',
    actionError: '分群分析动作未生效，请稍后重试',
    actionLabel: '提交校验',
    footerPattern: /条分群分析记录/,
    labelColumn: '分群名称',
  },
]

const row = (spec: PageSpec, id: number, label: string) => ({ id, [spec.labelColumn]: label })

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe.each(SPECS)('$name 异步读取所有权', (spec) => {
  let controlled: ControlledFetch

  // 默认关闭 abort 自动 reject，以便精确控制旧请求"晚到"的时机；
  // abort 仍会发生（signal.aborted 可断言），只是完成由测试手动驱动。
  beforeEach(() => {
    controlled = new ControlledFetch({ autoRejectOnAbort: false })
    controlled.install()
  })

  const getReads = () =>
    controlled.pending.filter(
      (request) => request.url.includes(spec.endpoint) && !request.url.includes('/actions'),
    )

  const footerLeft = (container: HTMLElement) =>
    container.querySelector('.page-foot > span') as HTMLElement

  const tableText = (container: HTMLElement) =>
    container.querySelector('.data-table tbody')?.textContent ?? ''

  it('场景1 先发后到：旧读取晚完成不能覆盖新读取的条目与总数', async () => {
    const { container } = render(<spec.View />)
    const first = getReads()[0]
    expect(first).toBeDefined()

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    const second = getReads()[1]
    // 旧意图已被取消（abort 只代表本调用者不再需要结果）。
    expect(first.signal?.aborted).toBe(true)
    expect(second.signal?.aborted).toBe(false)

    await act(async () => {
      second.resolve(jsonList([row(spec, 1, '新数据')], 1))
    })
    expect(footerLeft(container).textContent).toMatch(spec.footerPattern)
    expect(footerLeft(container).textContent).toContain('共 1 条')
    expect(tableText(container)).toContain('新数据')
    expect(container.querySelector('.error-text')).toBeNull()
    expect(container.querySelector('.loading-text')).toBeNull()

    // 旧请求更晚才把响应送达，必须被代次闸门丢弃。
    await act(async () => {
      first.resolve(jsonList([row(spec, 2, '旧数据')], 2))
    })
    expect(footerLeft(container).textContent).toContain('共 1 条')
    expect(tableText(container)).toContain('新数据')
    expect(tableText(container)).not.toContain('旧数据')
    expect(container.querySelector('.error-text')).toBeNull()
    expect(container.querySelector('.loading-text')).toBeNull()
  })

  it('场景2 旧失败晚到：不能把已经成功的页面标成失败', async () => {
    const { container } = render(<spec.View />)
    const first = getReads()[0]

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    const second = getReads()[1]

    await act(async () => {
      second.resolve(jsonList([row(spec, 1, '成功内容')], 1))
    })

    await act(async () => {
      first.reject(new Error('晚到的网络故障'))
    })

    expect(container.querySelector('.error-text')).toBeNull()
    expect(tableText(container)).toContain('成功内容')
    expect(footerLeft(container).textContent).toContain('共 1 条')
    expect(container.querySelector('.loading-text')).toBeNull()
  })

  it('场景3 新请求失败而旧请求成功：标注内容陈旧，可重试，重试后旧失败不回潮', async () => {
    const { container } = render(<spec.View />)

    await act(async () => {
      getReads()[0].resolve(jsonList([row(spec, 1, '旧成功')], 1))
    })
    expect(tableText(container)).toContain('旧成功')

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    await act(async () => {
      getReads()[1].resolve(errorResponse(500))
    })

    // 错误说明与"陈旧内容"标注同属当前失败代次，旧条目保留但被明确标注。
    expect(container.querySelector('.error-text')?.textContent).toBe(spec.readError)
    expect(footerLeft(container).textContent).toContain('当前为上一次成功读取的结果')
    expect(tableText(container)).toContain('旧成功')
    expect(footerLeft(container).textContent).toContain('共 1 条')

    // 对当前意图重试。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试当前读取' }))
    })
    const retryRead = getReads()[2]
    await act(async () => {
      retryRead.resolve(jsonList([row(spec, 1, '重试成功')], 3))
    })
    expect(container.querySelector('.error-text')).toBeNull()
    expect(footerLeft(container).textContent).not.toContain('当前为上一次成功读取的结果')
    expect(tableText(container)).toContain('重试成功')
    expect(tableText(container)).not.toContain('旧成功')
    expect(footerLeft(container).textContent).toContain('共 3 条')

    // 再来一轮：新意图成功后，更旧代次的失败晚到也不能重新占据反馈。
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kwx' } })
    })
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kwxy' } })
    })
    const stale = getReads()[3]
    const latest = getReads()[4]
    await act(async () => {
      latest.resolve(jsonList([row(spec, 1, '最新内容')], 5))
    })
    await act(async () => {
      stale.reject(new Error('旧代次晚到失败'))
    })
    expect(container.querySelector('.error-text')).toBeNull()
    expect(tableText(container)).toContain('最新内容')
    expect(footerLeft(container).textContent).toContain('共 5 条')
  })

  it('场景3b 首次读取即失败且无历史成功内容：显示错误与空表，不标陈旧，可重试恢复', async () => {
    const { container } = render(<spec.View />)
    await act(async () => {
      getReads()[0].reject(new TypeError('Network down'))
    })

    expect(container.querySelector('.error-text')?.textContent).toContain('接口请求失败')
    expect(footerLeft(container).textContent).not.toContain('当前为上一次成功读取的结果')
    expect(footerLeft(container).textContent).toContain('共 0 条')
    expect(container.querySelector('.loading-text')).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重试当前读取' }))
    })
    await act(async () => {
      getReads()[1].resolve(jsonList([row(spec, 1, '恢复后数据')], 1))
    })
    expect(container.querySelector('.error-text')).toBeNull()
    expect(tableText(container)).toContain('恢复后数据')
    expect(footerLeft(container).textContent).toContain('共 1 条')
  })

  it('场景4 离开后重入：旧页面完成事件不污染新页面实例', async () => {
    const { container, unmount } = render(<spec.View />)
    const firstPageRead = getReads()[0]
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    const secondPageRead = getReads()[1]

    unmount()
    // 卸载即作废旧 owner 的全部代次并中止其在途读取。
    expect(firstPageRead.signal?.aborted).toBe(true)
    expect(secondPageRead.signal?.aborted).toBe(true)

    const remounted = render(<spec.View />)
    const newPageRead = getReads()[2]
    expect(newPageRead).toBeDefined()

    // 旧页面的读取在卸载后才把结果送达。
    await act(async () => {
      firstPageRead.resolve(jsonList([row(spec, 1, '旧页面数据')], 9))
    })
    await act(async () => {
      secondPageRead.resolve(jsonList([row(spec, 2, '旧页面数据二')], 9))
    })
    expect(tableText(remounted.container)).not.toContain('旧页面数据')

    await act(async () => {
      newPageRead.resolve(jsonList([row(spec, 1, '新页面数据')], 1))
    })
    expect(tableText(remounted.container)).toContain('新页面数据')
    expect(footerLeft(remounted.container).textContent).toMatch(spec.footerPattern)
    expect(remounted.container.querySelector('.error-text')).toBeNull()
  })

  it('场景5 动作重载与输入交错：动作闭包按当前读取意图重载，旧代次不能覆盖', async () => {
    const { container } = render(<spec.View />)
    await act(async () => {
      getReads()[0].resolve(jsonList([row(spec, 1, '初始数据')], 1))
    })

    // 动作请求在途时用户改动输入。
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: spec.actionLabel })[0])
    })
    const post = controlled.get('/actions')
    expect(post.url).toBe(`${spec.endpoint}/1/actions`)

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    const inputRead = getReads()[1]
    expect(inputRead.url).toContain('?')

    // 动作完成后的重载必须使用当前输入（新请求键），而不是闭包里的旧筛选。
    await act(async () => {
      post.resolve(controlled.jsonResponse({ ok: true, message: 'done' }))
    })
    const reloadRead = getReads()[2]
    expect(reloadRead.url).toBe(inputRead.url)
    expect(getReads()[0].url).not.toContain('?')

    // 输入触发的旧代次先返回，动作重载的新代次后返回，页面只接受新代次。
    await act(async () => {
      inputRead.resolve(jsonList([row(spec, 2, '输入意图旧结果')], 2))
    })
    expect(tableText(container)).not.toContain('输入意图旧结果')

    await act(async () => {
      reloadRead.resolve(jsonList([row(spec, 3, '动作重载最新结果')], 3))
    })
    expect(tableText(container)).toContain('动作重载最新结果')
    expect(tableText(container)).not.toContain('输入意图旧结果')
    expect(footerLeft(container).textContent).toContain('共 3 条')
    expect(container.querySelector('.error-text')).toBeNull()
  })

  it('场景5b 动作本身失败：不产生读取代次，反馈标注陈旧且保留原条目', async () => {
    const { container } = render(<spec.View />)
    await act(async () => {
      getReads()[0].resolve(jsonList([row(spec, 1, '仍有效数据')], 1))
    })

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: spec.actionLabel })[0])
    })
    await act(async () => {
      controlled.get('/actions').resolve(errorResponse(422))
    })

    expect(container.querySelector('.error-text')?.textContent).toBe(spec.actionError)
    expect(footerLeft(container).textContent).toContain('当前为上一次成功读取的结果')
    expect(tableText(container)).toContain('仍有效数据')
    // 动作失败没有发起新的读取。
    expect(getReads()).toHaveLength(1)
  })

  it('场景5c 动作网络中断：错误来自请求封装，页面同样只作反馈不改条目', async () => {
    const { container } = render(<spec.View />)
    await act(async () => {
      getReads()[0].resolve(jsonList([row(spec, 1, '仍有效数据')], 1))
    })

    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: spec.actionLabel })[0])
    })
    await act(async () => {
      controlled.get('/actions').reject(new TypeError('Failed to fetch'))
    })

    expect(container.querySelector('.error-text')?.textContent).toContain('接口请求失败')
    expect(tableText(container)).toContain('仍有效数据')
    expect(getReads()).toHaveLength(1)
  })

  it('场景6 加载反馈与条目/错误同属一个代次，旧代次收尾不拨动加载状态', async () => {
    const { container } = render(<spec.View />)
    expect(container.querySelector('.loading-text')).not.toBeNull()

    const first = getReads()[0]
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText(spec.placeholder), { target: { value: 'kw' } })
    })
    expect(container.querySelector('.loading-text')).not.toBeNull()

    const second = getReads()[1]
    await act(async () => {
      second.resolve(jsonList([row(spec, 1, '完成数据')], 1))
    })
    expect(container.querySelector('.loading-text')).toBeNull()

    await act(async () => {
      first.reject(new Error('旧代次收尾'))
    })
    expect(container.querySelector('.loading-text')).toBeNull()
    expect(container.querySelector('.error-text')).toBeNull()
  })

  it('场景8 手动查询按钮与自动请求遵守同一所有权：旧读被中止，新一代晚到结果不被旧读覆盖', async () => {
    const { container } = render(<spec.View />)
    const first = getReads()[0]

    // 首读仍在途时手动点查询：同一页面只保留最新意图，旧读被中止并新建一代读取。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '查询' }))
    })
    expect(getReads()).toHaveLength(2)
    expect(first.signal?.aborted).toBe(true)
    expect(getReads()[1].signal?.aborted).toBe(false)

    // 被中止的旧读更晚才送达，内容必须被代次闸门丢弃。
    await act(async () => {
      first.resolve(jsonList([row(spec, 9, '旧读晚到内容')], 9))
    })
    expect(tableText(container)).not.toContain('旧读晚到内容')

    await act(async () => {
      getReads()[1].resolve(jsonList([row(spec, 1, '手动查询结果')], 4))
    })
    expect(tableText(container)).toContain('手动查询结果')
    expect(footerLeft(container).textContent).toContain('共 4 条')
    expect(container.querySelector('.error-text')).toBeNull()

    // 首读结算后再次手动查询：同样发起新一代读取，旧代次不残留错误或加载态。
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '查询' }))
    })
    expect(getReads()).toHaveLength(3)
    await act(async () => {
      getReads()[2].resolve(jsonList([row(spec, 2, '第二次查询')], 2))
    })
    expect(tableText(container)).toContain('第二次查询')
    expect(container.querySelector('.loading-text')).toBeNull()
  })

  it('场景7 StrictMode 双挂载：首次挂载的 owner 被废弃，仅存活实例能提交结果', async () => {
    const { container } = render(
      <StrictMode>
        <spec.View />
      </StrictMode>,
    )
    const reads = getReads()
    expect(reads).toHaveLength(2)
    expect(reads[0].signal?.aborted).toBe(true)
    expect(reads[1].signal?.aborted).toBe(false)

    await act(async () => {
      reads[1].resolve(jsonList([row(spec, 1, '存活实例数据')], 7))
    })
    expect(footerLeft(container).textContent).toContain('共 7 条')
    expect(tableText(container)).toContain('存活实例数据')

    await act(async () => {
      reads[0].reject(new Error('已废弃实例的晚到失败'))
    })
    expect(container.querySelector('.error-text')).toBeNull()
    expect(tableText(container)).toContain('存活实例数据')
  })
})

describe('跨模块所有权隔离', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('看板与分群数字 ID 相同也不共享结果归属：旧看板读取不能写入分群页面', async () => {
    const controlled = new ControlledFetch({ autoRejectOnAbort: false })
    controlled.install()

    const dashboard = render(<DashboardView />)
    const dashboardRead = controlled.pending.filter((r) => r.url.includes('/api/dashboard'))[0]
    dashboard.unmount()

    const cohort = render(<CohortView />)
    const cohortRead = controlled.pending.filter((r) => r.url.includes('/api/cohort'))[0]
    expect(dashboardRead.signal?.aborted).toBe(true)

    // 两个模块的条目 id 都是 1；看板的晚到结果与分群页面无任何归属关系。
    await act(async () => {
      dashboardRead.resolve(
        jsonList([{ id: 1, 看板名称: '看板独有数据', 看板编号: 'D-1' }], 1),
      )
    })
    await act(async () => {
      cohortRead.resolve(
        jsonList([{ id: 1, 分群名称: '分群独有数据', 分群编号: 'C-1' }], 1),
      )
    })

    const body = cohort.container.textContent ?? ''
    expect(body).toContain('分群独有数据')
    expect(body).not.toContain('看板独有数据')
    expect(body).toMatch(/共 1 条分群分析记录/)
    expect(cohort.container.querySelector('.error-text')).toBeNull()
  })
})
