import { useMemo, useState } from 'react'
import { Send } from 'lucide-react'
import { Button, Card, CardHeader, EmptyState, Select, Textarea } from '@/components/ui'
import { VisibilityBadge } from '@/components/badges'
import { formatDateTime } from '@/lib/utils'
import { accessFor, userLabel } from '@/lib/selectors'
import { contractRoute } from '@/routes'
import { useApp, useView } from '@/store'

function ProjectMessages({ transactionId }: { transactionId: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [msg, setMsg] = useState('')
  const [vis, setVis] = useState<'shared' | 'internal'>('shared')
  const tx = s.transactions.find((t) => t.id === transactionId)!
  const a = accessFor(s, tx)
  const messages = s.messages.filter((m) => m.transactionId === transactionId).sort((x, y) => x.createdAt.localeCompare(y.createdAt))

  const send = async (): Promise<void> => {
    if (!msg.trim()) return
    if (await act('sendMessage', [transactionId, msg, vis])) setMsg('')
  }

  return (
    <Card>
      <CardHeader title="项目消息" subtitle="「仅本企业」消息对方不可见" />
      <div className="max-h-[26rem] space-y-3 overflow-y-auto px-4 py-3">
        {messages.length === 0 && <p className="py-4 text-center text-xs text-ink-500">暂无消息</p>}
        {messages.map((m) => (
          <div key={m.id} className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="mb-0.5 flex flex-wrap items-center gap-2 text-xs text-ink-500">
              <span className="font-medium text-ink-700">{userLabel(s, m.authorId)}</span>
              <span>{formatDateTime(m.createdAt)}</span>
              <VisibilityBadge visibility={m.visibility} />
            </div>
            <p className="whitespace-pre-wrap text-sm text-ink-900">{m.body}</p>
          </div>
        ))}
      </div>
      {a.isCounsel ? (
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-ink-500">外部律师请在合同条款上添加意见。</p>
      ) : (
        <div className="flex items-end gap-2 border-t border-slate-100 p-3">
          <Textarea className="min-h-[40px] flex-1" rows={2} value={msg} onChange={(e) => setMsg(e.target.value)} placeholder="输入消息…" aria-label="消息内容" />
          <Select className="w-28" value={vis} onChange={(e) => setVis(e.target.value as typeof vis)} aria-label="消息可见范围">
            <option value="shared">双方可见</option>
            <option value="internal">仅本企业</option>
          </Select>
          <Button variant="primary" onClick={() => void send()} loading={busy} disabled={!msg.trim()}>
            <Send className="h-3.5 w-3.5" />
            发送
          </Button>
        </div>
      )}
    </Card>
  )
}

function NegotiationTimeline({ transactionId }: { transactionId: string }) {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const items = useMemo(
    () => s.activities.filter((a) => a.transactionId === transactionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [s.activities, transactionId]
  )
  return (
    <Card>
      <CardHeader title="协商记录" subtitle="谁修改了合同、谁提出意见、何时产生新版本" />
      {items.length === 0 ? (
        <EmptyState title="暂无记录" />
      ) : (
        <ol className="relative ml-6 max-h-[32rem] space-y-4 overflow-y-auto border-l border-slate-200 py-4 pr-4">
          {items.map((it) => (
            <li key={it.id} className="relative pl-5">
              <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-500">
                <span>{formatDateTime(it.createdAt)}</span>
                <VisibilityBadge visibility={it.visibility} />
              </div>
              <p className="mt-0.5 text-sm text-ink-900">{it.summary}</p>
              {it.contractId && s.contracts.some((c) => c.id === it.contractId) && (
                <button className="mt-0.5 text-xs text-brand-700 hover:underline" onClick={() => navigate(contractRoute(it.contractId!))}>
                  查看合同
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  )
}

/** Collaboration and negotiation of one business: project messages plus the negotiation trail. */
export default function Collaboration({ transactionId }: { transactionId: string }) {
  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-5">
      <div className="xl:col-span-3">
        <ProjectMessages transactionId={transactionId} />
      </div>
      <div className="xl:col-span-2">
        <NegotiationTimeline transactionId={transactionId} />
      </div>
    </div>
  )
}
