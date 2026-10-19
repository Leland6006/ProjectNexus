import { canViewTransaction } from './permissions.ts'
import { NexusError, type BusinessTask, type Database, type ProposedAction, type TaskStatus, type User } from './types.ts'

const uid = (prefix: string) => `${prefix}_${globalThis.crypto.randomUUID().slice(0, 12)}`
function text(raw: unknown, name: string, max: number): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > max) throw new NexusError('INVALID_INPUT', `${name}不能为空且不能超过${max}字`)
  return raw.trim()
}
export function workflowMember(db: Database, userId: string, transactionId: string, orgId?: string): User {
  const user = db.users.find((u) => u.id === userId)
  const tx = db.transactions.find((t) => t.id === transactionId)
  if (!user || !tx || !canViewTransaction(user, tx)) throw new NexusError('NOT_FOUND', '业务不存在或无权访问')
  if (user.role === 'external_counsel' || (orgId && user.orgId !== orgId)) throw new NexusError('PERMISSION_DENIED', '仅本企业成员可处理内部工作')
  return user
}

export function taskForAction(args: { orgId: string; transactionId: string; contractId: string | null; proposalId: string | null; actionIndex: number | null; userId: string; at: string; action: ProposedAction }): BusinessTask {
  const { action, at, userId } = args
  const titles = action.kind === 'revise_clause'
    ? ['核对合同现状与修改意图', '准备并核对合同修改材料', '记录实际处理结果']
    : action.kind === 'contact_counterparty' || action.kind === 'counter_offer'
      ? ['核对沟通方案及业务数据', '准备沟通材料并由用户办理', '记录实际沟通结果']
      : ['核对任务范围与所需信息', '准备材料并由用户执行', '记录实际执行结果']
  return {
    id: uid('task'), orgId: args.orgId, transactionId: args.transactionId, contractId: args.contractId,
    proposalId: args.proposalId, actionIndex: args.actionIndex, title: text(action.title, '任务标题', 120), detail: text(action.detail || action.title, '任务说明', 4000),
    ownerUserId: userId, dueDate: null, status: 'open', revision: 0, requiresReview: false,
    steps: titles.map((title) => ({ id: uid('step'), title, status: 'pending', result: null, completedBy: null, completedAt: null })),
    history: [{ at, actorId: userId, summary: '用户确认创建任务；尚未执行外部操作' }], createdAt: at, updatedAt: at
  }
}

function authorizedTask(db: Database, userId: string, taskId: string): BusinessTask {
  const task = db.tasks.find((t) => t.id === taskId)
  if (!task) throw new NexusError('NOT_FOUND', '任务不存在')
  workflowMember(db, userId, task.transactionId, task.orgId)
  return task
}
function changed(task: BusinessTask, userId: string, at: string, summary: string): void {
  task.revision++
  task.updatedAt = at
  task.history.push({ at, actorId: userId, summary })
}
export function createTask(db: Database, userId: string, input: { transactionId: string; title: string; detail: string }, at: string): BusinessTask {
  const user = workflowMember(db, userId, input.transactionId)
  const task = taskForAction({ orgId: user.orgId, transactionId: input.transactionId, contractId: null, proposalId: null, actionIndex: null, userId, at, action: { kind: 'add_task', title: input.title, detail: input.detail } })
  db.tasks.push(task)
  return task
}
export function updateTask(db: Database, userId: string, taskId: string, input: { revision: number; command?: 'start' | 'pause' | 'resume' | 'cancel' | 'reviewed'; ownerUserId?: string; dueDate?: string | null }, at: string): BusinessTask {
  const task = authorizedTask(db, userId, taskId)
  if (input.revision !== task.revision) throw new NexusError('CONFLICT', '任务已更新，请刷新后操作')
  if (task.status === 'completed' || task.status === 'cancelled') throw new NexusError('CONFLICT', '任务已结束')
  if (input.ownerUserId !== undefined && !db.users.some((u) => u.id === input.ownerUserId && u.orgId === task.orgId && u.role !== 'external_counsel')) throw new NexusError('INVALID_INPUT', '负责人须为本企业成员')
  if (input.dueDate !== undefined && input.dueDate !== null && (typeof input.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.dueDate) || Number.isNaN(Date.parse(input.dueDate)) || new Date(input.dueDate).toISOString().slice(0, 10) !== input.dueDate)) throw new NexusError('INVALID_INPUT', '截止日期无效')
  const next: Record<string, TaskStatus> = { start: 'in_progress', pause: 'paused', resume: 'in_progress', cancel: 'cancelled', reviewed: task.status }
  if (input.command !== undefined && !Object.hasOwn(next, input.command)) throw new NexusError('INVALID_INPUT', '未知任务操作')
  if (input.command === 'resume' && task.status !== 'paused') throw new NexusError('CONFLICT', '只有已暂停的任务可以恢复')
  if (input.command === 'start' && task.status !== 'open') throw new NexusError('CONFLICT', '任务已开始')
  if (task.requiresReview && input.command !== 'reviewed' && input.command !== 'cancel' && input.command !== 'pause') throw new NexusError('CONFLICT', '基础数据已变化，请先核对最新信息')
  if (input.ownerUserId !== undefined) task.ownerUserId = input.ownerUserId
  if (input.dueDate !== undefined) task.dueDate = input.dueDate
  if (input.command === 'reviewed') task.requiresReview = false
  if (input.command) task.status = next[input.command]
  const labels = { start: '开始执行', pause: '暂停任务', resume: '恢复任务', cancel: '取消任务', reviewed: '用户已核对最新业务数据，保留原任务计划继续处理' }
  changed(task, userId, at, input.command ? labels[input.command] : '更新负责人或截止日期')
  return task
}

export function completeTaskStep(db: Database, userId: string, taskId: string, input: { revision: number; stepId: string; result: string }, at: string): BusinessTask {
  const task = authorizedTask(db, userId, taskId)
  const step = task.steps.find((s) => s.id === input.stepId)
  const result = text(input.result, '实际处理记录', 4000)
  // Replayed identical requests have no second side effect, including after completion.
  if (step?.status === 'completed' && step.result === result) return task
  if (input.revision !== task.revision) throw new NexusError('CONFLICT', '任务已更新，请刷新后操作')
  if (task.requiresReview) throw new NexusError('CONFLICT', '基础数据已变化，请先核对最新信息')
  if (!['in_progress', 'waiting_user'].includes(task.status)) throw new NexusError('CONFLICT', '请先开始或恢复任务')
  if (!step || task.steps.find((s) => s.status === 'pending')?.id !== step.id) throw new NexusError('CONFLICT', '请按顺序完成当前步骤')
  Object.assign(step, { status: 'completed', result, completedBy: userId, completedAt: at })
  const complete = task.steps.every((s) => s.status === 'completed')
  task.status = complete ? 'completed' : 'waiting_user'
  changed(task, userId, at, `${step.title}：${result}`)
  if (complete) {
    const key = `ops.task_completed.${task.id}`
    if (!db.claims.some((c) => c.key === key && c.orgId === task.orgId)) db.claims.push({
      id: uid('cl'), orgId: task.orgId, transactionId: task.transactionId, key,
      label: '任务完成记录', value: `用户记录任务「${task.title}」已完成。处理结果：${result}`, numeric: null, unit: null,
      status: 'confirmed', source: { kind: 'user', ref: task.id, detail: '用户提交的任务完成记录，不代表已核验外部收款、签署或申报' },
      asOf: at, visibility: 'internal', supersededById: null, confirmedBy: userId, confirmedAt: at
    })
  }
  return task
}

export function recoverInterruptedRuns(db: Database, at: string): boolean {
  let changed = false
  for (const run of db.analysisRuns) if (run.status === 'running') {
    run.status = 'paused'; run.error = '上次运行被中断，请确认后继续。'; run.updatedAt = at
    for (const step of run.steps) if (step.status === 'running') { step.status = 'pending'; step.error = '上次未完成，将重新执行该节点' }
    changed = true
  }
  return changed
}
