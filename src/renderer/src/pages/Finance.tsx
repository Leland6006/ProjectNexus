import { Wallet } from 'lucide-react'
import type { CostStatus } from '@shared/types'
import { Badge, Button, Card, CardHeader, EmptyState, PageHeader } from '@/components/ui'
import { VisibilityBadge } from '@/components/badges'
import { NotEnabled, SourceLine } from '@/components/StatusNote'
import { currentUser, orgOf } from '@/lib/selectors'
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

function Overview() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const accounts = s.cashAccounts.filter((a) => a.orgId === me.orgId)
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="资金概览" subtitle={`${orgOf(s, me.orgId)?.name} · 只显示已录入的数据`} />
      <Card>
        <CardHeader title="现金账户" subtitle="人工录入的余额，不随合同或履约节点自动变化" />
        {accounts.length === 0 ? (
          <EmptyState icon={<Wallet className="h-7 w-7" />} title="尚未录入现金账户" hint="资金录入将在第二轮提供。在此之前，Nexus 不会推测你的账户余额。" />
        ) : (
          <ul>
            {accounts.map((a) => (
              <li key={a.id} className="flex items-center justify-between border-t border-slate-100 px-4 py-3 first:border-t-0">
                <div>
                  <p className="text-sm font-medium text-ink-900">{a.label}</p>
                  <p className="text-xs text-ink-400">余额日期 {a.asOf} · 期初余额（人工录入）</p>
                </div>
                <span className="text-lg font-semibold tabular-nums">{yuan(a.openingBalance)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mt-4">
        <CardHeader title="口径说明" />
        <ul className="list-disc space-y-1.5 py-3 pl-8 pr-4 text-sm text-ink-700">
          <li>合同金额是交易约定，不计入收入，也不计入账户余额。</li>
          <li>履约节点里的付款金额是计划；节点标记为“已完成”也不等于已经核对到账。</li>
          <li>还没有实际到账和付款记录，所以这里不显示“已收款”或公司整体现金流预测。</li>
          <li>单笔业务的现金流测算只在对应的 AI 建议中出现，不会相加成公司整体结论。</li>
        </ul>
      </Card>

      <div className="mt-4 flex gap-2">
        <Button onClick={() => navigate({ module: 'finance', view: 'costs' })}>查看成本</Button>
      </div>
    </div>
  )
}

function Costs() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const rows = s.costItems.filter((c) => c.orgId === me.orgId).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader title="成本" subtitle="为履行各笔业务预计或已经发生的支出" />
      <Card>
        {rows.length === 0 ? (
          <EmptyState title="还没有成本记录" hint="成本录入将在第二轮提供" />
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
                  <td className="px-4 py-2.5 font-medium">{c.name}</td>
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
        <SourceLine>“计划”与“已承诺”都还没有付出；只有“已支付”表示已经发生的支出。</SourceLine>
      </div>
    </div>
  )
}

const NOT_YET: Record<Exclude<FinanceView, 'overview' | 'costs'>, { title: string; detail: string }> = {
  receivables: {
    title: '应收应付',
    detail: '需要先有实际收付款记录，才能区分“合同约定应收”和“已经到账”。这项能力计划在第五轮提供。履约节点中的付款计划可以在各业务的「收付款」页查看。'
  },
  records: {
    title: '收支记录',
    detail: '还不能录入实际到账和付款。在此之前，Nexus 不会把合同金额或节点状态当作已发生的收支。'
  },
  invoices: {
    title: '发票',
    detail: '发票资料和开票引导流程尚未提供。具体开票步骤需要依据适用规则审核后再上线，Nexus 不会显示“开票完成”之类的结果。'
  }
}

export default function FinancePage({ view }: { view: FinanceView }) {
  if (view === 'overview') return <Overview />
  if (view === 'costs') return <Costs />
  const n = NOT_YET[view]
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title={n.title} />
      <NotEnabled title={n.title} detail={n.detail} />
    </div>
  )
}
