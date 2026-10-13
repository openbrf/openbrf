import { describe, expect, it } from "vitest";

import type { Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { PrismaService } from "../database/prisma.service";
import { BearerPrincipalService } from "./bearer-principal.service";
import type { ProtectedResource } from "./protected-resource";

/**
 * What a token is worth when a member holds more than one consent for an app.
 *
 * A unique index keeps one consent per member and app, so the database the
 * integration suite runs against refuses to hold two, and this can only be
 * shown here. It still matters: the resolver can run against a database the
 * migration has not reached yet, where racing submissions may have left two.
 * The rest of the resolver against real rows is `connected-apps.int-spec.ts`.
 */

const RESOURCE: ProtectedResource = {
  declared: true,
  path: "/api/plugin/mcp-connector/mcp",
  url: "https://brf.example/api/plugin/mcp-connector/mcp",
};

const ISSUED = new Date("2026-10-01T12:00:00Z");
const EARLIER = new Date("2026-10-01T11:00:00Z");
const LATER = new Date("2026-10-01T13:00:00Z");

const PRINCIPAL: Principal = {
  personId: "person-1",
  isAdmin: false,
  isPropertyManager: false,
  isBoardMember: false,
  isResident: true,
  isMember: true,
  capabilities: new Set(),
};

interface Consent {
  scopes: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface ConsentQuery {
  where?: { createdAt?: { lte?: Date } };
  orderBy?: { updatedAt?: "asc" | "desc" };
}

/**
 * The rows a query would get back: its age filter and its order applied, so
 * that a resolver leaning on either is answered as the database would.
 */
function query(consents: Consent[], args: ConsentQuery): Consent[] {
  const notAfter = args.where?.createdAt?.lte;
  const rows = consents.filter(
    (consent) => notAfter === undefined || consent.createdAt <= notAfter,
  );
  const order = args.orderBy?.updatedAt;
  if (order !== undefined) {
    const sign = order === "desc" ? -1 : 1;
    rows.sort((a, b) => sign * (a.updatedAt.getTime() - b.updatedAt.getTime()));
  }
  return rows;
}

/** A resolver whose token grants reading and writing, over these consents. */
function build(consents: Consent[]): BearerPrincipalService {
  const prisma = {
    oauthAccessToken: {
      findUnique: () =>
        Promise.resolve({
          id: "token-row-1",
          clientId: "https://klient.exempel.se/id",
          userId: "account-1",
          createdAt: ISSUED,
          expiresAt: new Date(Date.now() + 900_000),
          revoked: null,
          resources: [RESOURCE.url],
          scopes: ["mcp:read", "mcp:write"],
        }),
    },
    oauthConsent: {
      findMany: (args: ConsentQuery) => Promise.resolve(query(consents, args)),
    },
    user: { findUnique: () => Promise.resolve({ personId: "person-1" }) },
    oauthClient: { findUnique: () => Promise.resolve(null) },
  };
  const principals = { forPerson: () => Promise.resolve(PRINCIPAL) };
  return new BearerPrincipalService(
    prisma as unknown as PrismaService,
    principals as unknown as PrincipalService,
    RESOURCE,
  );
}

async function scopesOf(consents: Consent[]): Promise<string[] | null> {
  const identity = await build(consents).resolve("token");
  return identity?.scopes ?? null;
}

function consent(
  scopes: string[],
  createdAt: Date,
  updatedAt: Date = createdAt,
): Consent {
  return { scopes, createdAt, updatedAt };
}

describe("a member holding more than one consent for an app", () => {
  it("is granted only what every one of them grants, whichever changed last", async () => {
    // A stale row is not told apart by its age: the one changed last may be
    // the wider one, when the library updated it and left the narrower alone.
    const both = ["mcp:read", "mcp:write"];
    for (const consents of [
      [consent(both, EARLIER, ISSUED), consent(["mcp:read"], EARLIER)],
      [consent(both, EARLIER), consent(["mcp:read"], EARLIER, ISSUED)],
    ]) {
      expect(await scopesOf(consents)).toEqual(["mcp:read"]);
      expect(await scopesOf([...consents].reverse())).toEqual(["mcp:read"]);
    }
  });

  it("is narrowed by a consent newer than the token as well", async () => {
    // The library updates whichever row it finds first, so the one the member
    // narrowed can be the newer one, while the one the token was issued under
    // still grants everything.
    expect(
      await scopesOf([
        consent(["mcp:read", "mcp:write"], EARLIER),
        consent(["mcp:read"], LATER),
      ]),
    ).toEqual(["mcp:read"]);
  });

  it("is refused when they share no scope with the token", async () => {
    expect(
      await scopesOf([
        consent(["mcp:read"], EARLIER, ISSUED),
        consent(["mcp:write"], EARLIER),
      ]),
    ).toBeNull();
  });

  it("is refused when none of them is as old as the token", async () => {
    // Every grant the token could have been issued under is gone; a newer one
    // is a later connection, not this token's.
    expect(
      await scopesOf([
        consent(["mcp:read", "mcp:write"], LATER),
        consent(["mcp:read", "mcp:write"], LATER),
      ]),
    ).toBeNull();
  });
});
