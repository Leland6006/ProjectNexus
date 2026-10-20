import { useState } from 'react'
import { ArrowUp, FileText, Handshake, Sparkles } from 'lucide-react'
import { Button, Textarea } from '@/components/ui'
import { useApp } from '@/store'

export default function Dashboard() {
  const navigate = useApp((s) => s.navigate)
  const [message, setMessage] = useState('')
  const [submitted, setSubmitted] = useState(false)
  return (
    <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-center px-8 py-16">
      <div className="mb-8">
        <span className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
          <Sparkles className="h-5 w-5" />
        </span>
        <h1 className="text-3xl font-semibold tracking-tight">今天想推进什么业务？</h1>
        <p className="mt-3 text-sm leading-6 text-ink-500">
          从一笔交易、一份合同，或一个待确认的建议开始。
        </p>
      </div>
      <form
        className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm"
        onSubmit={(event) => {
          event.preventDefault()
          if (message.trim()) setSubmitted(true)
        }}
      >
        <Textarea
          aria-label="输入业务问题"
          className="min-h-28 resize-none border-0 shadow-none focus:ring-0"
          placeholder="描述你想处理的业务事项…"
          maxLength={4000}
          value={message}
          onChange={(event) => {
            setMessage(event.target.value)
            setSubmitted(false)
          }}
        />
        <div className="mt-2 flex items-center justify-between border-t border-slate-100 pt-3">
          <span className="text-xs text-ink-400">对话模型尚未接入</span>
          <Button
            aria-label="发送业务问题"
            type="submit"
            variant="primary"
            disabled={!message.trim()}
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        </div>
      </form>
      {submitted && (
        <p role="status" className="mt-3 rounded-lg bg-slate-50 p-3 text-sm leading-6 text-ink-700">
          当前尚未接入对话模型，暂时无法回答或自动执行业务操作。你可以进入下方业务页面继续处理。
        </p>
      )}
      <div className="mt-5 flex flex-wrap gap-3">
        <Button onClick={() => navigate({ page: 'transactions' })}>
          <Handshake className="h-4 w-4" />
          查看业务与项目
        </Button>
        <Button onClick={() => navigate({ page: 'contracts' })}>
          <FileText className="h-4 w-4" />
          查看合同
        </Button>
        <Button onClick={() => navigate({ page: 'proposals' })}>
          <Sparkles className="h-4 w-4" />
          查看建议
        </Button>
      </div>
    </div>
  )
}
