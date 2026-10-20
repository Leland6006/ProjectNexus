import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import {
  buildAgentContext,
  canPromote,
  confirmClaim,
  renderContext,
  selectPremises,
  visibleClaims
} from '../src/shared/context.ts'
import { looksLikeDatabase, migrateDatabase } from '../src/shared/migrations.ts'
import { buildViewState } from '../src/shared/permissions.ts'
import * as proposalView from '../src/shared/proposalView.ts'
import { createSeedDatabase, DEFAULT_USER_ID, ORG_A, ORG_B } from '../src/shared/seed.ts'
import { NexusError, type Claim, type Database, type ViewState } from '../src/shared/types.ts'

const TX = 'tx_equip'
const AT = '2026-10-19T09:00:00.000Z'

function claim(id: string, overrides: Partial<Claim> = {}): Claim {
  return {
    id,
    orgId: ORG_A,
    transactionId: TX,
    key: 'payment.prepay_rate',
    label: id,
    value: id,
    numeric: null,
    unit: null,
    status: 'confirmed',
    source: { kind: 'user' },
    asOf: AT,
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null,
    ...overrides
  }
}

test('被替代的事实不进入可见上下文或推理前提，权限与作用域仍生效', () => {
  const db = createSeedDatabase()
  db.claims = [
    claim('old', { supersededById: 'current' }),
    claim('current'),
    claim('inference', { status: 'inferred' }),
    claim('other-org', { orgId: ORG_B }),
    claim('other-tx', { transactionId: 'other' }),
    claim('company', { transactionId: null }),
    claim('cost', { key: 'cost.total' })
  ]
  const user = db.users.find((u) => u.id === DEFAULT_USER_ID)!
  const tx = db.transactions.find((t) => t.id === TX)!
  assert.deepEqual(
    visibleClaims(db, user, tx).map((c) => c.id),
    ['current', 'inference', 'company', 'cost']
  )
  const ctx = buildAgentContext(db, DEFAULT_USER_ID, 'legal', TX)
  assert.deepEqual(
    ctx.claims.map((c) => c.id),
    ['current', 'inference', 'company']
  )
  const selected = selectPremises(db.claims)
  assert.ok(!selected.premises.some((c) => c.id === 'old'))
  assert.ok(selected.excluded.some((c) => c.id === 'old'))
  const prompt = renderContext({ ...ctx, claims: [db.claims[0], ...ctx.claims] })
  assert.ok(!prompt.includes('old'))
  assert.ok(prompt.includes('current'))
})

test('被替代的推断和建议不能人工升级，当前记录仍可确认', () => {
  for (const status of ['inferred', 'recommended'] as const) {
    const old = claim('old', { status, supersededById: 'current' })
    assert.equal(canPromote(old), false)
    assert.throws(
      () => confirmClaim(old, DEFAULT_USER_ID, AT),
      (error: unknown) =>
        error instanceof NexusError && error.code === 'CONFLICT' && /替代/.test(error.message)
    )
    assert.equal(old.status, status)
    const current = claim('current', { status })
    assert.equal(canPromote(current), true)
    assert.equal(confirmClaim(current, DEFAULT_USER_ID, AT).status, 'confirmed')
  }
  assert.equal(canPromote(claim('fact')), false)
})

test('条款正文经过清理后带条款ID进入提示，财务视角仍无权读取', () => {
  const db = createSeedDatabase()
  const contract = db.contracts.find((c) => c.id === 'ct_equip')!
  contract.clauses = [
    {
      ...contract.clauses[0],
      id: 'clause-evidence',
      title: '付款约定',
      body: '<p onclick="bad()">交付后\n  <strong>三十日</strong>付款</p><script>script-secret</script><style>style-secret</style>'
    }
  ]
  const legal = renderContext(buildAgentContext(db, DEFAULT_USER_ID, 'legal', TX))
  assert.ok(legal.includes('clause-evidence'))
  assert.ok(legal.includes('交付后 三十日 付款'))
  assert.ok(!/onclick|bad\(\)|script-secret|style-secret|<p>|<strong>/.test(legal))
  const finance = renderContext(buildAgentContext(db, DEFAULT_USER_ID, 'finance', TX))
  assert.ok(!finance.includes('clause-evidence'))
  assert.ok(!finance.includes('三十日'))
})

test('单条条款正文限制长度，后续条款仍保留ID和正文', () => {
  const db = createSeedDatabase()
  const contract = db.contracts.find((c) => c.id === 'ct_equip')!
  const base = contract.clauses[0]
  contract.clauses = [
    { ...base, id: 'long-clause', title: '长条款', body: `<p>${'甲'.repeat(10_000)}尾部内容</p>` },
    { ...base, id: 'next-clause', title: '后续条款', body: '<p>后续付款约定</p>' }
  ]
  const prompt = renderContext(buildAgentContext(db, DEFAULT_USER_ID, 'legal', TX))
  assert.equal((prompt.match(/甲/g) ?? []).length, 4_000)
  assert.ok(!prompt.includes('尾部内容'))
  assert.ok(prompt.includes('next-clause'))
  assert.ok(prompt.includes('后续付款约定'))
})

const V2_ARRAYS = ['proposals', 'claims', 'costItems', 'cashAccounts'] as const

test('版本2数据库拒绝缺失及非数组的新集合', () => {
  for (const key of V2_ARRAYS) {
    for (const value of [undefined, null, {}, 'invalid']) {
      const db = createSeedDatabase()
      const raw = db as unknown as Record<string, unknown>
      if (value === undefined) delete raw[key]
      else raw[key] = value
      assert.equal(looksLikeDatabase(db), false, `${key}: ${String(value)}`)
      assert.equal(migrateDatabase(db).ok, false, `${key}: ${String(value)}`)
    }
  }
})

test('版本1和无版本数据库仍补齐新集合并保留原始内容', () => {
  for (const version of [1, undefined]) {
    const db = createSeedDatabase()
    const raw = db as unknown as Record<string, unknown>
    if (version === undefined) delete raw.schemaVersion
    else db.schemaVersion = version
    for (const key of V2_ARRAYS) delete raw[key]
    for (const c of [...db.contracts, ...db.versions]) delete (c as Partial<typeof c>).paymentTerms
    const originalName = db.transactions[0].name
    assert.equal(looksLikeDatabase(db), true)
    const result = migrateDatabase(db)
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.db.schemaVersion, 2)
    assert.equal(result.db.transactions[0].name, originalName)
    for (const key of V2_ARRAYS) assert.deepEqual(result.db[key], [])
    assert.ok([...result.db.contracts, ...result.db.versions].every((c) => c.paymentTerms === null))
  }
})

test('迁移后仍无效的版本1集合不得作为完整数据库返回', () => {
  const db = createSeedDatabase()
  db.schemaVersion = 1
  ;(db as unknown as Record<string, unknown>).claims = {}
  assert.equal(migrateDatabase(db).ok, false)
})

// 实际执行页面组件，替换数据和展示组件边界；不依赖源码字符串断言。
function renderProposalPage(view: ViewState): string {
  const require = createRequire(import.meta.url)
  const filename = new URL('../src/renderer/src/pages/Proposals.tsx', import.meta.url)
  const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).outputText
  const container =
    (tag: string) =>
    ({ children, className }: { children?: React.ReactNode; className?: string }) =>
      React.createElement(tag, { className }, children)
  const useApp = (selector: (state: unknown) => unknown) =>
    selector({ busy: false, act: async () => true, navigate: () => undefined })
  const module = { exports: {} as { default: React.ComponentType } }
  const overrides: Record<string, unknown> = {
    '@shared/context': { canPromote },
    '@shared/proposalView': proposalView,
    '@/store': { useView: () => view, useApp },
    '@/lib/utils': {
      cn: (...parts: unknown[]) => parts.filter(Boolean).join(' '),
      formatDateTime: (value: string) => value
    },
    '@/lib/agents': { runAgentAnalysis: async () => undefined },
    '@/lib/selectors': { accessFor: () => ({ isParty: false }), orgOf: () => undefined },
    '@/components/ui': {
      Badge: container('span'),
      Card: container('section'),
      Select: container('select'),
      Button: ({
        children,
        disabled,
        onClick,
        title
      }: {
        children?: React.ReactNode
        disabled?: boolean
        onClick?: () => void
        title?: string
      }) => React.createElement('button', { disabled, onClick, title }, children),
      CardHeader: () => null,
      EmptyState: () => null,
      PageHeader: () => null
    }
  }
  runInNewContext(code, {
    module,
    exports: module.exports,
    require: (id: string) => (Object.hasOwn(overrides, id) ? overrides[id] : require(id))
  })
  return renderToStaticMarkup(React.createElement(module.exports.default))
}

function proposalViewState(): ViewState {
  const db: Database = createSeedDatabase()
  const view = buildViewState(db, DEFAULT_USER_ID)
  assert.equal(view.proposals.filter((p) => p.status === 'pending').length, 1)
  return view
}

test('建议页面缺失依据时显示提示并禁用采纳，完整依据仍可采纳', () => {
  const view = proposalViewState()
  const complete = renderProposalPage(view)
  const completeButton = complete
    .match(/<button\b[^>]*>[^]*?<\/button>/g)
    ?.find((button) => button.includes('采纳'))
  assert.ok(completeButton)
  assert.ok(!completeButton.includes('disabled'))
  const proposal = view.proposals.find((p) => p.status === 'pending')!
  proposal.claimIds.push('missing-evidence')
  const incomplete = renderProposalPage(view)
  assert.match(incomplete, /依据.*缺失|缺少.*依据/)
  const approveButton = incomplete
    .match(/<button\b[^>]*>[^]*?<\/button>/g)
    ?.find((button) => button.includes('采纳'))
  assert.ok(approveButton)
  assert.match(approveButton, /disabled=""/)
})

test('建议页面不给已被替代的推断显示确认按钮', () => {
  const view = proposalViewState()
  view.claims = [claim('old', { status: 'inferred', supersededById: 'current' })]
  const html = renderProposalPage(view)
  assert.ok(!html.includes('只有人工确认后，推断才会成为事实'))
})
