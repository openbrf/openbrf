/**
 * When the Semgrep pull falls back to CI's copy of the image, and when it fails
 * instead.
 *
 * Runs scripts/pull-semgrep-image.sh itself, the script the workflow calls,
 * with the real curl against a registry of its own on localhost. Only `docker`
 * is replaced, by a stub that records what it was asked to pull and answers
 * the way the test says. Run with `node --test` from `pnpm lint:guards`.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "pull-semgrep-image.sh",
);
const IMAGE = `semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)}`;
const MIRROR_IMAGE = (host) => `${host}/${IMAGE}`;
/** CI's copy of an image in the GitHub Container Registry. */
const COPY_OF = (image) =>
  `ghcr.io/openbrf/ci-mirror/semgrep:${image.slice("semgrep/semgrep:".length)}`;
const COPY = COPY_OF(IMAGE);
const COPY_ATTEMPTS = 3;

let directory;
let server;
let host;
let cutOffHost;
let closeCutOff;
/** What the registry on localhost answers next: [status, body] or "cut-off". */
let answer;
let probed;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), "pull-semgrep-"));
  // Logs "pull <reference>" and fails or succeeds per reference, with the
  // message the test chose. CI's copy fails the number of times the test says
  // before it succeeds, as a copy still being made does.
  writeFileSync(
    join(directory, "docker"),
    `#!/usr/bin/env bash
echo "pull $2" >> "$DOCKER_LOG"
if [[ "$2" == "$MIRROR_HOST/"* ]]; then
  echo "$MIRROR_PULL_MESSAGE"
  exit "$MIRROR_PULL_EXIT"
fi
echo "$COPY_PULL_MESSAGE"
if [ "$(grep -cxF "pull $2" "$DOCKER_LOG")" -le "$COPY_PULL_FAILURES" ]; then
  exit 1
fi
exit 0
`,
  );
  chmodSync(join(directory, "docker"), 0o755);

  server = createServer((request, response) => {
    probed.push(request.url);
    response.writeHead(answer[0], { "Content-Type": "application/json" });
    response.end(answer[1]);
  });
  // Promises a body it never finishes: HTTP 404 and part of a MANIFEST_UNKNOWN
  // error, then the connection closes. curl exits 18.
  const cutOff = createTcpServer((socket) => {
    socket.once("data", () => {
      probed.push("cut-off");
      socket.end(
        'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 200\r\n\r\n{"errors":[{"code":"MANIFEST_UNKNOWN","message":"manifest unk',
      );
    });
  });
  await Promise.all([
    new Promise((ready) => server.listen(0, "127.0.0.1", ready)),
    new Promise((ready) => cutOff.listen(0, "127.0.0.1", ready)),
  ]);
  host = `127.0.0.1:${server.address().port}`;
  cutOffHost = `127.0.0.1:${cutOff.address().port}`;
  closeCutOff = () => new Promise((done) => cutOff.close(done));
});

after(async () => {
  await Promise.all([closeCutOff(), new Promise((done) => server.close(done))]);
  rmSync(directory, { recursive: true, force: true });
});

/**
 * Runs the script; `registry` is "main" (the answering server) or "cut-off",
 * "closed". `copy` is how many pulls of CI's copy fail before one succeeds,
 * and what each prints.
 */
async function run({
  image = IMAGE,
  ciCopy = image.startsWith("semgrep/semgrep:") ? COPY_OF(image) : COPY,
  registry = "main",
  reply = [404, "{}"],
  mirror = [1, "mirror said no"],
  copy = [0, "copy pulled"],
}) {
  answer = reply;
  probed = [];
  const log = join(directory, "docker.log");
  writeFileSync(log, "");
  const summary = join(directory, "summary.md");
  writeFileSync(summary, "");
  const mirrorHost =
    registry === "cut-off"
      ? cutOffHost
      : registry === "closed"
        ? "127.0.0.1:1"
        : host;
  const child = spawn(script, [image, ciCopy], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      MIRROR_HOST: mirrorHost,
      MIRROR_API_SCHEME: "http",
      DOCKER_LOG: log,
      GITHUB_STEP_SUMMARY: summary,
      MIRROR_PULL_EXIT: String(mirror[0]),
      MIRROR_PULL_MESSAGE: mirror[1],
      COPY_PULL_FAILURES: String(copy[0]),
      COPY_PULL_MESSAGE: copy[1],
      COPY_ATTEMPTS: String(COPY_ATTEMPTS),
      COPY_INTERVAL: "0",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise((done) => child.on("close", done));
  return {
    status,
    stdout,
    stderr,
    mirrorHost,
    pulls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    summary: readFileSync(summary, "utf8"),
  };
}

const manifestUnknown = JSON.stringify({
  errors: [
    { code: "MANIFEST_UNKNOWN", message: "Failed to fetch the manifest" },
  ],
});

test("a mirror that has the image is used, and the registry is not asked", async () => {
  const result = await run({ mirror: [0, "pulled from the mirror"] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${MIRROR_IMAGE(result.mirrorHost)}\n`);
  assert.deepEqual(result.pulls, [`pull ${MIRROR_IMAGE(result.mirrorHost)}`]);
  assert.deepEqual(probed, []);
  assert.equal(result.summary, "");
});

test("a 404 whose errors[].code is MANIFEST_UNKNOWN falls back to CI's copy, never to Docker Hub", async () => {
  const result = await run({ reply: [404, manifestUnknown] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${COPY}\n`);
  assert.deepEqual(result.pulls, [
    `pull ${MIRROR_IMAGE(result.mirrorHost)}`,
    `pull ${COPY}`,
  ]);
  assert.match(probed[0], /^\/v2\/semgrep\/semgrep\/manifests\/sha256:a{64}$/);
  assert.match(result.summary, /pulled CI's copy of it/);
  assert.match(result.stderr, /::warning::/);
});

test("a copy still being made is waited for", async () => {
  const result = await run({
    reply: [404, manifestUnknown],
    copy: [COPY_ATTEMPTS - 1, "manifest unknown"],
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${COPY}\n`);
  assert.deepEqual(result.pulls, [
    `pull ${MIRROR_IMAGE(result.mirrorHost)}`,
    ...Array(COPY_ATTEMPTS).fill(`pull ${COPY}`),
  ]);
});

test("MANIFEST_UNKNOWN among several errors still counts", async () => {
  const body = JSON.stringify({
    errors: [{ code: "UNKNOWN", message: "x" }, { code: "MANIFEST_UNKNOWN" }],
  });
  const result = await run({ reply: [404, body] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${COPY}\n`);
});

test("a 404 without a structured MANIFEST_UNKNOWN fails", async () => {
  for (const body of [
    "{}",
    "not json",
    "",
    '{"errors":"MANIFEST_UNKNOWN"}',
    '{"errors":["MANIFEST_UNKNOWN"]}',
    '{"code":"MANIFEST_UNKNOWN"}',
    // Valid JSON in which only the text, and not the code, says it.
    JSON.stringify({
      errors: [{ code: "NAME_UNKNOWN", message: "MANIFEST_UNKNOWN" }],
    }),
  ]) {
    const result = await run({ reply: [404, body] });
    assert.equal(result.status, 1, body);
    assert.equal(result.stdout, "", body);
    assert.deepEqual(
      result.pulls,
      [`pull ${MIRROR_IMAGE(result.mirrorHost)}`],
      body,
    );
    assert.match(result.stderr, /not falling back to CI's copy/, body);
  }
});

test("another error code that mentions MANIFEST_UNKNOWN in its message does not fall back", async () => {
  const body = JSON.stringify({
    errors: [{ code: "UNKNOWN", message: "upstream said MANIFEST_UNKNOWN" }],
  });
  const result = await run({ reply: [404, body] });
  assert.equal(result.status, 1);
  assert.deepEqual(result.pulls, [`pull ${MIRROR_IMAGE(result.mirrorHost)}`]);
  assert.equal(result.summary, "");
});

test("MANIFEST_UNKNOWN under another status does not fall back", async () => {
  for (const status of [200, 400, 403, 429, 500, 503]) {
    const result = await run({ reply: [status, manifestUnknown] });
    assert.equal(result.status, 1, String(status));
    assert.deepEqual(
      result.pulls,
      [`pull ${MIRROR_IMAGE(result.mirrorHost)}`],
      String(status),
    );
  }
});

test("a 404 whose transfer is cut off fails, as curl's exit status says", async () => {
  const result = await run({ registry: "cut-off" });
  assert.deepEqual(probed, ["cut-off"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.pulls, [`pull ${MIRROR_IMAGE(result.mirrorHost)}`]);
  assert.match(result.stderr, /did not complete \(curl exit 18\)/);
  assert.equal(result.summary, "");
});

test("a registry that cannot be reached fails", async () => {
  const result = await run({ registry: "closed" });
  assert.equal(result.status, 1);
  assert.deepEqual(result.pulls, [`pull ${MIRROR_IMAGE(result.mirrorHost)}`]);
  assert.match(result.stderr, /did not complete \(curl exit 7\)/);
});

test("an empty image from the guard stops with a message and pulls nothing", async () => {
  const result = await run({ image: "" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.pulls, []);
  assert.match(result.stderr, /printed no image/);
});

test("a copy that never comes fails after the last attempt and leaves no claim that it succeeded", async () => {
  const result = await run({
    reply: [404, manifestUnknown],
    copy: [99, "manifest unknown"],
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.pulls, [
    `pull ${MIRROR_IMAGE(result.mirrorHost)}`,
    ...Array(COPY_ATTEMPTS).fill(`pull ${COPY}`),
  ]);
  assert.match(result.stderr, /could not be pulled in 3 attempts/);
  assert.equal(result.summary, "");
});

test("a copy that is not the pin in another registry fails before any pull or probe", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  for (const ciCopy of [
    "",
    IMAGE,
    `ghcr.io/openbrf/ci-mirror/semgrep:1.2.4@${digest}`,
    `ghcr.io/openbrf/ci-mirror/semgrep:1.2.3@sha256:${"b".repeat(64)}`,
    `ghcr.io/openbrf/ci-mirror/other:1.2.3@${digest}`,
    `ghcr.io/openbrf/ci-mirror/semgrep:1.2.3@${digest} --privileged`,
    `ghcr.io/openbrf/ci-mirror/semgrep:1.2.3@${digest}\n::error::injected`,
    `--help ghcr.io/semgrep:1.2.3@${digest}`,
    `Ghcr.io/semgrep:1.2.3@${digest}`,
    `/semgrep:1.2.3@${digest}`,
  ]) {
    const result = await run({ ciCopy, reply: [404, manifestUnknown] });
    assert.equal(result.status, 1, JSON.stringify(ciCopy));
    assert.equal(result.stdout, "", JSON.stringify(ciCopy));
    assert.deepEqual(result.pulls, [], JSON.stringify(ciCopy));
    assert.deepEqual(probed, [], JSON.stringify(ciCopy));
    assert.match(result.stderr, /Expected CI's copy/, JSON.stringify(ciCopy));
    assert.deepEqual(
      commandLines(result.stderr).filter(
        (line) => !line.startsWith("::error::Expected"),
      ),
      [],
      JSON.stringify(ciCopy),
    );
  }
});

/**
 * The lines of a step's log the runner would read as workflow commands: those
 * starting with `::` that are outside a `::stop-commands::<token>` ...
 * `::<token>::` region.
 */
function commandLines(log) {
  const commands = [];
  let token = null;
  for (const line of log.split("\n")) {
    if (token !== null) {
      if (line === `::${token}::`) token = null;
    } else if (line.startsWith("::stop-commands::")) {
      token = line.slice("::stop-commands::".length);
    } else if (line.startsWith("::")) {
      commands.push(line);
    }
  }
  assert.equal(token, null, "a stop-commands region was left open");
  return commands;
}

test("an argument that is not a pinned semgrep/semgrep reference fails before any pull or probe", async () => {
  for (const image of [
    "semgrep/semgrep",
    "semgrep/semgrep:1.2.3",
    `semgrep/semgrep@sha256:${"a".repeat(64)}`,
    `semgrep/semgrep:latest@sha256:${"a".repeat(63)}`,
    `semgrep/semgrep:latest@sha256:${"A".repeat(64)}`,
    `semgrep/semgrep:1.2.3@sha256:${"a".repeat(65)}`,
    `semgrep/other:1.2.3@sha256:${"a".repeat(64)}`,
    `evil/semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)}`,
    `other.example/semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)}`,
    `semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)} --privileged`,
    `semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)}\n::error::injected`,
    `semgrep/semgrep:1/../x@sha256:${"a".repeat(64)}`,
    `semgrep/semgrep:1.2.3@sha256:${"a".repeat(64)}/../../x`,
    `semgrep/semgrep:.bad@sha256:${"a".repeat(64)}`,
    `semgrep/semgrep:-bad@sha256:${"a".repeat(64)}`,
    `semgrep/semgrep:${"t".repeat(129)}@sha256:${"a".repeat(64)}`,
    "--help",
  ]) {
    const result = await run({ image, reply: [404, manifestUnknown] });
    assert.equal(result.status, 1, JSON.stringify(image));
    assert.equal(result.stdout, "", JSON.stringify(image));
    assert.deepEqual(result.pulls, [], JSON.stringify(image));
    assert.deepEqual(probed, [], JSON.stringify(image));
    assert.match(result.stderr, /Expected a pinned reference/, image);
    // The argument is shown, but cannot issue commands.
    assert.deepEqual(
      commandLines(result.stderr).filter(
        (line) => !line.startsWith("::error::Expected"),
      ),
      [],
      JSON.stringify(image),
    );
  }
});

test("a tag with dots, dashes and underscores is accepted", async () => {
  const image = `semgrep/semgrep:1.2.3-rc_1@sha256:${"b".repeat(64)}`;
  const result = await run({ image, mirror: [0, "pulled"] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${result.mirrorHost}/${image}\n`);
});

test("a tag of exactly 128 characters is accepted", async () => {
  const image = `semgrep/semgrep:${"t".repeat(128)}@sha256:${"b".repeat(64)}`;
  const result = await run({ image, mirror: [0, "pulled"] });
  assert.equal(result.status, 0);
});

const hostile = "::error::injected\n::add-mask::secret\n::set-output name=x::y";

test("what the mirror's docker pull prints cannot issue workflow commands, and is still logged", async () => {
  for (const mirror of [
    [0, hostile],
    [1, hostile],
  ]) {
    const result = await run({ mirror, reply: [404, manifestUnknown] });
    assert.deepEqual(
      commandLines(result.stderr).filter(
        (line) => !line.startsWith("::warning::"),
      ),
      [],
    );
    assert.ok(result.stderr.includes(hostile));
  }
});

test("what pulling CI's copy prints cannot issue workflow commands, whether it succeeds or not", async () => {
  for (const [copy, status] of [
    [[0, hostile], 0],
    [[99, hostile], 1],
  ]) {
    const result = await run({ reply: [404, manifestUnknown], copy });
    assert.equal(result.status, status);
    assert.deepEqual(
      commandLines(result.stderr).filter(
        (line) => !/^::(warning|error)::/.test(line),
      ),
      [],
    );
    assert.ok(result.stderr.includes(hostile));
  }
});

test("a registry response body cannot issue workflow commands, and is still logged", async () => {
  const result = await run({ reply: [503, hostile] });
  assert.equal(result.status, 1);
  assert.deepEqual(
    commandLines(result.stderr).filter((line) => !line.startsWith("::error::")),
    [],
  );
  assert.ok(result.stderr.includes(hostile));
});

test("the log cannot close its own stop-commands region, and the token differs per run", async () => {
  const tokens = new Set();
  for (let n = 0; n < 3; n++) {
    // A hostile text that tries to end the region early with a guessed token.
    const result = await run({
      mirror: [1, "::stop-commands::x\n::x::\n::error::injected\n::0::"],
    });
    // Only the script's own error, not the injected one, is a command.
    assert.deepEqual(commandLines(result.stderr), [
      `::error::${result.mirrorHost} failed for a reason other than a missing manifest; not falling back to CI's copy.`,
    ]);
    for (const match of result.stderr.matchAll(
      /^::stop-commands::([0-9a-f]{32})$/gm,
    )) {
      tokens.add(match[1]);
    }
  }
  assert.ok(tokens.size > 1);
});
