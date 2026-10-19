import { useEffect, useState } from 'react'
import type { AnalysisRun, BusinessTask } from '@shared/types'
import { Badge, Button, Card, CardHeader, EmptyState, Field, Input, PageHeader, Select, Textarea } from '@/components/ui'
import { currentUser } from '@/lib/selectors'
import { formatDateTime } from '@/lib/utils'
import { projectRoute } from '@/routes'
import { useApp, useView } from '@/store'

const TASK_LABEL = { open: '待开始', in_progress: '进行中', waiting_user: '等待用户办理', paused: '已暂停', completed: '用户已记录完成', cancelled: '已取消' }
const RUN_LABEL = { running: '分析中', paused: '已暂停', failed: '未完成', completed: '已完成', stale: '源数据已变化', cancelled: '已被替代' }
const AGENT_LABEL = { finance: '财务计算', legal: '法务分析', ops: '经营分析', main: '综合方案' }

export function AnalysisCard({ run }: { run: AnalysisRun }) {
  const me = currentUser(useView())
  const act = useApp((x) => x.act)
  const navigate = useApp((x) => x.navigate)
  return <Card>
    <CardHeader title={run.trigger} subtitle={`${RUN_LABEL[run.status]} · ${formatDateTime(run.updatedAt)}`} action={<Button size="sm" onClick={() => navigate(projectRoute(run.transactionId))}>查看业务</Button>} />
    <div className="space-y-3 p-4">
      <p className="text-xs text-ink-500">运行方式：{run.provider} · 每个节点按专业权限获取上下文。预测与建议不会自动成为事实。</p>
      {run.error && <p role="status" className="text-sm text-amber-800">{run.error}</p>}
      <details open={run.status === 'running' || run.status === 'failed'}><summary className="cursor-pointer text-sm text-brand-700">专业协同过程（{run.steps.length} 个节点）</summary><ol className="mt-3 space-y-3">{run.steps.map((step) => <li key={step.agentId} className="rounded border border-slate-100 p-3"><p className="text-sm font-medium">{AGENT_LABEL[step.agentId]} · {{ pending: '等待', running: '运行中', completed: '完成', skipped: '未配置模型，已跳过', failed: '未完成' }[step.status]}</p>{step.findings.map((f, n) => <p key={n} className="mt-1 whitespace-pre-wrap text-sm text-ink-700">{f}</p>)}{step.error && <p className="text-xs text-amber-800">{step.error}</p>}<p className="mt-1 text-xs text-ink-400">已分发的记忆字段：{step.contextKeys.join('、') || '结构化业务数据／无记忆字段'}</p></li>)}</ol></details>
      {run.createdBy === me.id && <div className="flex gap-2">{run.status === 'running' && <Button size="sm" onClick={() => void act('pauseAnalysis', [run.id], '已请求暂停分析')}>暂停分析</Button>}{['paused', 'failed'].includes(run.status) && <Button size="sm" onClick={() => void act('resumeAnalysis', [run.id], '分析已恢复并完成')}>恢复未完成节点</Button>}</div>}
    </div>
  </Card>
}

export function TaskCard({ task }: { task: BusinessTask }) {
  const s = useView()
  const act = useApp((x) => x.act)
  const navigate = useApp((x) => x.navigate)
  const busy = useApp((x) => x.busy)
  const [result, setResult] = useState('')
  const [owner, setOwner] = useState(task.ownerUserId)
  const [date, setDate] = useState(task.dueDate ?? '')
  useEffect(() => { setOwner(task.ownerUserId); setDate(task.dueDate ?? ''); setResult('') }, [task.revision, task.ownerUserId, task.dueDate])
  const current = task.steps.find((step) => step.status === 'pending')
  const ended = task.status === 'completed' || task.status === 'cancelled'
  const command = (value: 'start' | 'pause' | 'resume' | 'cancel' | 'reviewed') => void act('updateTask', [task.id, { revision: task.revision, command: value }])
  return <Card>
    <CardHeader title={task.title} subtitle={`${TASK_LABEL[task.status]} · ${task.steps.filter((s) => s.status === 'completed').length}/${task.steps.length} 步 · ${s.transactions.find((t) => t.id === task.transactionId)?.name}`} action={<Button size="sm" onClick={() => navigate(projectRoute(task.transactionId))}>业务资料</Button>} />
    <div className="space-y-4 p-4">
      <p className="whitespace-pre-wrap text-sm text-ink-700">{task.detail}</p>
      <p className="text-xs text-ink-500">{task.proposalId ? '来源：用户采纳的方案' : '来源：用户创建'} · 创建于 {formatDateTime(task.createdAt)}。本流程只保存准备情况与用户记录，不会自动发消息、签署、付款或申报。</p>
      {!ended && <div className="grid grid-cols-3 items-end gap-2"><Field label="负责人"><Select value={owner} onChange={(e) => setOwner(e.target.value)}>{s.users.filter((u) => u.orgId === task.orgId && u.role !== 'external_counsel').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</Select></Field><Field label="截止日期（可留空）"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field><Button disabled={busy || task.requiresReview} onClick={() => void act('updateTask', [task.id, { revision: task.revision, ownerUserId: owner, dueDate: date || null }], '任务安排已更新')}>保存安排</Button></div>}
      {task.requiresReview && !ended && <div className="rounded-lg bg-amber-50 p-3"><p className="mb-2 text-sm text-amber-800">业务资料已变化。请查看最新信息并核对原计划后再继续。</p><Button size="sm" onClick={() => { if (window.confirm('已查看最新业务资料，并确认保留原任务计划继续处理？')) command('reviewed') }}>已核对最新资料</Button></div>}
      <ol className="space-y-2">{task.steps.map((step, n) => <li key={step.id} className="rounded-lg border border-slate-100 p-3"><p className="text-sm font-medium">{n + 1}. {step.title} · {step.status === 'completed' ? '已记录' : '待处理'}</p>{step.result && <p className="mt-1 whitespace-pre-wrap text-sm text-ink-600">{step.result}</p>}</li>)}</ol>
      {!ended && <div className="flex flex-wrap gap-2">{task.status === 'open' && <Button variant="primary" disabled={busy || task.requiresReview} onClick={() => command('start')}>开始任务</Button>}{task.status === 'paused' ? <Button disabled={busy || task.requiresReview} onClick={() => command('resume')}>继续任务</Button> : <Button disabled={busy} onClick={() => command('pause')}>暂停</Button>}<Button disabled={busy} onClick={() => { if (window.confirm('取消此任务？处理历史会保留。')) command('cancel') }}>取消任务</Button></div>}
      {current && !task.requiresReview && ['in_progress', 'waiting_user'].includes(task.status) && <form className="space-y-2 rounded-lg bg-slate-50 p-3" onSubmit={async (e) => { e.preventDefault(); if (await act('completeTaskStep', [task.id, { revision: task.revision, stepId: current.id, result }], '已保存步骤结果')) setResult('') }}><Field label={`当前步骤：${current.title}`} hint="记录已核对的信息、准备的材料或实际结果；不要将计划写成已完成事实。"><Textarea required maxLength={4000} value={result} onChange={(e) => setResult(e.target.value)} /></Field><Button type="submit" variant="primary" loading={busy} disabled={!result.trim()}>确认记录并推进下一步</Button></form>}
      <details><summary className="cursor-pointer text-xs text-ink-500">操作历史（{task.history.length}）</summary><ul className="mt-2 space-y-2 text-xs text-ink-600">{task.history.map((item, n) => <li key={n}>{formatDateTime(item.at)} · {s.users.find((u) => u.id === item.actorId)?.name ?? '系统'} · {item.summary}</li>)}</ul></details>
    </div>
  </Card>
}

export default function ExecutionCenter({ completed = false }: { completed?: boolean }) {
  const s = useView()
  const me = currentUser(s)
  const act = useApp((x) => x.act)
  const [txId, setTxId] = useState(s.transactions[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [tab, setTab] = useState<'tasks' | 'runs'>('tasks')
  const tasks = s.tasks.filter((t) => completed ? ['completed', 'cancelled'].includes(t.status) : !['completed', 'cancelled'].includes(t.status))
  return <div className="mx-auto max-w-4xl space-y-4 p-6"><PageHeader title={completed ? '任务处理记录' : '执行与协同'} subtitle="任务可暂停、恢复；结果由用户确认记录。" />
    {!completed && me.role !== 'external_counsel' && <details className="rounded-lg border border-slate-200 p-4"><summary className="cursor-pointer text-sm">新建任务</summary><form className="mt-3 space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act('createTask', [{ transactionId: txId, title, detail: title }], '已创建任务')) setTitle('') }}><Field label="关联业务"><Select value={txId} onChange={(e) => setTxId(e.target.value)}>{s.transactions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field><Field label="任务内容"><Input required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} /></Field><Button type="submit" disabled={!txId || !title.trim()}>创建</Button></form></details>}
    {!completed && <div className="flex gap-2"><Button variant={tab === 'tasks' ? 'primary' : 'secondary'} onClick={() => setTab('tasks')}>任务（{tasks.length}）</Button><Button variant={tab === 'runs' ? 'primary' : 'secondary'} onClick={() => setTab('runs')}>协同记录（{s.analysisRuns.length}）</Button></div>}
    {(completed || tab === 'tasks') ? tasks.length ? tasks.map((t) => <TaskCard key={t.id} task={t} />) : <Card><EmptyState title="暂无任务" hint="采纳方案后会创建任务，也可以手动新建。" /></Card> : s.analysisRuns.length ? [...s.analysisRuns].reverse().map((run) => <AnalysisCard key={run.id} run={run} />) : <Card><EmptyState title="暂无协同记录" hint="从业务页面运行分析，或修改付款安排、成本、延期状态。" /></Card>}
  </div>
}
