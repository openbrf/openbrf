-- What the management API has to be able to say in the log (ADR 0021).
--
-- One channel and one action. Whoever hosts an instance reads counts about it -
-- the apartments, the size of the registers, storage, the version and the state
-- of the migrations - through a listener on a port of its own, with a token held
-- by the host and a digest held by the instance. Every read is an entry, so the
-- association's own log shows when its processor read what.
--
-- A channel of its own rather than SYSTEM. SYSTEM is the instance acting on its
-- own clock; this is somebody outside it asking, and the two are told apart by
-- the question the channel answers - which way the act reached the records.
-- It is also what keeps the reading out of the board's activity: the summary's
-- day of the board's latest activity counts the channels a person acts through,
-- and neither this one nor SYSTEM is among them.
--
-- The entry has no actor and no target. The caller is a machine credential and
-- never a person, and the summary is about the association rather than anybody
-- in it, so it reaches no data subject access report. Its context carries the
-- document's schema version and nothing else.
--
-- Its own migration because PostgreSQL will not let a value added to an enum be
-- used in the transaction that added it, and Prisma runs each migration in one.
ALTER TYPE "AuditChannel" ADD VALUE IF NOT EXISTS 'MANAGEMENT';

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'INSTANCE_SUMMARY_READ';
