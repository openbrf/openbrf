-- Two values ADR 0035 adds.
--
-- NAME_IN_BUILDING is a publication-consent scope: the person's name on a
-- screen inside the building, which a plugin reads as `nameInBuilding`. It is
-- not NAME_ON_SITE, because a name in the stairwell and a name on a page anybody
-- can open are different things to agree to.
--
-- PLUGIN_RECORDED is what a plugin writes through `host.audit`: one value of the
-- core's own, written by the host, so every audit action stays a value of this
-- enum.
--
-- Their own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it.
ALTER TYPE "ConsentScope" ADD VALUE IF NOT EXISTS 'NAME_IN_BUILDING';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_RECORDED';
