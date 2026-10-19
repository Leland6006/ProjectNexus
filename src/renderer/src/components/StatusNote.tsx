import type { ReactNode } from 'react'
import { CircleDashed } from 'lucide-react'

/**
 * A capability that does not exist yet. Shown instead of a button that looks usable but
 * does nothing, so the product never pretends a feature works.
 */
export function NotEnabled({ title, detail, children }: { title: string; detail: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-5 py-5">
      <div className="flex items-start gap-3">
        <CircleDashed className="mt-0.5 h-5 w-5 shrink-0 text-ink-400" aria-hidden />
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink-900">
            {title}
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-normal text-ink-500">尚未启用</span>
          </p>
          <p className="mt-1 text-sm leading-6 text-ink-500">{detail}</p>
          {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
        </div>
      </div>
    </div>
  )
}

/** Small "where this number comes from" line under figures and lists. */
export function SourceLine({ children }: { children: ReactNode }) {
  return <p className="text-xs text-ink-400">{children}</p>
}
