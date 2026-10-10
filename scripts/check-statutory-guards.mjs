/**
 * Refuses code that turns a statutory archive guard off.
 *
 * The member register, the audit log, the termination register and the
 * obligation ledger are append-only by law and by trigger (EFL 5 kap., via BRL
 * 9 kap.). The triggers stop every caller including the schema owner, so the
 * only way past one is to disable it - and the application connects as a role
 * that cannot, which is what makes the guard hold at runtime.
 *
 * Two integration suites disable a guard on purpose, because a test that writes
 * to an append-only table cannot otherwise remove its own rows, and they are
 * named below. Nothing else in the tree may: the pattern reads as ordinary test
 * cleanup, it is a line long, and copied into a service or a migration it would
 * quietly make a statutory table editable - a register the association is
 * required to retain would become one anybody holding the owner's credentials
 * can rewrite. That is a defect a reviewer has to spot rather than one anything
 * refuses, which is what this check changes.
 *
 * Prose about the guards is expected and is not a finding: comments are removed
 * before anything is matched, and documentation is not scanned at all.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The files allowed to switch a guard off, and why each one is.
 *
 * Both disable one named trigger, on one table, and put it back in a finally.
 * An entry here is a decision to be argued for in review: adding a third means
 * saying why the suite cannot assert its way around the table instead.
 *
 * The list is checked in both directions. An entry naming a file that is gone
 * is an error, and so is one whose file no longer disables anything: an
 * exemption nothing is using is one the next edit to that file inherits without
 * anybody deciding to give it, and a statutory table would become editable with
 * no finding raised.
 */
const ALLOWED = new Map([
  [
    "apps/api/src/database/statutory-guards.int-spec.ts",
    "The suite that proves the guards exist has to see one fire and then clear " +
      "the row it wrote to make it fire.",
  ],
  [
    "apps/api/src/audit/audit-log.service.int-spec.ts",
    "The audit log is append-only, so this suite cannot remove the entries it " +
      "writes any other way.",
  ],
]);

/**
 * This file states the patterns and its test states what they must catch, so
 * both necessarily contain them. Skipped by path rather than by an entry in
 * ALLOWED, which is a list of files permitted to disable a guard - neither
 * ever touches a database.
 */
const SELF = new Set([
  "scripts/check-statutory-guards.mjs",
  "scripts/check-statutory-guards.test.mjs",
]);

/**
 * What a bypass looks like, matched against source with its comments removed.
 *
 * DISABLE TRIGGER is the direct one, and ENABLE REPLICA TRIGGER the same thing
 * spelled differently: a replica trigger fires only in a session that has set
 * session_replication_role, so in every ordinary session it is off.
 * session_replication_role itself is the indirect one: set to replica, a
 * session runs with user triggers off, which is how a restore normally loads
 * data and would take every guard down at once. Dropping a guard by name, or
 * replacing it in place, is the next.
 *
 * Then the functions the guards call. Every append-only trigger runs
 * openbrf_forbid_mutation and every truncate trigger openbrf_forbid_truncate,
 * so replacing either body with one that returns turns seven guards off in a
 * statement that names no trigger at all, and dropping one with CASCADE takes
 * its triggers with it. A shared function may be replaced only in the
 * migrations that defined it, and no openbrf_forbid_ or openbrf_check_
 * function may be dropped. ALTER TRIGGER is refused outright: nothing here
 * needs it, and renaming a guard is how it would slip past a check that looks
 * for the name.
 *
 * All of them tolerate a line break inside the statement, because SQL is
 * written across lines as readily as on one and a per-line matcher would miss
 * `DROP TRIGGER\n  member_register_entry_append_only\n  ON ...`. The patterns
 * that reach for a name are bounded by the statement terminator and by a
 * length, so they cannot join a trigger dropped in one statement to a guard
 * named in a later one - a trigger a suite created itself has a name of its own
 * and is not matched.
 */
const PATTERNS = [
  { name: "DISABLE TRIGGER", expression: /\bdisable\s+trigger\b/gi },
  {
    name: "ENABLE REPLICA TRIGGER",
    expression: /\benable\s+replica\s+trigger\b/gi,
  },
  {
    name: "session_replication_role",
    expression: /\bsession_replication_role\b/gi,
  },
  {
    name: "DROP or CREATE OR REPLACE TRIGGER on a guard",
    expression:
      /\b(?:drop|create\s+or\s+replace)\s+trigger\b[^;]{0,200}?(_append_only|_no_truncate)/gi,
  },
  {
    name: "CREATE OR REPLACE FUNCTION on a shared guard function",
    expression:
      /\bcreate\s+or\s+replace\s+function\s+(?:"?public"?\s*\.\s*)?"?openbrf_forbid_/gi,
    /*
     * Where the two functions were defined, and where they were given the
     * error surface they raise today. Migrations are never edited once applied,
     * so these stay true; a new body for either is a new migration and a line
     * here, argued for in review like an entry in ALLOWED.
     */
    definedIn: new Set([
      "apps/api/prisma/migrations/20260827122611_statutory_append_only_guards/migration.sql",
      "apps/api/prisma/migrations/20260827123622_forbid_truncate_on_statutory_tables/migration.sql",
      "apps/api/prisma/migrations/20260827123837_statutory_guard_error_surface/migration.sql",
    ]),
  },
  {
    name: "DROP FUNCTION on a guard function",
    expression: /\bdrop\s+function\b[^;]{0,200}?\bopenbrf_(?:forbid|check)_/gi,
  },
  { name: "ALTER TRIGGER", expression: /\balter\s+trigger\b/gi },
];

const SCANNED_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".mjs",
  ".cjs",
  ".js",
  ".sql",
];

/**
 * The source with every comment blanked out and everything else where it was.
 *
 * Blanked rather than removed, so a match's offset still points at the line it
 * is on. Strings are kept, because a bypass written in TypeScript is a SQL
 * string and removing them would leave nothing to find.
 *
 * A lexer with a stack rather than a scan for the next quote, because a
 * template literal can hold code and that code can hold another template. A
 * flat scan ends the outer literal at the first nested backtick, and everything
 * after it is then read in the wrong state: a `//` inside what is really string
 * content is taken for a comment, and the rest of that line - a real
 * `DISABLE TRIGGER` among it - is blanked out and never matched. The failure is
 * silent and it is in the direction that matters, so the nesting is tracked
 * rather than approximated.
 *
 * Reading left to right settles the orderings: a quote inside a comment cannot
 * open a string, a comment marker inside a string is not a comment, and a brace
 * inside a substitution is counted so an object literal does not close it. `--`
 * counts only in `.sql`, since in TypeScript it is a decrement, and `#` counts
 * nowhere - it is a private field in TypeScript and not a comment in
 * PostgreSQL.
 */
function withoutComments(source, path) {
  const sqlComments = path.endsWith(".sql");
  const out = [...source];
  let index = 0;

  /*
   * What is open, innermost last. A template literal, or a substitution inside
   * one with the depth of braces opened since it began - `${ {a: 1} }` closes
   * on its second brace and not its first.
   */
  const open = [];
  const inTemplate = () => open.at(-1)?.kind === "template";

  const blank = (from, to) => {
    for (let at = from; at < to; at += 1) {
      if (out[at] !== "\n") {
        out[at] = " ";
      }
    }
  };

  while (index < source.length) {
    const character = source[index];
    const two = source.slice(index, index + 2);

    if (inTemplate()) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (two === "${") {
        open.push({ kind: "substitution", depth: 0 });
        index += 2;
        continue;
      }
      if (character === "`") {
        open.pop();
        index += 1;
        continue;
      }
      index += 1;
      continue;
    }

    // Code: the file itself, or a substitution inside a template literal.
    if (two === "/*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (two === "//" || (sqlComments && two === "--")) {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      blank(index, stop);
      index = stop;
      continue;
    }

    if (character === "`") {
      open.push({ kind: "template" });
      index += 1;
      continue;
    }

    if (character === "'" || character === '"') {
      /*
       * PostgreSQL's E'...' takes backslash escapes and a plain '...' does not,
       * so which one this is decides whether a backslash before the delimiter
       * ends the string. Reading it wrong desynchronises the scanner, and here
       * that produces a finding rather than hiding one: the text after the
       * string gets read as code, and prose about a bypass in a comment is
       * reported as one.
       */
      const backslashEscapes =
        !sqlComments ||
        (character === "'" &&
          /[Ee]/.test(source[index - 1] ?? "") &&
          !/[A-Za-z0-9_$]/.test(source[index - 2] ?? ""));

      index += 1;
      while (index < source.length) {
        if (source[index] === "\\" && backslashEscapes) {
          index += 2;
          continue;
        }
        if (source[index] === character) {
          /*
           * SQL escapes a delimiter by doubling it - 'it''s', "od""d" - so a
           * pair is content and not the end. Handled explicitly rather than
           * left to the parity of closing and reopening on the two halves,
           * which comes out at the same place today and is an accident to rely
           * on: an unterminated string or an odd delimiter would put the
           * scanner inside a phantom string, and everything it swallowed there
           * would go unmatched.
           */
          if (sqlComments && source[index + 1] === character) {
            index += 2;
            continue;
          }
          break;
        }
        index += 1;
      }
      index += 1;
      continue;
    }

    const enclosing = open.at(-1);
    if (enclosing?.kind === "substitution") {
      if (character === "{") {
        enclosing.depth += 1;
      } else if (character === "}") {
        if (enclosing.depth === 0) {
          open.pop();
        } else {
          enclosing.depth -= 1;
        }
      }
    }

    index += 1;
  }

  return out.join("");
}

/** Every bypass in one file's source, with the line each is on. */
export function findBypasses(source, path) {
  const scanned = withoutComments(source, path);
  const findings = [];

  for (const pattern of PATTERNS) {
    if (pattern.definedIn?.has(path)) {
      continue;
    }
    pattern.expression.lastIndex = 0;
    let match = pattern.expression.exec(scanned);
    while (match !== null) {
      findings.push({
        path,
        line: scanned.slice(0, match.index).split("\n").length,
        pattern: pattern.name,
      });
      match = pattern.expression.exec(scanned);
    }
  }

  return findings.sort((left, right) => left.line - right.line);
}

if (import.meta.main) {
  /*
   * Tracked files and untracked ones that are not ignored, so a file added in
   * the working tree is scanned before it is ever committed. Ignored paths -
   * the generated client, build output, node_modules - are left out by
   * --exclude-standard.
   */
  const tracked = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter((path) => path !== "")
    .filter((path) =>
      SCANNED_EXTENSIONS.some((extension) => path.endsWith(extension)),
    );

  const findings = [];
  const exercised = new Set();

  for (const path of tracked) {
    if (SELF.has(path)) {
      continue;
    }

    let contents;
    try {
      contents = readFileSync(join(repoRoot, path), "utf8");
    } catch {
      // A tracked path that is not readable is a checkout problem, not a
      // finding.
      continue;
    }

    const found = findBypasses(contents, path);
    if (found.length === 0) {
      continue;
    }
    if (ALLOWED.has(path)) {
      exercised.add(path);
      continue;
    }
    findings.push(...found);
  }

  if (findings.length > 0) {
    console.error(
      "A statutory archive guard is switched off outside the files allowed to:",
    );
    for (const finding of findings) {
      console.error(`  ${finding.path}:${finding.line}  ${finding.pattern}`);
    }
    console.error(
      "\nThe member register, the audit log, the termination register and the\n" +
        "obligation ledger are append-only by law. If this is a test that cannot\n" +
        "clean up any other way, add the file to ALLOWED in\n" +
        "scripts/check-statutory-guards.mjs and say why. If it is anything else,\n" +
        "it is a defect.",
    );
    process.exit(1);
  }

  const stale = [...ALLOWED.keys()].filter((path) => !exercised.has(path));
  if (stale.length > 0) {
    console.error(
      "The allowlist carries exemptions nothing is using:\n" +
        stale
          .map(
            (path) =>
              `  ${path} - ${tracked.includes(path) ? "no longer disables a guard" : "is gone"}`,
          )
          .join("\n") +
        "\n\nRemove them. An exemption nothing is using is one the next edit to\n" +
        "that file inherits without anybody deciding to give it.",
    );
    process.exit(1);
  }

  console.log(
    `No statutory guard is disabled outside the ${String(ALLOWED.size)} files allowed to.`,
  );
}
