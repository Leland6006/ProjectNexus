import { useState } from 'react'
import type { CashPlan, CostItem, InvoiceCase } from '@shared/types'
import { businessDate, remainingAmount } from '@shared/ledger'
import { currentUser } from '@/lib/selectors'
import { useApp, useView } from '@/store'
import { DataEditor } from './DataEditors'
import { Button, Dialog, Field, Input, Select, Textarea } from './ui'

export function PlanEditor({ plan: suppliedPlan, cost, transactionId }: { plan?: CashPlan; cost?: CostItem; transactionId?: string }) {
  const s = useView(), act = useApp((x) => x.act), me = currentUser(s)
  const plan = suppliedPlan ?? (cost ? s.cashPlans.find((p) => p.costItemId === cost.id) : undefined)
  if (me.role === 'external_counsel') return null
  return <DataEditor label={plan?.status === 'cancelled' ? '重新启用计划' : plan ? '编辑计划' : cost ? '建立待付计划' : '新增收付计划'} title="人工核对收付计划" note="计划只表示尚待收付，不改变账户余额。合同与节点不会自动计入，请只录一遍。关联成本若已有核销，请重新启用原计划以保留结果，不要重录全部金额。"
    fields={[{ key: 'title', label: '计划名称' }, { key: 'transactionId', label: '关联业务', optional: true, options: [{ value: '', label: '公司日常事务（无关联业务）' }, ...s.transactions.map((t) => ({ value: t.id, label: t.name }))] }, { key: 'direction', label: '方向', options: [{ value: 'in', label: '应收' }, { value: 'out', label: '应付' }] }, { key: 'amount', label: '计划总金额（元，包含已核销部分）', type: 'number' }, { key: 'dueDate', label: '约定或预计日期', type: 'date' }]}
    initial={{ title: plan?.title ?? cost?.name ?? '', transactionId: plan?.transactionId ?? cost?.transactionId ?? transactionId ?? '', direction: plan?.direction ?? 'out', amount: String(plan?.amount ?? cost?.amount ?? ''), dueDate: plan?.dueDate ?? cost?.dueDate ?? businessDate() }}
    save={(v) => act('saveCashPlan', [{ ...v, amount: Number(v.amount), transactionId: v.transactionId || null, costItemId: plan?.costItemId ?? cost?.id ?? null, id: plan?.id, revision: plan?.revision }], '收付计划已核对保存')} />
}

export function EntryEditor({ plan }: { plan?: CashPlan }) {
  const s = useView(), act = useApp((x) => x.act), busy = useApp((x) => x.busy)
  const [open, setOpen] = useState(false), [preview, setPreview] = useState(false)
  const initial = () => ({ requestId: crypto.randomUUID(), accountId: s.cashAccounts[0]?.id ?? '', planId: plan?.id ?? '', transactionId: plan?.transactionId ?? '', direction: plan?.direction ?? 'in', amount: plan ? String(remainingAmount(plan, s.cashEntries)) : '', date: businessDate(), note: plan?.title ?? '', evidence: '' })
  const [form, setForm] = useState(initial)
  if (currentUser(s).role === 'external_counsel') return null
  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => { setForm({ ...form, [key]: e.target.value }); setPreview(false) }
  const selected = s.cashPlans.find((p) => p.id === form.planId)
  const account = s.cashAccounts.find((a) => a.id === form.accountId)
  return <><Button size="sm" disabled={!s.cashAccounts.length} title={!s.cashAccounts.length ? '请先添加现金账户' : undefined} onClick={() => { setForm(initial()); setPreview(false); setOpen(true) }}>{plan ? '记录实际收付 / 核销' : '录入实际收支'}</Button>
    <Dialog open={open} onClose={() => { if (window.confirm('关闭收支录入？尚未保存的信息将丢弃。')) setOpen(false) }} title="记录已发生的收支">
      <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); setPreview(true) }}>
        <p className="text-xs leading-5 text-ink-500">仅记录你已核对的实际收支，不会执行转账。关联计划后自动核销未结金额；收款不等于会计收入。</p>
        <Field label="核销计划"><Select value={form.planId} onChange={(e) => { const p = s.cashPlans.find((p) => p.id === e.target.value); setForm({ ...form, planId: p?.id ?? '', transactionId: p?.transactionId ?? '', direction: p?.direction ?? form.direction, amount: p ? String(remainingAmount(p, s.cashEntries)) : form.amount, note: p?.title ?? form.note }); setPreview(false) }}><option value="">不关联计划（不会减少任何应收应付）</option>{s.cashPlans.filter((p) => p.status === 'active' && remainingAmount(p, s.cashEntries) > 0).map((p) => <option key={p.id} value={p.id}>{p.direction === 'in' ? '应收' : '应付'} · {p.title} · 未结 ¥{remainingAmount(p, s.cashEntries)}</option>)}</Select></Field>
        <Field label="资金账户"><Select required value={form.accountId} onChange={set('accountId')}>{s.cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-3"><Field label="收支方向"><Select value={form.direction} disabled={!!selected} onChange={set('direction')}><option value="in">实际收款</option><option value="out">实际付款</option></Select></Field><Field label="金额（元）"><Input required type="number" min="0.01" step="0.01" value={form.amount} onChange={set('amount')} /></Field></div>
        <Field label="业务"><Select value={form.transactionId} disabled={!!selected} onChange={set('transactionId')}><option value="">无关联业务</option>{s.transactions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <Field label="实际发生日期"><Input required type="date" max={businessDate()} value={form.date} onChange={set('date')} /></Field>
        {account && form.date <= account.asOf && <p className="rounded bg-amber-50 p-2 text-xs text-amber-800">此记录在账户余额日（{account.asOf}）当日或之前，将视为已包含在日终余额中，仅用于历史记录与计划核销，不再加减余额。</p>}
        <Field label="收支说明"><Input required maxLength={500} value={form.note} onChange={set('note')} /></Field>
        <Field label="流水号 / 可区分的核对依据"><Textarea required maxLength={500} value={form.evidence} onChange={set('evidence')} placeholder="请根据实际流水核对，勿填写银行密码等敏感凭据" /></Field>
        {!preview ? <Button type="submit">核对录入内容</Button> : <div className="space-y-2 rounded border border-brand-200 bg-brand-50 p-3 text-sm"><p>将记录{form.direction === 'in' ? '收款' : '付款'} ¥{form.amount} · {form.date} · {account?.label}</p><p>{selected ? `核销「${selected.title}」，未结金额将相应减少。` : '未关联计划，已有应收应付保持原金额。'}</p><Button variant="primary" loading={busy} onClick={() => void (async () => { if (await act('recordCashEntry', [{ ...form, planId: form.planId || null, transactionId: form.transactionId || null, amount: Number(form.amount) }], '实际收支已记录（用户核对）')) setOpen(false) })()}>确认已核对并保存</Button></div>}
      </form>
    </Dialog>
  </>
}

export function InvoiceEditor({ item }: { item?: InvoiceCase }) {
  const s = useView(), act = useApp((x) => x.act), me = currentUser(s)
  if (!s.transactions.length || me.role === 'external_counsel') return null
  return <DataEditor label={item ? '编辑材料' : '新建发票事项'} title="准备开票材料" note="这里只整理材料，不判断税率、纳税义务或代为开票。请按真实业务和所用开票系统要求核对，涉及专业判断时向主管税务机关或专业人员确认。"
    fields={[{ key: 'transactionId', label: '业务', options: s.transactions.map((t) => ({ value: t.id, label: t.name })) }, { key: 'title', label: '事项名称' }, { key: 'buyerName', label: '购买方名称' }, { key: 'buyerTaxId', label: '购买方识别信息（不适用时注明原因）' }, { key: 'itemName', label: '商品或服务名称' }, { key: 'amount', label: '拟开票总金额（元）', type: 'number' }, { key: 'note', label: '其他材料 / 待核对事项', type: 'textarea', optional: true }]}
    initial={{ transactionId: item?.transactionId ?? s.transactions[0].id, title: item?.title ?? '', buyerName: item?.buyerName ?? '', buyerTaxId: item?.buyerTaxId ?? '', itemName: item?.itemName ?? '', amount: String(item?.amount ?? ''), note: item?.note ?? '' }} save={(v) => act('saveInvoiceCase', [{ ...v, amount: Number(v.amount), id: item?.id, revision: item?.revision }], '发票材料已保存，尚未开票')} />
}
