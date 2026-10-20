export const PARTNER_SCHEMA = `
CREATE TABLE partner_pairs (
  lower_org_id text NOT NULL REFERENCES organizations(id),
  upper_org_id text NOT NULL REFERENCES organizations(id),
  PRIMARY KEY (lower_org_id, upper_org_id),
  CHECK (lower_org_id < upper_org_id)
);
CREATE TABLE partner_relationships (
  id text PRIMARY KEY,
  requester_org_id text NOT NULL REFERENCES organizations(id),
  recipient_org_id text NOT NULL REFERENCES organizations(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'withdrawn', 'disconnected')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_org_id <> recipient_org_id)
);
CREATE UNIQUE INDEX partner_relationships_active_pair_idx
  ON partner_relationships (LEAST(requester_org_id, recipient_org_id), GREATEST(requester_org_id, recipient_org_id))
  WHERE status IN ('pending', 'accepted');
CREATE INDEX partner_relationships_requester_idx ON partner_relationships(requester_org_id, created_at DESC);
CREATE INDEX partner_relationships_recipient_idx ON partner_relationships(recipient_org_id, created_at DESC);
CREATE TABLE partner_messages (
  id text PRIMARY KEY,
  relationship_id text NOT NULL REFERENCES partner_relationships(id),
  author_id text NOT NULL REFERENCES identities(id),
  org_id text NOT NULL REFERENCES organizations(id),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000 AND length(btrim(body)) > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX partner_messages_relationship_created_idx ON partner_messages(relationship_id, created_at DESC, id DESC);
`
