/**
 * What the statutory guard scanner has to catch, and what it has to leave
 * alone.
 *
 * Run with `node --test` from `pnpm lint:guards`, so the detector is exercised
 * by the same command that runs it: a detector nothing exercises is one that
 * can quietly stop detecting. Every entry in the first list is a shape that got
 * past an earlier version of the check.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { findBypasses } from "./check-statutory-guards.mjs";

/** A migration that first defined one of the shared guard functions. */
const DEFINING_MIGRATION =
  "apps/api/prisma/migrations/20260827122611_statutory_append_only_guards/migration.sql";

/** Any other migration, which may not redefine one. */
const LATER_MIGRATION =
  "apps/api/prisma/migrations/20990101000000_later/migration.sql";

const MUST_MATCH = [
  {
    name: "a disabled trigger in a SQL string",
    path: "fixture.ts",
    source:
      'await tx.$executeRawUnsafe(`ALTER TABLE "x" DISABLE TRIGGER "y"`);',
  },
  {
    name: "executable code after a block comment on the same line",
    path: "fixture.ts",
    source:
      '/* cleanup */ await tx.$executeRawUnsafe(\'ALTER TABLE "x" DISABLE TRIGGER "y"\');',
  },
  {
    name: "a guard dropped across several lines",
    path: "fixture.sql",
    source:
      'DROP TRIGGER\n  member_register_entry_append_only\n  ON "member_register_entry";',
  },
  {
    name: "user triggers turned off for the whole session",
    path: "fixture.sql",
    source: "SET session_replication_role = replica;",
  },
  {
    /*
     * A doubled delimiter is SQL's escape for one, so the string does not end
     * there and the statement after it is code. Both halves of the pair are
     * consumed as content now; before that it came out right by parity alone.
     */
    name: "a statement after a SQL string with a doubled quote in it",
    path: "fixture.sql",
    source:
      "SELECT 'it''s'; ALTER TABLE \"member_register_entry\" DISABLE TRIGGER \"member_register_entry_append_only\";",
  },
  {
    /*
     * The nesting is what breaks a flat scan. It ends the outer literal at the
     * inner backtick, reads the `//` that follows as the start of a comment,
     * and blanks the rest of the line - the statement among it.
     */
    name: "a template literal nesting another, before a bypass on the same line",
    path: "fixture.ts",
    source:
      'const sql = `${prefix}${`//`} ALTER TABLE "x" DISABLE TRIGGER "y"`;',
  },
  {
    /*
     * Every guard trigger calls one of two shared functions, so replacing
     * either body turns seven guards off in one statement.
     */
    name: "a shared guard function replaced with one that lets writes through",
    path: LATER_MIGRATION,
    source:
      "CREATE OR REPLACE FUNCTION openbrf_forbid_mutation() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;",
  },
  {
    name: "a shared guard function replaced under a quoted, qualified name",
    path: "fixture.ts",
    source:
      'await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "public"."openbrf_forbid_truncate"() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql`);',
  },
  {
    name: "a guard function dropped with every trigger that calls it",
    path: "fixture.sql",
    source: "DROP FUNCTION openbrf_forbid_mutation() CASCADE;",
  },
  {
    name: "a check function dropped among others, if it exists",
    path: "fixture.sql",
    source:
      "DROP FUNCTION IF EXISTS refuse_inserts(),\n  public.openbrf_check_transfer_record();",
  },
  {
    name: "a trigger altered",
    path: "fixture.sql",
    source:
      'ALTER TRIGGER member_register_entry_append_only ON "member_register_entry" RENAME TO gone;',
  },
  {
    /*
     * A replica trigger fires only in a session that has set
     * session_replication_role, so in every ordinary session it is off.
     */
    name: "a guard set to fire only in replica sessions",
    path: "fixture.sql",
    source:
      'ALTER TABLE "member_register_entry" ENABLE REPLICA TRIGGER member_register_entry_append_only;',
  },
  {
    name: "a guard trigger replaced in place",
    path: "fixture.sql",
    source:
      'CREATE OR REPLACE TRIGGER member_register_entry_append_only BEFORE UPDATE ON "member_register_entry" FOR EACH ROW EXECUTE FUNCTION refuse_nothing();',
  },
];

const MUST_NOT_MATCH = [
  {
    name: "prose about a bypass in a line comment",
    path: "fixture.ts",
    source: "// the owner can ALTER TABLE ... DISABLE TRIGGER and walk past it",
  },
  {
    name: "prose about a bypass in a SQL comment",
    path: "fixture.sql",
    source:
      "-- separate from the owner so that DISABLE TRIGGER is out of reach",
  },
  {
    name: "a trigger the suite created itself, dropped by its own name",
    path: "fixture.ts",
    source:
      'await tx.$executeRawUnsafe(`DROP TRIGGER ${REFUSE_INSERTS} ON "register_report_obligation"`);',
  },
  {
    /*
     * E'...' honours a backslash escape and '...' does not. Reading the escaped
     * quote as the end of the string leaves the scanner one delimiter out, and
     * the comment below is then read as code and reported.
     */
    name: "an escape string with an escaped delimiter, before prose about a bypass",
    path: "fixture.sql",
    source: 'SELECT E\'it\\\'s\';\n-- ALTER TABLE "x" DISABLE TRIGGER "y";',
  },
  {
    name: "one statement dropping its own trigger and a later one naming a guard",
    path: "fixture.sql",
    source:
      'DROP TRIGGER refuse_inserts ON "x";\nCREATE TRIGGER member_register_entry_append_only BEFORE UPDATE ON "y" FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();',
  },
  {
    /*
     * The migrations that defined the two shared guard functions, and the one
     * that gave them their error surface, are where replacing them is the
     * point.
     */
    name: "a guard function replaced in a migration that defines it",
    path: DEFINING_MIGRATION,
    source:
      "CREATE OR REPLACE FUNCTION openbrf_forbid_mutation()\nRETURNS trigger AS $$\nBEGIN\n  RAISE EXCEPTION 'append-only';\nEND;\n$$ LANGUAGE plpgsql;",
  },
  {
    name: "a check function the suite does not touch, replaced",
    path: LATER_MIGRATION,
    source:
      "CREATE OR REPLACE FUNCTION openbrf_check_transfer_record() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;",
  },
];

for (const fixture of MUST_MATCH) {
  test(`finds ${fixture.name}`, () => {
    assert.notDeepEqual(findBypasses(fixture.source, fixture.path), []);
  });
}

for (const fixture of MUST_NOT_MATCH) {
  test(`leaves alone ${fixture.name}`, () => {
    assert.deepEqual(findBypasses(fixture.source, fixture.path), []);
  });
}
