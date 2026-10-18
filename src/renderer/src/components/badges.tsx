import type { ContractStatus, MilestoneStatus, SuggestionStatus, TransactionStatus, Visibility } from '@shared/types'
import { MILESTONE_STATUS_LABEL, TRANSACTION_STATUS_LABEL } from '@shared/types'
import { Lock, Scale, Users } from 'lucide-react'
import { Badge } from './ui'

const TX_TONE: Record<TransactionStatus, 'gray' | 'blue' | 'amber' | 'indigo' | 'green' | 'red'> = {
  draft: 'gray',
  negotiating: 'blue',
  pending_signature: 'amber',
  in_performance: 'indigo',
  completed: 'green',
  cancelled: 'red'
}

export function TransactionStatusBadge({ status }: { status: TransactionStatus }) {
  return <Badge tone={TX_TONE[status]}>{TRANSACTION_STATUS_LABEL[status]}</Badge>
}

const CONTRACT_LABEL: Record<ContractStatus, string> = { draft: '起草中', negotiating: '协商中', finalized: '已确认最终版' }

export function ContractStatusBadge({ status }: { status: ContractStatus }) {
  const tone = status === 'finalized' ? 'green' : status === 'negotiating' ? 'blue' : 'gray'
  return <Badge tone={tone}>{CONTRACT_LABEL[status]}</Badge>
}

const MS_TONE: Record<MilestoneStatus, 'gray' | 'blue' | 'green' | 'red'> = {
  pending: 'gray',
  in_progress: 'blue',
  completed: 'green',
  delayed: 'red'
}

export function MilestoneStatusBadge({ status }: { status: MilestoneStatus }) {
  return <Badge tone={MS_TONE[status]}>{MILESTONE_STATUS_LABEL[status]}</Badge>
}

export function SuggestionStatusBadge({ status }: { status: SuggestionStatus }) {
  const map = { pending: ['amber', '待处理'], accepted: ['green', '已接受'], rejected: ['red', '已拒绝'] } as const
  const [tone, label] = map[status]
  return <Badge tone={tone}>{label}</Badge>
}

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  if (visibility === 'shared')
    return (
      <Badge tone="blue">
        <Users className="h-3 w-3" />
        双方可见
      </Badge>
    )
  if (visibility === 'internal')
    return (
      <Badge tone="amber">
        <Lock className="h-3 w-3" />
        仅本企业
      </Badge>
    )
  return (
    <Badge tone="purple">
      <Scale className="h-3 w-3" />
      本企业及其律师
    </Badge>
  )
}
