import { useMemo, useState } from 'react'
import { FileText, Search } from 'lucide-react'
import type { ContractStatus } from '@shared/types'
import { Card, EmptyState, Input, PageHeader, Select } from '@/components/ui'
import { ContractStatusBadge } from '@/components/badges'
import { formatDateTime } from '@/lib/utils'
import { orgOf } from '@/lib/selectors'
import { useApp, useView } from '@/store'

export default function ContractsPage() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | ContractStatus>('all')

  const rows = useMemo(
    () =>
      s.contracts
        .filter((c) => (status === 'all' ? true : c.status === status))
        .filter((c) => {
          const tx = s.transactions.find((t) => t.id === c.transactionId)
          return `${c.title} ${tx?.name ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [s, q, status]
  )

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title="合同中心" subtitle="你有权查看的全部合同。新合同请在交易项目中创建" />
      <div className="mb-3 flex items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-400" />
          <Input
            className="pl-8"
            placeholder="搜索合同或交易名称"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="搜索合同"
          />
        </div>
        <Select
          className="w-40"
          value={status}
          onChange={(e) => setStatus(e.target.value as typeof status)}
          aria-label="按状态筛选合同"
        >
          <option value="all">全部状态</option>
          <option value="draft">起草中</option>
          <option value="negotiating">协商中</option>
          <option value="finalized">已确认最终版</option>
        </Select>
      </div>
      <Card>
        {rows.length === 0 ? (
          <EmptyState
            icon={<FileText className="h-8 w-8" />}
            title="没有符合条件的合同"
            hint="发起方共享合同后会出现在这里"
          />
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">合同名称</th>
                <th className="px-4 py-2.5 font-medium">所属交易</th>
                <th className="px-4 py-2.5 font-medium">版本数</th>
                <th className="px-4 py-2.5 font-medium">共享</th>
                <th className="px-4 py-2.5 font-medium">更新时间</th>
                <th className="px-4 py-2.5 font-medium">状态</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const tx = s.transactions.find((t) => t.id === c.transactionId)
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate({ page: 'contracts', contractId: c.id })}
                    className="cursor-pointer border-t border-slate-100 hover:bg-slate-50"
                  >
                    <td className="px-4 py-3 font-medium">{c.title}</td>
                    <td className="px-4 py-3 text-ink-700">{tx?.name}</td>
                    <td className="px-4 py-3 text-ink-700">
                      {s.versions.filter((v) => v.contractId === c.id).length}
                    </td>
                    <td className="px-4 py-3 text-ink-700">
                      {c.sharedWithCounterparty
                        ? `已共享给 ${orgOf(s, tx?.counterpartyOrgId ?? '')?.shortName ?? '对方'}`
                        : '仅本企业'}
                    </td>
                    <td className="px-4 py-3 text-ink-700">{formatDateTime(c.updatedAt)}</td>
                    <td className="px-4 py-3">
                      <ContractStatusBadge status={c.status} />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}
