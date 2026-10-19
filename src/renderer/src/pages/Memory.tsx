import { useMemo } from 'react'
import { sortClaimsByStatus, unconfirmedClaims } from '@shared/proposalView'
import type { Claim } from '@shared/types'
import { Card, CardHeader, EmptyState, PageHeader } from '@/components/ui'
import { NotEnabled } from '@/components/StatusNote'
import { currentUser, orgOf } from '@/lib/selectors'
import type { MemoryView } from '@/routes'
import { useView } from '@/store'
import Organization from './Organization'
import { ClaimRow } from './Proposals'

/** Claims grouped by business, company-wide facts first. */
function ClaimGroups({ claims, dense }: { claims: Claim[]; dense?: boolean }) {
  const s = useView()
  const groups = useMemo(() => {
    const map = new Map<string, Claim[]>()
    for (const c of sortClaimsByStatus(claims)) {
      const key = c.transactionId ?? ''
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0))
  }, [claims])
  return (
    <div className="space-y-4">
      {groups.map(([key, list]) => (
        <Card key={key || 'company'}>
          <CardHeader title={key ? s.transactions.find((t) => t.id === key)?.name ?? '业务项目' : '公司层面'} subtitle={`${list.length} 条`} />
          <ul className="space-y-1.5 px-4 py-3">
            {list.map((c) => (
              <ClaimRow key={c.id} claim={c} dense={dense} />
            ))}
          </ul>
        </Card>
      ))}
    </div>
  )
}

const PROFILE_FIELDS = ['所属行业', '主营业务', '经营目标', '团队规模', '注册地区']

function Profile() {
  const s = useView()
  const me = currentUser(s)
  const org = orgOf(s, me.orgId)
  const members = s.users.filter((u) => u.orgId === me.orgId).length
  return (
    <div className="mx-auto max-w-3xl p-6">
      <PageHeader title="公司资料" subtitle="Nexus 回答和整理信息时依据的企业背景" />
      <Card>
        <CardHeader title="基本信息" subtitle="来源：演示数据中的企业登记信息" />
        <dl className="divide-y divide-slate-100 text-sm">
          {[
            ['企业名称', org?.name],
            ['简称', org?.shortName],
            ['类型', org?.kind === 'law_firm' ? '律师事务所' : '企业'],
            ['成员', `${members} 人`]
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-ink-500">{k}</dt>
              <dd className="text-right font-medium text-ink-900">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <Card className="mt-4">
        <CardHeader title="经营信息" subtitle="尚未填写的项目显示“待补充”，Nexus 不会自行推测" />
        <dl className="divide-y divide-slate-100 text-sm">
          {PROFILE_FIELDS.map((k) => (
            <div key={k} className="flex justify-between gap-4 px-4 py-2.5">
              <dt className="text-ink-500">{k}</dt>
              <dd className="text-ink-400">待补充</dd>
            </div>
          ))}
        </dl>
        <p className="border-t border-slate-100 px-4 py-2.5 text-xs text-ink-500">编辑公司资料将在第二轮提供。</p>
      </Card>
    </div>
  )
}

function Confirmed() {
  const s = useView()
  const claims = s.claims.filter((c) => c.status === 'confirmed' && !c.supersededById)
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="已确认信息" subtitle="来自合同、账目或经人工确认的事实。Nexus 推理时只把这些当作前提。" />
      {claims.length === 0 ? (
        <Card>
          <EmptyState title="还没有已确认的信息" hint="在「待核实信息」中逐条确认后，会出现在这里" />
        </Card>
      ) : (
        <ClaimGroups claims={claims} />
      )}
    </div>
  )
}

function Unverified() {
  const s = useView()
  const queue = unconfirmedClaims(s.claims)
  const history = s.claims.filter((c) => c.supersededById)
  return (
    <div className="mx-auto max-w-4xl p-6">
      <PageHeader title="待核实信息" subtitle="推断、预测和建议在你逐条确认之前不会成为企业事实。采纳一个方案也不会自动确认它们。" />
      {queue.length === 0 ? (
        <Card>
          <EmptyState title="没有待核实的信息" />
        </Card>
      ) : (
        <ClaimGroups claims={queue} />
      )}
      {history.length > 0 && (
        <details className="mt-6">
          <summary className="cursor-pointer text-sm text-ink-500 hover:text-ink-900">历史记录（已被更新的结果替代，仅供追溯）· {history.length} 条</summary>
          <div className="mt-3">
            <ClaimGroups claims={history} dense />
          </div>
        </details>
      )}
    </div>
  )
}

export default function MemoryPage({ view }: { view: MemoryView }) {
  switch (view) {
    case 'profile':
      return <Profile />
    case 'confirmed':
      return <Confirmed />
    case 'unverified':
      return <Unverified />
    case 'library':
      return (
        <div className="mx-auto max-w-3xl p-6">
          <PageHeader title="资料库" />
          <NotEnabled
            title="资料库与专业知识检索"
            detail="还不能上传企业资料，也没有接入专业知识检索。后续会按适用地区、适用对象、生效时间和出处管理资料，回答时注明引用来源。"
          />
        </div>
      )
    case 'members':
      return <Organization />
  }
}
