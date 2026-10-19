import type { CostStatus, Transaction } from '@shared/types'
import { Badge, Card, CardHeader, EmptyState } from '@/components/ui'
import { MilestoneStatusBadge } from '@/components/badges'
import { SourceLine } from '@/components/StatusNote'
import { accessFor, orgOf } from '@/lib/selectors'
import { useView } from '@/store'

const COST_STATUS: Record<CostStatus, { label: string; tone: 'gray' | 'amber' | 'green' }> = {
  planned: { label: '计划', tone: 'gray' },
  committed: { label: '已承诺', tone: 'amber' },
  paid: { label: '已支付', tone: 'green' }
}

function yuan(n: number): string {
  return `¥${n.toLocaleString('zh-CN')}`
}

/** Payment plan and costs of one business. Everything here is a plan unless it says otherwise. */
export default function ProjectMoney({ tx }: { tx: Transaction }) {
  const s = useView()
  const myOrg = accessFor(s, tx).orgId
  const payments = s.milestones.filter((m) => m.transactionId === tx.id && m.paymentAmount > 0).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  const costs = s.costItems.filter((c) => c.transactionId === tx.id).sort((a, b) => a.dueDate.localeCompare(b.dueDate))

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="付款安排" subtitle={`合同金额 ${tx.amount > 0 ? yuan(tx.amount) : '未填写'}（交易约定，不是收入或余额）`} />
        {payments.length === 0 ? (
          <EmptyState title="还没有付款节点" hint="在「履约」中创建带付款金额的节点后，会显示在这里" />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-ink-500">
              <tr>
                <th className="px-4 py-2 font-medium">节点</th>
                <th className="px-4 py-2 font-medium">方向</th>
                <th className="px-4 py-2 font-medium">计划金额</th>
                <th className="px-4 py-2 font-medium">计划日期</th>
                <th className="px-4 py-2 font-medium">节点状态</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((m) => (
                <tr key={m.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 font-medium">{m.name}</td>
                  <td className="px-4 py-2.5 text-ink-700">{m.responsibleOrgId === myOrg ? '我方支付' : `${orgOf(s, m.responsibleOrgId)?.shortName ?? '对方'}支付`}</td>
                  <td className="px-4 py-2.5 tabular-nums">{yuan(m.paymentAmount)}</td>
                  <td className="px-4 py-2.5 text-ink-700">{m.dueDate}</td>
                  <td className="px-4 py-2.5">
                    <MilestoneStatusBadge status={m.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader title="成本" subtitle="仅显示你有权查看的成本" />
        {costs.length === 0 ? (
          <p className="px-4 py-4 text-xs text-ink-500">没有可见的成本记录</p>
        ) : (
          <ul>
            {costs.map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 first:border-t-0">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{c.name}</p>
                  <p className="text-xs text-ink-400">计划日期 {c.dueDate}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={COST_STATUS[c.status].tone}>{COST_STATUS[c.status].label}</Badge>
                  <span className="text-sm tabular-nums">{yuan(c.amount)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <SourceLine>以上都是合同约定或计划数据。节点标记完成不代表已核对到账；实际收支记录尚未启用。</SourceLine>
    </div>
  )
}
