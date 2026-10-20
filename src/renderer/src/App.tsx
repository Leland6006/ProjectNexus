import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Shell } from './components/Shell'
import { Spinner, Toasts, Button } from './components/ui'
import { useApp } from './store'
import Dashboard from './pages/Dashboard'
import Proposals from './pages/Proposals'
import Transactions from './pages/Transactions'
import TransactionDetail from './pages/TransactionDetail'
import ContractsPage from './pages/Contracts'
import ContractEditor from './pages/ContractEditor'
import Collaboration from './pages/Collaboration'
import Performance from './pages/Performance'
import Organization from './pages/Organization'
import SettingsPage from './pages/Settings'
import IdentityGate from './components/IdentityGate'
import Contacts from './pages/Contacts'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[renderer]', error, info.componentStack)
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <p className="text-base font-semibold">页面出现了问题</p>
        <p className="max-w-md text-sm text-ink-500">{this.state.error.message}</p>
        <Button variant="primary" onClick={() => this.setState({ error: null })}>
          重试
        </Button>
      </div>
    )
  }
}

function Router() {
  const route = useApp((s) => s.route)
  switch (route.page) {
    case 'dashboard':
      return <Dashboard />
    case 'proposals':
      return <Proposals />
    case 'transactions':
      return route.transactionId ? <TransactionDetail transactionId={route.transactionId} /> : <Transactions />
    case 'contracts':
      return route.contractId ? <ContractEditor contractId={route.contractId} /> : <ContractsPage />
    case 'contacts':
      return <Contacts />
    case 'collaboration':
      return <Collaboration />
    case 'performance':
      return <Performance />
    case 'organization':
      return <Organization />
    case 'settings':
      return <SettingsPage />
  }
}

export default function App() {
  const loading = useApp((s) => s.loading)
  const state = useApp((s) => s.state)
  const init = useApp((s) => s.init)
  const mode = useApp((s) => s.mode)
  const refresh = useApp((s) => s.refreshIdentity)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (mode !== 'server') return
    let disposed = false
    let refreshing = false
    let queued = false
    const invalidate = async () => {
      queued = true
      if (refreshing) return
      refreshing = true
      try {
        while (queued && !disposed) {
          queued = false
          const before = useApp.getState().identityStatus
          await refresh()
          const after = useApp.getState().identityStatus
          if (!disposed && before?.account?.id === after?.account?.id && before?.actingOrgId === after?.actingOrgId) {
            window.dispatchEvent(new Event('nexus:invalidate'))
          }
        }
      } finally { refreshing = false }
    }
    const unsubscribe = window.nexus.onInvalidate(() => { void invalidate() })
    const timer = setInterval(() => void invalidate(), 30_000)
    const onFocus = () => { void invalidate() }
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      unsubscribe()
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [mode, refresh])

  if (!loading && !state) return <><IdentityGate /><Toasts /></>

  if (loading) {
    return (
      <div className="h-full">
        <Spinner label="正在加载 Project Nexus" />
      </div>
    )
  }

  return (
    <>
      <Shell>
        <ErrorBoundary>
          <Router />
        </ErrorBoundary>
      </Shell>
      <Toasts />
    </>
  )
}
