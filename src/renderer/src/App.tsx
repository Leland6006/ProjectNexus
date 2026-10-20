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
import { EmptyState } from './components/ui'

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
      return <EmptyState title="好友与联系人尚未开通" hint="联系人功能将在后续版本开放。企业成员管理请前往「公司档案与记忆」。" />
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
    const timer = setInterval(() => void refresh(), 30_000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus) }
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
