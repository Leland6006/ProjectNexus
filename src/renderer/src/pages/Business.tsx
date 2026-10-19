import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { TRANSACTION_STATUS_LABEL, type TransactionStatus } from '@shared/types'
import { Button, Card, Dialog, EmptyState, Field, Input, PageHeader, Select, Textarea } from '@/components/ui'
import { TransactionStatusBadge } from '@/components/badges'
import { NotEnabled } from '@/components/StatusNote'
import { formatMoney } from '@/lib/utils'
import { accessFor, currentUser, directory, orgOf, otherPartyId } from '@/lib/selectors'
import { projectRoute } from '@/routes'
import { useApp, useView } from '@/store'

const TYPES = ['设备采购', '技术服务', '保密协议', '销售合作', '其他']

function NewBusinessDialog({ onClose, defaultCounterpartyId }: { onClose: () => void; defaultCounterpartyId?: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const counterparties = directory(s).organizations.filter((o) => o.kind === 'company' && o.id !== me.orgId)
  const initialCp = counterparties.some((o) => o.id === defaultCounterpartyId) ? defaultCounterpartyId! : counterparties[0]?.id ?? ''
  const [form, setForm] = useState({ name: '', type: TYPES[0], counterpartyOrgId: initialCp, amount: '', expectedSignDate: '', description: '' })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (): Promise<void> => {
    const before = new Set(s.transactions.map((t) => t.id))
    const ok = await act('createTransaction', [{ ...form, amount: Number(form.amount || 0) }], '业务已创建')
    if (!ok) return
    onClose()
    const created = useApp.getState().state?.transactions.find((t) => !before.has(t.id))
    if (created) navigate(projectRoute(created.id))
  }

  return (
    <Dialog open onClose={onClose} title="新建业务">
      <div className="space-y-3">
        <Field label="业务名称">
          <Input value={form.name} onChange={set('name')} placeholder="例如：智能设备采购项目" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="业务类型">
            <Select value={form.type} onChange={set('type')}>
              {TYPES.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </Select>
          </Field>
          <Field label="我方（当前经营企业）">
            <Input value={orgOf(s, me.orgId)?.name ?? ''} disabled />
          </Field>
        </div>
        <Field label="交易对象" hint="本地演示中只能选择已有的演示企业。无需对方注册即可建立交易对象将在后续版本提供。">
          <Select value={form.counterpartyOrgId} onChange={set('counterpartyOrgId')}>
            {counterparties.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="合同金额（人民币，元）">
            <Input type="number" min={0} value={form.amount} onChange={set('amount')} placeholder="0" />
          </Field>
          <Field label="预计签约时间">
            <Input type="date" value={form.expectedSignDate} onChange={set('expectedSignDate')} />
          </Field>
        </div>
        <Field label="业务说明">
          <Textarea value={form.description} onChange={set('description')} placeholder="简要描述背景与目标" />
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

export function ArchivedBusiness() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="归档" />
      <NotEnabled
        title="业务归档"
        detail="还不能归档业务。已完成或已取消的业务目前仍显示在「全部业务」中，可以用状态筛选查看。归档会在后续版本与资料归档一起提供。"
      />
    </div>
  )
}

/** All businesses, or the businesses with one counterparty when `orgId` is set. */
export default function BusinessList({ orgId, create }: { orgId?: string; create?: boolean }) {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const me = currentUser(s)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | TransactionStatus>('all')
  const [role, setRole] = useState<'all' | 'initiated' | 'received'>('all')
  const [open, setOpen] = useState(false)
  const showDialog = open || !!create
  const counterpartyName = orgId ? orgOf(s, orgId)?.name ?? '交易对象' : null

  const close = (): void => {
    setOpen(false)
    if (create) navigate({ module: 'business', view: 'all' })
  }

  const rows = useMemo(
    () =>
      s.transactions
        .filter((t) => !orgId || otherPartyId(t, accessFor(s, t).orgId) === orgId)
        .filter((t) => (status === 'all' ? true : t.status === status))
        .filter((t) => {
          if (role === 'all') return true
          const mine = t.initiatorOrgId === accessFor(s, t).orgId
          return role === 'initiated' ? mine : !mine
        })
        .filter((t) => {
          const needle = q.trim().toLowerCase()
          if (!needle) return true
          const names = `${orgOf(s, t.initiatorOrgId)?.name} ${orgOf(s, t.counterpartyOrgId)?.name}`
          return `${t.name} ${t.type} ${names}`.toLowerCase().includes(needle)
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [s, q, status, role, orgId]
  )

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title={counterpartyName ?? '全部业务'}
        subtitle={
          counterpartyName
            ? '与该交易对象的全部业务。交易对象只是分组，每笔业务的合同、磋商和收付款各自独立。'
            : '每笔业务都有自己的合同、磋商、履约和收付款'
        }
        actions={
          me.role !== 'external_counsel' && (
            <Button variant="primary" onClick={() => setOpen(true)}>
              <Plus className="h-4 w-4" />
              新建业务
            </Button>
          )
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-400" />
          <Input className="pl-8" placeholder="搜索业务名称、企业、类型" value={q} onChange={(e) => setQ(e.target.value)} aria-label="搜索业务" />
        </div>
        <Select className="w-36" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label="按状态筛选">
          <option value="all">全部状态</option>
          {(Object.keys(TRANSACTION_STATUS_LABEL) as TransactionStatus[]).map((k) => (
            <option key={k} value={k}>
              {TRANSACTION_STATUS_LABEL[k]}
            </option>
          ))}
        </Select>
        <Select className="w-36" value={role} onChange={(e) => setRole(e.target.value as typeof role)} aria-label="按发起方筛选">
          <option value="all">全部发起方</option>
          <option value="initiated">我方发起</option>
          <option value="received">对方发起</option>
        </Select>
        <span className="ml-auto text-xs text-ink-500">共 {rows.length} 项</span>
      </div>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title="没有符合条件的业务" hint={s.transactions.length === 0 ? '当前账号没有可访问的业务' : '试试调整搜索词或筛选条件'} />
        ) : (
          <table className="w-full table-fixed text-left text-sm">
            <thead className="bg-slate-50 text-xs text-ink-500">
              <tr>
                <th className="w-[30%] px-4 py-2.5 font-medium">业务名称</th>
                <th className="px-4 py-2.5 font-medium">类型</th>
                <th className="px-4 py-2.5 font-medium">交易对象</th>
                <th className="px-4 py-2.5 font-medium">发起方</th>
                <th className="px-4 py-2.5 font-medium">合同金额</th>
                <th className="px-4 py-2.5 font-medium">预计签约</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => {
                const mine = accessFor(s, t).orgId
                return (
                  <tr
                    key={t.id}
                    tabIndex={0}
                    onClick={() => navigate(projectRoute(t.id))}
                    onKeyDown={(e) => e.key === 'Enter' && navigate(projectRoute(t.id))}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50 focus-visible:bg-brand-50 focus-visible:outline-none"
                  >
                    <td className="truncate px-4 py-3 font-medium" title={t.name}>
                      {t.name}
                    </td>
                    <td className="truncate px-4 py-3 text-ink-700">{t.type}</td>
                    <td className="truncate px-4 py-3 text-ink-700">{orgOf(s, otherPartyId(t, mine))?.shortName}</td>
                    <td className="px-4 py-3 text-ink-700">{t.initiatorOrgId === mine ? '我方' : '对方'}</td>
                    <td className="px-4 py-3 tabular-nums text-ink-700">{formatMoney(t.amount)}</td>
                    <td className="px-4 py-3 text-ink-700">{t.expectedSignDate}</td>
                    <td className="px-4 py-3">
                      <TransactionStatusBadge status={t.status} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      {showDialog && <NewBusinessDialog onClose={close} defaultCounterpartyId={orgId} />}
    </div>
  )
}
