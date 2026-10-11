/**
 * When the Semgrep pull falls back to Docker Hub, and when it fails instead.
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
  // message the test chose for the mirror.
  writeFileSync(
    join(directory, "docker"),
    `#!/usr/bin/env bash
echo "pull $2" >> "$DOCKER_LOG"
if [[ "$2" == "$MIRROR_HOST/"* ]]; then
  echo "$MIRROR_PULL_MESSAGE"
  exit "$MIRROR_PULL_EXIT"
fi
echo "$HUB_PULL_MESSAGE"
exit "$HUB_PULL_EXIT"
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
  closeCutOff = () => cutOff.close();
});

after(async () => {
  closeCutOff();
  await new Promise((done) => server.close(done));
  rmSync(directory, { recursive: true, force: true });
});

/** Runs the script; `registry` is "main" (the answering server) or "cut-off", "closed". */
async function run({
  image = IMAGE,
  registry = "main",
  reply = [404, "{}"],
  mirror = [1, "mirror said no"],
  hub = [0, "hub pulled"],
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
  const child = spawn(script, [image], {
    env: {
      PATH: `${directory}:${process.env.PATH}`,
      MIRROR_HOST: mirrorHost,
      MIRROR_API_SCHEME: "http",
      DOCKER_LOG: log,
      GITHUB_STEP_SUMMARY: summary,
      MIRROR_PULL_EXIT: String(mirror[0]),
      MIRROR_PULL_MESSAGE: mirror[1],
      HUB_PULL_EXIT: String(hub[0]),
      HUB_PULL_MESSAGE: hub[1],
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

test("a 404 whose errors[].code is MANIFEST_UNKNOWN falls back to Docker Hub", async () => {
  const result = await run({ reply: [404, manifestUnknown] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${IMAGE}\n`);
  assert.deepEqual(result.pulls, [
    `pull ${MIRROR_IMAGE(result.mirrorHost)}`,
    `pull ${IMAGE}`,
  ]);
  assert.match(probed[0], /^\/v2\/semgrep\/semgrep\/manifests\/sha256:a{64}$/);
  assert.match(result.summary, /pulled it from Docker Hub/);
  assert.match(result.stderr, /::warning::/);
});

test("MANIFEST_UNKNOWN among several errors still counts", async () => {
  const body = JSON.stringify({
    errors: [{ code: "UNKNOWN", message: "x" }, { code: "MANIFEST_UNKNOWN" }],
  });
  const result = await run({ reply: [404, body] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `${IMAGE}\n`);
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
    assert.match(result.stderr, /not falling back to Docker Hub/, body);
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

test("a failed Docker Hub pull fails and leaves no claim that it succeeded", async () => {
  const result = await run({
    reply: [404, manifestUnknown],
    hub: [1, "toomanyrequests: rate limit"],
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.pulls, [
    `pull ${MIRROR_IMAGE(result.mirrorHost)}`,
    `pull ${IMAGE}`,
  ]);
  assert.equal(result.summary, "");
});
