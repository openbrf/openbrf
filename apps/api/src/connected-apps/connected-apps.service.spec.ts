import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActorContext } from "../audit/actor-context";
import type { AuditLogService } from "../audit/audit-log.service";
import type { PrincipalService } from "../authorization/principal.service";
import type { PrismaService } from "../database/prisma.service";
import { ConnectedAppsService } from "./connected-apps.service";

/**
 * What the log says when a grant nobody recorded cannot be withdrawn.
 *
 * The grant has to be found by hand after this, so the line has to name it -
 * and the one value that names it most directly is the client id, which is the
 * one value that may not be there. An app that identifies itself by the URL of
 * its own metadata document chose that URL, and its path and query can carry
 * whatever the app put in them (ADR 0007). What the withdrawal does when it
 * works is `connected-apps.int-spec.ts`.
 */

/**
 * A client id of the kind that must not reach the log: a metadata document
 * whose address carries somebody.
 */
const CLIENT_PATH = "/medlemmar/anna.andersson";
const CLIENT_QUERY = "lgh=1202";
const CLIENT_ID = `https://kalender.exempel.se${CLIENT_PATH}/client.json?${CLIENT_QUERY}`;

const PERSON_ID = "person-1";
const ACCOUNT_ID = "account-1";
const GRANT_ID = "consent-1";

const ACTOR: ActorContext = { personId: PERSON_ID, channel: "WEB" };

/**
 * A database where the withdrawal fails at the step named, quoting the client
 * id back the way a database failure quotes the value it was handling.
 */
function build(failAt: "lookup" | "withdrawal"): ConnectedAppsService {
  const quoting = (): Error =>
    new Error(`could not serialize access due to ${CLIENT_ID}`);
  const prisma = {
    user: { findUnique: () => Promise.resolve({ id: ACCOUNT_ID }) },
    oauthConsent: {
      findMany: () =>
        failAt === "lookup"
          ? Promise.reject(quoting())
          : Promise.resolve([{ id: GRANT_ID }]),
    },
    $transaction: () => Promise.reject(quoting()),
  };
  return new ConnectedAppsService(
    prisma as unknown as PrismaService,
    {} as AuditLogService,
    {} as PrincipalService,
  );
}

/** Everything one error call wrote, message and frames together. */
function written(logged: ReturnType<typeof vi.spyOn>): string {
  expect(logged).toHaveBeenCalledOnce();
  return (logged.mock.calls[0] ?? []).map(String).join("\n");
}

describe("withdrawing a consent the audit log could not record", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("names the grant that is left by its own key, and never the client's address", async () => {
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    await expect(
      build("withdrawal").withdrawUnrecordedConsent(
        ACTOR,
        PERSON_ID,
        CLIENT_ID,
      ),
    ).resolves.toBeUndefined();

    const line = written(logged);
    // Enough to find the row and remove it by hand.
    expect(line).toContain(GRANT_ID);
    expect(line).toContain(PERSON_ID);
    expect(line).toContain("Error");
    // And nothing the app chose, neither from the call nor from the failure.
    expect(line).not.toContain("kalender.exempel.se");
    expect(line).not.toContain(CLIENT_PATH);
    expect(line).not.toContain(CLIENT_QUERY);
  });

  it("falls back on the account when the grant could not even be read, and never on recency", async () => {
    const logged = vi
      .spyOn(Logger.prototype, "error")
      .mockImplementation(() => undefined);

    await build("lookup").withdrawUnrecordedConsent(
      ACTOR,
      PERSON_ID,
      CLIENT_ID,
    );

    const line = written(logged);
    expect(line).toContain(PERSON_ID);
    expect(line).toContain(ACCOUNT_ID);
    // The person's newest consent can be another app's, so the line must not
    // send anybody to delete it.
    expect(line).not.toMatch(/newest/i);
    expect(line).toContain("never by date");
    expect(line).not.toContain("kalender.exempel.se");
    expect(line).not.toContain(CLIENT_PATH);
    expect(line).not.toContain(CLIENT_QUERY);
  });
});
