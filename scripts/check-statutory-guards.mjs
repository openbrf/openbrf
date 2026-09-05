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
 * This file states the patterns, so it necessarily contains them. Skipped by
 * path rather than by an entry in ALLOWED, which is a list of files permitted
 * to disable a guard - this one never touches a database.
 */
const SELF = "scripts/check-statutory-guards.mjs";

/**
 * What a bypass looks like, matched against source with its comments removed.
 *
 * DISABLE TRIGGER is the direct one. session_replication_role is the indirect
 * one: set to replica, a session runs with user triggers off, which is how a
 * restore normally loads data and would take every guard down at once. Dropping
 * a guard by name is the third.
 *
 * All three tolerate a line break inside the statement, because SQL is written
 * across lines as readily as on one and a per-line matcher would miss
 * `DROP TRIGGER\n  member_register_entry_append_only\n  ON ...`. The drop
 * pattern is bounded by the statement terminator and by a length, so it cannot
 * join a trigger dropped in one statement to a guard named in a later one - a
 * trigger a suite created itself has a name of its own and is not matched.
 */
const PATTERNS = [
  { name: "DISABLE TRIGGER", expression: /\bdisable\s+trigger\b/gi },
  {
    name: "session_replication_role",
    expression: /\bsession_replication_role\b/gi,
  },
  {
    name: "DROP TRIGGER on a guard",
    expression: /\bdrop\s+trigger\b[^;]{0,200}?(_append_only|_no_truncate)/gi,
  },
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
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\" && !sqlComments) {
          // A backslash escape, which TypeScript has and SQL does not.
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
function findBypasses(source, path) {
  const scanned = withoutComments(source, path);
  const findings = [];

  for (const pattern of PATTERNS) {
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

/**
 * What the scanner has to catch, and what it has to leave alone.
 *
 * Checked on every run, here rather than in a test file: `scripts/` is not a
 * workspace package and no test runner reaches it, and a detector nothing
 * exercises is one that can quietly stop detecting. Every entry in the first
 * list is a shape that got past an earlier version of this check.
 */
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
    name: "one statement dropping its own trigger and a later one naming a guard",
    path: "fixture.sql",
    source:
      'DROP TRIGGER refuse_inserts ON "x";\nCREATE TRIGGER member_register_entry_append_only BEFORE UPDATE ON "y" FOR EACH ROW EXECUTE FUNCTION openbrf_forbid_mutation();',
  },
];

function selfTest() {
  const broken = [
    ...MUST_MATCH.filter(
      (fixture) => findBypasses(fixture.source, fixture.path).length === 0,
    ).map((fixture) => `missed: ${fixture.name}`),
    ...MUST_NOT_MATCH.filter(
      (fixture) => findBypasses(fixture.source, fixture.path).length > 0,
    ).map((fixture) => `false positive: ${fixture.name}`),
  ];

  if (broken.length > 0) {
    console.error(
      "This check no longer does what it says. Its own fixtures fail:\n" +
        broken.map((line) => `  ${line}`).join("\n"),
    );
    process.exit(1);
  }
}

selfTest();

/*
 * Tracked files and untracked ones that are not ignored, so a file added in the
 * working tree is scanned before it is ever committed. Ignored paths - the
 * generated client, build output, node_modules - are left out by
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
  if (path === SELF) {
    continue;
  }

  let contents;
  try {
    contents = readFileSync(join(repoRoot, path), "utf8");
  } catch {
    // A tracked path that is not readable is a checkout problem, not a finding.
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
