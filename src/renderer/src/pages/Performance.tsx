import { useState } from 'react'
import { CheckCircle2, Circle, CircleAlert, CircleDot, Plus } from 'lucide-react'
import { MILESTONE_STATUS_LABEL, type MilestoneStatus } from '@shared/types'
import {
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Textarea
} from '@/components/ui'
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

function NewMilestoneDialog({
  transactionId,
  onClose
}: {
  transactionId: string
  onClose: () => void
}) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const tx = s.transactions.find((t) => t.id === transactionId)!
  const [f, setF] = useState({
    name: '',
    responsibleOrgId: tx.initiatorOrgId,
    dueDate: '',
    paymentAmount: '',
    note: ''
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) =>
    setF((p) => ({ ...p, [k]: e.target.value }))
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
              if (
                await act(
                  'createMilestone',
                  [{ transactionId, ...f, paymentAmount: Number(f.paymentAmount || 0) }],
                  '履约节点已创建'
                )
              )
                onClose()
            }}
          >
            创建
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export default function Performance() {
  const s = useView()
  const act = useApp((x) => x.act)
  const [txId, setTxId] = useState<string>(
    s.transactions.find((t) => s.milestones.some((m) => m.transactionId === t.id))?.id ??
      s.transactions[0]?.id ??
      ''
  )
  const [creating, setCreating] = useState(false)

  const tx = s.transactions.find((t) => t.id === txId)
  const list = s.milestones
    .filter((m) => m.transactionId === txId)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const canWrite = tx ? accessFor(s, tx).isParty : false
  const paid = list.filter((m) => m.status === 'completed').reduce((n, m) => n + m.paymentAmount, 0)
  const totalPay = list.reduce((n, m) => n + m.paymentAmount, 0)

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="履约管理"
        subtitle="追踪付款、交付与验收节点"
        actions={
          <>
            <Select
              className="w-60"
              value={txId}
              onChange={(e) => setTxId(e.target.value)}
              aria-label="选择交易"
            >
              {s.transactions.length === 0 && <option value="">无可访问的交易</option>}
              {s.transactions.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
            {canWrite && (
              <Button variant="primary" onClick={() => setCreating(true)}>
                <Plus className="h-4 w-4" />
                创建节点
              </Button>
            )}
          </>
        }
      />

      {!tx ? (
        <Card>
          <EmptyState title="当前账号没有可访问的交易" />
        </Card>
      ) : (
        <>
          {totalPay > 0 && (
            <Card className="mb-4 p-4">
              <div className="mb-1.5 flex justify-between text-xs text-ink-500">
                <span>付款进度</span>
                <span>
                  {formatMoney(paid)} / {formatMoney(totalPay)}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full bg-brand-500 transition-all"
                  style={{ width: `${Math.round((paid / totalPay) * 100)}%` }}
                />
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="履约时间线" />
            {list.length === 0 ? (
              <EmptyState
                title="还没有履约节点"
                hint={canWrite ? '合同确认后，创建付款、交付与验收节点' : undefined}
              />
            ) : (
              <ol className="px-5 py-4">
                {list.map((m, i) => {
                  const d = daysUntil(m.dueDate)
                  return (
                    <li key={m.id} className="relative flex gap-4 pb-6 last:pb-0">
                      {i < list.length - 1 && (
                        <span className="absolute left-[9px] top-6 h-full w-px bg-slate-200" />
                      )}
                      <span className="relative z-10 mt-0.5 bg-white">{ICON[m.status]}</span>
                      <div className="min-w-0 flex-1 rounded-lg border border-slate-200 p-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium">{m.name}</p>
                            <p className="text-xs text-ink-500">
                              责任方：{orgOf(s, m.responsibleOrgId)?.shortName} · 计划 {m.dueDate}
                              {m.status !== 'completed' && (
                                <span
                                  className={cn(
                                    'ml-2',
                                    d < 0 ? 'text-rose-600' : d <= 7 ? 'text-amber-600' : ''
                                  )}
                                >
                                  {d < 0
                                    ? `已逾期 ${-d} 天`
                                    : d === 0
                                      ? '今天到期'
                                      : `${d} 天后到期`}
                                </span>
                              )}
                            </p>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <MilestoneStatusBadge status={m.status} />
                            {m.paymentAmount > 0 && (
                              <span className="text-sm font-medium">
                                {formatMoney(m.paymentAmount)}
                              </span>
                            )}
                          </div>
                        </div>
                        {m.note && <p className="mt-1.5 text-sm text-ink-700">{m.note}</p>}
                        {canWrite && (
                          <div className="mt-2 flex items-center gap-2">
                            <Select
                              className="w-32"
                              value={m.status}
                              onChange={(e) =>
                                void act(
                                  'updateMilestone',
                                  [m.id, { status: e.target.value }],
                                  '节点状态已更新'
                                )
                              }
                              aria-label={`更新「${m.name}」状态`}
                            >
                              {(Object.keys(MILESTONE_STATUS_LABEL) as MilestoneStatus[]).map(
                                (k) => (
                                  <option key={k} value={k}>
                                    {MILESTONE_STATUS_LABEL[k]}
                                  </option>
                                )
                              )}
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
        </>
      )}
      {creating && tx && (
        <NewMilestoneDialog transactionId={tx.id} onClose={() => setCreating(false)} />
      )}
    </div>
  )
}
