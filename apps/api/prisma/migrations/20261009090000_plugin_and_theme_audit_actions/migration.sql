-- Acts on plugins and themes that changed what an instance runs and left no
-- entry: an administrator switching a plugin on or off, changing its settings,
-- and removing a theme. Switching a plugin back on restores its access to the
-- register and the mail server, so the log has to be able to say who did it.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_ENABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_DISABLED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'PLUGIN_SETTINGS_CHANGED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'THEME_REMOVED';
