import { useMemo, useState } from 'react'
import { Card, CardHeader, EmptyState, PageHeader, Select } from '@/components/ui'
import { VisibilityBadge } from '@/components/badges'
import { formatDateTime } from '@/lib/utils'
import { userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'

export default function Collaboration() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const [txId, setTxId] = useState('all')

  const items = useMemo(() => {
    const acts = s.activities
      .filter((a) => txId === 'all' || a.transactionId === txId)
      .map((a) => ({ kind: 'activity' as const, id: a.id, at: a.createdAt, txId: a.transactionId, contractId: a.contractId, actor: a.actorId, text: a.summary, visibility: a.visibility }))
    const msgs = s.messages
      .filter((m) => txId === 'all' || m.transactionId === txId)
      .map((m) => ({ kind: 'message' as const, id: m.id, at: m.createdAt, txId: m.transactionId, contractId: null as string | null, actor: m.authorId, text: m.body, visibility: m.visibility as 'shared' | 'internal' | 'counsel' }))
    return [...acts, ...msgs].sort((a, b) => b.at.localeCompare(a.at))
  }, [s, txId])

  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader
        title="协作与消息"
        subtitle="项目消息、条款评论与协商活动的统一时间线"
        actions={
          <Select className="w-56" value={txId} onChange={(e) => setTxId(e.target.value)} aria-label="按交易筛选">
            <option value="all">全部交易</option>
            {s.transactions.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        }
      />
      <Card>
        <CardHeader title="时间线" subtitle="仅显示你有权查看的内容；对方的内部讨论不会出现在这里" />
        {items.length === 0 ? (
          <EmptyState title="暂无记录" />
        ) : (
          <ol className="relative ml-6 space-y-4 border-l border-slate-200 py-4 pr-4">
            {items.map((it) => {
              const tx = s.transactions.find((t) => t.id === it.txId)
              return (
                <li key={`${it.kind}-${it.id}`} className="relative pl-5">
                  <span className={`absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white ${it.kind === 'message' ? 'bg-emerald-500' : 'bg-brand-500'}`} />
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                    <span className="font-medium text-ink-700">{it.kind === 'message' ? `${userLabel(s, it.actor)} 发送消息` : '活动'}</span>
                    <span>{formatDateTime(it.at)}</span>
                    <VisibilityBadge visibility={it.visibility} />
                  </div>
                  <p className="mt-0.5 text-sm text-ink-900">{it.text}</p>
                  <div className="mt-0.5 flex gap-3 text-xs">
                    <button className="text-ink-500 hover:text-brand-700" onClick={() => navigate({ page: 'transactions', transactionId: it.txId })}>
                      {tx?.name}
                    </button>
                    {it.contractId && (
                      <button className="text-brand-600 hover:underline" onClick={() => navigate({ page: 'contracts', contractId: it.contractId! })}>
                        查看合同
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        )}
      </Card>
    </div>
  )
}
