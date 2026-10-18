import { AlertCircle, CalendarClock, FileClock, Handshake, MessageSquareReply } from 'lucide-react'
import { Badge, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui'
import { ContractStatusBadge, MilestoneStatusBadge, TransactionStatusBadge } from '@/components/badges'
import { daysUntil, formatDateTime, formatMoney, cn } from '@/lib/utils'
import { accessFor, currentUser, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

function StatCard({ icon, label, value, hint, onClick }: { icon: React.ReactNode; label: string; value: number | string; hint: string; onClick?: () => void }) {
  return (
    <button onClick={onClick} className="rounded-lg border border-slate-200 bg-white p-4 text-left shadow-card transition hover:border-brand-200 hover:shadow-md">
      <div className="mb-2 flex items-center gap-2 text-xs text-ink-500">
        <span className="text-brand-600">{icon}</span>
        {label}
      </div>
      <div className="text-2xl font-semibold tracking-tight">{value}</div>
      <div className="mt-1 text-xs text-ink-500">{hint}</div>
    </button>
  )
}

export default function Dashboard() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)

  const active = s.transactions.filter((t) => ['negotiating', 'pending_signature', 'in_performance'].includes(t.status))
  const pendingContracts = s.contracts.filter((c) => c.status !== 'finalized')

  // Suggestions waiting for MY organisation to respond to.
  const waitingForMe = s.suggestions.filter((sg) => {
    if (sg.status !== 'pending') return false
    const contract = s.contracts.find((c) => c.id === sg.contractId)
    const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)
    if (!tx) return false
    const a = accessFor(s, tx)
    return a.isParty && a.orgId !== sg.orgId
  })
  const waitingOnOthers = s.suggestions.filter((sg) => {
    if (sg.status !== 'pending') return false
    const contract = s.contracts.find((c) => c.id === sg.contractId)
    const tx = contract && s.transactions.find((t) => t.id === contract.transactionId)
    return !!tx && accessFor(s, tx).orgId === sg.orgId
  })

  const upcoming = s.milestones
    .filter((m) => m.status !== 'completed')
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 5)

  const activities = [...s.activities].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8)

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title={`你好，${me.name}`} subtitle={`${orgOf(s, me.orgId)?.name} · 以下是你有权查看的交易概览`} />

      <div className="grid grid-cols-4 gap-4">
        <StatCard icon={<Handshake className="h-4 w-4" />} label="进行中的交易" value={active.length} hint="协商 / 待签署 / 履行中" onClick={() => navigate({ page: 'transactions' })} />
        <StatCard icon={<FileClock className="h-4 w-4" />} label="待处理合同" value={pendingContracts.length} hint="尚未确认最终版本" onClick={() => navigate({ page: 'contracts' })} />
        <StatCard icon={<MessageSquareReply className="h-4 w-4" />} label="等待我方回复" value={waitingForMe.length} hint={`另有 ${waitingOnOthers.length} 条等待对方回复`} onClick={() => navigate({ page: 'collaboration' })} />
        <StatCard icon={<CalendarClock className="h-4 w-4" />} label="未完成履约节点" value={s.milestones.filter((m) => m.status !== 'completed').length} hint="按计划日期排序" onClick={() => navigate({ page: 'performance' })} />
      </div>

      <div className="mt-5 grid grid-cols-5 gap-4">
        <Card className="col-span-3">
          <CardHeader title="进行中的交易" />
          {active.length === 0 ? (
            <EmptyState icon={<Handshake className="h-8 w-8" />} title="暂无进行中的交易" hint="在「交易项目」中创建一个新交易开始协作" />
          ) : (
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-ink-500">
                <tr>
                  <th className="px-4 py-2 font-medium">交易</th>
                  <th className="px-4 py-2 font-medium">对方</th>
                  <th className="px-4 py-2 font-medium">金额</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                </tr>
              </thead>
              <tbody>
                {active.map((t) => {
                  const a = accessFor(s, t)
                  const other = a.orgId === t.initiatorOrgId ? t.counterpartyOrgId : t.initiatorOrgId
                  return (
                    <tr key={t.id} onClick={() => navigate({ page: 'transactions', transactionId: t.id })} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-4 py-2.5 font-medium">{t.name}</td>
                      <td className="px-4 py-2.5 text-ink-700">{orgOf(s, other)?.shortName}</td>
                      <td className="px-4 py-2.5 text-ink-700">{formatMoney(t.amount)}</td>
                      <td className="px-4 py-2.5">
                        <TransactionStatusBadge status={t.status} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="col-span-2">
          <CardHeader title="即将到期的履约节点" />
          {upcoming.length === 0 ? (
            <EmptyState title="暂无待办节点" />
          ) : (
            <ul>
              {upcoming.map((m) => {
                const d = daysUntil(m.dueDate)
                return (
                  <li key={m.id} className="flex items-start justify-between gap-3 border-t border-slate-100 px-4 py-2.5 first:border-t-0">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{m.name}</p>
                      <p className="text-xs text-ink-500">
                        {orgOf(s, m.responsibleOrgId)?.shortName} · {m.dueDate}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <MilestoneStatusBadge status={m.status} />
                      <span className={cn('text-xs', d < 0 ? 'text-rose-600' : d <= 7 ? 'text-amber-600' : 'text-ink-500')}>{d < 0 ? `已逾期 ${-d} 天` : d === 0 ? '今天到期' : `${d} 天后`}</span>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card className="col-span-3">
          <CardHeader title="待处理合同" />
          {pendingContracts.length === 0 ? (
            <EmptyState title="没有待处理的合同" />
          ) : (
            <ul>
              {pendingContracts.map((c) => (
                <li key={c.id} onClick={() => navigate({ page: 'contracts', contractId: c.id })} className="flex cursor-pointer items-center justify-between border-t border-slate-100 px-4 py-2.5 first:border-t-0 hover:bg-slate-50">
                  <div>
                    <p className="font-medium">{c.title}</p>
                    <p className="text-xs text-ink-500">更新于 {formatDateTime(c.updatedAt)}</p>
                  </div>
                  <ContractStatusBadge status={c.status} />
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="col-span-2">
          <CardHeader title="等待回复的协商" />
          {waitingForMe.length + waitingOnOthers.length === 0 ? (
            <EmptyState title="没有等待回复的协商" />
          ) : (
            <ul>
              {[...waitingForMe.map((x) => ({ x, mine: false })), ...waitingOnOthers.map((x) => ({ x, mine: true }))].map(({ x, mine }) => {
                const contract = s.contracts.find((c) => c.id === x.contractId)!
                const clause = contract.clauses.find((c) => c.id === x.clauseId)
                return (
                  <li key={x.id} onClick={() => navigate({ page: 'contracts', contractId: contract.id })} className="cursor-pointer border-t border-slate-100 px-4 py-2.5 first:border-t-0 hover:bg-slate-50">
                    <div className="flex items-center gap-2">
                      <AlertCircle className={cn('h-3.5 w-3.5', mine ? 'text-ink-400' : 'text-amber-600')} />
                      <span className="truncate font-medium">{clause?.title}</span>
                      <Badge tone={mine ? 'gray' : 'amber'}>{mine ? '等待对方' : '需要我方处理'}</Badge>
                    </div>
                    <p className="mt-0.5 truncate pl-5 text-xs text-ink-500">{x.reason}</p>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card className="col-span-5">
          <CardHeader title="近期活动" />
          {activities.length === 0 ? (
            <EmptyState title="暂无活动" />
          ) : (
            <ul className="px-4 py-2">
              {activities.map((a) => (
                <li key={a.id} className="flex items-start gap-3 py-1.5">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-brand-500" />
                  <span className="flex-1 text-ink-700">{a.summary}</span>
                  <span className="shrink-0 text-xs text-ink-400">{formatDateTime(a.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}
