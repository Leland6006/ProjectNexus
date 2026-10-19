import { clausesFingerprint } from './terms.ts'
// Fictional demo data. All companies, people and contract text are invented.

import { CURRENT_SCHEMA_VERSION } from './migrations.ts'
import type {
  Activity,
  CashAccount,
  Claim,
  Clause,
  Comment,
  Contract,
  ContractVersion,
  CostItem,
  Database,
  Message,
  Milestone,
  Organization,
  PaymentTerms,
  Proposal,
  Suggestion,
  Transaction,
  User
} from './types.ts'

const ts = (md: string, hm = '09:00'): string => `2026-${md}T${hm}:00.000Z`

export const ORG_A = 'org_qiming' // 启明智能科技有限公司
export const ORG_B = 'org_yuanhang' // 远航精密制造有限公司
export const ORG_C = 'org_huaxin' // 华信企业服务有限公司
export const ORG_LAW = 'org_mingheng' // 明衡律师事务所

export const DEFAULT_USER_ID = 'u_a_biz'

const organizations: Organization[] = [
  { id: ORG_A, name: '启明智能科技有限公司', shortName: '启明智能', kind: 'company' },
  { id: ORG_B, name: '远航精密制造有限公司', shortName: '远航精密', kind: 'company' },
  { id: ORG_C, name: '华信企业服务有限公司', shortName: '华信服务', kind: 'company' },
  { id: ORG_LAW, name: '明衡律师事务所', shortName: '明衡律所', kind: 'law_firm' }
]

const users: User[] = [
  { id: 'u_a_biz', name: '陈思远', orgId: ORG_A, role: 'business', title: '商务经理' },
  { id: 'u_a_legal', name: '林静怡', orgId: ORG_A, role: 'legal', title: '法务主管' },
  { id: 'u_b_biz', name: '王志诚', orgId: ORG_B, role: 'business', title: '销售总监' },
  { id: 'u_b_legal', name: '赵雅琪', orgId: ORG_B, role: 'legal', title: '法务经理' },
  { id: 'u_a_counsel', name: '周明哲', orgId: ORG_LAW, role: 'external_counsel', title: '合伙人律师' },
  { id: 'u_c_biz', name: '孙晓彤', orgId: ORG_C, role: 'business', title: '项目经理' }
]

// ---------- Transaction 1: 智能设备采购项目 (full demo) ----------

const c = (id: string, title: string, body: string): Clause => ({ id, title, body })

const V1_CLAUSES: Clause[] = [
  c('cl_e1', '第一条 合同标的', '<p>供方向需方出售智能巡检机器人共计 20 台，型号为 YH-R300，单价及规格详见附件一《设备清单》。</p>'),
  c('cl_e2', '第二条 合同价款与付款', '<p>合同总价款为人民币 1,280,000 元（含税）。需方按以下节点付款：</p><ul><li>合同签订后 5 个工作日内支付 10% 预付款；</li><li>设备验收合格后 10 个工作日内支付剩余 90% 款项。</li></ul>'),
  c('cl_e3', '第三条 交付与验收', '<p>供方应在预付款到账后 30 日内将设备交付至需方指定地点。需方应在收货后 7 日内完成验收，逾期未提出书面异议的，视为验收合格。</p>'),
  c('cl_e4', '第四条 质量保证', '<p>供方保证设备为全新、合格产品，质保期为验收合格之日起 12 个月。质保期内因设备本身质量问题造成的故障，供方应免费维修或更换。</p>'),
  c('cl_e5', '第五条 违约责任', '<p>任何一方逾期履行义务的，每逾期一日，应按逾期金额的万分之五向对方支付违约金，违约金总额不超过合同总价款的 10%。</p>')
]

const CONFIDENTIAL = c(
  'cl_e6',
  '第六条 保密义务',
  '<p>双方对在本合同履行过程中知悉的对方技术资料、报价及商业信息负有保密义务，未经对方书面同意不得向第三方披露，保密期限至合同终止后 3 年。</p>'
)
const V2_CLAUSES: Clause[] = [
  ...V1_CLAUSES.slice(0, 1),
  c('cl_e2', '第二条 合同价款与付款', '<p>合同总价款为人民币 1,280,000 元（含税）。需方按以下节点付款：</p><ul><li>合同签订后 5 个工作日内支付 10% 预付款；</li><li>设备验收合格后 10 个工作日内支付剩余 90% 款项，供方应在付款前开具合法有效的增值税专用发票。</li></ul>'),
  ...V1_CLAUSES.slice(2),
  CONFIDENTIAL
]
const V3_CLAUSES: Clause[] = V2_CLAUSES.map((cl) =>
  cl.id === 'cl_e2' ? c(cl.id, cl.title, cl.body.replace('50% 预付款', '10% 预付款').replace('50% 款项', '90% 款项')) :
  cl.id === 'cl_e3'
    ? c('cl_e3', '第三条 交付与验收', '<p>供方应在预付款到账后 45 日内将设备交付至需方指定地点。需方应在收货后 7 日内完成验收，逾期未提出书面异议的，视为验收合格。</p>')
    : cl
)

const ver = (
  id: string,
  contractId: string,
  number: number,
  label: string,
  note: string,
  clauses: Clause[],
  authorId: string,
  createdAt: string,
  paymentTerms: PaymentTerms | null = null
): ContractVersion => ({ id, contractId, number, label, note, clauses, paymentTerms, authorId, createdAt })

const transactions: Transaction[] = [
  {
    id: 'tx_equip',
    name: '智能设备采购项目',
    type: '设备采购',
    initiatorOrgId: ORG_A,
    counterpartyOrgId: ORG_B,
    amount: 1_280_000,
    currency: 'CNY',
    expectedSignDate: '2026-11-05',
    description: '远航精密向启明智能采购 20 台智能巡检机器人，启明为供方，用于华东仓储中心的自动化巡检升级（演示数据）。',
    status: 'negotiating',
    counterpartyStatus: 'joined',
    counselGrants: [{ userId: 'u_a_counsel', grantedByOrgId: ORG_A, grantedByUserId: 'u_a_legal', grantedAt: ts('10-12', '10:00') }],
    createdBy: 'u_a_biz',
    createdAt: ts('10-03'),
    updatedAt: ts('10-16', '15:30')
  },
  {
    id: 'tx_service',
    name: '技术服务外包项目',
    type: '技术服务',
    initiatorOrgId: ORG_A,
    counterpartyOrgId: ORG_C,
    amount: 560_000,
    currency: 'CNY',
    expectedSignDate: '2026-12-01',
    description: '启明智能委托华信服务提供企业内部协同系统的实施与运维支持（演示数据）。',
    status: 'draft',
    counterpartyStatus: 'invited',
    counselGrants: [],
    createdBy: 'u_a_biz',
    createdAt: ts('10-14'),
    updatedAt: ts('10-14', '14:00')
  },
  {
    id: 'tx_nda',
    name: '供应商保密协议项目',
    type: '保密协议',
    initiatorOrgId: ORG_B,
    counterpartyOrgId: ORG_A,
    amount: 0,
    currency: 'CNY',
    expectedSignDate: '2026-10-25',
    description: '远航精密与启明智能在正式采购前签署双向保密协议（演示数据）。',
    status: 'pending_signature',
    counterpartyStatus: 'joined',
    counselGrants: [],
    createdBy: 'u_b_biz',
    createdAt: ts('09-28'),
    updatedAt: ts('10-10', '11:00')
  }
]

/**
 * Structured mirror of ct_equip's payment clause. See types.ts for why this exists.
 *
 * The demo hinges on these two: the counterparty pushed the prepayment from 50% down
 * to 10% in v3, which is what the agent graph reacts to. Without the numbers being
 * fields rather than prose, no amount of model calling can compute the cash gap.
 */
const EQUIP_TERMS: PaymentTerms = { prepayRate: 0.5, instalments: [], settlementDays: 15, payerOrgId: ORG_B, acceptanceDate: '2026-12-05', verifiedClausesFingerprint: clausesFingerprint(V3_CLAUSES) }
const EQUIP_TERMS_REVISED: PaymentTerms = { prepayRate: 0.1, instalments: [], settlementDays: 15, payerOrgId: ORG_B, acceptanceDate: '2026-12-05', verifiedClausesFingerprint: clausesFingerprint(V3_CLAUSES) }

const contracts: Contract[] = [
  {
    id: 'ct_equip',
    transactionId: 'tx_equip',
    title: '智能巡检机器人采购合同',
    status: 'negotiating',
    clauses: V3_CLAUSES,
    // Mirrors v3: the counterparty's 10% prepayment demand, not our opening 50%.
    paymentTerms: EQUIP_TERMS_REVISED,
    sharedWithCounterparty: true,
    sharedAt: ts('10-08'),
    finalVersionId: null,
    finalConfirmedBy: [],
    createdBy: 'u_a_biz',
    createdAt: ts('10-03', '10:00'),
    updatedAt: ts('10-14', '16:00')
  },
  {
    id: 'ct_service',
    transactionId: 'tx_service',
    title: '企业协同系统技术服务合同',
    status: 'draft',
    clauses: [
      c('cl_s1', '第一条 服务内容', '<p>服务方按照附件《需求说明书》向委托方提供系统实施与运维支持服务。</p>'),
      c('cl_s2', '第二条 服务费用与支付', '<p>服务费用共计人民币 560,000 元，按里程碑分期支付。</p>')
    ],
    paymentTerms: null,
    sharedWithCounterparty: false,
    sharedAt: null,
    finalVersionId: null,
    finalConfirmedBy: [],
    createdBy: 'u_a_biz',
    createdAt: ts('10-14', '14:30'),
    updatedAt: ts('10-14', '14:30')
  },
  {
    id: 'ct_nda',
    transactionId: 'tx_nda',
    title: '双向保密协议',
    status: 'finalized',
    clauses: [
      c('cl_n1', '第一条 保密信息的定义', '<p>保密信息是指一方向另一方披露的、具有商业价值且未公开的技术、经营及财务信息。</p>'),
      c('cl_n2', '第二条 保密义务', '<p>接收方应以不低于保护自身同类信息的谨慎程度保护保密信息，不得向任何第三方披露。</p>'),
      c('cl_n3', '第三条 保密期限', '<p>保密义务自本协议签署之日起生效，最长不超过 5 年。</p>')
    ],
    paymentTerms: null,
    sharedWithCounterparty: true,
    sharedAt: ts('09-29'),
    finalVersionId: 'ver_nda1',
    finalConfirmedBy: [ORG_B, ORG_A],
    createdBy: 'u_b_biz',
    createdAt: ts('09-28', '10:00'),
    updatedAt: ts('10-10', '11:00')
  }
]

const versions: ContractVersion[] = [
  ver('ver_e1', 'ct_equip', 1, '初稿', '启明内部起草，基于「设备采购合同」模板', V1_CLAUSES, 'u_a_biz', ts('10-05', '11:00'), EQUIP_TERMS),
  ver('ver_e2', 'ct_equip', 2, '发送对方版本', '补充发票要求与保密条款后发送远航', V2_CLAUSES, 'u_a_legal', ts('10-08', '16:00'), EQUIP_TERMS),
  ver(
    'ver_e3',
    'ct_equip',
    3,
    '第二轮协商稿',
    '接受远航关于交付周期的修改建议；对方要求预付款由 50% 降至 10%',
    V3_CLAUSES,
    'u_a_biz',
    ts('10-14', '16:00'),
    EQUIP_TERMS_REVISED
  ),
  ver('ver_s1', 'ct_service', 1, '初稿', '空白合同起草', contracts[1].clauses, 'u_a_biz', ts('10-14', '14:30')),
  ver('ver_nda1', 'ct_nda', 1, '签署版', '双方确认的最终版本', contracts[2].clauses, 'u_b_biz', ts('10-09', '15:00'))
]

const cm = (
  id: string,
  clauseId: string,
  authorId: string,
  orgId: string,
  visibility: Comment['visibility'],
  body: string,
  createdAt: string,
  parentId: string | null = null
): Comment => ({ id, contractId: 'ct_equip', clauseId, parentId, authorId, orgId, body, visibility, createdAt })

const comments: Comment[] = [
  cm('cm_1', 'cl_e3', 'u_b_biz', ORG_B, 'shared', '考虑到供方提出的传感器备货周期，需方可以讨论放宽至 45 日，但请保证首批交付。', ts('10-10', '10:20')),
  cm('cm_2', 'cl_e3', 'u_a_biz', ORG_A, 'shared', '供方会优先安排首批 10 台，并接受对整体 45 日交付方案的修改建议。', ts('10-10', '14:05'), 'cm_1'),
  cm('cm_3', 'cl_e5', 'u_a_legal', ORG_A, 'internal', '【内部】违约金上限 10% 是我方底线，建议不要让步；如果对方坚持，可以用延长付款账期作交换。', ts('10-11', '09:40')),
  cm('cm_4', 'cl_e5', 'u_a_counsel', ORG_A, 'counsel', '【律师意见】万分之五的日违约金折算年化约 18%，在司法实践中通常可被支持，但超过实际损失 30% 时存在被调减的风险。建议保留 10% 总额上限，并增加“以实际损失为限”的表述。', ts('10-13', '11:15')),
  cm('cm_5', 'cl_e4', 'u_b_legal', ORG_B, 'internal', '【内部】请核实供方核心部件供应商的质保与整机质保是否一致，避免后续履约争议。', ts('10-11', '16:30')),
  cm('cm_6', 'cl_e2', 'u_b_legal', ORG_B, 'shared', '付款条款没有问题，请确认发票开具时点是否与验收时间一致。', ts('10-09', '09:30')),
  cm('cm_7', 'cl_e2', 'u_a_legal', ORG_A, 'shared', '已在第二版中补充：发票应在付款前开具。', ts('10-09', '10:10'), 'cm_6')
]

const suggestions: Suggestion[] = [
  {
    id: 'sg_1',
    contractId: 'ct_equip',
    clauseId: 'cl_e3',
    authorId: 'u_b_biz',
    orgId: ORG_B,
    originalBody: V2_CLAUSES[2].body,
    proposedBody: V3_CLAUSES[2].body,
    reason: '核心传感器备货周期较长，请将交付期调整为 45 日。',
    status: 'accepted',
    resolvedBy: 'u_a_biz',
    resolvedAt: ts('10-14', '15:50'),
    createdAt: ts('10-10', '11:00')
  },
  {
    id: 'sg_2',
    contractId: 'ct_equip',
    clauseId: 'cl_e4',
    authorId: 'u_b_biz',
    orgId: ORG_B,
    originalBody: V2_CLAUSES[3].body,
    proposedBody: '<p>供方保证设备为全新、合格产品，质保期为验收合格之日起 6 个月。质保期内因设备本身质量问题造成的故障，供方应免费维修或更换。</p>',
    reason: '建议将质保期调整为 6 个月，与同类设备市场惯例保持一致。',
    status: 'rejected',
    resolvedBy: 'u_a_legal',
    resolvedAt: ts('10-14', '15:55'),
    createdAt: ts('10-10', '11:10')
  },
  {
    id: 'sg_3',
    contractId: 'ct_equip',
    clauseId: 'cl_e5',
    authorId: 'u_b_biz',
    orgId: ORG_B,
    originalBody: V3_CLAUSES[4].body,
    proposedBody: '<p>任何一方逾期履行义务的，每逾期一日，应按逾期金额的万分之五向对方支付违约金，违约金总额不超过合同总价款的 5%。</p>',
    reason: '将违约金总额上限从 10% 调整为 5%，双方风险更对等。',
    status: 'pending',
    resolvedBy: null,
    resolvedAt: null,
    createdAt: ts('10-16', '14:20')
  }
]

const messages: Message[] = [
  { id: 'msg_1', transactionId: 'tx_equip', authorId: 'u_a_biz', orgId: ORG_A, visibility: 'shared', body: '王总好，合同初稿已共享给贵司，请法务同事先过目，有意见可以直接在条款上批注。', createdAt: ts('10-08', '16:10') },
  { id: 'msg_2', transactionId: 'tx_equip', authorId: 'u_b_biz', orgId: ORG_B, visibility: 'shared', body: '收到，我们今天内部过一遍，主要想确认交付周期和质保。', createdAt: ts('10-09', '09:20') },
  { id: 'msg_3', transactionId: 'tx_equip', authorId: 'u_b_biz', orgId: ORG_B, visibility: 'internal', body: '【内部】对方价格已经比较紧，优先守住交付周期，质保可以作为交换条件。', createdAt: ts('10-09', '10:30') },
  { id: 'msg_4', transactionId: 'tx_equip', authorId: 'u_a_biz', orgId: ORG_A, visibility: 'internal', body: '【内部】采购预算上限 130 万，对方现价 128 万，付款节点不要再让步。', createdAt: ts('10-09', '11:00') },
  { id: 'msg_5', transactionId: 'tx_equip', authorId: 'u_a_biz', orgId: ORG_A, visibility: 'shared', body: '交付期 45 日的修改已接受，第二轮协商稿已保存为 v3，请查收。', createdAt: ts('10-14', '16:05') }
]

const ms = (
  id: string,
  name: string,
  responsibleOrgId: string,
  dueDate: string,
  status: Milestone['status'],
  note: string,
  paymentAmount = 0
): Milestone => ({ id, transactionId: 'tx_equip', name, responsibleOrgId, dueDate, status, note, paymentAmount, createdBy: 'u_a_biz', createdAt: ts('10-12', '09:00') })

const milestones: Milestone[] = [
  ms('ms_1', '支付 10% 预付款', ORG_B, '2026-11-05', 'in_progress', '拟定付款安排，尚未核对到账。', 128_000),
  ms('ms_2', '交付第一批设备（10 台）', ORG_A, '2026-11-20', 'pending', '首批设备运至华东仓储中心。'),
  ms('ms_3', '完成验收', ORG_B, '2026-12-05', 'pending', '收货后 7 日内完成验收。'),
  ms('ms_4', '支付剩余 90% 款项', ORG_B, '2026-12-20', 'pending', '预计验收后 15 日支付，需先核对发票资料。', 1_152_000)
]

const act = (
  id: string,
  transactionId: string,
  contractId: string | null,
  actorId: string,
  orgId: string,
  type: Activity['type'],
  summary: string,
  visibility: Activity['visibility'],
  createdAt: string
): Activity => ({ id, transactionId, contractId, actorId, orgId, type, summary, visibility, createdAt })

const activities: Activity[] = [
  act('a_1', 'tx_equip', null, 'u_a_biz', ORG_A, 'transaction_created', '陈思远 创建了交易项目「智能设备采购项目」', 'internal', ts('10-03')),
  act('a_2', 'tx_equip', 'ct_equip', 'u_a_biz', ORG_A, 'contract_created', '陈思远 创建了合同「智能巡检机器人采购合同」', 'internal', ts('10-03', '10:00')),
  act('a_3', 'tx_equip', 'ct_equip', 'u_a_biz', ORG_A, 'version_saved', '陈思远 保存了版本 v1「初稿」', 'internal', ts('10-05', '11:00')),
  act('a_4', 'tx_equip', null, 'u_a_biz', ORG_A, 'counterparty_invited', '陈思远 邀请 远航精密制造有限公司 加入交易项目', 'shared', ts('10-08', '09:00')),
  act('a_5', 'tx_equip', 'ct_equip', 'u_a_biz', ORG_A, 'contract_shared', '陈思远 将合同「智能巡检机器人采购合同」共享给 远航精密制造有限公司', 'shared', ts('10-08', '09:30')),
  act('a_6', 'tx_equip', 'ct_equip', 'u_a_legal', ORG_A, 'version_saved', '林静怡 保存了版本 v2「发送对方版本」', 'shared', ts('10-08', '16:00')),
  act('a_7', 'tx_equip', null, 'u_b_biz', ORG_B, 'counterparty_joined', '王志诚 代表 远航精密制造有限公司 加入了交易项目', 'shared', ts('10-09', '09:00')),
  act('a_8', 'tx_equip', 'ct_equip', 'u_b_legal', ORG_B, 'comment_added', '赵雅琪 评论了「第二条 合同价款与付款」', 'shared', ts('10-09', '09:30')),
  act('a_9', 'tx_equip', 'ct_equip', 'u_a_legal', ORG_A, 'comment_replied', '林静怡 回复了「第二条 合同价款与付款」', 'shared', ts('10-09', '10:10')),
  act('a_10', 'tx_equip', 'ct_equip', 'u_b_biz', ORG_B, 'comment_added', '王志诚 评论了「第三条 交付与验收」', 'shared', ts('10-10', '10:20')),
  act('a_11', 'tx_equip', 'ct_equip', 'u_b_biz', ORG_B, 'suggestion_created', '王志诚 对「第三条 交付与验收」提出了修改建议', 'shared', ts('10-10', '11:00')),
  act('a_12', 'tx_equip', 'ct_equip', 'u_b_biz', ORG_B, 'suggestion_created', '王志诚 对「第四条 质量保证」提出了修改建议', 'shared', ts('10-10', '11:10')),
  act('a_13', 'tx_equip', 'ct_equip', 'u_a_legal', ORG_A, 'comment_added', '林静怡 评论了「第五条 违约责任」', 'internal', ts('10-11', '09:40')),
  act('a_14', 'tx_equip', 'ct_equip', 'u_b_legal', ORG_B, 'comment_added', '赵雅琪 评论了「第四条 质量保证」', 'internal', ts('10-11', '16:30')),
  act('a_15', 'tx_equip', null, 'u_a_legal', ORG_A, 'counsel_invited', '林静怡 邀请外部律师 周明哲 参与本交易', 'counsel', ts('10-12', '10:00')),
  act('a_16', 'tx_equip', 'ct_equip', 'u_a_counsel', ORG_A, 'comment_added', '周明哲 评论了「第五条 违约责任」', 'counsel', ts('10-13', '11:15')),
  act('a_17', 'tx_equip', 'ct_equip', 'u_a_biz', ORG_A, 'suggestion_accepted', '陈思远 接受了对「第三条 交付与验收」的修改建议', 'shared', ts('10-14', '15:50')),
  act('a_18', 'tx_equip', 'ct_equip', 'u_a_legal', ORG_A, 'suggestion_rejected', '林静怡 拒绝了对「第四条 质量保证」的修改建议', 'shared', ts('10-14', '15:55')),
  act('a_19', 'tx_equip', 'ct_equip', 'u_a_biz', ORG_A, 'version_saved', '陈思远 保存了版本 v3「第二轮协商稿」', 'shared', ts('10-14', '16:00')),
  act('a_20', 'tx_equip', 'ct_equip', 'u_b_biz', ORG_B, 'suggestion_created', '王志诚 对「第五条 违约责任」提出了修改建议', 'shared', ts('10-16', '14:20')),
  act('a_21', 'tx_service', null, 'u_a_biz', ORG_A, 'transaction_created', '陈思远 创建了交易项目「技术服务外包项目」', 'internal', ts('10-14')),
  act('a_22', 'tx_service', null, 'u_a_biz', ORG_A, 'counterparty_invited', '陈思远 邀请 华信企业服务有限公司 加入交易项目', 'shared', ts('10-14', '14:00')),
  act('a_23', 'tx_service', 'ct_service', 'u_a_biz', ORG_A, 'contract_created', '陈思远 创建了合同「企业协同系统技术服务合同」', 'internal', ts('10-14', '14:30')),
  act('a_24', 'tx_nda', null, 'u_b_biz', ORG_B, 'transaction_created', '王志诚 创建了交易项目「供应商保密协议项目」', 'internal', ts('09-28')),
  act('a_25', 'tx_nda', 'ct_nda', 'u_b_biz', ORG_B, 'contract_shared', '王志诚 将合同「双向保密协议」共享给 启明智能科技有限公司', 'shared', ts('09-29')),
  act('a_26', 'tx_nda', 'ct_nda', 'u_b_biz', ORG_B, 'final_confirmed', '双方已确认合同最终版本 v1', 'shared', ts('10-10', '11:00'))
]

// The service layer keeps the invariant "a shared contract's counterparty has joined/been invited".
// tx_service is 'invited' with an unshared contract, which is a valid draft state.

const costItems: CostItem[] = [
  {
    id: 'cost_1',
    transactionId: 'tx_equip',
    orgId: ORG_A,
    name: '核心传感器备货款',
    amount: 620_000,
    dueDate: '2026-11-10',
    status: 'committed',
    visibility: 'internal',
    createdBy: 'u_a_biz',
    createdAt: ts('10-16', '09:30')
  },
  {
    id: 'cost_2',
    transactionId: 'tx_equip',
    orgId: ORG_A,
    name: '现场实施人工',
    amount: 96_000,
    dueDate: '2026-12-01',
    status: 'planned',
    visibility: 'internal',
    createdBy: 'u_a_biz',
    createdAt: ts('10-16', '09:35')
  }
]

const cashAccounts: CashAccount[] = [
  { id: 'cash_a', orgId: ORG_A, label: '基本存款账户', openingBalance: 150_000, asOf: '2026-10-18' }
]

// Company memory is normally empty at install: claims are written by agents and promoted
// by people. The demo ships the one worked example the product exists for — the
// counterparty cut the prepayment from 50% to 10% in v3 — so the centre is not blank on
// first launch and the whole chain (fact / inference / recommendation) can be inspected.
const claims: Claim[] = [
  {
    id: 'cl_demo_prepay',
    orgId: ORG_A,
    transactionId: 'tx_equip',
    key: 'payment.prepay_amount',
    label: '预付款金额',
    value: '¥128,000',
    numeric: 128_000,
    unit: 'CNY',
    status: 'confirmed',
    source: { kind: 'contract', ref: 'ct_equip', detail: '按合同金额 ¥1,280,000 与预付款比例 10% 计算' },
    asOf: ts('10-14', '16:00'),
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  },
  {
    id: 'cl_demo_gap',
    orgId: ORG_A,
    transactionId: 'tx_equip',
    key: 'cash.gap',
    label: '预计资金缺口',
    value: '¥438,000',
    numeric: 438_000,
    unit: 'CNY',
    status: 'inferred',
    source: { kind: 'agent', ref: 'finance', detail: '按 11-10 备货款、12-01 人工成本、12-20 尾款与现金余额测算' },
    asOf: ts('10-16', '09:40'),
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  },
  {
    id: 'cl_demo_legal',
    orgId: ORG_A,
    transactionId: 'tx_equip',
    key: 'risk.legal.0',
    label: '法务风险提示',
    value: '预付款降至 10% 后，我方先履行义务而缺少付款保障，建议补充验收期限与逾期付款违约责任。',
    numeric: null,
    unit: null,
    status: 'inferred',
    source: { kind: 'agent', ref: 'legal' },
    asOf: ts('10-16', '09:40'),
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  },
  {
    id: 'cl_demo_ops',
    orgId: ORG_A,
    transactionId: 'tx_equip',
    key: 'ops.plan.0',
    label: '经营应对建议',
    value: '将备货启动时间推迟至预付款到账后，或改为按交付批次分阶段收款。',
    numeric: null,
    unit: null,
    status: 'recommended',
    source: { kind: 'agent', ref: 'ops' },
    asOf: ts('10-16', '09:40'),
    visibility: 'internal',
    supersededById: null,
    confirmedBy: null,
    confirmedAt: null
  }
]

const proposals: Proposal[] = [
  {
    id: 'pp_demo_prepay',
    transactionId: 'tx_equip',
    contractId: 'ct_equip',
    orgId: ORG_A,
    title: '预付款由 50% 降至 10%，12 月 1 日存在 ¥438,000 资金缺口',
    rationale: [
      '预付款 ¥128,000，可动用现金 ¥150,000。',
      '预计在 2026-12-01 出现资金缺口 ¥438,000（最低余额 ¥-438,000）。',
      '本次变更使预付款减少 ¥512,000。',
      '法务：预付款降至 10% 后缺少付款保障，建议补充验收期限与逾期违约责任。',
      '经营：可将备货启动推迟至预付款到账后，或改为按交付批次分阶段收款。'
    ].join('\n'),
    actions: [
      { kind: 'counter_offer', title: '向对方提出 40% 预付款的反报价', detail: '财务测算：40% 预付款（¥512,000）可覆盖 11-10 的备货支出，且不改变尾款账期。' },
      { kind: 'revise_clause', title: '补充验收期限与逾期付款违约责任条款', detail: '法务：若对方坚持 10% 预付款，需以验收期限和违约金条款替代付款保障。' },
      { kind: 'add_task', title: '将备货启动推迟至预付款到账后', detail: '经营：在预付款到账前不触发传感器备货，避免先垫付 ¥620,000。' }
    ],
    claimIds: ['cl_demo_prepay', 'cl_demo_gap', 'cl_demo_legal', 'cl_demo_ops'],
    eventId: null,
    status: 'pending',
    createdBy: 'agent:main',
    createdAt: ts('10-16', '09:40'),
    resolvedBy: null,
    resolvedAt: null,
    baseVersionId: 'ver_e3'
  }
]

export function createSeedDatabase(): Database {
  // Deep copy so callers can mutate freely without touching module-level constants.
  return structuredClone({
    schemaVersion: CURRENT_SCHEMA_VERSION,
    organizations,
    users,
    transactions,
    contracts,
    versions,
    comments,
    suggestions,
    messages,
    milestones,
    activities,
    costItems,
    cashAccounts,
    claims,
    proposals,
    // No chat history is shipped: an invented conversation would look like real advice.
    conversations: [],
    chatMessages: [],
    analysisRuns: [],
    tasks: [],
    counterparties: [],
    importDrafts: [],
    internalReviews: [],
    cashPlans: [],
    cashEntries: [],
    invoiceCases: []
  })
}
