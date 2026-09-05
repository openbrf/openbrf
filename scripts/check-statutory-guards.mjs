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
 * quietly make a statutory table editable. That is a defect a reviewer has to
 * spot rather than one anything refuses, which is what this check changes.
 *
 * Prose about the guards is expected and is not a finding. Comment lines are
 * skipped, and so is documentation: what is scanned is code.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The two files allowed to switch a guard off, and why each one is.
 *
 * Both disable one named trigger, on one table, and put it back in a finally.
 * An entry here is a decision to be argued for in review: adding a third means
 * saying why the suite cannot asserts its way around the table instead.
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
 * What a bypass looks like.
 *
 * DISABLE TRIGGER is the direct one. session_replication_role is the indirect
 * one: set to replica, a session runs with user triggers off, which is how a
 * restore normally loads data and would take every guard down at once. Dropping
 * a guard by name is the third - a trigger a test created itself has a name of
 * its own and is not matched.
 */
const PATTERNS = [
  { name: "DISABLE TRIGGER", expression: /\bdisable\s+trigger\b/i },
  {
    name: "session_replication_role",
    expression: /\bsession_replication_role\b/i,
  },
  {
    name: "DROP TRIGGER on a guard",
    expression: /\bdrop\s+trigger\b[^\n]*(_append_only|_no_truncate)/i,
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
 * A line that only talks about a bypass.
 *
 * Comment markers for the four languages scanned: `//` and `*` for TypeScript
 * and JavaScript, `--` for SQL, `#` for anything shell-flavoured that ends up
 * with one of these extensions.
 */
function isComment(line) {
  return /^\s*(\/\/|\*|\/\*|--|#)/.test(line);
}

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

/**
 * This file states the patterns, so it necessarily contains them. Skipped by
 * path rather than by an entry in ALLOWED, which is a list of files permitted
 * to disable a guard - this one never touches a database.
 */
const SELF = "scripts/check-statutory-guards.mjs";

const findings = [];

for (const path of tracked) {
  if (ALLOWED.has(path) || path === SELF) {
    continue;
  }

  let contents;
  try {
    contents = readFileSync(join(repoRoot, path), "utf8");
  } catch {
    // A tracked path that is not readable is a checkout problem, not a finding.
    continue;
  }

  contents.split("\n").forEach((line, index) => {
    if (isComment(line)) {
      return;
    }
    for (const pattern of PATTERNS) {
      if (pattern.expression.test(line)) {
        findings.push({ path, line: index + 1, pattern: pattern.name });
      }
    }
  });
}

if (findings.length > 0) {
  console.error(
    "A statutory archive guard is switched off outside the two files allowed to:",
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

const unused = [...ALLOWED.keys()].filter((path) => !tracked.includes(path));
if (unused.length > 0) {
  console.error(
    `The allowlist names files that are gone: ${unused.join(", ")}. Remove ` +
      "them, so the list stays a statement about the tree rather than a record " +
      "of one.",
  );
  process.exit(1);
}

console.log(
  `No statutory guard is disabled outside the ${String(ALLOWED.size)} files allowed to.`,
);
