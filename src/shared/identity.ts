export type IdentityRole = 'owner' | 'admin' | 'business' | 'finance' | 'legal' | 'readonly'

export const IDENTITY_ROLE_LABEL: Record<IdentityRole, string> = {
  owner: '企业所有者',
  admin: '管理员',
  business: '业务',
  finance: '财务',
  legal: '法务',
  readonly: '只读'
}

export interface IdentityAccount {
  id: string
  name: string
  email: string
}
export interface IdentityCompany {
  id: string
  name: string
  shortName: string
  role: IdentityRole
}
export interface IdentityStatus {
  account: IdentityAccount | null
  companies: IdentityCompany[]
  actingOrgId: string | null
  configured: boolean
}
export interface IdentitySession {
  id: string
  createdAt: string
  current: boolean
}
export interface IdentityMember {
  id: string
  userId: string
  name: string
  email: string
  role: IdentityRole
  status: string
}
export interface IdentityInvitation {
  id: string
  email: string
  role: IdentityRole
  status: string
  expiresAt: string
  orgId: string
  orgName: string
}
export type IdentityPartnerStatus =
  'pending' | 'accepted' | 'rejected' | 'withdrawn' | 'disconnected'
export interface IdentityPartner {
  id: string
  requesterOrgId: string
  recipientOrgId: string
  partner: { id: string; name: string; shortName: string }
  status: IdentityPartnerStatus
  revision: number
  createdAt: string
}
export interface IdentityPartners {
  partners: IdentityPartner[]
}
export interface PartnerMessage {
  id: string
  relationshipId: string
  authorId: string
  orgId: string
  body: string
  createdAt: string
}
export interface PartnerMessages {
  messages: PartnerMessage[]
}

export type IdentityResult<T = unknown> =
  { ok: true; data: T } | { ok: false; code: string; message: string }
