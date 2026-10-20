// 003 是固定的服务端存储迁移；不要随客户端 schemaVersion 修改已发布 SQL。
const textColumn = (column: string, field: string, required = true) => `${column} text GENERATED ALWAYS AS (payload->>'${field}') STORED${required ? ' NOT NULL' : ''}`
const identityColumn = (column: string, field: string, required = true) => `${textColumn(column, field, required)} REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED`
const orgColumn = (field = 'orgId') => `${textColumn('org_id', field)} REFERENCES organizations(id)`
const payload = `id text PRIMARY KEY CHECK (length(id)>0), payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND (payload->>'id') IS NOT DISTINCT FROM id)`
const txColumn = (required = true) => `${textColumn('transaction_id', 'transactionId', required)} REFERENCES business_transactions(id) DEFERRABLE INITIALLY DEFERRED`
const contractColumn = (required = true) => `${textColumn('contract_id', 'contractId', required)} REFERENCES business_contracts(id) DEFERRABLE INITIALLY DEFERRED`
const table = (name: string, columns: string) => `CREATE TABLE business_${name} (${payload}, ${columns});`

export const BUSINESS_TABLES = {
  transactions: 'business_transactions', contracts: 'business_contracts', versions: 'business_versions',
  comments: 'business_comments', suggestions: 'business_suggestions', messages: 'business_messages',
  milestones: 'business_milestones', activities: 'business_activities', costItems: 'business_cost_items',
  cashAccounts: 'business_cash_accounts', claims: 'business_claims', proposals: 'business_proposals'
} as const

const definitions = [
  table('transactions', `${textColumn('initiator_org_id', 'initiatorOrgId')} REFERENCES organizations(id),
    ${textColumn('counterparty_org_id', 'counterpartyOrgId')} REFERENCES organizations(id),
    ${textColumn('counterparty_status', 'counterpartyStatus')} CHECK (counterparty_status IN ('none','invited','joined')),
    ${identityColumn('created_by', 'createdBy')}, CHECK (initiator_org_id<>counterparty_org_id)`),
  table('contracts', `${txColumn()}, ${identityColumn('created_by', 'createdBy')},
    ${textColumn('final_version_id', 'finalVersionId', false)}, UNIQUE(id,transaction_id)`),
  table('versions', `${contractColumn()}, ${identityColumn('author_id', 'authorId')},
    number integer GENERATED ALWAYS AS ((payload->>'number')::integer) STORED NOT NULL CHECK(number>0),
    UNIQUE(contract_id,number), UNIQUE(id,contract_id)`),
  table('comments', `${contractColumn()}, ${orgColumn()}, ${identityColumn('author_id', 'authorId')},
    ${textColumn('parent_id', 'parentId', false)}, UNIQUE(id,contract_id),
    FOREIGN KEY(parent_id,contract_id) REFERENCES business_comments(id,contract_id) DEFERRABLE INITIALLY DEFERRED`),
  table('suggestions', `${contractColumn()}, ${orgColumn()}, ${identityColumn('author_id', 'authorId')}, ${identityColumn('resolved_by', 'resolvedBy', false)}`),
  table('messages', `${txColumn()}, ${orgColumn()}, ${identityColumn('author_id', 'authorId')}`),
  table('milestones', `${txColumn()}, ${orgColumn('responsibleOrgId')}, ${identityColumn('created_by', 'createdBy')}`),
  table('activities', `${txColumn()}, ${contractColumn(false)}, ${orgColumn()}, ${identityColumn('actor_id', 'actorId')},
    FOREIGN KEY(contract_id,transaction_id) REFERENCES business_contracts(id,transaction_id) DEFERRABLE INITIALLY DEFERRED`),
  table('cost_items', `${txColumn()}, ${orgColumn()}, ${identityColumn('created_by', 'createdBy')}`),
  table('cash_accounts', orgColumn()),
  table('claims', `${txColumn(false)}, ${orgColumn()}, ${textColumn('superseded_by_id', 'supersededById', false)} REFERENCES business_claims(id) DEFERRABLE INITIALLY DEFERRED,
    ${identityColumn('confirmed_by', 'confirmedBy', false)}, UNIQUE(id,org_id),
    source_contract_id text GENERATED ALWAYS AS (CASE WHEN payload->'source'->>'kind'='contract' THEN payload->'source'->>'ref' END) STORED REFERENCES business_contracts(id) DEFERRABLE INITIALLY DEFERRED,
    source_transaction_id text GENERATED ALWAYS AS (CASE WHEN payload->'source'->>'kind'='transaction' THEN payload->'source'->>'ref' END) STORED REFERENCES business_transactions(id) DEFERRABLE INITIALLY DEFERRED,
    source_cost_id text GENERATED ALWAYS AS (CASE WHEN payload->'source'->>'kind'='ledger' THEN payload->'source'->>'ref' END) STORED REFERENCES business_cost_items(id) DEFERRABLE INITIALLY DEFERRED,
    source_user_id text GENERATED ALWAYS AS (CASE WHEN payload->'source'->>'kind'='user' THEN payload->'source'->>'ref' END) STORED REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED`),
  table('proposals', `${txColumn()}, ${contractColumn(false)}, ${orgColumn()}, ${identityColumn('resolved_by', 'resolvedBy', false)},
    ${textColumn('base_version_id', 'baseVersionId', false)},
    created_by text GENERATED ALWAYS AS (CASE WHEN payload->>'createdBy'='agent:main' THEN NULL ELSE payload->>'createdBy' END) STORED REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(id,org_id), FOREIGN KEY(contract_id,transaction_id) REFERENCES business_contracts(id,transaction_id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(base_version_id,contract_id) REFERENCES business_versions(id,contract_id) DEFERRABLE INITIALLY DEFERRED`)
].join('\n')

export const BUSINESS_SCHEMA = `
DO $$ DECLARE snapshot jsonb; field text; BEGIN
  SELECT payload INTO STRICT snapshot FROM business_state WHERE id='singleton' FOR UPDATE;
  IF snapshot <> '{}'::jsonb THEN
    IF snapshot->'schemaVersion' IS DISTINCT FROM '2'::jsonb THEN RAISE EXCEPTION '业务数据版本不受支持'; END IF;
    FOR field IN SELECT jsonb_object_keys(snapshot) LOOP
      IF field <> ALL(ARRAY['schemaVersion','users','organizations',${Object.keys(BUSINESS_TABLES).map((key) => `'${key}'`).join(',')}]) THEN
        RAISE EXCEPTION '业务数据包含未知字段 %',field;
      END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY[${Object.keys(BUSINESS_TABLES).map((key) => `'${key}'`).join(',')}] LOOP
      IF jsonb_typeof(snapshot->field) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION '业务集合格式无效 %',field; END IF;
    END LOOP;
    FOREACH field IN ARRAY ARRAY['users','organizations'] LOOP
      IF snapshot ? field AND jsonb_typeof(snapshot->field)<>'array' THEN RAISE EXCEPTION '业务目录格式无效'; END IF;
    END LOOP;
  END IF;
END $$;
CREATE TABLE business_org_scopes (org_id text PRIMARY KEY REFERENCES organizations(id));
${definitions}
ALTER TABLE business_contracts ADD CONSTRAINT business_final_version_fk FOREIGN KEY(final_version_id,id) REFERENCES business_versions(id,contract_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE business_proposal_claims (
  proposal_id text NOT NULL, claim_id text NOT NULL, org_id text NOT NULL REFERENCES organizations(id),
  PRIMARY KEY(proposal_id,claim_id),
  FOREIGN KEY(proposal_id,org_id) REFERENCES business_proposals(id,org_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(claim_id,org_id) REFERENCES business_claims(id,org_id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE business_counsel_grants (
  transaction_id text NOT NULL REFERENCES business_transactions(id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  user_id text NOT NULL REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED,
  granted_by_org_id text NOT NULL REFERENCES organizations(id),
  granted_by_user_id text NOT NULL REFERENCES identities(id) DEFERRABLE INITIALLY DEFERRED,
  PRIMARY KEY(transaction_id,user_id)
);
CREATE INDEX business_transactions_initiator_idx ON business_transactions(initiator_org_id,id);
CREATE INDEX business_transactions_counterparty_idx ON business_transactions(counterparty_org_id,id) WHERE counterparty_status<>'none';
${Object.entries(BUSINESS_TABLES).filter(([key]) => !['transactions','versions','comments','suggestions','cashAccounts'].includes(key)).map(([, name]) => `CREATE INDEX ${name}_tx_idx ON ${name}(transaction_id,id);`).join('\n')}
${['versions','comments','suggestions'].map((name) => `CREATE INDEX business_${name}_contract_idx ON business_${name}(contract_id,id);`).join('\n')}
CREATE INDEX business_cash_accounts_org_idx ON business_cash_accounts(org_id,id);
CREATE INDEX business_claims_company_idx ON business_claims(org_id,id) WHERE transaction_id IS NULL;
${Object.entries(BUSINESS_TABLES).map(([key, name]) => `INSERT INTO ${name}(id,payload) SELECT item->>'id',item FROM business_state CROSS JOIN LATERAL jsonb_array_elements(COALESCE(payload->'${key}','[]'::jsonb)) AS item;`).join('\n')}
INSERT INTO business_proposal_claims(proposal_id,claim_id,org_id)
 SELECT p.id,claim_id,p.org_id FROM business_proposals p CROSS JOIN LATERAL jsonb_array_elements_text(p.payload->'claimIds') AS claim_id;
INSERT INTO business_counsel_grants(transaction_id,user_id,granted_by_org_id,granted_by_user_id)
 SELECT t.id,g->>'userId',g->>'grantedByOrgId',g->>'grantedByUserId'
 FROM business_transactions t CROSS JOIN LATERAL jsonb_array_elements(t.payload->'counselGrants') AS g;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM business_transactions WHERE jsonb_typeof(payload->'counselGrants') IS DISTINCT FROM 'array')
    OR EXISTS (SELECT 1 FROM business_contracts WHERE jsonb_typeof(payload->'finalConfirmedBy') IS DISTINCT FROM 'array')
    OR EXISTS (SELECT 1 FROM business_proposals WHERE jsonb_typeof(payload->'claimIds') IS DISTINCT FROM 'array')
    OR EXISTS (SELECT 1 FROM business_claims WHERE jsonb_typeof(payload->'source') IS DISTINCT FROM 'object') THEN RAISE EXCEPTION '业务关系集合格式无效'; END IF;
  IF EXISTS (SELECT 1 FROM business_proposals p WHERE jsonb_array_length(p.payload->'claimIds')<>(SELECT count(*) FROM business_proposal_claims pc WHERE pc.proposal_id=p.id)) THEN RAISE EXCEPTION '方案信息引用集合无效'; END IF;
  IF EXISTS (SELECT 1 FROM business_versions GROUP BY contract_id HAVING min(number)<>1 OR max(number)<>count(*)) THEN RAISE EXCEPTION '合同版本集合不连续'; END IF;
  IF EXISTS (SELECT 1 FROM business_contracts c WHERE NOT EXISTS(SELECT 1 FROM business_versions v WHERE v.contract_id=c.id)) THEN RAISE EXCEPTION '合同缺少版本集合'; END IF;
  IF EXISTS (SELECT 1 FROM (
    SELECT c.org_id,t.initiator_org_id,t.counterparty_org_id FROM business_comments c JOIN business_contracts k ON k.id=c.contract_id JOIN business_transactions t ON t.id=k.transaction_id
    UNION ALL SELECT c.org_id,t.initiator_org_id,t.counterparty_org_id FROM business_suggestions c JOIN business_contracts k ON k.id=c.contract_id JOIN business_transactions t ON t.id=k.transaction_id
    ${['messages','milestones','activities','cost_items','claims','proposals'].map((name) => `UNION ALL SELECT c.org_id,t.initiator_org_id,t.counterparty_org_id FROM business_${name} c JOIN business_transactions t ON t.id=c.transaction_id`).join('\n')}
    UNION ALL SELECT c.granted_by_org_id,t.initiator_org_id,t.counterparty_org_id FROM business_counsel_grants c JOIN business_transactions t ON t.id=c.transaction_id
  ) scoped WHERE org_id NOT IN (initiator_org_id,counterparty_org_id)) THEN RAISE EXCEPTION '业务实体组织归属无效'; END IF;
  IF EXISTS (SELECT 1 FROM business_claims c JOIN business_claims s ON s.id=c.superseded_by_id WHERE c.org_id<>s.org_id OR c.transaction_id IS DISTINCT FROM s.transaction_id) THEN RAISE EXCEPTION '替代信息归属无效'; END IF;
  IF EXISTS (SELECT 1 FROM business_proposal_claims pc JOIN business_proposals p ON p.id=pc.proposal_id JOIN business_claims c ON c.id=pc.claim_id WHERE c.transaction_id IS NOT NULL AND c.transaction_id<>p.transaction_id) THEN RAISE EXCEPTION '方案引用跨交易信息'; END IF;
  IF EXISTS (SELECT 1 FROM business_contracts c JOIN business_transactions t ON t.id=c.transaction_id CROSS JOIN LATERAL jsonb_array_elements_text(c.payload->'finalConfirmedBy') AS org_id WHERE org_id NOT IN (t.initiator_org_id,t.counterparty_org_id)) THEN RAISE EXCEPTION '合同确认企业归属无效'; END IF;
  IF EXISTS (SELECT 1 FROM business_proposals WHERE base_version_id IS NOT NULL AND contract_id IS NULL) THEN RAISE EXCEPTION '方案版本缺少合同'; END IF;
  IF EXISTS (SELECT 1 FROM business_claims c LEFT JOIN business_contracts k ON k.id=c.source_contract_id LEFT JOIN business_cost_items l ON l.id=c.source_cost_id
    WHERE (c.source_contract_id IS NOT NULL AND c.transaction_id IS DISTINCT FROM k.transaction_id)
       OR (c.source_transaction_id IS NOT NULL AND c.transaction_id IS DISTINCT FROM c.source_transaction_id)
       OR (c.source_cost_id IS NOT NULL AND (c.transaction_id IS DISTINCT FROM l.transaction_id OR c.org_id<>l.org_id))) THEN RAISE EXCEPTION '信息来源归属无效'; END IF;
END $$;
SET CONSTRAINTS ALL IMMEDIATE;
DROP TABLE business_state;
`
