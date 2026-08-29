import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { loadEnvForIntegrationTests } from "../testing/integration-env";

/**
 * The budget on the endpoints anyone can reach, over real HTTP.
 *
 * Driven against invitation activation because a refused attempt is what the
 * budget is for: an invalid token answers 400 and writes nothing, so the suite
 * can spend a whole budget without leaving a row behind, and what it proves is
 * that a refused request costs a token too. A limiter that only counted the
 * requests that succeeded would count nothing on an endpoint where guessing is
 * the attack.
 *
 * The other two properties are what keep the limiter from becoming a denial of
 * service of its own: one address's spending is its own, and a read is never
 * limited.
 *
 * Every test spends an address of its own. Sharing one would make the file
 * order-dependent on a bucket that refills while the suite runs, which is a
 * test that passes or fails by how fast the machine is.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;

/**
 * Fixed addresses, unlike the other suites' rotating ones: this suite is about
 * exhausting a budget, so it has to spend one address's over and over.
 * 10.12.0.0/16 is this suite's; the other integration suites each hold their
 * own second octet.
 */
const ADDRESSES = {
  refused: "10.12.0.1",
  spent: "10.12.0.2",
  neighbour: "10.12.0.3",
  reader: "10.12.0.4",
} as const;

/** Matches the budget on InvitationAcceptController.accept. */
const ACTIVATIONS_PER_MINUTE = 10;

function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  address: string;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      method: options.method,
      url: options.url,
      payload: options.payload,
      headers: { "x-forwarded-for": options.address },
    });
}

/** An activation attempt with a token no invitation was ever issued for. */
function activate(address: string) {
  return inject({
    method: "POST",
    url: "/api/invitations/accept",
    payload: {
      token: `no-such-token-${process.hrtime.bigint().toString(36)}`,
      password: "a-long-enough-password",
    },
    address,
  });
}

/**
 * When a budget that has not refused is a defect rather than a slow machine.
 *
 * Spending outpaces the refill until one attempt takes longer than
 * WINDOW_MS / ACTIVATIONS_PER_MINUTE, six seconds here; at this many attempts
 * the suite tolerates a little under five seconds per request before it calls
 * the limiter broken, which no rejected token lookup comes close to.
 */
const MOST_ATTEMPTS = ACTIVATIONS_PER_MINUTE * 5;

/**
 * Spends one address's budget until it is refused, and returns the refusal.
 *
 * Counting exactly ACTIVATIONS_PER_MINUTE attempts would race the refill: the
 * bucket gains a token every six seconds, so a machine that took longer than
 * that to spend the budget would have one back before the last attempt landed
 * and the request after it would answer 400. That is a test that passes or
 * fails by how fast the machine is, which this file's header rules out.
 *
 * The size of the budget is asserted in public-rate-limit.guard.spec.ts, where
 * the clock is injected and the arithmetic can be exact. What is left for this
 * file is what only real HTTP can show: that the budget is spent by refused
 * requests too, and that spending it is answered with a refusal of its own.
 */
async function spendTheBudget(address: string) {
  for (let attempt = 0; attempt < MOST_ATTEMPTS; attempt += 1) {
    const answered = await activate(address);
    if (answered.statusCode === 429) {
      return answered;
    }
    // Refused on its merits, which is what a wrong token deserves - and what
    // costs a token all the same.
    expect(answered.statusCode).toBe(400);
  }
  throw new Error(
    `The budget from ${address} was never spent in ${MOST_ATTEMPTS} attempts.`,
  );
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 180_000);

afterAll(async () => {
  await app.close();
});

describe("a public endpoint's budget", () => {
  it("refuses the request after it, whatever the ones before it answered", async () => {
    // The refusal that ended the spending is the request after the budget.
    // Asking again to obtain one would put a second gap between the last spent
    // token and the assertion, for a bucket that refills while the suite runs.
    const refused = await spendTheBudget(ADDRESSES.refused);

    expect(refused.json()).toMatchObject({ reason: "too-many-requests" });
    // So a client that means well knows when to come back rather than
    // hammering the door it was just turned away from.
    expect(Number(refused.headers["retry-after"])).toBeGreaterThan(0);
    // The body is the refusal and nothing else: nothing that came in with the
    // request comes back out of it.
    expect(JSON.stringify(refused.json())).not.toContain("no-such-token");
  });

  it("is one address's alone", async () => {
    // Returning only once refused, so reaching here is the assertion that this
    // address is spent.
    await spendTheBudget(ADDRESSES.spent);

    /*
     * A resident on another connection is unaffected, which is the whole reason
     * the limiter reads the forwarded header rather than counting the
     * instance's requests as one. The end-to-end suite depends on exactly this:
     * every test there is a different member signing in from their own home.
     */
    const neighbour = await activate(ADDRESSES.neighbour);

    expect(neighbour.statusCode).toBe(400);
  });

  it("is not spent by reading", async () => {
    await spendTheBudget(ADDRESSES.reader);

    /*
     * Budgets sit on unauthenticated mutations only. The interface makes many
     * reads - the sign-in screen asks whether setup is still open before it
     * renders anything - and limiting those would turn a busy morning into a
     * broken instance.
     */
    const answered = await inject({
      method: "GET",
      url: "/api/setup/state",
      address: ADDRESSES.reader,
    });

    expect(answered.statusCode).toBe(200);
  });
});
