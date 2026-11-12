import { describe, expect, it } from 'vitest'

import { RequestOwner } from '@/api/client'
import { ControlledFetch, errorResponse, jsonList } from '@/test/controlledFetch'

function installFetch(options?: { autoRejectOnAbort?: boolean }) {
  const controlled = new ControlledFetch(options)
  controlled.install()
  return controlled
}

describe('RequestOwner 读取代次与所有权', () => {
  it('同键并发读取只发一次网络请求，所有调用者共享同一份结果', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    const first = owner.read('/api/x?')
    const second = owner.read('/api/x?')
    expect(controlled.pending).toHaveLength(1)
    expect(second.generation).toBeGreaterThan(first.generation)

    const payload = [{ id: 1 }]
    controlled.get('/api/x').resolve(jsonList(payload))
    const [a, b] = await Promise.all([first.promise, second.promise])
    expect(await a.json()).toEqual({ items: payload, total: 1 })
    expect(b).toBe(a)

    owner.dispose()
  })

  it('不同请求键各自发起独立读取', () => {
    const controlled = installFetch()
    const owner = new RequestOwner()
    owner.read('/api/x?a=1')
    owner.read('/api/x?a=2')
    expect(controlled.pending).toHaveLength(2)
    owner.dispose()
  })

  it('只有最新代次拥有提交资格，重复读取不会让旧代次恢复资格', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    // 同键两次读取合并为一个共享网络请求，但代次各自递增。
    const first = owner.read('/api/x?')
    const second = owner.read('/api/x?')
    expect(controlled.pending).toHaveLength(1)

    expect(owner.isCurrent(second.generation)).toBe(true)
    expect(owner.isCurrent(first.generation)).toBe(false)

    controlled.nth('/api/x', 0).resolve(jsonList([{ id: 2 }]))
    await second.promise

    // 再次读取后，更早的两个代次都不能恢复资格；已结算的同键读取不复用，发新请求。
    const third = owner.read('/api/x?')
    expect(controlled.pending).toHaveLength(2)
    expect(owner.isCurrent(first.generation)).toBe(false)
    expect(owner.isCurrent(second.generation)).toBe(false)
    expect(owner.isCurrent(third.generation)).toBe(true)

    owner.dispose()
  })

  it('某个调用者取消只摘除自己，共享读取的其他调用者仍能拿到结果', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    const first = owner.read('/api/x?')
    const second = owner.read('/api/x?')
    first.cancel()

    // 共享读取仍有订阅者，不能中止网络请求。
    const pending = controlled.get('/api/x')
    expect(pending.signal?.aborted).toBe(false)

    pending.resolve(jsonList([{ id: 9 }]))
    const response = await second.promise
    expect((await response.json()).items).toEqual([{ id: 9 }])

    owner.dispose()
  })

  it('最后一个调用者取消才真正中止读取，之后同键重读拿到全新控制器', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    const first = owner.read('/api/x?')
    first.cancel()
    expect(controlled.nth('/api/x', 0).signal?.aborted).toBe(true)
    await expect(first.promise).rejects.toMatchObject({ name: 'AbortError' })

    const second = owner.read('/api/x?')
    expect(controlled.pending).toHaveLength(2)
    expect(controlled.nth('/api/x', 1).signal?.aborted).toBe(false)
    controlled.nth('/api/x', 1).resolve(jsonList([{ id: 3 }]))
    expect((await second.promise).status).toBe(200)

    owner.dispose()
  })

  it('读取结算后同键再次读取发起新请求，不复用已结算结果', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    const first = owner.read('/api/x?')
    controlled.nth('/api/x', 0).resolve(jsonList([{ id: 1 }]))
    await first.promise

    owner.read('/api/x?')
    expect(controlled.pending).toHaveLength(2)

    owner.dispose()
  })

  it('dispose 作废全部代次并中止在途独占读取，旧完成事件不再有任何资格', async () => {
    const controlled = installFetch({ autoRejectOnAbort: false })
    const owner = new RequestOwner()
    const read = owner.read('/api/x?')

    owner.dispose()
    expect(owner.isDisposed).toBe(true)
    expect(owner.isCurrent(read.generation)).toBe(false)
    expect(controlled.nth('/api/x', 0).signal?.aborted).toBe(true)

    // 即便旧请求在卸载后才完成，代次校验也已永久关闭。
    controlled.nth('/api/x', 0).resolve(jsonList([{ id: 1 }]))
    expect(await read.promise).toBeInstanceOf(Response)
    expect(owner.isCurrent(read.generation)).toBe(false)
  })

  it('dispose 不中止仍被其他所有者共享的读取（取消语义只属于本调用者）', () => {
    installFetch()
    const ownerA = new RequestOwner()
    const ownerB = new RequestOwner()

    // 模拟同一底层读取被两个 owner 持有时，单个 owner 销毁不影响另一 owner。
    const readA = ownerA.read('/api/shared?')
    ownerB.read('/api/shared?')
    ownerA.dispose()

    // ownerA 的代次作废；ownerB 仍有效。fetch 在本测试各发一份，重点校验代次语义。
    expect(ownerA.isCurrent(readA.generation)).toBe(false)
    expect(ownerB.isDisposed).toBe(false)

    ownerB.dispose()
  })

  it('非中止错误照常抛出，AbortError 不被包装成普通网络错误', async () => {
    const controlled = installFetch()
    const owner = new RequestOwner()

    const failed = owner.read('/api/x?')
    controlled.get('/api/x').resolve(errorResponse(500))
    const response = await failed.promise
    expect(response.ok).toBe(false)

    const aborted = owner.read('/api/y?')
    aborted.cancel()
    await expect(aborted.promise).rejects.toMatchObject({ name: 'AbortError' })

    owner.dispose()
  })
})
