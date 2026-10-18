import { Building2, Scale } from 'lucide-react'
import { ROLE_LABEL } from '@shared/types'
import { Badge, Card, CardHeader, PageHeader } from '@/components/ui'
import { currentUser } from '@/lib/selectors'
import { useView } from '@/store'

export default function Organization() {
  const s = useView()
  const me = currentUser(s)
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="企业与成员" subtitle="演示环境中的虚构企业与账号。所有名称均为虚构。" />
      <div className="space-y-4">
        {s.organizations.map((o) => (
          <Card key={o.id}>
            <CardHeader
              title={
                <span className="flex items-center gap-2">
                  {o.kind === 'law_firm' ? <Scale className="h-4 w-4 text-purple-600" /> : <Building2 className="h-4 w-4 text-brand-600" />}
                  {o.name}
                </span>
              }
              action={<Badge tone={o.kind === 'law_firm' ? 'purple' : 'indigo'}>{o.kind === 'law_firm' ? '律师事务所' : '企业'}</Badge>}
            />
            <ul>
              {s.users
                .filter((u) => u.orgId === o.id)
                .map((u) => (
                  <li key={u.id} className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5 first:border-t-0">
                    <div className="flex items-center gap-3">
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-sm font-medium">{u.name.slice(0, 1)}</span>
                      <div>
                        <p className="font-medium">
                          {u.name}
                          {u.id === me.id && <span className="ml-2 text-xs text-brand-600">（当前账号）</span>}
                        </p>
                        <p className="text-xs text-ink-500">{u.title}</p>
                      </div>
                    </div>
                    <Badge tone={u.role === 'legal' ? 'blue' : u.role === 'external_counsel' ? 'purple' : 'gray'}>{ROLE_LABEL[u.role]}</Badge>
                  </li>
                ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  )
}
