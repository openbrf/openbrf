import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { auditEntriesByAction, registerRowCounts } from "../src/database";
import { expect, stack, test } from "../src/fixtures";
import { ensureInstance } from "../src/provision";
import {
  managementTokenDigest,
  repositoryRoot,
  runInAppContainer,
} from "../src/stack";

/**
 * The management API in the deployed image (ADR 0021).
 *
 * The listener runs on a port of its own inside the app container, and the
 * stack publishes no host port for it, so the spec calls it from inside the
 * container: from where the host's control plane stands rather than from the
 * internet. What is shown here and nowhere else is that the image carries the
 * whole of it - the variables reach the process through the compose files,
 * the listener starts beside the application, the runtime role may read the
 * migration table, and the entry lands in the log the image wrote to - and
 * that the public address has no management route at all.
 *
 * The token is a credential of this loopback stack like the passwords in
 * stack.env, which holds its digest; the first test keeps the two together.
 */

test.describe.configure({ mode: "serial" });

const TOKEN =
  "e2e-management-token-0000000000000000000000000000000000000000004";

/** What a call from inside the container answered. */
type Answer = {
  readonly status: number;
  readonly cacheControl: string | null;
  readonly body: string;
};

/**
 * Calls the listener from inside the app container, with `token` if given.
 *
 * The port is the container's own OPENBRF_MANAGEMENT_PORT, so a variable that
 * never reached the process fails here rather than being papered over by the
 * spec knowing the number. The token travels in the environment of the one
 * command rather than on its command line.
 */
function callListener(token: string | null): Answer {
  const script = [
    "const url = 'http://127.0.0.1:' + process.env.OPENBRF_MANAGEMENT_PORT + '/v1/summary';",
    "const token = process.env.MANAGEMENT_TOKEN;",
    "fetch(url, { headers: token ? { authorization: 'Bearer ' + token } : {} })",
    "  .then(async (response) => process.stdout.write(JSON.stringify({",
    "    status: response.status,",
    "    cacheControl: response.headers.get('cache-control'),",
    "    body: await response.text(),",
    "  })))",
    "  .catch((error) => { process.stderr.write(String(error)); process.exit(1); });",
  ].join("\n");

  const { status, output } = runInAppContainer(
    ["node", "-e", script],
    token === null ? {} : { MANAGEMENT_TOKEN: token },
    60_000,
  );
  expect(status, output).toBe(0);
  return JSON.parse(output) as Answer;
}

/** @openbrf/api's version, which is the platform's. */
function platformVersion(): string {
  const manifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "apps/api/package.json"), "utf8"),
  ) as { version: string };
  return manifest.version;
}

test("the stack's digest is the digest of the spec's token", () => {
  // Minted and digested as the host does: SHA-256, base64url, unpadded.
  expect(createHash("sha256").update(TOKEN, "utf8").digest("base64url")).toBe(
    managementTokenDigest(),
  );
});

test("the listener answers the summary to its token", async ({ api }) => {
  await ensureInstance(api);
  const counts = await registerRowCounts();

  const answer = callListener(TOKEN);

  expect(answer.status, answer.body).toBe(200);
  expect(answer.cacheControl).toBe("no-store");
  const summary = JSON.parse(answer.body) as {
    schema: number;
    version: string;
    claimed: boolean;
    apartments: number;
    register: { persons: number };
    migrations: { pending: number; failed: number; latest: string | null };
  };
  expect(summary.schema).toBe(1);
  expect(summary.version).toBe(platformVersion());
  expect(summary.claimed).toBe(true);
  // The fixture's two addresses carry 42 apartments, and the rows are the
  // count: the suite writes nothing while this reads.
  expect(summary.apartments).toBeGreaterThanOrEqual(42);
  expect(summary.apartments).toBe(counts.apartments);
  expect(summary.register.persons).toBe(counts.persons);
  expect(summary.migrations.pending).toBe(0);
  expect(summary.migrations.failed).toBe(0);
  expect(summary.migrations.latest).not.toBeNull();
});

test("every read is in the log, on the management channel, by nobody", async () => {
  const before = await auditEntriesByAction("INSTANCE_SUMMARY_READ");

  expect(callListener(TOKEN).status).toBe(200);

  const after = await auditEntriesByAction("INSTANCE_SUMMARY_READ");
  expect(after.length).toBe(before.length + 1);
  const latest = after.at(-1);
  expect(latest?.channel).toBe("MANAGEMENT");
  expect(latest?.actorPersonId).toBeNull();
  expect(latest?.context).toEqual({ schema: 1 });
});

test("a wrong token, and none, are refused", () => {
  for (const token of ["not-the-management-token", null]) {
    const answer = callListener(token);
    expect(answer.status, String(token)).toBe(401);
    expect(JSON.parse(answer.body)).toEqual({
      reason: "management-token-invalid",
    });
  }
});

test("the public address has no management route", async ({ api }) => {
  // The token is worth nothing there: presented on the application's own
  // port it is an anonymous request, and neither path is a route.
  for (const path of ["/api/management/v1/summary", "/v1/summary"]) {
    const response = await api.get(`${stack.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status(), path).toBe(404);
    expect(await response.text(), path).not.toContain('"schema"');
  }
});
