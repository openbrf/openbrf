-- Six privileged writes the log did not record.
--
-- ISSUE_STATUS_CHANGED: the property manager, the board or an administrator
-- moved an issue between statuses with nothing naming who. The entry names the
-- issue and the status either side.
--
-- MOVE_IN_RECORDED, MOVE_OUT_RECORDED: a residency started or ended. The
-- member register's own rows say what happened to the membership; nothing said
-- who entered the residency or when.
--
-- PLUGIN_ENABLED, PLUGIN_DISABLED, PLUGIN_SETTINGS_CHANGED: an administrator
-- switched a plugin on or off, or changed what it is configured with. A plugin
-- runs with the permissions its install consented to, so who switched it on is
-- the question an incident asks. The settings entry names the fields and never
-- the values, which can hold a key.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ISSUE_STATUS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOVE_IN_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MOVE_OUT_RECORDED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_SETTINGS_CHANGED';
