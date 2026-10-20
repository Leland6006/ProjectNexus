export const PARTNER_MESSAGE_SCHEMA = `
-- Block legacy writers until validation and both guards commit atomically.
LOCK TABLE partner_relationships, partner_messages IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM partner_messages m
    JOIN partner_relationships r ON r.id=m.relationship_id
    WHERE m.org_id NOT IN (r.requester_org_id, r.recipient_org_id)
  ) THEN
    RAISE EXCEPTION 'partner_messages contains a non-participant organization' USING ERRCODE='23514';
  END IF;
END $$;

CREATE FUNCTION enforce_partner_message_participant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Missing relationships remain the responsibility of the existing foreign key.
  IF EXISTS (
    SELECT 1 FROM partner_relationships r
    WHERE r.id=NEW.relationship_id
      AND NEW.org_id NOT IN (r.requester_org_id, r.recipient_org_id)
  ) THEN
    RAISE EXCEPTION 'partner message organization is not a relationship participant' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER partner_messages_participant_guard
  BEFORE INSERT OR UPDATE OF relationship_id,org_id ON partner_messages
  FOR EACH ROW EXECUTE FUNCTION enforce_partner_message_participant();

CREATE FUNCTION prevent_partner_participant_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requester_org_id IS DISTINCT FROM OLD.requester_org_id
    OR NEW.recipient_org_id IS DISTINCT FROM OLD.recipient_org_id THEN
    RAISE EXCEPTION 'partner relationship participants are immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER partner_relationship_participants_immutable
  BEFORE UPDATE OF requester_org_id,recipient_org_id ON partner_relationships
  FOR EACH ROW EXECUTE FUNCTION prevent_partner_participant_change();
`
