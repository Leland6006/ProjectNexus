import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react'
import { Shell } from './components/Shell'
import { Spinner, Toasts, Button } from './components/ui'
import { useApp } from './store'
import type { Route } from './routes'
import NexusPage from './pages/Nexus'
import ActionsPage from './pages/Actions'
import BusinessList, { ArchivedBusiness } from './pages/Business'
import ProjectWorkspace from './pages/Project'
import ContractsPage from './pages/Contracts'
import ContractEditor from './pages/ContractEditor'
import FinancePage from './pages/Finance'
import MemoryPage from './pages/Memory'
import SettingsPage from './pages/Settings'

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

type BusinessRoute = Extract<Route, { module: 'business' }>

function BusinessRouter({ route }: { route: BusinessRoute }) {
  switch (route.view) {
    case 'all':
      return <BusinessList create={route.create} />
    case 'counterparty':
      return <BusinessList key={route.orgId} orgId={route.orgId} />
    case 'archived':
      return <ArchivedBusiness />
    case 'contracts':
      return <ContractsPage />
    case 'project':
      return <ProjectWorkspace key={route.transactionId} transactionId={route.transactionId} tab={route.tab} />
    case 'contract':
      return <ContractEditor key={route.contractId} contractId={route.contractId} />
  }
}

function Router() {
  const route = useApp((s) => s.route)
  switch (route.module) {
    case 'nexus':
      return <NexusPage key={route.conversationId ?? 'new'} conversationId={route.conversationId} />
    case 'actions':
      return <ActionsPage view={route.view} />
    case 'business':
      return <BusinessRouter route={route} />
    case 'finance':
      return <FinancePage view={route.view} />
    case 'memory':
      return <MemoryPage view={route.view} />
    case 'settings':
      return <SettingsPage />
  }
}

export default function App() {
  const loading = useApp((s) => s.loading)
  const state = useApp((s) => s.state)
  const init = useApp((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  if (loading || !state) {
    return (
      <div className="h-full">
        <Spinner label="正在加载 Nexus" />
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
