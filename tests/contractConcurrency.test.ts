import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { createSession, handleCall } from '../src/main/handlers.ts'
import { createSeedDatabase } from '../src/shared/seed.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import { sanitizeHtml } from '../src/shared/sanitize.ts'
import { canConfirmFinal, newClause, sortVersionsDesc } from '../src/shared/editorRules.ts'
import type { Clause, ViewState } from '../src/shared/types.ts'

function sessions() {
  const db = createSeedDatabase()
  let commits = 0
  const first = createSession(db, 'u_a_biz', () => { commits++ })
  const second = createSession(db, 'u_a_legal', () => { commits++ })
  const current = () => structuredClone(db.contracts.find((c) => c.id === 'ct_equip')!.clauses)
  return { db, first, second, current, commits: () => commits }
}

for (const path of ['updateClauses', 'resolveSuggestion', 'restoreVersion'] as const) {
  test(`双会话：${path}变更条款后拒绝陈旧草稿，重载后可保存`, async () => {
    const { db, first, second, current, commits } = sessions()
    const initial = current()
    const local = initial.map((c, index) => index === 0 ? { ...c, body: '<p>本地未保存内容</p>' } : c)
    if (path === 'updateClauses') {
      const remote = initial.map((c, index) => index === 1 ? { ...c, body: '<p>另一客户端保存</p>' } : c)
      assert.equal((await handleCall(second, path, ['ct_equip', remote, initial])).ok, true)
    } else if (path === 'resolveSuggestion') {
      const suggestion = second.service.createSuggestion('u_b_biz', 'ct_equip', initial[0].id, '<p>对方提出的新内容</p>', '并发验证')
      assert.equal((await handleCall(second, path, [suggestion.id, true])).ok, true)
    } else {
      assert.equal((await handleCall(second, path, ['ct_equip', 'ver_e2'])).ok, true)
    }
    const remote = current()
    assert.notDeepEqual(remote, initial)
    const before = JSON.stringify(db)
    const committed = commits()
    const stale = await handleCall(first, 'updateClauses', ['ct_equip', local, initial])
    assert.equal(stale.ok, false)
    if (!stale.ok) { assert.equal(stale.code, 'CONFLICT'); assert.match(stale.message, /远端.*已修改/) }
    assert.deepEqual(current(), remote)
    assert.equal(JSON.stringify(db), before, '冲突不得更改任何数据')
    assert.equal(commits(), committed)
    const reload = await handleCall(first, 'getState', [])
    assert.equal(reload.ok, true)
    if (!reload.ok) return
    const base = reload.state.contracts.find((c) => c.id === 'ct_equip')!.clauses
    const merged = base.map((c, index) => index === 0 ? { ...c, body: '<p>重载后重新编辑</p>' } : c)
    assert.equal((await handleCall(first, 'updateClauses', ['ct_equip', merged, base])).ok, true)
    assert.deepEqual(current(), merged)
  })
}

test('基础快照比较覆盖标题、编号、条款顺序和增删，忽略对象键顺序', async () => {
  for (const change of [
    (clauses: Clause[]) => { clauses[0].title = '标题变化' },
    (clauses: Clause[]) => { clauses[0].id = 'different-id' },
    (clauses: Clause[]) => { clauses.reverse() },
    (clauses: Clause[]) => { clauses.pop() },
    (clauses: Clause[]) => { clauses.push({ id: 'added', title: '新增', body: '<p>新增</p>' }) }
  ]) {
    const { first, second, current } = sessions()
    const base = current()
    const remote = current()
    change(remote)
    assert.equal((await handleCall(second, 'updateClauses', ['ct_equip', remote, base])).ok, true)
    const result = await handleCall(first, 'updateClauses', ['ct_equip', base, base])
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'CONFLICT')
    assert.deepEqual(current(), remote)
  }
  const { first, current } = sessions()
  const base = current().map(({ body, title, id }) => ({ body, title, id }))
  assert.equal((await handleCall(first, 'updateClauses', ['ct_equip', current(), base])).ok, true)
})

test('基础快照不标准化，非条款变更不产生误冲突，旧demo调用兼容', async () => {
  const { first, current } = sessions()
  const base = current()
  await handleCall(first, 'saveVersion', ['ct_equip', '只新增版本'])
  await handleCall(first, 'addComment', ['ct_equip', base[0].id, '只新增评论', 'shared'])
  assert.equal((await handleCall(first, 'updateClauses', ['ct_equip', current(), base])).ok, true)
  const modifiedBase = current()
  modifiedBase[0].body = modifiedBase[0].body.replace('<p>', '<p class="ignored">')
  const result = await handleCall(first, 'updateClauses', ['ct_equip', current(), modifiedBase])
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'CONFLICT')
  assert.equal((await handleCall(first, 'updateClauses', ['ct_equip', current()])).ok, true)
})

test('无效基础快照返回INVALID_INPUT并保留数据', async () => {
  for (const invalid of [null, {}, [], [null], [{ id: 'id', title: 'x' }], [{ id: 'id', title: 'x', body: 2 }]]) {
    const { first, current } = sessions()
    const before = current()
    const result = await handleCall(first, 'updateClauses', ['ct_equip', before, invalid])
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_INPUT')
    assert.deepEqual(current(), before)
  }
})

const settle = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }

type Element = { type: string | ((props: Record<string, unknown>) => Element); key?: string; props: Record<string, any> }
function elements(root: Element): Element[] {
  if (!root || typeof root !== 'object') return []
  const children = [root.props?.children].flat(Infinity).filter(Boolean) as Element[]
  return [root, ...children.flatMap(elements)]
}

// 执行实际TSX组件；轻量hook驱动器只替换React调度与子组件，不复制编辑器逻辑。
function editorHarness() {
  let view = structuredClone(buildViewState(createSeedDatabase(), 'u_a_biz'))
  let identity: any = { account: { id: 'account-a' }, actingOrgId: 'org_qiming' }
  const requests: { method: string; args: unknown[] }[] = []
  let call = async (_method: string, _args: unknown[]) => true
  const store = { act: async (method: string, args: unknown[]) => { requests.push({ method, args: structuredClone(args) }); return call(method, args) }, busy: false, navigate: () => {}, toast: () => {}, identityStatus: identity }
  const useApp = Object.assign((selector: (state: typeof store) => unknown) => selector(store), { getState: () => ({ state: view }) })
  const slots: any[] = []
  const dependencies: unknown[][] = []
  const cleanups: (((() => void) | undefined))[] = []
  let cursor = 0
  let effects: (() => void)[] = []
  const hooks = {
    useState: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: unknown) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef: (initial: unknown) => {
      const index = cursor++
      if (!(index in slots)) slots[index] = { current: initial }
      return slots[index]
    },
    useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
      const index = cursor++
      if (!dependencies[index] || deps.some((value, at) => !Object.is(value, dependencies[index][at]))) {
        dependencies[index] = deps
        effects.push(() => { cleanups[index]?.(); cleanups[index] = effect() || undefined })
      }
    }
  }
  const filename = new URL('../src/renderer/src/pages/ContractEditor.tsx', import.meta.url)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText
  const module = { exports: {} as { default: (props: { contractId: string }) => Element } }
  const require = createRequire(import.meta.url)
  let confirm = true
  const window = { confirm: () => confirm, addEventListener: () => {}, removeEventListener: () => {} }
  runInNewContext(code, {
    module, exports: module.exports, structuredClone, crypto: globalThis.crypto, window,
    require: (name: string) => {
      if (name === 'react') return hooks
      if (name === 'react/jsx-runtime') return require(name)
      if (name === '@/store') return { useApp, useView: () => view }
      if (name === '@shared/editorRules') return { canConfirmFinal, newClause, sortVersionsDesc }
      if (name === '@shared/sanitize') return { sanitizeHtml }
      if (name === '@/lib/selectors') return { accessFor: () => ({ isOwner: true, isParty: true, orgId: 'org_qiming' }), orgOf: () => ({ shortName: '测试企业' }) }
      if (name === '@/lib/utils') return { cn: () => '', formatDateTime: () => '时间' }
      return new Proxy({}, { get: (_target, key) => key })
    }
  })
  const wrapper = () => module.exports.default({ contractId: 'ct_equip' })
  const component = wrapper().type as (props: { contractId: string }) => Element
  let tree: Element
  function render() {
    cursor = 0
    effects = []
    tree = component({ contractId: 'ct_equip' })
    for (const effect of effects) effect()
    cursor = 0
    effects = []
    tree = component({ contractId: 'ct_equip' })
    for (const effect of effects) effect()
    return tree
  }
  function byType(name: string) { return elements(tree).find((el) => el.type === name)! }
  function button(label: string) { return elements(tree).find((el) => el.type === 'Button' && [el.props.children].flat(Infinity).includes(label))! }
  render()
  return {
    render, byType, button, requests, wrapper,
    edit(body: string) { const props = byType('ClauseBody').props; props.onChange(props.clauses[0].id, { body }); render() },
    remote(body: string) { view = structuredClone(view); view.contracts.find((c) => c.id === 'ct_equip')!.clauses[0].body = body; render() },
    setCall(value: typeof call) { call = value },
    setConfirm(value: boolean) { confirm = value },
    setIdentity(value: typeof identity) { identity = value; store.identityStatus = value },
    setView(value: ViewState) { view = value },
    unmount() { for (const cleanup of cleanups) cleanup?.() },
    view: () => view,
    tree: () => tree
  }
}

test('编辑器轮询保留dirty草稿与最初base，保存冲突后不换base重试', async () => {
  const h = editorHarness()
  const initial = structuredClone(h.byType('ClauseBody').props.clauses)
  h.edit('<p>本地草稿</p>')
  h.remote('<p>远端条款</p>')
  h.setCall(async (method) => method === 'getState')
  await h.button('保存草稿').props.onClick()
  await Promise.resolve()
  h.render()
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>本地草稿</p>')
  const calls = h.requests.filter((r) => r.method === 'updateClauses')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args[2], initial)
  h.button('复制本地内容').props.onClick()
  h.render()
  assert.match(h.byType('Textarea').props.value, /本地草稿/)
  assert.match(JSON.stringify(h.tree()), /远端合同条款已修改/)
})

test('编辑器主动重载须确认，取消保留草稿，确认后采用最新base', async () => {
  const h = editorHarness()
  h.edit('<p>本地草稿</p>')
  h.remote('<p>远端最新条款</p>')
  h.setConfirm(false)
  h.button('重新载入最新条款').props.onClick()
  await Promise.resolve()
  assert.equal(h.requests.length, 0)
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>本地草稿</p>')
  h.setConfirm(true)
  h.button('重新载入最新条款').props.onClick()
  await settle()
  h.render()
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>远端最新条款</p>')
  h.edit('<p>重载后编辑</p>')
  h.button('保存草稿').props.onClick()
  await Promise.resolve()
  assert.equal((h.requests.at(-1)!.args[2] as Clause[])[0].body, '<p>远端最新条款</p>')
})

test('保存期间继续编辑不清除dirty，后续保存使用本人已提交的base', async () => {
  const h = editorHarness()
  let release!: (ok: boolean) => void
  h.setCall(async () => new Promise<boolean>((resolve) => { release = resolve }))
  h.edit('<p>第一次提交</p>')
  h.button('保存草稿').props.onClick()
  h.edit('<p>等待保存期间继续编辑</p>')
  h.remote('<p>第一次提交</p>')
  release(true)
  await Promise.resolve()
  await settle()
  h.render()
  assert.equal(h.button('保存草稿').props.disabled, false)
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>等待保存期间继续编辑</p>')
  h.setCall(async () => true)
  h.button('保存草稿').props.onClick()
  await Promise.resolve()
  assert.equal((h.requests.at(-1)!.args[2] as Clause[])[0].body, '<p>第一次提交</p>')
})

test('重新载入期间继续编辑会保留新草稿，不因载入响应丢失内容', async () => {
  const h = editorHarness()
  let release!: (ok: boolean) => void
  h.setCall(async () => new Promise<boolean>((resolve) => { release = resolve }))
  h.edit('<p>原草稿</p>')
  h.remote('<p>远端版本</p>')
  h.button('重新载入最新条款').props.onClick()
  h.edit('<p>载入中继续编辑</p>')
  release(true)
  await settle()
  h.render()
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>载入中继续编辑</p>')
  assert.equal(h.button('保存草稿').props.disabled, false)
})

test('身份切换卸载后，旧保存失败响应不再刷新或修改新上下文', async () => {
  const h = editorHarness()
  let release!: (ok: boolean) => void
  h.setCall(async () => new Promise<boolean>((resolve) => { release = resolve }))
  h.edit('<p>旧账号草稿</p>')
  h.button('保存草稿').props.onClick()
  h.unmount()
  release(false)
  await settle()
  assert.equal(h.requests.length, 1)
  assert.equal(h.requests[0].method, 'updateClauses')
})

test('非dirty远端变更自动采用，合同身份key隔离账号与企业草稿状态', () => {
  const h = editorHarness()
  h.remote('<p>远端自动更新</p>')
  assert.equal(h.byType('ClauseBody').props.clauses[0].body, '<p>远端自动更新</p>')
  const key = h.wrapper().key
  h.setIdentity({ account: { id: 'account-a' }, actingOrgId: 'org_other' })
  assert.notEqual(h.wrapper().key, key)
  h.setIdentity({ account: { id: 'account-b' }, actingOrgId: 'org_qiming' })
  assert.notEqual(h.wrapper().key, key)
  h.setIdentity({ account: { id: 'account-a' }, actingOrgId: 'org_qiming' })
  const next = structuredClone(h.view())
  next.currentUserId = 'u_a_legal'
  h.setView(next)
  assert.notEqual(h.wrapper().key, key)
})
