---
"@openbrf/api": minor
"@openbrf/web": patch
"@openbrf/i18n": minor
"@openbrf/shared": minor
---

Add a management API for whoever hosts an instance. It is off unless the
operator configures a port and a token, answers on that port only, never on the
public address, and returns one summary: the number of apartments, how many
people the registers hold, whether residents have been invited, the day the
board was last active, how often the register extracts have been generated,
storage used, the running version and the state of the database migrations. It
carries nothing about any one person. The instance keeps only a digest of the
token, and every read is written to the audit log under a channel of its own.
