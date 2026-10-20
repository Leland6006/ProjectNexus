import {
  useEffect,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useApp } from '@/store'

// ---------- Button ----------
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-600 text-white shadow-sm hover:bg-brand-700',
        secondary: 'border border-slate-200 bg-white text-ink-700 shadow-sm hover:bg-slate-50',
        ghost: 'text-ink-700 hover:bg-slate-100',
        danger: 'bg-rose-600 text-white hover:bg-rose-700'
      },
      size: { sm: 'h-7 px-2.5 text-xs', md: 'h-8 px-3', lg: 'h-9 px-4' }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
)

interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  loading?: boolean
}

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  )
}

// ---------- Form fields ----------
const fieldClass =
  'w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm text-ink-900 shadow-sm placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-50'

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn(fieldClass, 'h-8', props.className)} />
}

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea {...props} className={cn(fieldClass, 'min-h-[72px] resize-y', props.className)} />
  )
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn(fieldClass, 'h-8 pr-6', props.className)} />
}

export function Field({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-500">{hint}</span>}
    </label>
  )
}

// ---------- Badge ----------
const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        gray: 'bg-slate-100 text-slate-700',
        blue: 'bg-blue-50 text-blue-700',
        indigo: 'bg-brand-50 text-brand-700',
        green: 'bg-emerald-50 text-emerald-700',
        amber: 'bg-amber-50 text-amber-700',
        red: 'bg-rose-50 text-rose-700',
        purple: 'bg-purple-50 text-purple-700'
      }
    },
    defaultVariants: { tone: 'gray' }
  }
)

export function Badge({
  tone,
  children,
  className
}: VariantProps<typeof badgeVariants> & { children: ReactNode; className?: string }) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>
}

// ---------- Card ----------
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('rounded-lg border border-slate-200 bg-white shadow-card', className)}>
      {children}
    </div>
  )
}

export function CardHeader({
  title,
  action,
  subtitle
}: {
  title: ReactNode
  action?: ReactNode
  subtitle?: string
}) {
  return (
    <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
      <div>
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon?: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      {icon && <div className="mb-2 text-ink-400">{icon}</div>}
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-ink-500">{hint}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  )
}

// ---------- Dialog ----------
export function Dialog({
  open,
  onClose,
  title,
  children,
  width = 'max-w-lg'
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  width?: string
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-6 pt-[8vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn('w-full rounded-xl bg-white shadow-2xl', width)}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="关闭"
            className="rounded p-1 text-ink-500 hover:bg-slate-100"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
      </div>
    </div>
  )
}

// ---------- Toasts ----------
export function Toasts() {
  const toasts = useApp((s) => s.toasts)
  const dismiss = useApp((s) => s.dismissToast)
  return (
    <div
      className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-80 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-start gap-2 rounded-lg border bg-white px-3 py-2.5 text-sm shadow-lg',
            t.kind === 'error'
              ? 'border-rose-200'
              : t.kind === 'success'
                ? 'border-emerald-200'
                : 'border-slate-200'
          )}
        >
          {t.kind === 'success' && (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
          )}
          {t.kind === 'error' && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />}
          {t.kind === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />}
          <span className="flex-1 text-ink-900">{t.text}</span>
          <button
            onClick={() => dismiss(t.id)}
            aria-label="关闭提示"
            className="text-ink-400 hover:text-ink-700"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

export function Spinner({ label = '加载中' }: { label?: string }) {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-ink-500">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span>{label}…</span>
    </div>
  )
}

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string
  subtitle?: string
  actions?: ReactNode
}) {
  return (
    <div className="mb-5 flex items-end justify-between">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-ink-500">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  )
}
