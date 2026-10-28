import { createHash } from "node:crypto";

import { Logger } from "@nestjs/common";
import {
  type PluginRecipient,
  PluginRecipientError,
  type PluginRecipientErrorCode,
  type PluginRecipientRequest,
  PluginResidentRouteError,
} from "@openbrf/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AuditEntryInput } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import {
  type PinnedRequest,
  type PinnedResponse,
  ResponseTooLargeError,
} from "../network/pinned-request";
import { PluginRecipientsService } from "./plugin-recipients.service";
import {
  RESIDENT_ROUTE_ANSWER_WAIT_MS,
  residentRouteHandler,
  runOnResidentRoute,
} from "./resident-route-scope";

/**
 * A plugin's way out to its declared recipients (ADR 0037).
 *
 * The network and the database are doubles, because what is under test is
 * what the host decides before anything leaves: which origin a request may
 * reach, which redirect it may follow, which categories and persons a
 * disclosure may name, and that the record of a disclosure is written before
 * the send and its outcome after. Every step lands in one ordered list, so
 * "before" and "after" are asserted on the order things happened in.
 */

const PLUGIN = "assistant";

const PROVIDER: PluginRecipient = {
  id: "model-provider",
  origin: "https://api.example.com",
  purpose: { sv: "Språkmodellen", en: "The language model" },
  personalData: ["name", "freeText"],
};

const RATES: PluginRecipient = {
  id: "exchange-rates",
  origin: "https://rates.example.com",
  purpose: { sv: "Växelkurser", en: "Exchange rates" },
  personalData: [],
};

const DECLARED = [PROVIDER, RATES];

const PUBLIC_ADDRESS = { address: "93.184.215.14", family: 4 as const };

type Step =
  | { kind: "audit"; entry: AuditEntryInput }
  | { kind: "send"; request: PinnedRequest };

function harness(
  options: {
    answers?: (PinnedResponse | Error)[];
    address?: string;
    allowPrivate?: boolean;
    /** How many of the named persons the register holds and may hand out. */
    personsFound?: number;
    failAuditOn?: AuditEntryInput["action"];
    /** The persons a record the plugin can read is about. */
    readable?: string[];
  } = {},
) {
  const steps: Step[] = [];
  const answers = [...(options.answers ?? [ok("{}")])];

  const send = vi.fn(async (request: PinnedRequest) => {
    steps.push({ kind: "send", request });
    const answer = answers.shift() ?? ok("{}");
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  });
  const count = vi.fn(
    async ({ where }: { where: { id: { in: string[] } } }) =>
      options.personsFound ?? where.id.in.length,
  );
  const holdsReadableRecordAbout = vi.fn(
    async (_plugin: string, subject: string) =>
      (options.readable ?? []).includes(subject),
  );
  const prisma = {
    person: { count },
    $transaction: async (work: (tx: unknown) => Promise<void>) => {
      await work("tx");
    },
  };
  const audit = {
    record: vi.fn(async (entry: AuditEntryInput) => {
      if (entry.action === options.failAuditOn) {
        throw new Error("the database went away");
      }
      steps.push({ kind: "audit", entry });
    }),
  };

  const service = new PluginRecipientsService(
    prisma as never,
    audit as never,
    {
      OPENBRF_ALLOW_PRIVATE_HOSTS: options.allowPrivate ?? false,
    } as unknown as Env,
    {
      resolve: async () => [
        options.address === undefined
          ? PUBLIC_ADDRESS
          : { address: options.address, family: 4 },
      ],
      send,
    },
    { holdsReadableRecordAbout } as never,
  );

  const fetch = (id: string, path: string, init?: PluginRecipientRequest) =>
    service.fetch(PLUGIN, DECLARED, id, path, init);

  return { fetch, steps, send, count, audit, holdsReadableRecordAbout };
}

function ok(body: string, status = 200): PinnedResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(body),
  };
}

function redirect(location: string, status = 302): PinnedResponse {
  return { status, headers: { location }, body: Buffer.alloc(0) };
}

async function refusal(
  attempt: Promise<unknown>,
): Promise<PluginRecipientErrorCode> {
  const error = await attempt.then(
    () => {
      throw new Error("expected a refusal");
    },
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(PluginRecipientError);
  return (error as PluginRecipientError).code;
}

const DISCLOSURE: PluginRecipientRequest = {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": "sk-hemlig" },
  body: '{"text":"Anna Svensson i lägenhet 1102"}',
  disclosure: { personalData: ["name", "freeText"], subjects: ["p1", "p2"] },
};

describe("host.recipients.fetch", () => {
  describe("which origin it reaches", () => {
    it("sends to the path on the declared origin, at the addresses judged", async () => {
      const { fetch, send } = harness({ answers: [ok('{"models":[]}')] });

      const response = await fetch("model-provider", "/v1/models?limit=5", {
        headers: { "x-api-key": "sk-hemlig" },
      });

      expect(response.status).toBe(200);
      expect(response.json()).toEqual({ models: [] });
      expect(send).toHaveBeenCalledOnce();
      const [request] = send.mock.calls[0] ?? [];
      expect(request?.url.href).toBe(
        "https://api.example.com/v1/models?limit=5",
      );
      expect(request?.method).toBe("GET");
      expect(request?.addresses).toEqual([PUBLIC_ADDRESS]);
      expect(request?.headers).toEqual({ "x-api-key": "sk-hemlig" });
    });

    it("refuses an id the manifest does not declare", async () => {
      const { fetch, send } = harness();

      expect(await refusal(fetch("elsewhere", "/"))).toBe(
        "recipient-not-declared",
      );
      expect(send).not.toHaveBeenCalled();
    });

    it.each([
      ["no leading slash", "v1/models"],
      ["an absolute URL", "https://elsewhere.example/v1"],
      ["a second leading slash", "//elsewhere.example/v1"],
      ["a backslash the parser reads as a slash", "/\\elsewhere.example/v1"],
      ["credentials", "//user:pass@api.example.com/v1"],
      ["a path that is too long", `/${"a".repeat(2048)}`],
    ])("refuses a path with %s", async (_label, path) => {
      const { fetch, send, audit } = harness();

      expect(await refusal(fetch("model-provider", path))).toBe("path-refused");
      expect(send).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254"])(
      "refuses an origin whose host resolves to %s",
      async (address) => {
        const { fetch, send, audit } = harness({ address });

        expect(await refusal(fetch("model-provider", "/", DISCLOSURE))).toBe(
          "address-refused",
        );
        expect(send).not.toHaveBeenCalled();
        // Nothing left, so nothing was disclosed.
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it("reaches a private address where whoever runs the instance allows it", async () => {
      const { fetch, send } = harness({
        address: "192.168.1.10",
        allowPrivate: true,
      });

      await fetch("model-provider", "/");

      expect(send).toHaveBeenCalledOnce();
    });
  });

  describe("redirects", () => {
    it("follows one that stays on the origin", async () => {
      const { fetch, send } = harness({
        answers: [redirect("/v2/models"), ok("[]")],
      });

      const response = await fetch("model-provider", "/v1/models");

      expect(response.status).toBe(200);
      expect(send.mock.calls.map(([request]) => request.url.href)).toEqual([
        "https://api.example.com/v1/models",
        "https://api.example.com/v2/models",
      ]);
    });

    it.each([
      ["another host", "https://elsewhere.example/v1"],
      ["another scheme", "http://api.example.com/v1"],
      ["another port", "https://api.example.com:8443/v1"],
      ["a sibling host", "https://evil.api.example.com/v1"],
    ])("refuses one to %s, and sends nothing there", async (_label, to) => {
      const { fetch, send } = harness({ answers: [redirect(to), ok("{}")] });

      expect(await refusal(fetch("model-provider", "/v1"))).toBe(
        "redirect-refused",
      );
      expect(send).toHaveBeenCalledOnce();
    });

    it("refuses a sixth", async () => {
      const { fetch, send } = harness({
        answers: Array.from({ length: 7 }, (_, hop) =>
          redirect(`/hop/${String(hop)}`),
        ),
      });

      expect(await refusal(fetch("model-provider", "/"))).toBe(
        "redirect-refused",
      );
      expect(send).toHaveBeenCalledTimes(6);
    });

    it("turns a POST answered with a 303 into a GET without the body", async () => {
      const { fetch, send } = harness({
        answers: [redirect("/result/1", 303), ok("{}")],
      });

      await fetch("model-provider", "/v1/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "k" },
        body: "{}",
      });

      const second = send.mock.calls[1]?.[0];
      expect(second?.method).toBe("GET");
      expect(second?.body).toBeNull();
      expect(second?.headers).toEqual({ "x-api-key": "k" });
    });

    it("keeps the method and the body on a 307", async () => {
      const { fetch, send } = harness({
        answers: [redirect("/v1/jobs/b", 307), ok("{}")],
      });

      await fetch("model-provider", "/v1/jobs", { method: "POST", body: "{}" });

      const second = send.mock.calls[1]?.[0];
      expect(second?.method).toBe("POST");
      expect(second?.body?.toString()).toBe("{}");
    });
  });

  describe("the request a plugin hands it", () => {
    it.each<[string, PluginRecipientRequest]>([
      ["a method it does not send", { method: "CONNECT" as never }],
      ["a body on a GET", { body: "x" }],
      ["a host header", { headers: { Host: "elsewhere.example" } }],
      ["a length header", { headers: { "Content-Length": "1" } }],
      ["a proxy header", { headers: { "proxy-authorization": "x" } }],
      ["a header value that splits the request", { headers: { a: "b\r\nc" } }],
      ["a header with no name", { headers: { "": "x" } }],
      ["a timeout of none", { timeoutMs: 0 }],
      ["a timeout past five minutes", { timeoutMs: 300_001 }],
      [
        "a body that is not text or bytes",
        { method: "POST", body: 1 as never },
      ],
    ])("refuses %s before anything is sent", async (_label, init) => {
      const { fetch, send } = harness();

      expect(await refusal(fetch("model-provider", "/", init))).toBe(
        "request-refused",
      );
      expect(send).not.toHaveBeenCalled();
    });

    it("hands back a recipient's 4xx as an answer, not a refusal", async () => {
      const { fetch } = harness({ answers: [ok('{"error":"x"}', 429)] });

      const response = await fetch("model-provider", "/");

      expect(response.status).toBe(429);
      expect(response.text()).toBe('{"error":"x"}');
    });

    it("refuses an answer longer than it reads", async () => {
      const { fetch } = harness({ answers: [new ResponseTooLargeError()] });

      expect(await refusal(fetch("model-provider", "/"))).toBe(
        "response-too-large",
      );
    });

    it("reports a connection that fails as unreachable", async () => {
      const { fetch } = harness({ answers: [new Error("ECONNRESET")] });

      expect(await refusal(fetch("model-provider", "/"))).toBe("unreachable");
    });
  });

  describe("a disclosure of personal data", () => {
    it("records one entry per person before the send and one after", async () => {
      const { fetch, steps } = harness({ answers: [ok("{}", 201)] });

      await fetch("model-provider", "/v1/messages", DISCLOSURE);

      expect(steps.map((step) => step.kind)).toEqual([
        "audit",
        "audit",
        "send",
        "audit",
        "audit",
      ]);

      const digest = `sha256:${createHash("sha256")
        .update(DISCLOSURE.body as string)
        .digest("hex")}`;
      const [first, second, , third, fourth] = steps as {
        entry: AuditEntryInput;
      }[];
      const disclosureId = first?.entry.context?.disclosureId;
      expect(disclosureId).toEqual(expect.any(String));

      for (const [step, person] of [
        [first, "p1"],
        [second, "p2"],
      ] as const) {
        expect(step?.entry).toEqual({
          action: "PLUGIN_DISCLOSURE_STARTED",
          channel: "PLUGIN",
          actorPersonId: null,
          pluginId: PLUGIN,
          targetPersonId: person,
          targetKind: "plugin",
          targetId: PLUGIN,
          context: {
            disclosureId,
            recipient: "model-provider",
            origin: "https://api.example.com",
            personalData: ["freeText", "name"],
            digest,
          },
        });
      }
      for (const [step, person] of [
        [third, "p1"],
        [fourth, "p2"],
      ] as const) {
        expect(step?.entry).toMatchObject({
          action: "PLUGIN_DISCLOSURE_FINISHED",
          pluginId: PLUGIN,
          targetPersonId: person,
          context: {
            disclosureId,
            recipient: "model-provider",
            outcome: "answered",
            status: 201,
          },
        });
      }
    });

    it("never puts the body, a header or the path in an entry", async () => {
      const { fetch, audit } = harness();

      await fetch("model-provider", "/v1/messages?about=Anna", DISCLOSURE);

      const written = JSON.stringify(audit.record.mock.calls);
      expect(written).not.toContain("Anna");
      expect(written).not.toContain("sk-hemlig");
    });

    it("records the failure when no answer comes", async () => {
      const { fetch, steps } = harness({
        answers: [new Error("ECONNREFUSED")],
      });

      expect(
        await refusal(fetch("model-provider", "/v1/messages", DISCLOSURE)),
      ).toBe("unreachable");
      expect(steps.map((step) => step.kind)).toEqual([
        "audit",
        "audit",
        "send",
        "audit",
        "audit",
      ]);
      expect(steps.at(-1)).toMatchObject({
        entry: {
          action: "PLUGIN_DISCLOSURE_FINISHED",
          context: { outcome: "failed", code: "unreachable" },
        },
      });
    });

    it("records a refused redirect as the outcome", async () => {
      const { fetch, steps } = harness({
        answers: [redirect("https://elsewhere.example/")],
      });

      expect(
        await refusal(fetch("model-provider", "/v1/messages", DISCLOSURE)),
      ).toBe("redirect-refused");
      expect(steps.at(-1)).toMatchObject({
        entry: { context: { outcome: "failed", code: "redirect-refused" } },
      });
    });

    it("records a disclosure that names nobody once, with no person", async () => {
      const { fetch, audit } = harness();

      await fetch("model-provider", "/v1/messages", {
        ...DISCLOSURE,
        disclosure: { personalData: ["freeText"], subjects: [] },
      });

      expect(audit.record.mock.calls.map(([entry]) => entry)).toEqual([
        expect.objectContaining({
          action: "PLUGIN_DISCLOSURE_STARTED",
          targetPersonId: null,
        }),
        expect.objectContaining({
          action: "PLUGIN_DISCLOSURE_FINISHED",
          targetPersonId: null,
        }),
      ]);
    });

    it("sends nothing when the entry before it cannot be written", async () => {
      const { fetch, send } = harness({
        failAuditOn: "PLUGIN_DISCLOSURE_STARTED",
      });

      await expect(
        fetch("model-provider", "/v1/messages", DISCLOSURE),
      ).rejects.toThrow("the database went away");
      expect(send).not.toHaveBeenCalled();
    });

    it("hands back the answer when only the entry after it fails", async () => {
      // The request has gone and the entry before it says so; an error here
      // would invite the plugin to send it a second time.
      const { fetch } = harness({ failAuditOn: "PLUGIN_DISCLOSURE_FINISHED" });
      const error = vi
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => undefined);

      try {
        const response = await fetch(
          "model-provider",
          "/v1/messages",
          DISCLOSURE,
        );

        expect(response.status).toBe(200);
        // The class of the failure and the plugin, never its message: one
        // thrown while writing the entry can repeat what was being written
        // (ADR 0007).
        const logged = JSON.stringify(error.mock.calls);
        expect(logged).toContain("Error");
        expect(logged).toContain(PLUGIN);
        expect(logged).not.toContain("the database went away");
      } finally {
        error.mockRestore();
      }
    });

    it.each<[string, PluginRecipient["id"], string[]]>([
      [
        "a category the recipient is not declared to receive",
        "model-provider",
        ["email"],
      ],
      [
        "any category to a recipient that receives none",
        "exchange-rates",
        ["name"],
      ],
    ])(
      "refuses %s before anything is recorded or sent",
      async (_label, id, personalData) => {
        const { fetch, send, audit } = harness();

        expect(
          await refusal(
            fetch(id, "/", {
              ...DISCLOSURE,
              disclosure: {
                personalData: personalData as never,
                subjects: ["p1"],
              },
            }),
          ),
        ).toBe("personal-data-not-declared");
        expect(audit.record).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();
      },
    );

    it("refuses a disclosure that is not an object", async () => {
      const { fetch, send } = harness();

      expect(
        await refusal(
          fetch("model-provider", "/", {
            ...DISCLOSURE,
            disclosure: null as never,
          }),
        ),
      ).toBe("request-refused");
      expect(send).not.toHaveBeenCalled();
    });

    it("refuses a disclosure that names no category", async () => {
      const { fetch, send } = harness();

      expect(
        await refusal(
          fetch("model-provider", "/", {
            ...DISCLOSURE,
            disclosure: { personalData: [], subjects: ["p1"] },
          }),
        ),
      ).toBe("request-refused");
      expect(send).not.toHaveBeenCalled();
    });

    it("refuses a person the register would not hand the plugin", async () => {
      // Protected, restricted or unknown: one answer for all three.
      const { fetch, send, audit, count } = harness({ personsFound: 1 });

      expect(
        await refusal(fetch("model-provider", "/v1/messages", DISCLOSURE)),
      ).toBe("subject-refused");
      expect(count).toHaveBeenCalledWith({
        where: {
          id: { in: ["p1", "p2"] },
          protectedPersonalData: false,
          processingRestrictedAt: null,
        },
      });
      expect(audit.record).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    describe("on a resident route (ADR 0051)", () => {
      const onRoute = <T>(work: () => T): T =>
        runOnResidentRoute(
          { pluginId: PLUGIN, request: {}, personId: "p1" },
          work,
        );

      it("refuses a person other than the caller no readable record is about, as any other", async () => {
        const { fetch, send, holdsReadableRecordAbout } = harness();

        expect(
          await refusal(
            onRoute(() => fetch("model-provider", "/v1/messages", DISCLOSURE)),
          ),
        ).toBe("subject-refused");
        // The caller is not asked about; nobody is asked whether they are listed.
        expect(holdsReadableRecordAbout.mock.calls).toEqual([[PLUGIN, "p2"]]);
        expect(send).not.toHaveBeenCalled();
      });

      it("sends a disclosure about the caller and a person a readable record is about", async () => {
        const { fetch, send } = harness({ readable: ["p2"] });

        await onRoute(() =>
          fetch("model-provider", "/v1/messages", DISCLOSURE),
        );

        expect(send).toHaveBeenCalledTimes(1);
      });

      it("asks the records before the register, and the caller of neither", async () => {
        const { fetch, count, holdsReadableRecordAbout } = harness({
          personsFound: 0,
        });

        expect(
          await refusal(
            onRoute(() => fetch("model-provider", "/v1/messages", DISCLOSURE)),
          ),
        ).toBe("subject-refused");
        expect(holdsReadableRecordAbout).toHaveBeenCalledTimes(1);
        expect(count).not.toHaveBeenCalled();
      });

      it("holds a disclosure made off the route while its handler awaits it, and looks nobody up, whoever it names", async () => {
        vi.useFakeTimers();
        try {
          // None of the persons found, as for an unknown or protected id, or
          // every one, as for persons the plugin may name.
          for (const personsFound of [0, 2]) {
            const { fetch, count, send, holdsReadableRecordAbout } = harness({
              personsFound,
            });
            let heard = (_disclosed: Promise<unknown>): void => undefined;
            const listened = new Promise<unknown>((resolve) => {
              heard = resolve;
            });
            const answer = onRoute(() =>
              residentRouteHandler(PLUGIN, async () => {
                await listened.catch(() => undefined);
                return { done: true };
              })(),
            ) as Promise<unknown>;

            // A listener the handler awaits, run where a job emits.
            const disclosed = fetch(
              "model-provider",
              "/v1/messages",
              DISCLOSURE,
            );
            heard(disclosed);
            const refused = disclosed.catch((cause: unknown) => cause);
            await vi.advanceTimersByTimeAsync(RESIDENT_ROUTE_ANSWER_WAIT_MS);

            expect(await refused).toEqual(
              new PluginResidentRouteError(PLUGIN, "recipients.fetch", true),
            );
            await expect(answer).resolves.toEqual({ done: true });
            expect(count).not.toHaveBeenCalled();
            expect(holdsReadableRecordAbout).not.toHaveBeenCalled();
            expect(send).not.toHaveBeenCalled();
          }
        } finally {
          vi.useRealTimers();
        }
      });

      it("asks nothing of the records off a resident route", async () => {
        const { fetch, send, holdsReadableRecordAbout } = harness();

        await fetch("model-provider", "/v1/messages", DISCLOSURE);

        expect(holdsReadableRecordAbout).not.toHaveBeenCalled();
        expect(send).toHaveBeenCalledTimes(1);
      });
    });

    it("refuses more than a hundred persons", async () => {
      const { fetch, send } = harness();

      expect(
        await refusal(
          fetch("model-provider", "/", {
            ...DISCLOSURE,
            disclosure: {
              personalData: ["name"],
              subjects: Array.from({ length: 101 }, (_, n) => `p${String(n)}`),
            },
          }),
        ),
      ).toBe("subject-refused");
      expect(send).not.toHaveBeenCalled();
    });

    it("records nothing for a request that carries no personal data", async () => {
      const { fetch, audit } = harness();

      await fetch("exchange-rates", "/today");

      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  describe("the bytes it sends", () => {
    let harnessed: ReturnType<typeof harness>;

    beforeEach(() => {
      harnessed = harness();
    });

    it("sends a copy of a byte body, so the bytes digested are the bytes sent", async () => {
      const bytes = new TextEncoder().encode("{}");

      const pending = harnessed.fetch("model-provider", "/v1/messages", {
        method: "POST",
        body: bytes,
        disclosure: { personalData: ["freeText"], subjects: [] },
      });
      bytes[0] = 0x58;
      await pending;

      const [request] = harnessed.send.mock.calls[0] ?? [];
      expect(request?.body?.toString()).toBe("{}");
    });
  });
});
