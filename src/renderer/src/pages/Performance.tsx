import { useState } from 'react'
import { CheckCircle2, Circle, CircleAlert, CircleDot, Plus } from 'lucide-react'
import { MILESTONE_STATUS_LABEL, type MilestoneStatus } from '@shared/types'
import { Button, Card, CardHeader, Dialog, EmptyState, Field, Input, Select, Textarea } from '@/components/ui'
import { MilestoneStatusBadge } from '@/components/badges'
import { cn, daysUntil, formatMoney } from '@/lib/utils'
import { accessFor, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

const ICON: Record<MilestoneStatus, React.ReactNode> = {
  pending: <Circle className="h-5 w-5 text-slate-300" />,
  in_progress: <CircleDot className="h-5 w-5 text-brand-600" />,
  completed: <CheckCircle2 className="h-5 w-5 text-emerald-600" />,
  delayed: <CircleAlert className="h-5 w-5 text-rose-600" />
}

function NewMilestoneDialog({ transactionId, onClose }: { transactionId: string; onClose: () => void }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const tx = s.transactions.find((t) => t.id === transactionId)!
  const [f, setF] = useState({ name: '', responsibleOrgId: tx.initiatorOrgId, dueDate: '', paymentAmount: '', note: '' })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))
  return (
    <Dialog open onClose={onClose} title="创建履约节点">
      <div className="space-y-3">
        <Field label="节点名称" hint="例如：支付30%预付款、交付第一批设备">
          <Input value={f.name} onChange={set('name')} autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="责任方">
            <Select value={f.responsibleOrgId} onChange={set('responsibleOrgId')}>
              {[tx.initiatorOrgId, tx.counterpartyOrgId].map((id) => (
                <option key={id} value={id}>
                  {orgOf(s, id)?.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="计划日期">
            <Input type="date" value={f.dueDate} onChange={set('dueDate')} />
          </Field>
        </div>
        <Field label="付款金额（元，非付款节点留空）">
          <Input type="number" min={0} value={f.paymentAmount} onChange={set('paymentAmount')} />
        </Field>
        <Field label="备注">
          <Textarea value={f.note} onChange={set('note')} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>取消</Button>
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              if (await act('createMilestone', [{ transactionId, ...f, paymentAmount: Number(f.paymentAmount || 0) }], '履约节点已创建')) onClose()
            }}
          >
            创建
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** Performance timeline of one business. */
export default function Performance({ transactionId }: { transactionId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const [creating, setCreating] = useState(false)
  const tx = s.transactions.find((t) => t.id === transactionId)
  if (!tx) return <EmptyState title="业务不存在或无权访问" />

  const list = s.milestones.filter((m) => m.transactionId === tx.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const canWrite = accessFor(s, tx).isParty
  const done = list.filter((m) => m.status === 'completed').length

  return (
    <div>
      <Card>
        <CardHeader
          title="履约时间线"
          subtitle={list.length > 0 ? `${done} / ${list.length} 个节点已标记完成` : undefined}
          action={
            canWrite && (
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                <Plus className="h-3.5 w-3.5" />
                创建节点
              </Button>
            )
          }
        />
        {list.length === 0 ? (
          <EmptyState title="还没有履约节点" hint={canWrite ? '合同确认后，创建付款、交付与验收节点' : undefined} />
        ) : (
          <ol className="px-5 py-4">
            {list.map((m, i) => {
              const d = daysUntil(m.dueDate)
              return (
                <li key={m.id} className="relative flex gap-4 pb-6 last:pb-0">
                  {i < list.length - 1 && <span className="absolute left-[9px] top-6 h-full w-px bg-slate-200" />}
                  <span className="relative z-10 mt-0.5 bg-white">{ICON[m.status]}</span>
                  <div className="min-w-0 flex-1 rounded-lg border border-slate-200 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-medium">{m.name}</p>
                        <p className="text-xs text-ink-500">
                          责任方：{orgOf(s, m.responsibleOrgId)?.shortName} · 计划 {m.dueDate}
                          {m.status !== 'completed' && (
                            <span className={cn('ml-2', d < 0 ? 'text-rose-600' : d <= 7 ? 'text-amber-600' : '')}>
                              {d < 0 ? `已逾期 ${-d} 天` : d === 0 ? '今天到期' : `${d} 天后到期`}
                            </span>
                          )}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        <MilestoneStatusBadge status={m.status} />
                        {m.paymentAmount > 0 && <span className="text-sm font-medium">计划 {formatMoney(m.paymentAmount)}</span>}
                      </div>
                    </div>
                    {m.note && <p className="mt-1.5 text-sm text-ink-700">{m.note}</p>}
                    {canWrite && (
                      <div className="mt-2">
                        <Select
                          className="w-32"
                          value={m.status}
                          onChange={(e) => void act('updateMilestone', [m.id, { status: e.target.value }], '节点状态已更新')}
                          aria-label={`更新「${m.name}」状态`}
                        >
                          {(Object.keys(MILESTONE_STATUS_LABEL) as MilestoneStatus[]).map((k) => (
                            <option key={k} value={k}>
                              {MILESTONE_STATUS_LABEL[k]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>
      {creating && <NewMilestoneDialog transactionId={tx.id} onClose={() => setCreating(false)} />}
    </div>
  )
}
