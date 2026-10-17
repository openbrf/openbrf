/**
 * How docker/credentials.mjs writes a generated password onto its volume:
 * past a temporary file an interrupted boot left there, and, when the write
 * fails, without leaving one of its own and with the error that stopped it.
 *
 * Each case runs the real ensurePassword or writePassword in a Node process of
 * its own, on a directory of its own, because a failure ends the process. Run
 * with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

const CREDENTIALS = new URL("../docker/credentials.mjs", import.meta.url).href;

let directory;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "docker-credentials-"));
});

afterEach(() => {
  chmodSync(directory, 0o700);
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Runs `body` as a module that has imported ensurePassword and writePassword,
 * with the password file's path in `file`.
 */
function run(file, body) {
  return spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { ensurePassword, writePassword } from ${JSON.stringify(CREDENTIALS)};
const file = process.argv[1];
${body}`,
      file,
    ],
    { encoding: "utf8" },
  );
}

test("a temporary file an interrupted boot left does not stop the next one", () => {
  const file = join(directory, "owner", "password");
  mkdirSync(join(directory, "owner"));
  // A boot stopped between the write and the rename, under the name this
  // process would have used when the name was the pid alone, and under the
  // random name it uses now.
  const result = run(
    file,
    `import { writeFileSync } from "node:fs";
writeFileSync(\`\${file}.\${process.pid}.tmp\`, "stale");
writeFileSync(\`\${file}.0123456789abcdef.tmp\`, "stale");
process.stdout.write(ensurePassword(file));`,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(file, "utf8"), result.stdout);
});

test("a write that fails leaves no temporary file and names its own error", () => {
  // A directory where the file should be: the temporary file is written and
  // the rename over it fails.
  const file = join(directory, "password");
  mkdirSync(file);
  writeFileSync(join(file, "occupied"), "");

  const result = run(file, `writePassword(file, "secret", 0o600);`);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /cannot be written \((EISDIR|ENOTEMPTY|EEXIST)\)\./,
  );
  assert.doesNotMatch(result.stderr, /chowned/);
  assert.deepEqual(
    readdirSync(directory).filter((entry) => entry.endsWith(".tmp")),
    [],
  );
});

test(
  "a volume the image's user cannot write to says how to fix it",
  { skip: process.getuid?.() === 0 && "root writes to any directory" },
  () => {
    const file = join(directory, "password");
    chmodSync(directory, 0o500);

    const result = run(file, `writePassword(file, "secret", 0o600);`);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /cannot be written \(EACCES\)\./);
    assert.match(result.stderr, /chowned to uid 1000/);
  },
);
