import { useState } from 'react'
import type { Contract } from '@shared/types'
import { reviewFingerprint } from '@shared/terms'
import { Button, Field, Select, Textarea } from '@/components/ui'
import { currentUser, userOf } from '@/lib/selectors'
import { formatDateTime } from '@/lib/utils'
import { useApp, useView } from '@/store'

export function InternalReviewPanel({ contract, dirty }: { contract: Contract; dirty: boolean }) {
  const s = useView(), me = currentUser(s), act = useApp((x) => x.act), busy = useApp((x) => x.busy)
  const colleagues = s.users.filter((u) => u.orgId === me.orgId && u.id !== me.id && u.role !== 'external_counsel')
  const [reviewerId, setReviewer] = useState(colleagues[0]?.id ?? '')
  const [comments, setComments] = useState<Record<string, string>>({})
  const tx = s.transactions.find((t) => t.id === contract.transactionId)
  const canRequest = me.role !== 'external_counsel' && tx?.initiatorOrgId === me.orgId
  const reviews = s.internalReviews.filter((r) => r.contractId === contract.id)
  const fingerprint = reviewFingerprint(contract, s.versions)
  return <div className="space-y-4 p-4">
    <p className="text-xs leading-5 text-ink-500">本企业内部审阅，保留审阅人和意见。此记录不代表对外签约或电子签名；目前通过本机演示账号切换处理。</p>
    {canRequest && contract.status !== 'finalized' && <div className="space-y-2 rounded-lg border bg-white p-3">
      <Field label="内部审阅人"><Select value={reviewerId} onChange={(e) => setReviewer(e.target.value)}>{colleagues.map((u) => <option key={u.id} value={u.id}>{u.name} · {u.title}</option>)}</Select></Field>
      {dirty && <p className="text-xs text-amber-700">请先保存草稿，再发起或处理审阅。</p>}
      <Button disabled={dirty || !reviewerId} loading={busy} onClick={() => void act('requestInternalReview', [contract.id, reviewerId], '已记录内部审阅请求')}>发起内部审阅</Button>
    </div>}
    {!reviews.length && <p className="text-sm text-ink-500">暂无内部审阅记录。</p>}
    {[...reviews].reverse().map((r) => {
      const stale = r.sourceFingerprint !== fingerprint
      return <div key={r.id} className="space-y-2 rounded-lg border bg-white p-3 text-xs">
        <p className="font-medium">{userOf(s, r.requestedBy)?.name} → {userOf(s, r.reviewerId)?.name} · {{ pending: '待审阅', approved: '通过', rejected: '需修改' }[r.status]}{stale ? ' · 合同已更新' : ''}</p>
        <p className="text-ink-500">发起于 {formatDateTime(r.createdAt)}</p>
        {r.comment && <p className="whitespace-pre-wrap">{r.comment}</p>}
        {r.decidedAt && <p className="text-ink-500">处理于 {formatDateTime(r.decidedAt)}</p>}
        {stale && <p className="text-amber-700">本记录适用于历史稿，不能作为当前稿的内部审阅结论。</p>}
        {r.status === 'pending' && r.reviewerId === me.id && !stale && contract.status !== 'finalized' && <>
          <Textarea value={comments[r.id] ?? ''} onChange={(e) => setComments({ ...comments, [r.id]: e.target.value })} placeholder="填写审阅意见" aria-label="内部审阅意见" />
          <div className="flex gap-2">{(['approved', 'rejected'] as const).map((decision) => <Button key={decision} disabled={dirty || !comments[r.id]?.trim()} loading={busy} onClick={() => void act('decideInternalReview', [r.id, { decision, comment: comments[r.id] }], '审阅意见已记录')}>{decision === 'approved' ? '通过审阅' : '退回修改'}</Button>)}</div>
        </>}
      </div>
    })}
  </div>
}
