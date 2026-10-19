import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUp, Briefcase, ChevronDown, ChevronRight, Compass, Info, Loader2, Pencil } from 'lucide-react'
import { todayBriefing } from '@shared/briefing'
import type { ChatMessage } from '@shared/types'
import { Button, EmptyState, Input } from '@/components/ui'
import { cn, formatDateTime } from '@/lib/utils'
import { currentUser, orgOf } from '@/lib/selectors'
import { HOME, attentionRoute } from '@/routes'
import { useApp, useView } from '@/store'

const QUICK_STARTS = ['看看公司最近需要关注什么', '评估一笔新业务', '帮我处理一项经营事务']

function RuntimeBadge() {
  const runtime = useView().runtime
  if (runtime.connected) {
    return <span className="text-xs text-emerald-700">AI 已配置（{runtime.id}）</span>
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-ink-400" title="消息会保存在会话中，但不会生成回答，也不会修改业务数据">
      <Info className="h-3.5 w-3.5" aria-hidden />
      尚未连接 AI · 消息会保存，不会生成回答
    </span>
  )
}

function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  autoFocus,
  rows = 3
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  autoFocus?: boolean
  rows?: number
}) {
  const busy = useApp((x) => x.busy)
  const id = useId()
  const draft = useApp((x) => x.chatDraft)
  const canSend = value.trim().length > 0 && !busy && !draft
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter adds a line. Never send while an IME is composing Chinese.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (canSend) onSubmit()
    }
  }
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm transition focus-within:border-brand-300 focus-within:ring-4 focus-within:ring-brand-50">
      <label htmlFor={id} className="sr-only">
        发送给 Nexus 的消息
      </label>
      <textarea
        id={id}
        rows={rows}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKey}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="block w-full resize-none rounded-2xl bg-transparent px-4 pt-3 text-sm leading-6 text-ink-900 outline-none placeholder:text-ink-400"
      />
      <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
        {draft && <Button size="sm" onClick={() => void useApp.getState().act('cancelChat', [])}>停止生成</Button>}
        <RuntimeBadge />
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="发送"
          title="发送（Enter）"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:bg-slate-200 disabled:text-ink-400"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function TodayBriefing() {
  const s = useView()
  const navigate = useApp((x) => x.navigate)
  const [open, setOpen] = useState(true)
  const me = currentUser(s)
  const items = useMemo(() => todayBriefing(s, new Date()), [s])

  return (
    <section className="mt-8" aria-label="今日经营">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded text-xs font-medium text-ink-500 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        今日经营
        {items.length > 0 && <span className="text-ink-400">· {items.length} 项</span>}
      </button>
      {open && (
        <div className="mt-2">
          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 px-4 py-4 text-sm text-ink-500">
              <p>还没有可以展示的经营事项。Nexus 只根据你录入和参与的业务数据整理，不会凭空生成经营状态。</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={() => navigate({ module: 'memory', view: 'profile' })}>
                  查看公司资料
                </Button>
                {me.role !== 'external_counsel' && (
                  <Button size="sm" onClick={() => navigate({ module: 'business', view: 'all', create: true })}>
                    新建业务
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
              {items.map((item) => (
                <li key={item.id}>
                  <button
                    onClick={() => navigate(attentionRoute(item))}
                    className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                  >
                    <span className={cn('mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full', item.urgency === 0 ? 'bg-rose-500' : item.kind === 'decision' ? 'bg-amber-500' : 'bg-brand-500')} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink-900">{item.title}</span>
                      <span className="block truncate text-xs text-ink-400">
                        {item.detail} · {item.source}
                      </span>
                    </span>
                    <ChevronRight className="mt-1 h-3.5 w-3.5 shrink-0 text-ink-300" />
                  </button>
                </li>
              ))}
              <li>
                <button
                  onClick={() => navigate({ module: 'actions', view: 'attention' })}
                  className="w-full px-4 py-2 text-left text-xs text-brand-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-500"
                >
                  在「行动与决策」中查看全部
                </button>
              </li>
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

function NexusHome() {
  const s = useView()
  const act = useApp((x) => x.act)
  const navigate = useApp((x) => x.navigate)
  const [text, setText] = useState('')
  const me = currentUser(s)

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body) return
    const before = new Set(s.conversations.map((c) => c.id))
    if (!(await act('startConversation', [body]))) return
    setText('')
    const created = useApp.getState().state?.conversations.find((c) => !before.has(c.id))
    const route = useApp.getState().route
    if (created && route.module === 'nexus' && !route.conversationId) navigate({ module: 'nexus', conversationId: created.id })
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-6 pb-12 pt-[12vh]">
      <h1 className="text-center text-2xl font-semibold tracking-tight text-ink-900">今天想和 Nexus 一起推进什么？</h1>
      <p className="mt-2 text-center text-sm text-ink-500">
        {me.name} · {orgOf(s, me.orgId)?.name}
      </p>
      <div className="mt-8">
        <Composer value={text} onChange={setText} onSubmit={() => void send()} placeholder="描述你想了解或推进的事情…" autoFocus />
      </div>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        {QUICK_STARTS.map((q) => (
          <button
            key={q}
            onClick={() => setText(q)}
            className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-ink-700 hover:border-brand-200 hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {q}
          </button>
        ))}
      </div>
      <TodayBriefing />
    </div>
  )
}

function SystemNotice({ message, showLinks }: { message: ChatMessage; showLinks: boolean }) {
  const navigate = useApp((x) => x.navigate)
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-ink-500">
        <Info className="h-3.5 w-3.5" aria-hidden />
        Nexus 状态
      </p>
      <p className="text-sm leading-6 text-ink-700">{message.body}</p>
      {showLinks && (
        <div className="mt-2.5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => navigate({ module: 'business', view: 'all' })}>
            <Briefcase className="h-3.5 w-3.5" />
            业务与项目
          </Button>
          <Button size="sm" onClick={() => navigate({ module: 'actions', view: 'attention' })}>
            <Compass className="h-3.5 w-3.5" />
            需要关注的事项
          </Button>
          <Button size="sm" onClick={() => navigate({ module: 'memory', view: 'profile' })}>
            公司档案
          </Button>
        </div>
      )}
      <p className="mt-1.5 text-[11px] text-ink-400">{formatDateTime(message.createdAt)}</p>
    </div>
  )
}

function ConversationView({ id }: { id: string }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const navigate = useApp((x) => x.navigate)
  const draft = useApp((x) => x.chatDraft)
  const busy = useApp((x) => x.busy)
  const conv = s.conversations.find((c) => c.id === id)
  const messages = useMemo(
    () => s.chatMessages.filter((m) => m.conversationId === id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [s.chatMessages, id]
  )
  const [text, setText] = useState('')
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(conv?.title ?? '')
  const end = useRef<HTMLDivElement>(null)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [messages.length, draft?.body])

  if (!conv) {
    return (
      <div className="p-6">
        <EmptyState title="会话不存在或无权访问" action={<Button onClick={() => navigate(HOME)}>开始新对话</Button>} />
      </div>
    )
  }

  const lastNotice = [...messages].reverse().find((m) => m.role === 'system')

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (!body) return
    if (await act('sendChatMessage', [id, body])) setText('')
  }

  const saveTitle = async (): Promise<void> => {
    const next = title.trim()
    if (next && next !== conv.title) await act('renameConversation', [id, next], '已重命名')
    else setTitle(conv.title)
    setEditing(false)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-slate-100 px-6">
        {editing ? (
          <Input
            value={title}
            autoFocus
            aria-label="会话名称"
            maxLength={60}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => void saveTitle()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void saveTitle()
              if (e.key === 'Escape') {
                setTitle(conv.title)
                setEditing(false)
              }
            }}
            className="h-7 max-w-md"
          />
        ) : (
          <>
            <h1 className="truncate text-sm font-medium text-ink-900">{conv.title}</h1>
            <button
              onClick={() => {
                setTitle(conv.title)
                setEditing(true)
              }}
              aria-label="重命名会话"
              title="重命名"
              className="rounded p-1 text-ink-400 hover:bg-slate-100 hover:text-ink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
          </>
        )}
        <span className="ml-auto shrink-0 text-xs text-ink-400">仅你本人可见 · 不会自动写入企业记忆</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-4 px-6 py-6">
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-slate-100 px-4 py-2.5">
                  <p className="whitespace-pre-wrap text-sm leading-6 text-ink-900">{m.body}</p>
                  <p className="mt-1 text-right text-[11px] text-ink-400">{formatDateTime(m.createdAt)}</p>
                </div>
              </div>
            ) : m.role === 'system' ? (
              <SystemNotice key={m.id} message={m} showLinks={m.id === lastNotice?.id && m.runtime === 'none'} />
            ) : (
              <div key={m.id}>
                <p className="mb-1 text-xs text-ink-400">Nexus · {m.runtime}</p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-ink-900">{m.body}</p>
                {m.profileUpdate && <div className="mt-3 space-y-3 rounded-xl border border-brand-200 bg-brand-50 p-4"><p className="text-sm font-medium">公司经营资料修改预览</p><dl className="space-y-1 text-sm">{Object.entries(m.profileUpdate.values).map(([key, value]) => <div key={key} className="flex gap-3"><dt className="w-20 shrink-0 text-ink-500">{({ industry: '行业', business: '主营业务', goal: '经营目标', stage: '经营阶段', region: '地区', teamSize: '团队规模' } as Record<string, string>)[key]}</dt><dd className="whitespace-pre-wrap">{value || '未填写'}</dd></div>)}</dl>{m.profileUpdate.appliedAt ? <p className="text-xs text-emerald-700">已确认保存 · {formatDateTime(m.profileUpdate.appliedAt)}</p> : <><p className="text-xs text-ink-500">仅是草稿，核对后才会更新。其他业务数据不会改变。</p><Button size="sm" variant="primary" loading={busy} onClick={() => void act('confirmProfileUpdate', [m.id], '已按确认的草稿更新经营资料')}>确认并更新公司资料</Button></>}</div>}
                {!!m.references?.length && <details className="mt-3 rounded-lg border border-slate-100 p-3"><summary className="cursor-pointer text-xs text-ink-500">本次使用的数据依据（{m.references.length}）</summary><ul className="mt-2 space-y-2 text-xs text-ink-600">{m.references.map((r) => <li key={r.id}><strong>{r.label}</strong> · {r.detail}</li>)}</ul></details>}
              </div>
            )
          )}
          {draft?.conversationId === id && <div aria-live="polite"><p className="mb-1 text-xs text-ink-500">Nexus 正在查询企业数据并生成回答…</p><p className="whitespace-pre-wrap text-sm leading-6">{draft.body}</p></div>}
          {!draft && lastNotice && lastNotice.runtime !== 'none' && messages.at(-1)?.role === 'system' && <Button size="sm" loading={busy} onClick={() => void act('retryChat', [id])}>重试上一条问题</Button>}
          <div ref={end} />
        </div>
      </div>

      <div className="shrink-0 border-t border-slate-100 bg-white px-6 py-3">
        <div className="mx-auto max-w-2xl">
          <Composer value={text} onChange={setText} onSubmit={() => void send()} placeholder="继续补充…" rows={2} autoFocus />
        </div>
      </div>
    </div>
  )
}

export default function NexusPage({ conversationId }: { conversationId: string | null }) {
  return conversationId ? <ConversationView id={conversationId} /> : <NexusHome />
}
