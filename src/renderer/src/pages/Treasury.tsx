import { useState } from 'react'
import { businessDate, companyFinance, remainingAmount } from '@shared/ledger'
import type { InvoiceCase } from '@shared/types'
import { CashEditor } from '@/components/DataEditors'
import { EntryEditor, InvoiceEditor, PlanEditor } from '@/components/FinanceEditors'
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Input, PageHeader, Textarea } from '@/components/ui'
import { currentUser, orgOf } from '@/lib/selectors'
import { projectRoute } from '@/routes'
import { useApp, useView } from '@/store'
const yuan = (n: number | null) => n === null ? '待补充' : `¥${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`

export function TreasuryOverview() {
  const s = useView(), navigate = useApp((x) => x.navigate), f = companyFinance(s), me = currentUser(s)
  return <div className="mx-auto max-w-5xl space-y-4 p-6">
    <PageHeader title="资金概览" subtitle={`${orgOf(s, me.orgId)?.name} · 用户核对的资金台账，不是银行余额`} actions={<CashEditor />} />
    <div className="grid grid-cols-3 gap-3">{[['按记录推算的当前余额', f.currentBalance], ['未结应收', f.receivables], ['未结应付', f.payables]].map(([label, value]) => <Card key={label as string} className="p-4"><p className="text-xs text-ink-500">{label}</p><p className="mt-2 text-xl font-semibold">{yuan(value as number | null)}</p></Card>)}</div>
    <Card><CardHeader title="现金账户" subtitle="日终余额快照 + 余额日之后的实际收支；不同日期的账户分别计算再汇总" />{f.balances.length ? f.balances.map((a) => <div key={a.id} className="flex items-center justify-between gap-3 border-t p-4 text-sm"><div><p className="font-medium">{a.label}</p><p className="mt-1 text-xs text-ink-500">{a.asOf} 日终快照 {yuan(a.openingBalance)} · 按记录推算 {f.available ? yuan(a.currentBalance) : '待核对'}</p></div><CashEditor account={a} /></div>) : <EmptyState title="尚未录入现金账户" hint="添加已核对的账户余额及日期后，可录入收支并生成条件预测。" />}</Card>
    <Card><CardHeader title="公司跨项目资金预测" subtitle="仅包含已核对收付计划，覆盖所有日期；不等于完整经营账" action={<Button onClick={() => navigate({ module: 'finance', view: 'receivables' })}>维护收付计划</Button>} />
      <div className="space-y-3 p-4 text-sm">{!f.available ? f.missing.map((m) => <p key={m}>{m}</p>) : <>
        <p>按计划收付的最大预计缺口：<strong>{yuan(f.shortfall)}</strong>；未来收款全部延迟时的支出压力：<strong>{yuan(f.withoutReceiptsShortfall)}</strong>。</p>
        {!f.timeline.length ? <p className="text-ink-500">尚无未结收付计划；零预测缺口不代表没有经营风险。</p> : <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>{['日期', '计划流入', '计划流出', '预计余额', '不含未来收款的余额'].map((h) => <th key={h} className="py-2 font-medium">{h}</th>)}</tr></thead><tbody>{f.timeline.map((p) => <tr key={p.date} className="border-t"><td className="py-2">{p.date}</td><td>{yuan(p.inflow)}</td><td>{yuan(p.outflow)}</td><td className={p.balance < 0 ? 'text-rose-700' : ''}>{yuan(p.balance)}</td><td>{yuan(p.withoutReceipts)}</td></tr>)}</tbody></table></div>}
      </>}
      {f.uncoveredCosts > 0 && <div className="rounded bg-amber-50 p-3 text-amber-900">还有 {f.uncoveredCosts} 项未付成本没有关联收付计划，尚未纳入本预测。<Button size="sm" onClick={() => navigate({ module: 'finance', view: 'costs' })}>去核对成本</Button></div>}
      <details><summary className="cursor-pointer text-ink-500">计算口径与覆盖范围</summary>{f.notes.map((n) => <p className="mt-2 text-xs leading-5 text-ink-500" key={n}>{n}</p>)}</details></div>
    </Card><div className="flex gap-2"><EntryEditor /><Button onClick={() => navigate({ module: 'finance', view: 'records' })}>查看实际收支</Button></div>
  </div>
}

export function CashPlansPage() {
  const s = useView(), act = useApp((x) => x.act), navigate = useApp((x) => x.navigate), [q, setQ] = useState('')
  const rows = s.cashPlans.filter((p) => `${p.title} ${s.transactions.find((t) => t.id === p.transactionId)?.name ?? ''}`.includes(q.trim())).sort((a, b) => a.dueDate.localeCompare(b.dueDate))
  return <div className="mx-auto max-w-5xl space-y-4 p-6"><PageHeader title="应收应付" subtitle="人工核对的收付计划；核销实际收支后，只对未结部分预测" actions={<PlanEditor />} /><Input aria-label="搜索收付计划" placeholder="搜索计划或业务" value={q} onChange={(e) => setQ(e.target.value)} />
    {!rows.length ? <Card><EmptyState title="尚无收付计划" hint="可手动添加，或到成本页将已核对的成本关联为待付计划。合同与履约节点不会自动计入。" /></Card> : rows.map((p) => { const left = remainingAmount(p, s.cashEntries); return <Card key={p.id} className="space-y-3 p-4"><div className="flex justify-between gap-3"><div><p className="font-medium">{p.title} <Badge tone={p.status === 'cancelled' ? 'gray' : left === 0 ? 'green' : 'amber'}>{p.status === 'cancelled' ? '已取消' : left === 0 ? '已结清' : p.direction === 'in' ? '待收' : '待付'}</Badge></p><p className="mt-1 text-xs text-ink-500">{p.dueDate}{p.dueDate < businessDate() && left > 0 && p.status === 'active' ? ' · 已逾期' : ''} · {p.direction === 'in' ? '应收' : '应付'} · 总额 {yuan(p.amount)} · 未结 {yuan(left)}{p.costItemId ? ' · 已关联成本，不重复叠加' : ''}</p></div>{p.transactionId && <Button onClick={() => navigate(projectRoute(p.transactionId!, 'money'))}>查看业务</Button>}</div>
      <div className="flex flex-wrap gap-2"><PlanEditor plan={p} />{p.status === 'active' && left > 0 && <EntryEditor plan={p} />}{p.status === 'active' && <Button onClick={() => { if (window.confirm('取消此计划的剩余收付安排？实际收支历史会保留。可通过编辑计划重新启用。')) void act('cancelCashPlan', [p.id, p.revision], '计划已取消') }}>取消计划</Button>}</div>
    </Card> })}
  </div>
}

export function CashRecordsPage() {
  const s = useView(), act = useApp((x) => x.act), busy = useApp((x) => x.busy), [q, setQ] = useState(''), [voidId, setVoidId] = useState<string | null>(null), [reason, setReason] = useState('')
  const rows = s.cashEntries.filter((e) => `${e.note} ${e.evidence}`.includes(q.trim())).slice().sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
  return <div className="mx-auto max-w-5xl space-y-4 p-6"><PageHeader title="收支记录" subtitle="用户按流水核对的实际收支；保留作废原因和历史，不执行银行转账" actions={<EntryEditor />} /><Input aria-label="搜索收支记录" placeholder="搜索说明、流水或核对依据" value={q} onChange={(e) => setQ(e.target.value)} />
    {!s.cashAccounts.length && <p className="text-sm text-amber-800">请先在资金概览添加账户，再录入实际收支。</p>}
    {!rows.length ? <Card><EmptyState title="还没有实际收支" hint="先核对账户流水，再录入收款或付款；关联计划可进行部分核销。" /></Card> : rows.map((e) => <Card key={e.id} className="space-y-2 p-4 text-sm"><div className="flex justify-between"><p className="font-medium">{e.note} <Badge tone={e.status === 'void' ? 'gray' : e.direction === 'in' ? 'green' : 'blue'}>{e.status === 'void' ? '已作废' : e.direction === 'in' ? '实际收款' : '实际付款'}</Badge></p><span className="font-semibold">{yuan(e.amount)}</span></div><p className="text-xs text-ink-500">{e.date} · {s.cashAccounts.find((a) => a.id === e.accountId)?.label} · {e.planId ? `核销：${s.cashPlans.find((p) => p.id === e.planId)?.title}` : '未关联计划，不自动减少应收应付'}</p><p className="break-words text-xs">核对依据：{e.evidence}</p>{e.voidReason && <p className="text-xs text-rose-700">作废原因：{e.voidReason} · {e.voidedAt}</p>}{e.status === 'posted' && <Button size="sm" onClick={() => { setVoidId(e.id); setReason('') }}>作废错误记录</Button>}</Card>)}
    <Dialog open={!!voidId} onClose={() => setVoidId(null)} title="作废收支记录"><div className="space-y-3"><p className="text-sm">作废后恢复相应计划未结额，保留原记录。如果发生在余额快照当日或以前，请重新核对账户日终余额；作废不会改写快照。</p><Field label="作废原因"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field><Button loading={busy} disabled={!reason.trim()} onClick={() => void (async () => { if (await act('voidCashEntry', [voidId, reason], '已作废，历史保留')) setVoidId(null) })()}>确认作废</Button></div></Dialog>
  </div>
}

function InvoiceCard({ item }: { item: InvoiceCase }) {
  const act = useApp((x) => x.act), busy = useApp((x) => x.busy), [result, setResult] = useState(''), [number, setNumber] = useState('')
  const steps = { materials: ['check', '我已逐项核对材料'], checked: ['submit', '记录我已自行提交办理'], submitted: ['record', '记录我收到的发票结果'], recorded: ['', ''] } as const
  const [command, label] = steps[item.stage]
  return <Card className="space-y-3 p-4 text-sm"><p className="font-medium">{item.title} <Badge tone={item.stage === 'recorded' ? 'green' : 'amber'}>{{ materials: '整理材料', checked: '已核对，待用户办理', submitted: '用户已提交，等待结果', recorded: '用户已记录结果（未验证）' }[item.stage]}</Badge></p>
    <ol className="grid grid-cols-4 gap-1 text-xs text-ink-500">{['1 整理材料', '2 人工核对', '3 用户自行办理', '4 记录结果'].map((s) => <li className="rounded bg-slate-50 p-2" key={s}>{s}</li>)}</ol>
    <p>{item.buyerName} · {item.itemName} · 拟开票 {yuan(item.amount)}</p><details><summary>查看材料</summary><p className="mt-2">购买方识别信息：{item.buyerTaxId}</p><p className="whitespace-pre-wrap">{item.note || '无其他材料'}</p></details>
    {item.stage === 'materials' && <InvoiceEditor item={item} />}
    {command && <div className="space-y-2"><p className="text-xs leading-5 text-ink-500">{item.stage === 'materials' ? '请对照真实合同和对方提供的信息核对名称、识别信息、商品/服务及金额，列出仍待确认的资料。' : item.stage === 'checked' ? '请在你实际使用的开票平台自行办理；这里不会替你提交或判断适用税率。' : '请核对你实际取得的发票，再填写号码和结果。系统未连接税务验证。'}</p><Textarea value={result} onChange={(e) => setResult(e.target.value)} placeholder="记录本步核对情况或实际办理结果" aria-label="本步发票记录" />{command === 'record' && <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="实际取得的发票号码" aria-label="发票号码" />}<Button variant="primary" loading={busy} disabled={!result.trim() || (command === 'record' && !number.trim())} onClick={() => void (async () => { if (await act('advanceInvoiceCase', [item.id, { revision: item.revision, command, result, invoiceNumber: number }], '本步用户记录已保存')) { setResult(''); setNumber('') } })()}>{label}</Button></div>}
    {item.stage !== 'materials' && <Button size="sm" onClick={() => { if (window.confirm('回到材料整理？原来的办理记录会保留在历史中。')) void act('advanceInvoiceCase', [item.id, { revision: item.revision, command: 'reopen', result: '用户选择重新核对材料' }], '已回到材料整理') }}>重新核对材料</Button>}
    <details><summary>办理历史（{item.history.length}）</summary>{item.history.map((h, i) => <p key={i} className="mt-2 whitespace-pre-wrap text-xs text-ink-500">{h.at} · {h.summary}</p>)}</details>
  </Card>
}
export function InvoicesPage() {
  const s = useView()
  return <div className="mx-auto max-w-4xl space-y-4 p-6"><PageHeader title="发票材料与办理记录" subtitle="整理、核对、用户自行办理、记录结果；不代开票或验证发票真伪" actions={<InvoiceEditor />} />{s.invoiceCases.length ? [...s.invoiceCases].reverse().map((i) => <InvoiceCard item={i} key={i.id} />) : <Card><EmptyState title="还没有发票事项" hint="从一笔业务开始整理材料，逐步记录核对和办理进度。" /></Card>}</div>
}
