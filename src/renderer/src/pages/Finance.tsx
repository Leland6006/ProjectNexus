import { TreasuryOverview, CashPlansPage, CashRecordsPage, InvoicesPage } from './Treasury'
import { PlanEditor } from '@/components/FinanceEditors'
import { CostEditor } from '@/components/DataEditors'
import type { CostStatus } from '@shared/types'
import { Badge, Card, EmptyState, PageHeader } from '@/components/ui'
import { VisibilityBadge } from '@/components/badges'
import { SourceLine } from '@/components/StatusNote'
import { currentUser } from '@/lib/selectors'
import { projectRoute, type FinanceView } from '@/routes'
import { useApp, useView } from '@/store'

const COST_STATUS: Record<CostStatus, { label: string; tone: 'gray' | 'amber' | 'green' }> = {
  planned: { label: '计划', tone: 'gray' },
  committed: { label: '已承诺', tone: 'amber' },
  paid: { label: '已支付', tone: 'green' }
}

function yuan(n: number): string {
  return `¥${n.toLocaleString('zh-CN')}`
}

function Costs() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const rows = s.costItems.filter((c) => c.orgId === me.orgId).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader title="成本" subtitle="为履行各笔业务预计或已经发生的支出" actions={<CostEditor />} />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="还没有成本记录" hint="点击添加成本，关联已有业务" />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">名称</th>
                <th className="px-4 py-2.5 font-medium">所属业务</th>
                <th className="px-4 py-2.5 font-medium">金额</th>
                <th className="px-4 py-2.5 font-medium">计划日期</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
                <th className="px-4 py-2.5 font-medium">可见范围</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 font-medium">{c.name} <CostEditor cost={c} /> {c.status !== 'paid' && !s.cashPlans.some((p) => p.costItemId === c.id && p.status === 'active') && <PlanEditor cost={c} />}</td>
                  <td className="px-4 py-2.5">
                    <button className="text-brand-700 hover:underline" onClick={() => navigate(projectRoute(c.transactionId, 'money'))}>
                      {s.transactions.find((t) => t.id === c.transactionId)?.name ?? '业务项目'}
                    </button>
                  </td>
                  <td className="px-4 py-2.5 tabular-nums">{yuan(c.amount)}</td>
                  <td className="px-4 py-2.5 text-ink-700">{c.dueDate}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={COST_STATUS[c.status].tone}>{COST_STATUS[c.status].label}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <VisibilityBadge visibility={c.visibility} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <div className="mt-2">
        <SourceLine>“计划”与“已承诺”都还没有付出；“已支付”为成本台账标注，不会自动改变账户余额。实际付款请在收支记录中录入；关联成本计划可核销。</SourceLine>
      </div>
    </div>
  )
}

export default function FinancePage({ view }: { view: FinanceView }) {
  if (view === 'overview') return <TreasuryOverview />
  if (view === 'costs') return <Costs />
  if (view === 'receivables') return <CashPlansPage />
  if (view === 'records') return <CashRecordsPage />
  return <InvoicesPage />
}
