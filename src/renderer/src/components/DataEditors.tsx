import { businessDate } from '@shared/ledger'
import { useState } from 'react'
import type { CashAccount, CompanyProfile, Contract, CostItem } from '@shared/types'
import { Button, Dialog, Field, Input, Select, Textarea } from './ui'
import { useApp, useView } from '@/store'
import { currentUser } from '@/lib/selectors'

type Entry = { key: string; label: string; type?: 'text' | 'date' | 'number' | 'textarea'; optional?: boolean; options?: { value: string; label: string }[] }
export function DataEditor({ label, title, fields, initial, save, note }: { label: string; title: string; fields: Entry[]; initial: Record<string, string>; save: (values: Record<string, string>) => Promise<boolean>; note?: string }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState(initial)
  const [preview, setPreview] = useState(false)
  const busy = useApp((x) => x.busy)
  const close = () => { if (JSON.stringify(values) !== JSON.stringify(initial) && !window.confirm('放弃尚未保存的修改？')) return; setOpen(false) }
  return <>
    <Button size="sm" onClick={() => { setValues(initial); setPreview(false); setOpen(true) }}>{label}</Button>
    <Dialog open={open} onClose={close} title={title}>
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setPreview(true) }}>
        {note && <p className="text-xs leading-5 text-amber-800">{note}</p>}
        {preview ? <><p className="text-sm font-medium">请核对本次修改，确认后才写入企业数据。</p><dl className="space-y-2 text-sm">{fields.map((f) => <div key={f.key}><dt className="text-ink-500">{f.label}</dt><dd className="whitespace-pre-wrap">{f.options?.find((o) => o.value === values[f.key])?.label ?? (values[f.key] || '未填写')}</dd></div>)}</dl></> : fields.map((f) => <Field key={f.key} label={f.label}>
          {f.options ? <Select required={!f.optional} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}>{f.optional && !f.options.some((o) => o.value === '') && <option value="">未填写</option>}{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</Select>
            : f.type === 'textarea' ? <Textarea maxLength={2000} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
              : <Input required={!f.optional} type={f.type ?? 'text'} min={f.key === 'teamSize' ? 1 : 0} step={f.key === 'teamSize' ? 1 : '0.01'} maxLength={100} value={values[f.key] ?? ''} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />}
        </Field>)}
        <div className="flex justify-end gap-2">{preview ? <><Button type="button" onClick={() => setPreview(false)}>返回修改</Button><Button type="button" variant="primary" loading={busy} onClick={async () => { if (await save(values)) setOpen(false) }}>确认保存</Button></> : <Button type="submit" variant="primary">预览修改</Button>}</div>
      </form>
    </Dialog>
  </>
}
const today = businessDate
export function ProfileEditor({ profile }: { profile?: CompanyProfile | null }) {
  const act = useApp((x) => x.act)
  const fields: Entry[] = [{ key: 'industry', label: '所属行业' }, { key: 'business', label: '主营业务', type: 'textarea' }, { key: 'goal', label: '经营目标', type: 'textarea' }, { key: 'stage', label: '经营阶段' }, { key: 'teamSize', label: '团队规模', type: 'number' }, { key: 'region', label: '注册地区' }].map((f) => ({ ...f, optional: true })) as Entry[]
  return <DataEditor label="编辑经营信息" title="公司经营资料" fields={fields} initial={Object.fromEntries(fields.map((f) => [f.key, String(profile?.[f.key as keyof CompanyProfile] ?? '')]))} save={(v) => act('updateCompanyProfile', [{ ...v, teamSize: v.teamSize ? Number(v.teamSize) : null }], '公司资料已更新')} />
}
export function CashEditor({ account }: { account?: CashAccount }) {
  const act = useApp((x) => x.act)
  return <DataEditor label={account ? '更新余额' : '添加账户'} title="现金账户快照" fields={[{ key: 'label', label: '账户名称' }, { key: 'openingBalance', label: '截至该日可动用余额（元）', type: 'number' }, { key: 'asOf', label: '余额日期', type: 'date' }]} initial={{ label: account?.label ?? '', openingBalance: String(account?.openingBalance ?? ''), asOf: account?.asOf ?? today() }} save={(v) => act('saveCashAccount', [{ ...v, id: account?.id, openingBalance: Number(v.openingBalance) }], '账户余额已保存')} note="这是人工核对的余额快照。按当日日终余额记录，含当日及以前收支；后续实际记录会参与推算，更新快照后不再重复加减历史。" />
}
export function CostEditor({ cost, transactionId }: { cost?: CostItem; transactionId?: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const me = currentUser(s)
  const navigate = useApp((x) => x.navigate)
  const projects = s.transactions.filter((t) => [t.initiatorOrgId, t.counterpartyOrgId].includes(me.orgId))
  if (!projects.length || me.role === 'external_counsel') return null
  if (cost && s.cashPlans.some((p) => p.costItemId === cost.id && p.status === 'active')) return <Button size="sm" onClick={() => navigate({ module: 'finance', view: 'receivables' })}>管理关联收付计划</Button>
  return <DataEditor label={cost ? '编辑' : '添加成本'} title="项目成本" fields={[{ key: 'transactionId', label: '所属业务', options: projects.map((t) => ({ value: t.id, label: t.name })) }, { key: 'name', label: '成本名称' }, { key: 'amount', label: '金额（元）', type: 'number' }, { key: 'dueDate', label: '预计支付日／实际支付日', type: 'date' }, { key: 'status', label: '状态', options: [{ value: 'planned', label: '计划' }, { value: 'committed', label: '已承诺' }, { value: 'paid', label: '已支付' }] }]} initial={{ transactionId: cost?.transactionId ?? transactionId ?? projects[0].id, name: cost?.name ?? '', amount: String(cost?.amount ?? ''), dueDate: cost?.dueDate ?? today(), status: cost?.status ?? 'planned' }} save={(v) => act('saveCostItem', [{ ...v, id: cost?.id, amount: Number(v.amount) }], '成本已保存')} note="仅本企业可见。已支付成本不再作为未来支出扣除。修改基础数据后，旧待决策方案需要重新分析。" />
}

export function PaymentEditor({ contract }: { contract: Contract }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const tx = s.transactions.find((t) => t.id === contract.transactionId)!
  const [open, setOpen] = useState(false)
  const [preview, setPreview] = useState(false)
  const [rate, setRate] = useState('')
  const [days, setDays] = useState('')
  const [date, setDate] = useState('')
  const [payer, setPayer] = useState('')
  const [instalments, setInstalments] = useState(contract.paymentTerms?.instalments ?? [])
  const me = currentUser(s)
  if (tx.initiatorOrgId !== me.orgId || me.role === 'external_counsel' || contract.status === 'finalized') return null
  const close = () => { if (window.confirm('关闭付款安排编辑？未保存的修改将丢弃。')) setOpen(false) }
  return <><Button size="sm" onClick={() => { setRate(String((contract.paymentTerms?.prepayRate ?? 0) * 100)); setDays(String(contract.paymentTerms?.settlementDays ?? 15)); setDate(contract.paymentTerms?.acceptanceDate ?? ''); setPayer(contract.paymentTerms?.payerOrgId ?? ''); setInstalments(structuredClone(contract.paymentTerms?.instalments ?? [])); setPreview(false); setOpen(true) }}>编辑付款安排</Button>
    <Dialog open={open} onClose={close} title="结构化付款安排"><form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setPreview(true) }}>
      <p className="text-xs leading-5 text-amber-800">核对合同正文后保存。此表不会自动修改正文；保存会创建付款条款版本、清除最终版确认并重新分析。</p>
      {preview ? <div className="space-y-2 text-sm"><p>付款方：{s.organizations.find((o) => o.id === payer)?.name}</p><p>预付 {rate}%；预计验收 {date}；验收后 {days} 日结清尾款。</p>{instalments.map((i) => <p key={i.id}>{i.label}：{Math.round(i.rate * 10000) / 100}%，{i.dueDate}</p>)}<p>请确认上述安排与合同正文一致。</p></div> : <>
        <Field label="付款方"><Select required value={payer} onChange={(e) => setPayer(e.target.value)}><option value="">请选择</option>{[tx.initiatorOrgId, tx.counterpartyOrgId].map((id) => <option key={id} value={id}>{s.organizations.find((o) => o.id === id)?.name}</option>)}</Select></Field>
        <Field label="预付款比例（%）"><Input required type="number" min="0" max="100" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} /></Field>
        <Field label="预计验收日"><Input required type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="验收后尾款账期（天）"><Input required type="number" min="0" max="365" step="1" value={days} onChange={(e) => setDays(e.target.value)} /></Field>
        {instalments.map((i, n) => <div key={i.id} className="space-y-2 rounded border p-2"><Field label={`分期 ${n + 1} 名称`}><Input required value={i.label} onChange={(e) => setInstalments(instalments.map((x) => x.id === i.id ? { ...x, label: e.target.value } : x))} /></Field><Field label="比例（%）"><Input required type="number" min="0" max="100" step="0.01" value={Math.round(i.rate * 10000) / 100} onChange={(e) => setInstalments(instalments.map((x) => x.id === i.id ? { ...x, rate: Number(e.target.value) / 100 } : x))} /></Field><Field label="支付日"><Input required type="date" value={i.dueDate} onChange={(e) => setInstalments(instalments.map((x) => x.id === i.id ? { ...x, dueDate: e.target.value } : x))} /></Field><Button type="button" onClick={() => setInstalments(instalments.filter((x) => x.id !== i.id))}>移除这笔分期</Button></div>)}
        {instalments.length < 24 && <Button type="button" onClick={() => setInstalments([...instalments, { id: crypto.randomUUID(), label: '', rate: 0, dueDate: date }])}>添加分期</Button>}
      </>}
      <div className="flex justify-end gap-2">{preview ? <><Button type="button" onClick={() => setPreview(false)}>返回修改</Button><Button type="button" variant="primary" loading={busy} onClick={async () => { if (await act('updatePaymentTerms', [contract.id, { prepayRate: Number(rate) / 100, settlementDays: Number(days), payerOrgId: payer, acceptanceDate: date, instalments }], '付款安排已保存')) setOpen(false) }}>确认与正文一致并保存</Button></> : <Button type="submit" variant="primary">预览修改</Button>}</div>
    </form></Dialog>
  </>
}
