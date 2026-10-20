CREATE TABLE IF NOT EXISTS identities (
  id text PRIMARY KEY,
  oidc_sub text NOT NULL UNIQUE CHECK (length(oidc_sub) > 0),
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS identities_email_idx ON identities(email);

CREATE TABLE IF NOT EXISTS organizations (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  short_name text NOT NULL CHECK (length(btrim(short_name)) BETWEEN 1 AND 40),
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'law_firm')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES identities(id),
  org_id text NOT NULL REFERENCES organizations(id),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'business', 'finance', 'legal', 'readonly')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, org_id)
);
CREATE INDEX IF NOT EXISTS memberships_org_active_idx ON memberships(org_id, status);
CREATE INDEX IF NOT EXISTS memberships_user_active_idx ON memberships(user_id, status);

CREATE TABLE IF NOT EXISTS invitations (
  id text PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254),
  org_id text NOT NULL REFERENCES organizations(id),
  role text NOT NULL CHECK (role IN ('admin', 'business', 'finance', 'legal', 'readonly')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'withdrawn', 'expired')),
  expires_at timestamptz NOT NULL,
  invited_by text NOT NULL REFERENCES identities(id),
  accepted_by text REFERENCES identities(id),
  revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((status = 'accepted') = (accepted_by IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_email_idx ON invitations(org_id, email) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS invitations_email_status_idx ON invitations(email, status);

CREATE TABLE IF NOT EXISTS audit (
  id text PRIMARY KEY,
  org_id text REFERENCES organizations(id),
  actor_id text NOT NULL REFERENCES identities(id),
  action text NOT NULL,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_org_created_idx ON audit(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_state (
  id text PRIMARY KEY DEFAULT 'singleton' CHECK (id = 'singleton'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO business_state(id) VALUES ('singleton') ON CONFLICT (id) DO NOTHING;
