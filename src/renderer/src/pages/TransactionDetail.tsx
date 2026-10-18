import { useState } from 'react'
import { ArrowLeft, FilePlus2, Pencil, Scale, Send, UserPlus } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL, type Transaction, type TransactionStatus } from '@shared/types'
import { TEMPLATES } from '@shared/templates'
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Textarea } from '@/components/ui'
import { ContractStatusBadge, TransactionStatusBadge, VisibilityBadge } from '@/components/badges'
import { formatDateTime, formatMoney } from '@/lib/utils'
import { accessFor, orgOf, userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'

function EditDialog({ tx, onClose }: { tx: Transaction; onClose: () => void }) {
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [f, setF] = useState({ name: tx.name, type: tx.type, amount: String(tx.amount), expectedSignDate: tx.expectedSignDate, description: tx.description, status: tx.status })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Dialog open onClose={onClose} title="编辑交易项目">
      <div className="space-y-3">
        <Field label="交易名称">
          <Input value={f.name} onChange={set('name')} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="交易类型">
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
          <Field label="交易金额（元）">
            <Input type="number" min={0} value={f.amount} onChange={set('amount')} />
          </Field>
          <Field label="预计签约时间">
            <Input type="date" value={f.expectedSignDate} onChange={set('expectedSignDate')} />
          </Field>
        </div>
        <Field label="项目说明">
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
        <Field label="合同模板" hint={selected?.description}>
          <Select value={tpl} onChange={(e) => setTpl(e.target.value)}>
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
            <option value="">空白合同</option>
          </Select>
        </Field>
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
              if (created) navigate({ page: 'contracts', contractId: created.id })
            }}
          >
            创建并编辑
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export default function TransactionDetail({ transactionId }: { transactionId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const [editing, setEditing] = useState(false)
  const [newContract, setNewContract] = useState(false)
  const [msg, setMsg] = useState('')
  const [msgVis, setMsgVis] = useState<'shared' | 'internal'>('shared')

  const tx = s.transactions.find((t) => t.id === transactionId)
  if (!tx) {
    return (
      <div className="p-6">
        <EmptyState title="交易项目不存在或无权访问" action={<Button onClick={() => navigate({ page: 'transactions' })}>返回交易列表</Button>} />
      </div>
    )
  }

  const a = accessFor(s, tx)
  const contracts = s.contracts.filter((c) => c.transactionId === tx.id)
  const messages = s.messages.filter((m) => m.transactionId === tx.id).sort((x, y) => x.createdAt.localeCompare(y.createdAt))
  const activities = s.activities.filter((x) => x.transactionId === tx.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 12)
  const counselUsers = s.users.filter((u) => u.role === 'external_counsel')
  const grantable = counselUsers.filter((u) => !tx.counselGrants.some((g) => g.userId === u.id))
  const myCounsel = tx.counselGrants.filter((g) => g.grantedByOrgId === a.orgId)
  const invitePending = a.isOwner && tx.counterpartyStatus === 'none'
  const mustAccept = a.isCounterparty && !a.isCounsel && tx.counterpartyStatus === 'invited'

  const send = async (): Promise<void> => {
    if (!msg.trim()) return
    if (await act('sendMessage', [tx.id, msg, msgVis])) setMsg('')
  }

  return (
    <div className="mx-auto max-w-6xl p-6">
      <button onClick={() => navigate({ page: 'transactions' })} className="mb-3 inline-flex items-center gap-1 text-xs text-ink-500 hover:text-ink-900">
        <ArrowLeft className="h-3.5 w-3.5" />
        返回交易项目
      </button>

      <div className="mb-5 flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{tx.name}</h1>
            <TransactionStatusBadge status={tx.status} />
          </div>
          <p className="mt-1 max-w-3xl text-sm text-ink-500">{tx.description || '暂无项目说明'}</p>
        </div>
        <div className="flex gap-2">
          {a.isOwner && (
            <Button onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" />
              编辑
            </Button>
          )}
          {invitePending && (
            <Button variant="primary" loading={busy} onClick={() => void act('inviteCounterparty', [tx.id], `已邀请 ${orgOf(s, tx.counterpartyOrgId)?.shortName}`)}>
              <UserPlus className="h-3.5 w-3.5" />
              邀请 {orgOf(s, tx.counterpartyOrgId)?.shortName}
            </Button>
          )}
          {mustAccept && (
            <Button variant="primary" loading={busy} onClick={() => void act('acceptInvitation', [tx.id], '已加入交易项目')}>
              接受邀请并加入
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
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
                  <li key={c.id} onClick={() => navigate({ page: 'contracts', contractId: c.id })} className="flex cursor-pointer items-center justify-between border-t border-slate-100 px-4 py-3 first:border-t-0 hover:bg-slate-50">
                    <div>
                      <p className="font-medium">{c.title}</p>
                      <p className="text-xs text-ink-500">
                        {c.clauses.length} 个条款 · 更新于 {formatDateTime(c.updatedAt)}
                        {!c.sharedWithCounterparty && ' · 尚未共享给对方'}
                      </p>
                    </div>
                    <ContractStatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card>
            <CardHeader title="项目消息" subtitle="「仅本企业」消息对方不可见" />
            <div className="max-h-80 space-y-3 overflow-y-auto px-4 py-3">
              {messages.length === 0 && <p className="py-4 text-center text-xs text-ink-500">暂无消息</p>}
              {messages.map((m) => (
                <div key={m.id} className="rounded-lg bg-slate-50 px-3 py-2">
                  <div className="mb-0.5 flex items-center gap-2 text-xs text-ink-500">
                    <span className="font-medium text-ink-700">{userLabel(s, m.authorId)}</span>
                    <span>{formatDateTime(m.createdAt)}</span>
                    <VisibilityBadge visibility={m.visibility} />
                  </div>
                  <p className="text-sm text-ink-900">{m.body}</p>
                </div>
              ))}
            </div>
            {a.isCounsel ? (
              <p className="border-t border-slate-100 px-4 py-3 text-xs text-ink-500">外部律师请在合同条款上添加意见。</p>
            ) : (
              <div className="flex items-end gap-2 border-t border-slate-100 p-3">
                <Textarea className="min-h-[40px] flex-1" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="输入消息…" aria-label="消息内容" />
                <Select className="w-28" value={msgVis} onChange={(e) => setMsgVis(e.target.value as typeof msgVis)} aria-label="消息可见范围">
                  <option value="shared">双方可见</option>
                  <option value="internal">仅本企业</option>
                </Select>
                <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!msg.trim()}>
                  <Send className="h-3.5 w-3.5" />
                  发送
                </Button>
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="交易信息" />
            <dl className="space-y-2.5 px-4 py-3 text-sm">
              {[
                ['交易类型', tx.type],
                ['发起企业', orgOf(s, tx.initiatorOrgId)?.name],
                ['交易对方', orgOf(s, tx.counterpartyOrgId)?.name],
                ['交易金额', formatMoney(tx.amount)],
                ['预计签约', tx.expectedSignDate]
              ].map(([k, v]) => (
                <div key={k as string} className="flex justify-between gap-3">
                  <dt className="text-ink-500">{k}</dt>
                  <dd className="text-right font-medium">{v}</dd>
                </div>
              ))}
              <div className="flex justify-between gap-3">
                <dt className="text-ink-500">对方状态</dt>
                <dd>{tx.counterpartyStatus === 'joined' ? <Badge tone="green">已加入</Badge> : tx.counterpartyStatus === 'invited' ? <Badge tone="amber">已邀请，待加入</Badge> : <Badge>未邀请</Badge>}</dd>
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
                <div className="mt-3 flex gap-2">
                  {grantable.map((u) => (
                    <Button key={u.id} size="sm" loading={busy} onClick={() => void act('grantCounsel', [tx.id, u.id], `已邀请律师 ${u.name}`)}>
                      <UserPlus className="h-3.5 w-3.5" />
                      邀请 {u.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="最近活动" />
            <ul className="max-h-72 overflow-y-auto px-4 py-2">
              {activities.length === 0 && <li className="py-3 text-xs text-ink-500">暂无活动</li>}
              {activities.map((x) => (
                <li key={x.id} className="border-b border-slate-100 py-2 last:border-b-0">
                  <p className="text-sm text-ink-700">{x.summary}</p>
                  <p className="text-xs text-ink-400">{formatDateTime(x.createdAt)}</p>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      </div>

      {editing && <EditDialog tx={tx} onClose={() => setEditing(false)} />}
      {newContract && <NewContractDialog tx={tx} onClose={() => setNewContract(false)} />}
    </div>
  )
}
