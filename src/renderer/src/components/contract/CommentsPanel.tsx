import { useState } from 'react'
import type { Comment, Contract, Visibility } from '@shared/types'
import {
  COUNSEL_VISIBILITY_LABEL,
  replyVisibility,
  visibilityOptions,
  VISIBILITY_LABEL
} from '@shared/editorRules'
import { cn, formatDateTime } from '@/lib/utils'
import { userLabel } from '@/lib/selectors'
import { useApp, useView } from '@/store'
import { VisibilityBadge } from '../badges'
import { Button, EmptyState, Select, Textarea } from '../ui'

export function CommentsPanel({
  contract,
  clauseId,
  clauseTitle,
  canShare,
  isCounsel
}: {
  contract: Contract
  clauseId: string
  clauseTitle: string
  canShare: boolean
  isCounsel: boolean
}) {
  const s = useView()
  const act = useApp((x) => x.act)
  const busy = useApp((x) => x.busy)
  const [body, setBody] = useState('')
  const [vis, setVis] = useState<Visibility>(
    isCounsel ? 'counsel' : canShare ? 'shared' : 'internal'
  )
  const [replyTo, setReplyTo] = useState<Comment | null>(null)

  const all = s.comments
    .filter((c) => c.contractId === contract.id && c.clauseId === clauseId)
    .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
  const roots = all.filter((c) => !c.parentId)

  const options = visibilityOptions({ isCounsel, canShare, replyAudience: replyTo?.visibility })
  const selected: Visibility = options.includes(vis) ? vis : options[0]

  const submit = async (): Promise<void> => {
    if (!body.trim()) return
    const effective = replyVisibility(replyTo?.visibility, selected)
    if (
      await act(
        'addComment',
        [contract.id, clauseId, body, effective, replyTo?.id ?? null],
        replyTo ? '回复已发送' : '评论已发布'
      )
    ) {
      setBody('')
      setReplyTo(null)
    }
  }

  const renderComment = (c: Comment, nested = false) => (
    <div
      key={c.id}
      className={cn(
        'rounded-lg border bg-white p-2.5',
        nested ? 'ml-5 mt-1.5 border-slate-100' : 'border-slate-200'
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs">
        <span className="font-medium text-ink-900">{userLabel(s, c.authorId)}</span>
        <VisibilityBadge visibility={c.visibility} />
      </div>
      <p className="whitespace-pre-wrap text-sm text-ink-700">{c.body}</p>
      <div className="mt-1 flex items-center justify-between text-xs text-ink-400">
        <span>{formatDateTime(c.createdAt)}</span>
        {!nested && (
          <button
            className="text-brand-600 hover:underline"
            onClick={() => {
              setReplyTo(c)
              setVis(c.visibility)
            }}
          >
            回复
          </button>
        )}
      </div>
    </div>
  )

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-slate-200 bg-white px-3 py-2 text-xs text-ink-500">
        当前条款：<span className="font-medium text-ink-900">{clauseTitle}</span>
      </div>
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {roots.length === 0 && <EmptyState title="这条款还没有评论" hint="在下方发表第一条意见" />}
        {roots.map((c) => (
          <div key={c.id}>
            {renderComment(c)}
            {all.filter((r) => r.parentId === c.id).map((r) => renderComment(r, true))}
          </div>
        ))}
      </div>
      <div className="border-t border-slate-200 bg-white p-3">
        {replyTo && (
          <div className="mb-2 flex items-center justify-between rounded bg-slate-100 px-2 py-1 text-xs text-ink-700">
            <span className="truncate">回复 {userLabel(s, replyTo.authorId)}</span>
            <button className="text-ink-500 hover:text-ink-900" onClick={() => setReplyTo(null)}>
              取消
            </button>
          </div>
        )}
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="输入评论…"
          rows={3}
          aria-label="评论内容"
        />
        <div className="mt-2 flex items-center gap-2">
          <Select
            value={selected}
            onChange={(e) => setVis(e.target.value as Visibility)}
            aria-label="评论可见范围"
            className="flex-1"
          >
            {options.map((v) => (
              <option key={v} value={v}>
                {isCounsel ? COUNSEL_VISIBILITY_LABEL : VISIBILITY_LABEL[v]}
              </option>
            ))}
          </Select>
          <Button
            variant="primary"
            loading={busy}
            disabled={!body.trim()}
            onClick={() => void submit()}
          >
            {replyTo ? '回复' : '发表'}
          </Button>
        </div>
      </div>
    </div>
  )
}
