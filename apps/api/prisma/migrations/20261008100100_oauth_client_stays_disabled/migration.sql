-- A client the instance has turned away stays turned away.
--
-- Revoking a client for the whole instance sets `disabled` on its row, and the
-- provider refuses a disabled client at the authorization and token endpoints.
-- The application is not the only writer of that row, though. A client that
-- identifies itself by the URL of its metadata document has the row rewritten
-- whenever the provider fetches that document again, and the rewrite carries
-- the `disabled` it read before the fetch began. A refresh that read the row
-- while the client was still allowed, and finished after the revoke, would put
-- it back.
--
-- A lock taken by the revoke alone cannot close that: the refresh never asks
-- for it. So the rule sits on the row, where every writer meets it. Once a
-- client is disabled, no UPDATE turns it back on. An update that blocks behind
-- the revoke sees the disabled row as OLD once the revoke commits, so the order
-- of the two does not matter.
--
-- Nothing in the application enables a client again. If one ever has to be,
-- that is a decision to take in a migration of its own rather than a side
-- effect of a write somebody made for another reason. Deleting the row is
-- untouched: that is how a registration that did not finish is cleaned up.

CREATE OR REPLACE FUNCTION openbrf_keep_oauth_client_disabled()
RETURNS trigger AS $$
BEGIN
  IF OLD.disabled IS TRUE THEN
    NEW.disabled := TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER oauth_client_stays_disabled
  BEFORE UPDATE ON "auth_oauth_client"
  FOR EACH ROW EXECUTE FUNCTION openbrf_keep_oauth_client_disabled();
