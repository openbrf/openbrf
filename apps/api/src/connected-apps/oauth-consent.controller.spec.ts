import type { FastifyReply } from "fastify";
import { describe, expect, it } from "vitest";

import type { AuditEntryInput } from "../audit/audit-log.service";
import { AuditLogService } from "../audit/audit-log.service";
import type { AuthService } from "../auth/auth.service";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { OAuthConsentController } from "./connected-apps.controller";

/**
 * Granting a connection, and what is recorded when one is granted.
 *
 * Two properties carry the weight here. The signed query has to reach the
 * provider byte for byte, because the signature is over those bytes and a
 * re-serialised one fails as a refused consent rather than as a mangled
 * request - a failure that reads as the member's fault. And the audit entry has
 * to follow the provider's answer rather than precede it: the log is
 * append-only, so an entry written before a refusal cannot be taken back, and
 * it would say a member connected something they never did.
 */

const SIGNED_QUERY =
  "response_type=code&client_id=https%3A%2F%2Fklient.exempel.se%2Fid" +
  "&redirect_uri=https%3A%2F%2Fklient.exempel.se%2Fcb&scope=mcp%3Aread+mcp%3Awrite" +
  "&ba_param=ba_iat&ba_param=resource&sig=abc123";

interface Built {
  controller: OAuthConsentController;
  forwarded: () => Request;
  recorded: AuditEntryInput[];
}

/**
 * What the provider answers, in the shape it actually answers in.
 *
 * Not a 3xx. The consent endpoint asks for JSON before it authorizes, so every
 * outcome comes back 200 with an address to send the browser to, and only a
 * granted one carries an authorization code.
 */
function providerAnswer(url: string, status = 200): Response {
  return new Response(JSON.stringify({ redirect: true, url }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const GRANTED = "https://klient.exempel.se/cb?code=auth-code-1&state=xyz";

function build(response = providerAnswer(GRANTED)): Built {
  let seen: Request | undefined;
  const auth = {
    handler: (request: Request) => {
      seen = request;
      return Promise.resolve(response);
    },
  } as unknown as AuthService;

  const recorded: AuditEntryInput[] = [];
  const audit = {
    record: (entry: AuditEntryInput) => {
      recorded.push(entry);
      return Promise.resolve();
    },
  } as unknown as AuditLogService;

  return {
    controller: new OAuthConsentController(auth, audit),
    forwarded: () => {
      if (seen === undefined) {
        throw new Error("the provider was never called");
      }
      return seen;
    },
    recorded,
  };
}

function request(): RequestWithPrincipal {
  return {
    method: "POST",
    url: "/api/connected-apps/consent",
    protocol: "https",
    id: "req-1",
    principal: { personId: "person-1" },
    headers: {
      host: "brf.example",
      cookie: "better-auth.session_token=abc",
      origin: "https://brf.example",
      "content-type": "application/json",
      "content-length": "120",
    },
  } as unknown as RequestWithPrincipal;
}

function reply(): FastifyReply {
  const self = {
    raw: { setHeader: () => undefined },
    header: () => self,
    status: () => self,
    send: () => Promise.resolve(),
  };
  return self as unknown as FastifyReply;
}

describe("forwarding the consent", () => {
  it("posts to the provider's own endpoint, not to this route", async () => {
    const { controller, forwarded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(forwarded().url).toBe("https://brf.example/api/auth/oauth2/consent");
    expect(forwarded().method).toBe("POST");
  });

  it("passes the signed query through byte for byte", async () => {
    const { controller, forwarded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    const body = (await forwarded().json()) as {
      accept: boolean;
      oauth_query: string;
    };
    // Not re-encoded, not reordered, and the repeated parameter still repeated.
    // The signature is taken over exactly this string.
    expect(body.oauth_query).toBe(SIGNED_QUERY);
    expect(body.accept).toBe(true);
  });

  it("carries the browser's own cookie and origin", async () => {
    const { controller, forwarded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    // The provider refuses a state-changing request that presents a cookie and
    // no origin, which a browser always sends and a hand-built request easily
    // forgets.
    expect(forwarded().headers.get("cookie")).toBe(
      "better-auth.session_token=abc",
    );
    expect(forwarded().headers.get("origin")).toBe("https://brf.example");
  });

  it("describes the body it actually sends", async () => {
    const { controller, forwarded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(forwarded().headers.get("content-type")).toBe("application/json");
    // The incoming length described the browser's body, not this one.
    expect(forwarded().headers.get("content-length")).not.toBe("120");
  });
});

describe("what is recorded", () => {
  it("records the connection against the person, naming the app", async () => {
    const { controller, recorded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      action: "CONNECTED_APP_CONNECTED",
      channel: "WEB",
      actorPersonId: "person-1",
      targetPersonId: "person-1",
      targetKind: "connectedApp",
      targetId: "https://klient.exempel.se/id",
    });
  });

  it("records the scopes and the redirect host, and not the whole redirect URI", async () => {
    const { controller, recorded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded[0]?.context).toEqual({
      scopes: ["mcp:read", "mcp:write"],
      redirectHost: "klient.exempel.se",
    });
  });

  it("records nothing when the provider refused", async () => {
    const { controller, recorded } = build(new Response("no", { status: 400 }));

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    // The log is append-only. An entry saying a member connected something
    // they did not cannot be taken back.
    expect(recorded).toEqual([]);
  });

  it("records nothing when the provider declined with a 200", async () => {
    // The refusal a member actually meets. The provider answers an error URL
    // with an ordinary 200, so the status says nothing about the outcome and
    // only the missing code does.
    const { controller, recorded } = build(
      providerAnswer(
        "https://klient.exempel.se/cb?error=access_denied" +
          "&error_description=User+denied+access&state=xyz",
      ),
    );

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded).toEqual([]);
  });

  it("records nothing when the provider asked for a fresh sign-in", async () => {
    // A request carrying prompt=login is sent back to authenticate instead of
    // being granted. No code, so no connection yet.
    const { controller, recorded } = build(
      providerAnswer("https://brf.example/app/sign-in?client_id=abc"),
    );

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded).toEqual([]);
  });

  it("records nothing when the answer is a 3xx rather than the JSON shape", async () => {
    const { controller, recorded } = build(new Response(null, { status: 302 }));

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded).toEqual([]);
  });

  it("records nothing when the answer cannot be read", async () => {
    const { controller, recorded } = build(
      new Response("not json", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    expect(recorded).toEqual([]);
  });

  it("still forwards the provider's answer to the browser unread", async () => {
    // The grant check reads a clone. Reading the response itself would leave
    // the browser with an empty body and no way to reach the app that asked.
    const { controller } = build();
    const sent: unknown[] = [];
    const capturing = {
      raw: { setHeader: () => undefined },
      header: () => capturing,
      status: () => capturing,
      send: (body: unknown) => {
        sent.push(body);
        return Promise.resolve();
      },
    } as unknown as FastifyReply;

    await controller.consent(request(), capturing, {
      oauth_query: SIGNED_QUERY,
    });

    expect(JSON.stringify(sent[0])).toContain("auth-code-1");
  });

  it("records nothing when the query names no client", async () => {
    const { controller, recorded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: "response_type=code&sig=abc",
    });

    expect(recorded).toEqual([]);
  });

  it("does not put the signature or the cookie in the entry", async () => {
    const { controller, recorded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
    });

    const written = JSON.stringify(recorded[0]);
    expect(written).not.toContain("abc123");
    expect(written).not.toContain("better-auth.session_token");
  });
});

describe("a body that is not what the screen sends", () => {
  it("forwards an empty query rather than throwing", async () => {
    const { controller, forwarded, recorded } = build();

    // A caller that posts nothing gets the provider's own refusal, which is
    // the answer that belongs to it, rather than a fault from this route.
    await controller.consent(request(), reply(), { oauth_query: 42 });

    const body = (await forwarded().json()) as { oauth_query: string };
    expect(body.oauth_query).toBe("");
    expect(recorded).toEqual([]);
  });

  it("refuses a request the guard did not authenticate", async () => {
    const { controller } = build();
    const unauthenticated = {
      ...request(),
      principal: undefined,
    } as unknown as RequestWithPrincipal;

    // Which person is granting is taken from the session and from nowhere
    // else, so a request with no principal has no meaning here.
    await expect(
      controller.consent(unauthenticated, reply(), {
        oauth_query: SIGNED_QUERY,
      }),
    ).rejects.toThrow();
  });
});

describe("where the recorded client comes from", () => {
  it("takes it from the signed query and not from a field a caller set", async () => {
    const { controller, recorded } = build();

    await controller.consent(request(), reply(), {
      oauth_query: SIGNED_QUERY,
      // A caller adding this to the body must not be able to have a different
      // app recorded than the one the provider verified the signature over.
      client_id: "https://angripare.exempel.se/id",
    } as { oauth_query: string });

    expect(recorded[0]?.targetId).toBe("https://klient.exempel.se/id");
  });
});
