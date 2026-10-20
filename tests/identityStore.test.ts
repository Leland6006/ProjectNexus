import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import type { NexusBridge, ApiResult } from '../src/shared/api.ts'
import type { IdentityResult, IdentityStatus } from '../src/shared/identity.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { createSeedDatabase, DEFAULT_USER_ID } from '../src/shared/seed.ts'

interface TestStore {
  getState: () => {
    state: typeof view | null
    mode: 'demo' | 'server' | null
    identityStatus: IdentityStatus | null
    choosingCompany: boolean
    error: string | null
    loading: boolean
    busy: boolean
    route: { page: string; contractId?: string }
    toasts: unknown[]
    init: () => Promise<void>
    refreshIdentity: () => Promise<void>
    identity: <T = unknown>(action: string, body?: unknown) => Promise<T | null>
    selectCompany: (orgId: string) => Promise<void>
    chooseCompany: () => void
    act: (method: string, args: unknown[], successText?: string) => Promise<boolean>
    navigate: (route: { page: string; contractId?: string }) => void
  }
  setState: (state: Record<string, unknown>) => void
}
const view = buildViewState(createSeedDatabase(), DEFAULT_USER_ID)
const account = { id: 'test-account', name: '测试成员', email: 'member@example.test' }
const companies: IdentityStatus['companies'] = [
  { id: 'org-a', name: '测试甲企业', shortName: '测试甲', role: 'owner' },
  { id: 'org-b', name: '测试乙企业', shortName: '测试乙', role: 'legal' }
]
const status = (actingOrgId: string | null = 'org-a'): IdentityStatus => ({ account, companies, actingOrgId, configured: true })
const anonymous = (): IdentityStatus => ({ account: null, companies: [], actingOrgId: null, configured: true })
const failure = (code: string): { ok: false; code: string; message: string } => ({ ok: false, code, message: `测试错误：${code}` })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }

// 每项测试执行实际store模块和真实Zustand，仅替换主进程桥接与提示定时器。
function harness(overrides: Partial<NexusBridge> = {}) {
  const bridge: NexusBridge = {
    mode: async () => 'server',
    identity: async () => ({ ok: true, data: status() }),
    call: async () => ({ ok: true, state: view }),
    ...overrides
  }
  const filename = new URL('../src/renderer/src/store.ts', import.meta.url)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
  }).outputText
  const module = { exports: {} as { useApp: TestStore } }
  runInNewContext(code, { module, exports: module.exports, require: createRequire(import.meta.url), window: { nexus: bridge }, setTimeout: () => 0, Error })
  const store = module.exports.useApp
  store.setState({ state: view, mode: 'server', identityStatus: status(), loading: false })
  return { store, bridge }
}

test('生产启动在匿名、无企业及未配置状态下不请求业务数据', async () => {
  for (const data of [anonymous(), status(null), { ...status(), companies: [] }, { ...status(), configured: false }]) {
    let businessCalls = 0
    const { store } = harness({ identity: async () => ({ ok: true, data }), call: async () => { businessCalls++; return { ok: true, state: view } } })
    await store.getState().init()
    assert.equal(businessCalls, 0)
    assert.equal(store.getState().state, null)
    assert.equal(store.getState().loading, false)
  }
})

test('运行模式失败不回落演示数据且结束加载', async () => {
  let businessCalls = 0
  const { store } = harness({ mode: async () => { throw new Error('模式读取失败') }, call: async () => { businessCalls++; return { ok: true, state: view } } })
  await store.getState().init()
  assert.equal(businessCalls, 0)
  assert.equal(store.getState().state, null)
  assert.equal(store.getState().loading, false)
  assert.match(store.getState().error ?? '', /模式读取失败/)
})

for (const code of ['UNAUTHENTICATED', 'ACCOUNT_DISABLED', 'SESSION_EXPIRED']) {
  test(`${code}业务失败清理旧页面和账号后重新获取身份`, async () => {
    const { store } = harness({ call: async () => failure(code), identity: async () => ({ ok: true, data: anonymous() }) })
    store.getState().navigate({ page: 'contracts', contractId: 'old-contract' })
    assert.equal(await store.getState().act('updateClauses', []), false)
    assert.equal(store.getState().state, null)
    assert.equal(store.getState().identityStatus?.account, null)
    assert.equal(store.getState().route.page, 'dashboard')
    assert.equal(store.getState().route.contractId, undefined)
  })
  test(`${code}身份状态直接返回失效码时清理旧账号`, async () => {
    const { store } = harness({ identity: async () => failure(code) })
    store.getState().navigate({ page: 'contracts', contractId: 'old-contract' })
    await store.getState().refreshIdentity()
    assert.equal(store.getState().state, null)
    assert.equal(store.getState().identityStatus?.account, null)
    assert.equal(store.getState().route.page, 'dashboard')
  })
}

test('企业选择门禁内创建企业后可进入服务端自动选中的新企业', async () => {
  let selected = 'org-a'
  let businessCalls = 0
  const { store } = harness({
    identity: async (action) => {
      if (action === 'create-company') { selected = 'org-b'; return { ok: true, data: { company: companies[1], actingOrgId: selected } } }
      return { ok: true, data: status(selected) }
    },
    call: async () => { businessCalls++; return { ok: true, state: view } }
  })
  store.getState().chooseCompany()
  assert.notEqual(await store.getState().identity('create-company', { name: '测试乙企业' }), null)
  await store.getState().refreshIdentity()
  assert.equal(store.getState().choosingCompany, false)
  assert.equal(store.getState().identityStatus?.actingOrgId, 'org-b')
  assert.equal(businessCalls, 1)
  assert.equal(store.getState().state, view)
})

for (const outcome of ['success', 'error', 'reject'] as const) {
  for (const action of ['select-company', 'logout'] as const) {
    test(`${action}后丢弃旧业务${outcome}响应`, async () => {
      const pending = deferred<ApiResult>()
      let selected = 'org-a'
      const { store, bridge } = harness({
        call: async () => pending.promise,
        identity: async (name) => {
          if (name === 'select-company') selected = 'org-b'
          return { ok: true, data: name === 'status' ? status(selected) : {} }
        }
      })
      const old = store.getState().act('updateClauses', [], '不应显示旧成功提示')
      if (action === 'logout') await store.getState().identity('logout')
      else {
        bridge.call = async () => ({ ok: true, state: view })
        await store.getState().selectCompany('org-b')
      }
      const snapshot = store.getState()
      if (outcome === 'success') pending.resolve({ ok: true, state: { ...view } })
      else if (outcome === 'error') pending.resolve(failure('ACCOUNT_DISABLED'))
      else pending.reject(new Error('旧请求断网'))
      assert.equal(await old, false)
      assert.equal(store.getState().state, snapshot.state)
      assert.equal(store.getState().identityStatus, snapshot.identityStatus)
      assert.equal(store.getState().toasts.length, snapshot.toasts.length)
    })
  }
}

test('旧身份错误恢复的第二次status不覆盖退出后的匿名身份', async () => {
  const latest = deferred<IdentityResult>()
  let statusCalls = 0
  const { store } = harness({
    call: async () => failure('MEMBERSHIP_REQUIRED'),
    identity: async (action) => action !== 'status' ? { ok: true, data: {} } : ++statusCalls === 1 ? { ok: true, data: status() } : latest.promise
  })
  const refresh = store.getState().refreshIdentity()
  await settle()
  assert.equal(statusCalls, 2)
  await store.getState().identity('logout')
  latest.resolve({ ok: true, data: status() })
  await refresh
  assert.equal(store.getState().state, null)
  assert.equal(store.getState().identityStatus?.account, null)
})

test('首次身份变更后业务请求抛错仍结束加载并呈现重试错误', async () => {
  const { store } = harness({ call: async () => { throw new Error('业务连接失败') } })
  store.setState({ identityStatus: null, state: null })
  await store.getState().init()
  assert.equal(store.getState().loading, false)
  assert.equal(store.getState().state, null)
  assert.match(store.getState().error ?? '', /业务连接失败/)
})

for (const action of ['logout', 'revoke-all']) {
  test(`${action}网络失败保留登录身份和当前页面`, async () => {
    const { store } = harness({ identity: async () => failure('SERVICE_UNAVAILABLE') })
    store.getState().navigate({ page: 'settings' })
    assert.equal(await store.getState().identity(action), null)
    assert.equal(store.getState().state, view)
    assert.equal(store.getState().identityStatus?.account?.id, account.id)
    assert.equal(store.getState().route.page, 'settings')
  })
}

test('旧身份请求拒绝不产生跨企业错误提示也不结束新操作busy', async () => {
  const old = deferred<IdentityResult>()
  const newer = deferred<IdentityResult>()
  const { store, bridge } = harness({ identity: async () => old.promise })
  const first = store.getState().identity('members')
  store.getState().chooseCompany()
  bridge.identity = async () => newer.promise
  const second = store.getState().identity('create-company', { name: '新企业' })
  old.reject(new Error('旧身份请求断网'))
  await first
  assert.equal(store.getState().toasts.length, 0)
  assert.equal(store.getState().busy, true)
  newer.resolve({ ok: true, data: {} })
  await second
  assert.equal(store.getState().busy, false)
})
