import { useState } from 'react'
import { ArrowLeft, FilePlus2, Pencil, Play, Scale, UserPlus } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL, type Transaction, type TransactionStatus } from '@shared/types'
import { PROPOSAL_STATUS_LABEL, PROPOSAL_STATUS_TONE } from '@shared/proposalView'
import { TEMPLATES } from '@shared/templates'
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Textarea } from '@/components/ui'
import { ContractStatusBadge, TransactionStatusBadge } from '@/components/badges'
import { cn, formatDateTime, formatMoney } from '@/lib/utils'
import { runAgentAnalysis } from '@/lib/agents'
import { accessFor, directory, orgOf, otherPartyId, userLabel, type Access } from '@/lib/selectors'
import { contractRoute, projectRoute, type ProjectTab } from '@/routes'
import { useApp, useView } from '@/store'
import Collaboration from './Collaboration'
import Performance from './Performance'
import ProjectMoney from './ProjectMoney'

const TABS: { id: ProjectTab; label: string }[] = [
  { id: 'overview', label: '概览与合同' },
  { id: 'collab', label: '协作与磋商' },
  { id: 'performance', label: '履约' },
  { id: 'money', label: '收付款' }
]

function EditDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [f, setF] = useState({ name: tx.name, type: tx.type, amount: String(tx.amount), expectedSignDate: tx.expectedSignDate, description: tx.description, status: tx.status })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Dialog open onClose={onClose} title="编辑业务">
      <div className="space-y-3">
        <Field label="业务名称">
          <Input value={f.name} onChange={set('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="业务类型">
            <Input value={f.type} onChange={set('type')} />
          </Field>
          <Field label="当前状态">
            <Select value={f.status} onChange={set('status')}>
              {(Object.keys(TRANSACTION_STATUS_LABEL) as TransactionStatus[]).map((k) => (
                <option key={k} value={k}>
                  {TRANSACTION_STATUS_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="合同金额（元）">
            <Input type="number" min={0} value={f.amount} onChange={set('amount')} />
          </Field>
          <Field label="预计签约时间">
            <Input type="date" value={f.expectedSignDate} onChange={set('expectedSignDate')} />
          </Field>
        </div>
        <Field label="业务说明">
          <Textarea value={f.description} onChange={set('description')} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (await act('updateTransaction', [tx.id, { ...f, amount: Number(f.amount) }], '已保存修改')) onClose()
            }}
          >
            保存
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function NewContractDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const s = useView()
  const [title, setTitle] = useState(`${tx.name}合同`)
  const [tpl, setTpl] = useState(TEMPLATES[0].id)
  const selected = TEMPLATES.find((t) => t.id === tpl)
  return (
    <Dialog open onClose={onClose} title="创建合同">
      <div className="space-y-3">
        <Field label="合同名称">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        </Field>
        <Field label="合同模板" hint={selected?.description ?? '从空白合同开始起草'}>
          <Select value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="">空白合同</option>
          </Select>
        </Field>
        <p className="text-xs text-ink-500">合同文件导入（DOCX、PDF、OCR）尚未提供，目前请从模板或空白合同起草。</p>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              const before = new Set(s.contracts.map((c) => c.id))
              if (!(await act('createContract', tpl ? [tx.id, title, tpl] : [tx.id, title], '合同已创建'))) return
              onClose()
              const created = useApp.getState().state?.contracts.find((c) => !before.has(c.id))
              if (created) navigate(contractRoute(created.id))
            }}
          >
            创建并编辑
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function Overview({ tx, a }: { tx: Transaction; a: Access }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const [newContract, setNewContract] = useState(false)
  const contracts = s.contracts.filter((c) => c.transactionId === tx.id)
  const proposals = s.proposals.filter((p) => p.transactionId === tx.id)
  const activities = s.activities.filter((x) => x.transactionId === tx.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 8)
  const counselUsers = directory(s).users.filter((u) => u.role === 'external_counsel')
  const grantable = counselUsers.filter((u) => !tx.counselGrants.some((g) => g.userId === u.id))
  const myCounsel = tx.counselGrants.filter((g) => g.grantedByOrgId === a.orgId)

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card>
          <CardHeader
            title="合同"
            action={
              a.isOwner && (
                <Button size="sm" onClick={() => setNewContract(true)}>
                  <FilePlus2 className="h-3.5 w-3.5" />
                  创建合同
                </Button>
              )
            }
          />
          {contracts.length === 0 ? (
            <EmptyState title="还没有可见的合同" hint={a.isOwner ? '从模板创建第一份合同，开始起草' : '发起方共享合同后会显示在这里'} />
          ) : (
            <ul>
              {contracts.map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => navigate(contractRoute(c.id))}
                    className="flex w-full items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-left first:border-t-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.title}</p>
                      <p className="text-xs text-ink-500">
                        {c.clauses.length} 个条款 · 更新于 {formatDateTime(c.updatedAt)}
                        {!c.sharedWithCounterparty && ' · 尚未共享给对方'}
                      </p>
                    </div>
                    <ContractStatusBadge status={c.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {!a.isCounsel && (
          <Card>
            <CardHeader title="相关方案" subtitle="协同分析生成的方案，需要人工决策后才会生效" />
            {proposals.length === 0 ? (
              <p className="px-4 py-3 text-xs text-ink-500">还没有针对这笔业务的方案。</p>
            ) : (
              <ul>
                {proposals.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => navigate({ module: 'actions', view: p.status === 'pending' ? 'decisions' : 'done' })}
                      className="w-full border-t border-slate-100 px-4 py-2.5 text-left first:border-t-0 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                    >
                      <div className="flex items-center gap-2">
                        <Badge tone={PROPOSAL_STATUS_TONE[p.status]}>{PROPOSAL_STATUS_LABEL[p.status]}</Badge>
                        <span className="truncate text-sm font-medium">{p.title}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-400">{formatDateTime(p.createdAt)}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}

        <Card>
          <CardHeader title="最近动态" />
          <ul className="px-4 py-2">
            {activities.length === 0 && <li className="py-3 text-xs text-ink-500">暂无动态</li>}
            {activities.map((x) => (
              <li key={x.id} className="border-b border-slate-100 py-2 last:border-b-0">
                <p className="text-sm text-ink-700">{x.summary}</p>
                <p className="text-xs text-ink-400">{formatDateTime(x.createdAt)}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      <div className="space-y-4">
        <Card>
          <CardHeader title="业务信息" />
          <dl className="space-y-2.5 px-4 py-3 text-sm">
            {[
              ['业务类型', tx.type],
              ['发起企业', orgOf(s, tx.initiatorOrgId)?.name],
              ['交易对方', orgOf(s, tx.counterpartyOrgId)?.name],
              ['合同金额', formatMoney(tx.amount)],
              ['预计签约', tx.expectedSignDate]
            ].map(([k, v]) => (
              <div key={k as string} className="flex justify-between gap-3">
                <dt className="shrink-0 text-ink-500">{k}</dt>
                <dd className="text-right font-medium">{v}</dd>
              </div>
            ))}
            <div className="flex justify-between gap-3">
              <dt className="text-ink-500">对方协作状态</dt>
              <dd>
                {tx.counterpartyStatus === 'joined' ? <Badge tone="green">已加入</Badge> : tx.counterpartyStatus === 'invited' ? <Badge tone="amber">已邀请，待加入</Badge> : <Badge>未邀请</Badge>}
              </dd>
            </div>
          </dl>
        </Card>

        <Card>
          <CardHeader title="外部律师" subtitle="仅显示本企业授权的律师" />
          <div className="px-4 py-3">
            {myCounsel.length === 0 ? (
              <p className="text-xs text-ink-500">尚未邀请外部律师</p>
            ) : (
              <ul className="space-y-1.5">
                {myCounsel.map((g) => (
                  <li key={g.userId} className="flex items-center gap-2 text-sm">
                    <Scale className="h-3.5 w-3.5 text-purple-600" />
                    {userLabel(s, g.userId)}
                  </li>
                ))}
              </ul>
            )}
            {a.isParty && grantable.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {grantable.map((u) => (
                  <Button key={u.id} size="sm" loading={busy} onClick={() => void act('grantCounsel', [tx.id, u.id], `已授权律师 ${u.name}`)}>
                    <UserPlus className="h-3.5 w-3.5" />
                    授权 {u.name}
                  </Button>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
      {newContract && <NewContractDialog tx={tx} onClose={() => setNewContract(false)} />}
    </div>
  )
}

/** Workspace of one business: contracts, negotiation, performance and money in one place. */
export default function ProjectWorkspace({ transactionId, tab }: { transactionId: string; tab: ProjectTab }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const [editing, setEditing] = useState(false)

  const tx = s.transactions.find((t) => t.id === transactionId)
  if (!tx) {
    return (
      <div className="p-6">
        <EmptyState title="业务不存在或无权访问" action={<Button onClick={() => navigate({ module: 'business', view: 'all' })}>返回全部业务</Button>} />
      </div>
    )
  }

  const a = accessFor(s, tx)
  const other = otherPartyId(tx, a.orgId)
  const otherOrg = orgOf(s, other)
  const invitePending = a.isOwner && tx.counterpartyStatus === 'none'
  const mustAccept = a.isCounterparty && !a.isCounsel && tx.counterpartyStatus === 'invited'

  return (
    <div className="mx-auto max-w-6xl p-6">
      <button
        onClick={() => navigate({ module: 'business', view: 'counterparty', orgId: other })}
        className="mb-3 inline-flex items-center gap-1 rounded text-xs text-ink-500 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        {otherOrg?.shortName ?? '交易对象'}的全部业务
      </button>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="break-all text-xl font-semibold tracking-tight">{tx.name}</h1>
            <TransactionStatusBadge status={tx.status} />
          </div>
          <p className="mt-1 text-xs text-ink-500">
            交易对象：{otherOrg?.name ?? '未知企业'} · 我方：{orgOf(s, a.orgId ?? '')?.name}（{tx.initiatorOrgId === a.orgId ? '发起方' : '受邀方'}）
          </p>
          {tx.description && <p className="mt-1.5 max-w-3xl text-sm text-ink-500">{tx.description}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          {a.isOwner && (
            <Button onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </Button>
          )}
          {a.isParty && (
            <Button loading={busy} onClick={() => void runAgentAnalysis(tx.id)} title="未连接模型时只执行确定性的财务测算">
              <Play className="h-3.5 w-3.5" />
              运行协同分析
            </Button>
          )}
          {invitePending && (
            <Button
              variant="primary"
              loading={busy}
              title="本地演示：邀请后，对方的演示账号可以在自己的工作区看到这笔业务"
              onClick={() => void act('inviteCounterparty', [tx.id], `已邀请 ${otherOrg?.shortName}`)}
            >
              <UserPlus className="h-3.5 w-3.5" />
              邀请 {otherOrg?.shortName} 协作
            </Button>
          )}
          {mustAccept && (
            <Button variant="primary" loading={busy} onClick={() => void act('acceptInvitation', [tx.id], '已加入业务协作')}>
              接受邀请并加入
            </Button>
          )}
        </div>
      </div>

      <div role="tablist" aria-label="业务内容" className="mb-4 flex gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => navigate(projectRoute(tx.id, t.id))}
            className={cn(
              '-mb-px border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500',
              tab === t.id ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-ink-500 hover:text-ink-900'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div role="tabpanel">
        {tab === 'overview' && <Overview tx={tx} a={a} />}
        {tab === 'collab' && <Collaboration transactionId={tx.id} />}
        {tab === 'performance' && <Performance transactionId={tx.id} />}
        {tab === 'money' && <ProjectMoney tx={tx} />}
      </div>

      {editing && <EditDialog tx={tx} onClose={() => setEditing(false)} />}
    </div>
  )
}
