import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { IdentityBridge } from '../src/main/identity.ts'
import type { IdentityPartner, IdentityStatus } from '../src/shared/identity.ts'

const status = (orgId = 'org-a', accountId = 'user-a'): IdentityStatus => ({
  configured: true, account: { id: accountId, email: 'a@example.test', name: '测试成员' }, actingOrgId: orgId,
  companies: [{ id: orgId, name: '当前企业', shortName: '当前', role: 'owner' }]
})
const partner = (id: string, state: IdentityPartner['status'] = 'accepted'): IdentityPartner => ({
  id: `relation-${id}`, requesterOrgId: 'org-a', recipientOrgId: id,
  partner: { id, name: `企业${id}`, shortName: id }, status: state, revision: 1, createdAt: '2026-10-20T00:00:00Z'
})
const settle = async () => { for (let index = 0; index < 12; index++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

// 执行实际联系人Hook，替换React调度器以观察异步请求、作用域和定时器生命周期。
function harness(identity: (action: string) => Promise<unknown>) {
  const slots: { value?: unknown; deps?: unknown[]; cleanup?: () => void }[] = []
  let cursor = 0
  let refreshes = 0
  const effects: (() => void)[] = []
  const timers = new Set<() => void>()
  const listeners = new Map<string, () => void>()
  const state = {
    mode: 'server' as 'server' | 'demo', state: {} as object | null,
    choosingCompany: false, identityStatus: status(), identity,
    refreshIdentity: async () => { refreshes++ }
  }
  const same = (left?: unknown[], right?: unknown[]) => !!left && !!right && left.length === right.length && left.every((item, index) => Object.is(item, right[index]))
  const react = {
    useState(initial: unknown) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: initial }
      return [slots[index].value, (value: unknown) => { slots[index].value = typeof value === 'function' ? value(slots[index].value) : value }]
    },
    useRef(initial: unknown) {
      const index = cursor++
      if (!slots[index]) slots[index] = { value: { current: initial } }
      return slots[index].value
    },
    useCallback(callback: () => unknown, deps: unknown[]) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps)) slots[index] = { value: callback, deps }
      return slots[index].value
    },
    useEffect(callback: () => (() => void) | undefined, deps: unknown[]) {
      const index = cursor++
      if (same(slots[index]?.deps, deps)) return
      const previous = slots[index]
      slots[index] = { deps }
      effects.push(() => { previous?.cleanup?.(); slots[index].cleanup = callback() })
    }
  }
  const useApp = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state })
  const source = readFileSync(new URL('../src/renderer/src/pages/Contacts.tsx', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
  type Result = { partners: IdentityPartner[] | null; loading: boolean; error: string | null; reload: () => Promise<void> }
  const module = { exports: {} as { usePartners: () => Result } }
  const nativeRequire = createRequire(import.meta.url)
  runInNewContext(code, {
    module, exports: module.exports,
    require: (name: string) => name === 'react' ? react : name === '@/store' ? { useApp } : name.startsWith('@/') || name === 'lucide-react' ? {} : nativeRequire(name),
    window: { addEventListener: (name: string, callback: () => void) => listeners.set(name, callback), removeEventListener: (name: string) => listeners.delete(name) },
    setInterval: (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, 30_000); timers.add(callback); return callback },
    clearInterval: (callback: () => void) => timers.delete(callback)
  })
  return {
    state, timers, listeners,
    render() { cursor = 0; const result = module.exports.usePartners(); effects.splice(0).forEach((effect) => effect()); return result },
    unmount() { slots.forEach((slot) => slot.cleanup?.()) },
    refreshes: () => refreshes
  }
}

test('合作关系桥接仅路由白名单并使用服务端约定的请求体', async (t) => {
  const requests: { path: string; method: string; body: unknown }[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    requests.push({ path: new URL(String(input)).pathname, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : null })
    return new Response(JSON.stringify({ ok: true, data: { partners: [] } }), { headers: { 'Content-Type': 'application/json' } })
  })
  const bridge = new IdentityBridge('https://api.example.test', false, async () => {})
  assert.equal((await bridge.identity('partners')).ok, true)
  assert.equal((await bridge.identity('create-partner', { orgId: 'org-b', ignored: 'value' })).ok, true)
  for (const action of ['accept', 'reject', 'withdraw', 'disconnect']) {
    assert.equal((await bridge.identity(`${action}-partner`, { id: 'relation/a', orgId: 'ignored' })).ok, true)
  }
  assert.equal((await bridge.identity('accept-partner')).ok, false)
  assert.equal((await bridge.identity('delete-partner', { id: 'x' })).ok, false)
  assert.deepEqual(requests, [
    { path: '/partners', method: 'GET', body: null },
    { path: '/partners', method: 'POST', body: { orgId: 'org-b' } },
    ...['accept', 'reject', 'withdraw', 'disconnect'].map((action) => ({ path: `/partners/relation%2Fa/${action}`, method: 'POST', body: {} }))
  ])
})

test('联系人切换企业后不显示旧列表，迟到结果不能覆盖新企业', async () => {
  const old = deferred<unknown>()
  let calls = 0
  const app = harness(async () => ++calls === 1 ? old.promise : { partners: [partner('new')] })
  app.render()
  app.state.identityStatus = status('org-b')
  assert.equal(app.render().partners, null)
  await settle()
  assert.equal(app.render().partners?.[0].partner.id, 'new')
  old.resolve({ partners: [partner('old')] })
  await settle()
  assert.equal(app.render().partners?.[0].partner.id, 'new')
  app.unmount()
})

test('同企业并发读取只采用最新请求结果', async () => {
  const first = deferred<unknown>()
  const second = deferred<unknown>()
  let requests = 0
  const app = harness(async () => ++requests === 1 ? first.promise : second.promise)
  app.render()
  app.listeners.forEach((callback) => callback())
  second.resolve({ partners: [partner('latest')] })
  await settle()
  first.resolve({ partners: [partner('stale')] })
  await settle()
  assert.equal(app.render().partners?.[0].partner.id, 'latest')
  app.unmount()
})

test('退出或进入企业选择后丢弃迟到联系人，清理轮询与focus监听', async () => {
  for (const transition of ['logout', 'choose-company']) {
    const pending = deferred<unknown>()
    const app = harness(async () => pending.promise)
    app.render()
    assert.equal(app.timers.size, 1)
    assert.equal(app.listeners.size, 2)
    if (transition === 'logout') app.state.identityStatus = { ...status(), account: null, actingOrgId: null }
    else app.state.choosingCompany = true
    app.state.state = null
    assert.equal(app.render().partners, null)
    pending.resolve({ partners: [partner('private')] })
    await settle()
    assert.equal(app.render().partners, null)
    assert.equal(app.refreshes(), 0)
    assert.equal(app.timers.size, 0)
    assert.equal(app.listeners.size, 0)
    app.unmount()
  }
})

test('实时失效通知刷新联系人并丢弃被后续通知超越的响应，卸载清理监听', async () => {
  const stale = deferred<unknown>()
  let reads = 0
  const app = harness(async () => ++reads === 2 ? stale.promise : { partners: [partner(`最新-${reads}`, 'pending')] })
  app.render(); await settle()
  assert.ok(app.listeners.has('nexus:invalidate'))
  app.listeners.get('nexus:invalidate')?.()
  app.listeners.get('nexus:invalidate')?.()
  await settle()
  stale.resolve({ partners: [partner('过期联系人')] })
  await settle()
  assert.equal(app.render().partners?.[0].partner.id, '最新-3')
  app.unmount()
  assert.equal(app.listeners.size, 0)
})

test('联系人请求失败呈现可重试错误，不伪装成成功空列表', async () => {
  let success = false
  const app = harness(async () => success ? { partners: [] } : null)
  app.render()
  await settle()
  const failed = app.render()
  assert.equal(failed.partners, null)
  assert.equal(failed.loading, false)
  assert.match(failed.error ?? '', /未能加载/)
  success = true
  await failed.reload()
  const recovered = app.render()
  assert.equal(recovered.error, null)
  assert.equal(recovered.partners?.length, 0)
  app.unmount()
})

test('同企业刷新失败保留联系人以维持已选会话，同时明确显示错误', async () => {
  let fail = false
  const app = harness(async () => fail ? null : { partners: [partner('org-b')] })
  app.render(); await settle()
  fail = true
  app.listeners.get('nexus:invalidate')?.()
  await settle()
  const result = app.render()
  assert.equal(result.partners?.[0].partner.id, 'org-b')
  assert.match(result.error ?? '', /未能加载/)
  assert.equal(result.loading, false)
  app.unmount()
})

test('轮询和focus读取新合作状态，仅accepted目录变化刷新业务视图', async () => {
  let items = [partner('org-b', 'pending')]
  const app = harness(async () => ({ partners: items }))
  app.render()
  await settle()
  assert.equal(app.refreshes(), 0)
  items = [partner('org-b')]
  app.timers.forEach((callback) => callback())
  await settle()
  assert.equal(app.render().partners?.[0].status, 'accepted')
  assert.equal(app.refreshes(), 1)
  app.listeners.forEach((callback) => callback())
  await settle()
  assert.equal(app.refreshes(), 1)
  items = [partner('org-b', 'disconnected')]
  app.listeners.forEach((callback) => callback())
  await settle()
  assert.equal(app.render().partners?.[0].status, 'disconnected')
  assert.equal(app.refreshes(), 2)
  app.unmount()
  assert.equal(app.timers.size, 0)
  assert.equal(app.listeners.size, 0)
})

function transactionHarness(items: IdentityPartner[], loadError: string | null = null) {
  const slots: unknown[] = []
  let cursor = 0
  let submissions = 0
  const pending = deferred<boolean>()
  const state = {
    mode: 'server', busy: false, identityStatus: status(), state: { transactions: [] },
    act: async () => { submissions++; return pending.promise }, navigate: () => {}
  }
  const useApp = Object.assign((select: (value: typeof state) => unknown) => select(state), { getState: () => state })
  const code = ts.transpileModule(readFileSync(new URL('../src/renderer/src/pages/Transactions.tsx', import.meta.url), 'utf8') + '\nexport { NewTransactionDialog }', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const module = { exports: {} as { NewTransactionDialog: (props: { open: boolean; onClose: () => void }) => unknown } }
  const nativeRequire = createRequire(import.meta.url)
  runInNewContext(code, {
    module, exports: module.exports,
    require: (name: string) => {
      if (name === 'react') return {
        useRef: (initial: unknown) => { const index = cursor++; return slots[index] ?? (slots[index] = { current: initial }) },
        useState: (initial: unknown) => { const index = cursor++; slots[index] ??= initial; return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }] }
      }
      if (name === '@/store') return { useApp, useView: () => state.state }
      if (name === './Contacts') return { usePartners: () => ({ partners: items, loading: false, error: loadError, reload: async () => {} }) }
      if (name === '@/lib/selectors') return { currentUser: () => ({ id: 'user-a', orgId: 'org-a', role: 'business' }), directory: () => ({ organizations: [{ id: 'visible-only', kind: 'company', name: '历史交易可见企业' }] }), orgOf: () => ({ name: '当前企业' }) }
      if (name === '@/components/ui') return Object.fromEntries(['Button', 'Card', 'Dialog', 'EmptyState', 'Field', 'Input', 'PageHeader', 'Select', 'Textarea'].map((item) => [item, item]))
      if (name.startsWith('@/') || name.startsWith('@shared/') || name === 'lucide-react') return {}
      return nativeRequire(name)
    }
  })
  type Element = { type: string; props: { children?: unknown; value?: string; placeholder?: string; disabled?: boolean; onChange?: (event: { target: { value: string } }) => void; onClick?: () => void } }
  return {
    render() {
      cursor = 0
      const nodes: Element[] = []
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk)
        else if (value && typeof value === 'object' && 'props' in value) { const node = value as Element; nodes.push(node); walk(node.props.children) }
      }
      walk(module.exports.NewTransactionDialog({ open: true, onClose: () => {} }))
      return nodes
    },
    submissions: () => submissions, pending
  }
}

test('创建交易只列出accepted伙伴，不采用历史可见企业或pending记录', async () => {
  const app = transactionHarness([partner('accepted-org'), partner('pending-org', 'pending'), partner('disconnected-org', 'disconnected')])
  let nodes = app.render()
  const options = nodes.filter((node) => node.type === 'option' && node.props.value !== undefined)
  assert.deepEqual(options.map((node) => node.props.value), ['', 'accepted-org'])
  assert.equal(nodes.find((node) => node.type === 'Select' && node.props.value === '')?.props.value, '')
  nodes.find((node) => node.type === 'Input' && node.props.placeholder === '例如：智能设备采购项目')?.props.onChange?.({ target: { value: '合作交易' } })
  nodes.find((node) => node.type === 'Select' && node.props.value === '')?.props.onChange?.({ target: { value: 'accepted-org' } })
  nodes = app.render()
  const submit = nodes.find((node) => node.type === 'Button' && node.props.children === '创建')!
  assert.equal(submit.props.disabled, false)
  submit.props.onClick?.()
  submit.props.onClick?.()
  assert.equal(app.submissions(), 1)
  app.pending.resolve(false)
  await settle()
})

test('无合作候选或加载失败时不能创建交易，并提供联系人入口或重试', () => {
  for (const error of [null, '加载失败']) {
    const app = transactionHarness([], error)
    const nodes = app.render()
    const submit = nodes.find((node) => node.type === 'Button' && node.props.children === '创建')!
    assert.equal(submit.props.disabled, true)
    submit.props.onClick?.()
    assert.equal(app.submissions(), 0)
    assert.ok(nodes.some((node) => node.type === 'Button' && node.props.children === (error ? '重试' : '前往好友与联系人')))
  }
})

test('演示模式不请求真实联系人或生成模拟关系', async () => {
  let requests = 0
  const app = harness(async () => { requests++; return { partners: [partner('fake')] } })
  app.state.mode = 'demo'
  assert.equal(app.render().partners, null)
  await settle()
  assert.equal(requests, 0)
  assert.equal(app.timers.size, 0)
  app.unmount()
})
