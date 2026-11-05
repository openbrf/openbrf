import { type AddressInfo, createServer } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { HttpApiMailDriver, MailApiError } from "./http-api-mail.driver";
import { type OutgoingMail, mayHaveBeenHandedOver } from "./mail-driver";
import {
  startMailApiTestServer,
  type MailApiTestServer,
} from "./testing/mail-api-test-server";

/**
 * The HTTP mail driver against a real HTTP conversation.
 *
 * The contract this driver publishes is the conversation - the path, the keys,
 * the content type and the JSON - so it is tested against a server that checks
 * them and refuses a header the service owns, rather than against a stub of the
 * driver's own method.
 */

let api: MailApiTestServer;

beforeAll(async () => {
  api = await startMailApiTestServer();
});

afterAll(async () => {
  await api.close();
});

function driver(
  overrides: { url?: string; key?: string; requestTimeoutMs?: number } = {},
): HttpApiMailDriver {
  return new HttpApiMailDriver({
    url: overrides.url ?? api.baseUrl,
    key: overrides.key ?? api.key,
    messageIdDomain: "getpost.se",
    requestTimeoutMs: overrides.requestTimeoutMs ?? 5000,
  });
}

const MAIL: OutgoingMail = {
  from: { name: null, address: "utskick@delad.example" },
  to: "anna@exempel.se",
  subject: "Ett konto väntar på dig hos Brf Eksemplet",
  html: "<p>Aktivera ditt konto</p>",
  text: "Aktivera ditt konto",
  replyTo: null,
  messageId: null,
  inReplyTo: null,
};

/** The last request's body, parsed. */
function lastPayload(): Record<string, unknown> {
  return JSON.parse(api.requests.at(-1)?.body ?? "{}") as Record<
    string,
    unknown
  >;
}

describe("posting a message", () => {
  it("sends the documented JSON to <base>/emails with the key", async () => {
    await driver().send({
      ...MAIL,
      from: { name: "Brf Eksemplet", address: "utskick@delad.example" },
      replyTo: "styrelsen@eksemplet.example",
      inReplyTo: "fraga-1@utanfor.example",
    });

    const request = api.requests.at(-1);
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/emails");
    expect(request?.authorization).toBe(`Bearer ${api.key}`);
    expect(request?.contentType).toBe("application/json");
    // Exactly this and nothing else: every field the contract names, and no
    // field it does not.
    expect(lastPayload()).toEqual({
      from: '"Brf Eksemplet" <utskick@delad.example>',
      to: ["anna@exempel.se"],
      subject: "Ett konto väntar på dig hos Brf Eksemplet",
      html: "<p>Aktivera ditt konto</p>",
      text: "Aktivera ditt konto",
      reply_to: ["styrelsen@eksemplet.example"],
      headers: {
        "In-Reply-To": "<fraga-1@utanfor.example>",
        References: "<fraga-1@utanfor.example>",
      },
    });
  });

  it("leaves out a Reply-To and the headers when there are none", async () => {
    await driver().send(MAIL);

    expect(lastPayload()).toEqual({
      from: "utskick@delad.example",
      to: ["anna@exempel.se"],
      subject: "Ett konto väntar på dig hos Brf Eksemplet",
      html: "<p>Aktivera ditt konto</p>",
      text: "Aktivera ditt konto",
    });
  });

  it("never sends a Message-ID, even when the caller has one", async () => {
    /*
     * The service owns the header and refuses it from the caller, so a driver
     * that passed the caller's identifier on would have every threaded answer
     * refused. The test server refuses it the same way, so this is also what
     * the round trip below depends on.
     */
    const sent = await driver().send({
      ...MAIL,
      messageId: "svar-1@styrelsen.example",
      inReplyTo: "fraga-1@utanfor.example",
    });

    const headers = (lastPayload().headers ?? {}) as Record<string, string>;
    expect(
      Object.keys(headers).map((name) => name.toLowerCase()),
    ).not.toContain("message-id");
    expect(api.requests.at(-1)?.body).not.toContain("svar-1@styrelsen.example");
    // What it reports is the identifier the service wrote instead.
    expect(sent.messageId).toBe(`${api.accepted.at(-1)?.id ?? ""}@getpost.se`);
  });

  it("keeps the base address's own path, with or without a trailing slash", async () => {
    await driver({ url: `${api.baseUrl}/` }).send(MAIL);

    expect(api.requests.at(-1)?.path).toBe("/v1/emails");
  });
});

describe("the display name", () => {
  it("is quoted, with a quote and a backslash escaped and å left as it is", async () => {
    await driver().send({
      ...MAIL,
      from: {
        name: 'Brf "Åkern" \\ Söder',
        address: "utskick@delad.example",
      },
    });

    // RFC 5322 3.2.4: inside a quoted string only the quote and the backslash
    // are escaped. The letter outside ASCII is the service's to encode.
    expect(lastPayload().from).toBe(
      '"Brf \\"Åkern\\" \\\\ Söder" <utskick@delad.example>',
    );
  });
});

describe("the idempotency key", () => {
  it("is the caller's identifier, so a retried answer is sent once", async () => {
    await driver().send({ ...MAIL, messageId: "svar-2@styrelsen.example" });

    expect(api.requests.at(-1)?.idempotencyKey).toBe(
      "svar-2@styrelsen.example",
    );
  });

  it("is a fresh one for every message that has none", async () => {
    await driver().send(MAIL);
    const first = api.requests.at(-1)?.idempotencyKey;
    await driver().send(MAIL);
    const second = api.requests.at(-1)?.idempotencyKey;

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});

describe("the identifier it reports", () => {
  it("is the service's id under the configured domain", async () => {
    api.answerNextWith(200, JSON.stringify({ id: "abc" }), {
      "content-type": "application/json",
    });

    const sent = await driver().send({
      ...MAIL,
      messageId: "svar-3@styrelsen.example",
    });

    // The service writes <abc@getpost.se>, and that is what a reply names.
    expect(sent).toEqual({ messageId: "abc@getpost.se" });
  });

  it("is the id of a message the service accepted", async () => {
    const sent = await driver().send(MAIL);

    expect(sent.messageId).toBe(`${api.accepted.at(-1)?.id ?? ""}@getpost.se`);
  });

  it("is none for a 2xx without an id", async () => {
    api.answerNextWith(202, "{}", { "content-type": "application/json" });

    await expect(driver().send(MAIL)).resolves.toEqual({ messageId: null });
  });

  it("is none for an id that could not be the left side of a Message-ID", async () => {
    api.answerNextWith(200, JSON.stringify({ id: "a b<c>" }));

    await expect(driver().send(MAIL)).resolves.toEqual({ messageId: null });
  });
});

describe("a refusal", () => {
  it.each([422, 503])(
    "fails on %i with the status and never the body",
    async (status) => {
      api.answerNextWith(
        status,
        JSON.stringify({ message: "anna@exempel.se is not deliverable" }),
      );

      const failure = await driver()
        .send(MAIL)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(MailApiError);
      expect((failure as MailApiError).status).toBe(status);
      // A refusal quotes the recipient back, and the recipient is an address.
      expect((failure as MailApiError).message).toBe(
        `The mail API refused the message (HTTP ${String(status)}).`,
      );
      expect((failure as MailApiError).message).not.toContain("@");
    },
  );

  it("fails when the service does not accept the key", async () => {
    const accepted = api.accepted.length;

    await expect(driver({ key: "wrong" }).send(MAIL)).rejects.toMatchObject({
      status: 401,
    });
    expect(api.accepted).toHaveLength(accepted);
  });

  it("fails at the bound when the service never answers", async () => {
    api.silenceNext();

    const failure = await driver({ requestTimeoutMs: 200 })
      .send(MAIL)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MailApiError);
    expect((failure as MailApiError).message).toBe(
      "The mail API did not answer in time.",
    );
  });

  it("ends the request when the caller's signal is aborted, long before its own bound", async () => {
    // A caller that holds a lock across the handoff hands nothing over after
    // its deadline, and hears of it as its own abort.
    api.silenceNext();
    const deadline = AbortSignal.timeout(100);
    const started = Date.now();

    const failure = await driver({ requestTimeoutMs: 5000 })
      .send(MAIL, deadline)
      .catch((error: unknown) => error);

    expect(failure).toBe(deadline.reason);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("sends nothing on a signal that is already aborted", async () => {
    const before = api.requests.length;

    await expect(driver().send(MAIL, AbortSignal.abort())).rejects.toThrow();
    expect(api.requests).toHaveLength(before);
  });

  it("treats a redirect as a failure and does not follow it", async () => {
    // The key and the recipient would go wherever the answer pointed.
    api.answerNextWith(302, "", { location: `${api.baseUrl}/elsewhere` });
    const before = api.requests.length;

    await expect(driver().send(MAIL)).rejects.toMatchObject({ status: 302 });
    expect(api.requests).toHaveLength(before + 1);
  });

  it("reports an unreachable service rather than throwing something else", async () => {
    await expect(
      driver({ url: "http://127.0.0.1:1/v1" }).send(MAIL),
    ).rejects.toBeInstanceOf(MailApiError);
  });
});

/**
 * How far a failed request had got, as the driver states it on its error.
 *
 * A service that declined the request did not take the message. One that
 * failed after reading it, a gateway in front of it, a key another request is
 * still being handled under, and a request that ran out of time may have.
 */
describe("a failed request", () => {
  it.each([302, 400, 401, 422, 429])(
    "says an answer of HTTP %i was not handed over",
    async (status) => {
      api.answerNextWith(status, "");

      const failure = await driver()
        .send(MAIL)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ status, handover: "not-handed-over" });
      expect(mayHaveBeenHandedOver(failure)).toBe(false);
    },
  );

  it.each([409, 500, 502, 503, 504])(
    "says an answer of HTTP %i may have been handed over",
    async (status) => {
      api.answerNextWith(status, "");

      const failure = await driver()
        .send(MAIL)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({
        status,
        handover: "may-have-been-handed-over",
      });
      expect(mayHaveBeenHandedOver(failure)).toBe(true);
    },
  );

  it("says a request that ran out of time may have been handed over", async () => {
    api.silenceNext();

    const failure = await driver({ requestTimeoutMs: 200 })
      .send(MAIL)
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      status: null,
      handover: "may-have-been-handed-over",
    });
  });

  it("says a connection refused was not handed over", async () => {
    // A port that was free a moment ago, so nothing answers on it. Not port 1,
    // which fetch refuses itself without a code that says why.
    const port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const { port: free } = probe.address() as AddressInfo;
        probe.close(() => {
          resolve(free);
        });
      });
    });

    const failure = await driver({ url: `http://127.0.0.1:${String(port)}/v1` })
      .send(MAIL)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MailApiError);
    expect(failure).toMatchObject({
      status: null,
      handover: "not-handed-over",
    });
  });
});
