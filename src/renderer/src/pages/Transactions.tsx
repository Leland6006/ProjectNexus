import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL, type TransactionStatus } from '@shared/types'
import { Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Textarea } from '@/components/ui'
import { TransactionStatusBadge } from '@/components/badges'
import { formatMoney } from '@/lib/utils'
import { accessFor, currentUser, orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

const TYPES = ['设备采购', '技术服务', '保密协议', '销售合作', '其他']

function NewTransactionDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const counterparties = s.organizations.filter((o) => o.kind === 'company' && o.id !== me.orgId)
  const [form, setForm] = useState({ name: '', type: TYPES[0], counterpartyOrgId: counterparties[0]?.id ?? '', amount: '', expectedSignDate: '', description: '' })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (): Promise<void> => {
    const before = new Set(s.transactions.map((t) => t.id))
    const ok = await act('createTransaction', [{ ...form, amount: Number(form.amount || 0) }], '交易项目已创建')
    if (!ok) return
    onClose()
    const created = useApp.getState().state?.transactions.find((t) => !before.has(t.id))
    if (created) navigate({ page: 'transactions', transactionId: created.id })
  }

  return (
    <Dialog open={open} onClose={onClose} title="创建交易项目">
      <div className="space-y-3">
        <Field label="交易名称">
          <Input value={form.name} onChange={set('name')} placeholder="例如：智能设备采购项目" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="交易类型">
            <Select value={form.type} onChange={set('type')}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="发起企业">
            <Input value={orgOf(s, me.orgId)?.name ?? ''} disabled />
          </Field>
        </div>
        <Field label="交易对方">
          <Select value={form.counterpartyOrgId} onChange={set('counterpartyOrgId')}>
            {counterparties.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="交易金额（人民币，元）">
            <Input type="number" min={0} value={form.amount} onChange={set('amount')} placeholder="0" />
          </Field>
          <Field label="预计签约时间">
            <Input type="date" value={form.expectedSignDate} onChange={set('expectedSignDate')} />
          </Field>
        </div>
        <Field label="项目说明">
          <Textarea value={form.description} onChange={set('description')} placeholder="简要描述交易背景与目标" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            创建
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export default function Transactions() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | TransactionStatus>('all')
  const [role, setRole] = useState<'all' | 'initiated' | 'received'>('all')
  const [open, setOpen] = useState(false)

  const rows = useMemo(
    () =>
      s.transactions
        .filter((t) => (status === 'all' ? true : t.status === status))
        .filter((t) => (role === 'all' ? true : role === 'initiated' ? t.initiatorOrgId === accessFor(s, t).orgId : t.initiatorOrgId !== accessFor(s, t).orgId))
        .filter((t) => {
          const needle = q.trim().toLowerCase()
          if (!needle) return true
          const names = `${orgOf(s, t.initiatorOrgId)?.name} ${orgOf(s, t.counterpartyOrgId)?.name}`
          return `${t.name} ${t.type} ${names}`.toLowerCase().includes(needle)
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [s, q, status, role]
  )

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="交易项目"
        subtitle="交易项目是协作的基础单位，合同、沟通与履约都围绕它展开"
        actions={
          me.role !== 'external_counsel' && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              创建交易项目
            </Button>
          )
        }
      />

      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-400" />
          <Input className="pl-8" placeholder="搜索交易名称、企业、类型" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索交易" />
        </div>
        <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="按状态筛选">
          <option value="all">全部状态</option>
          {(Object.keys(TRANSACTION_STATUS_LABEL) as TransactionStatus[]).map((k) => (
            <option key={k} value={k}>
              {TRANSACTION_STATUS_LABEL[k]}
            </option>
          ))}
        </Select>
        <Select className="w-36" value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="按角色筛选">
          <option value="all">全部角色</option>
          <option value="initiated">我方发起</option>
          <option value="received">对方发起</option>
        </Select>
        <span className="ml-auto text-xs text-ink-500">共 {rows.length} 项</span>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="没有符合条件的交易项目" hint={s.transactions.length === 0 ? '你当前的账号没有可访问的交易' : '试试调整搜索词或筛选条件'} />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">交易名称</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">发起企业</th>
                <th className="px-4 py-2.5 font-medium">交易对方</th>
                <th className="px-4 py-2.5 font-medium">金额</th>
                <th className="px-4 py-2.5 font-medium">预计签约</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => navigate({ page: 'transactions', transactionId: t.id })} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-4 py-3 font-medium">{t.name}</td>
                  <td className="px-4 py-3 text-ink-700">{t.type}</td>
                  <td className="px-4 py-3 text-ink-700">{orgOf(s, t.initiatorOrgId)?.shortName}</td>
                  <td className="px-4 py-3 text-ink-700">{orgOf(s, t.counterpartyOrgId)?.shortName}</td>
                  <td className="px-4 py-3 text-ink-700">{formatMoney(t.amount)}</td>
                  <td className="px-4 py-3 text-ink-700">{t.expectedSignDate}</td>
                  <td className="px-4 py-3">
                    <TransactionStatusBadge status={t.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {open && <NewTransactionDialog open={open} onClose={() => setOpen(false)} />}
    </div>
  )
}
