import type { Contract } from '@shared/types'
import { formatDateTime } from '@/lib/utils'
import { useView } from '@/store'
import { VisibilityBadge } from '../badges'
import { EmptyState } from '../ui'

export function ActivityPanel({ contract }: { contract: Contract }) {
  const s = useView()
  const list = s.activities
    .filter((x) => x.contractId === contract.id)
    .sort((x, y) => y.createdAt.localeCompare(x.createdAt))
  if (list.length === 0) return <EmptyState title="暂无协商记录" />
  return (
    <ol className="relative ml-5 mt-3 space-y-4 border-l border-slate-200 pb-4 pr-3">
      {list.map((x) => (
        <li key={x.id} className="relative pl-4">
          <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-brand-500" />
          <p className="text-sm text-ink-700">{x.summary}</p>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-ink-400">
            {formatDateTime(x.createdAt)}
            <VisibilityBadge visibility={x.visibility} />
          </div>
        </li>
      ))}
    </ol>
  )
}
