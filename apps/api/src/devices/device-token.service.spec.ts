import { describe, expect, it, vi } from "vite-plus/test";

import { markAuthenticated } from "../actions/authenticated-request";
import type { AuditLogService } from "../audit/audit-log.service";
import { hashOpaqueToken } from "../auth/opaque-token";
import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import type { Capability, Principal } from "../authorization/capabilities";
import type { PrincipalService } from "../authorization/principal.service";
import type { PrismaService } from "../database/prisma.service";
import { MAX_LIVE_DEVICE_TOKENS } from "./device-token";
import {
  DeviceTokenIssueRefusedError,
  DeviceTokenLimitError,
} from "./device-token.errors";
import { DeviceTokenService } from "./device-token.service";

/**
 * Who may issue a device token, and what is kept of it (ADR 0031).
 *
 * Issuing is a board member's act in the board's own interface: the request a
 * plugin hands over has to be one core authenticated with a session, for a
 * person holding `site:manage` when the token is issued.
 */

function principal(capabilities: Capability[]): Principal {
  return {
    personId: "person-1",
    isAdmin: false,
    isPropertyManager: false,
    isBoardMember: true,
    isResident: true,
    isMember: true,
    capabilities: new Set(capabilities),
  };
}

function build(options: { capabilities?: Capability[]; live?: number } = {}) {
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
    id: "token-row-1",
    issuedAt: new Date("2026-10-20T08:00:00Z"),
    lastUsedAt: null,
    revokedAt: null,
    ...data,
  }));
  const count = vi.fn(async () => options.live ?? 0);
  const lock = vi.fn(async () => 0);
  const tx = { pluginDeviceToken: { create, count }, $executeRaw: lock };
  const prisma = {
    $transaction: vi.fn(
      async (run: (client: unknown) => Promise<unknown>) => await run(tx),
    ),
  };
  const record = vi.fn(async () => undefined);
  const forPerson = vi.fn(async () =>
    principal(options.capabilities ?? ["site:manage"]),
  );
  const service = new DeviceTokenService(
    prisma as unknown as PrismaService,
    { record } as unknown as AuditLogService,
    { forPerson } as unknown as PrincipalService,
  );
  return { service, create, count, lock, record, forPerson };
}

/** A request the guard authenticated, as a plugin's route receives it. */
function sessionRequest(): RequestWithPrincipal {
  const request = {
    principal: principal(["site:manage"]),
  } as unknown as RequestWithPrincipal;
  markAuthenticated(request, {
    personId: "person-1",
    token: null,
    requestId: "req-1",
  });
  return request;
}

const OPTIONS = { route: "screen", subject: "scr_1", label: "Entrance B" };

describe("issuing a device token", () => {
  it("issues one for a board member's request, keeping only its digest", async () => {
    const { service, create, record } = build();

    const { token, device } = await service.issue(
      "signage",
      ["screen"],
      sessionRequest(),
      OPTIONS,
    );

    expect(token).toMatch(/^obrf_dt_[A-Za-z0-9_-]{43}$/);
    const stored = create.mock.calls[0]?.[0].data;
    expect(stored).toMatchObject({
      pluginId: "signage",
      routeId: "screen",
      tokenHash: hashOpaqueToken(token),
      issuedByPersonId: "person-1",
    });
    expect(Object.values(stored ?? {})).not.toContain(token);
    expect(device).toMatchObject({ route: "screen", subject: "scr_1" });
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "DEVICE_TOKEN_ISSUED",
        actorPersonId: "person-1",
      }),
      expect.anything(),
    );
  });

  it("issues a different token every time", async () => {
    const { service } = build();
    const first = await service.issue(
      "signage",
      ["screen"],
      sessionRequest(),
      OPTIONS,
    );
    const second = await service.issue(
      "signage",
      ["screen"],
      sessionRequest(),
      OPTIONS,
    );
    expect(first.token).not.toBe(second.token);
  });

  it("refuses a person who does not manage the website, read now", async () => {
    // The guard let the request through with site:manage; the person has
    // since lost it, and the check is made again at the moment of issuing.
    const { service, create, forPerson } = build({
      capabilities: ["self:manage"],
    });

    await expect(
      service.issue("signage", ["screen"], sessionRequest(), OPTIONS),
    ).rejects.toBeInstanceOf(DeviceTokenIssueRefusedError);
    expect(forPerson).toHaveBeenCalledWith("person-1");
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a request core did not authenticate", async () => {
    const { service, create } = build();
    const forged = {
      principal: principal(["site:manage"]),
    } as unknown as RequestWithPrincipal;

    await expect(
      service.issue("signage", ["screen"], forged, OPTIONS),
    ).rejects.toBeInstanceOf(DeviceTokenIssueRefusedError);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a connected app's token, which is not the board's own interface", async () => {
    const { service, create } = build();
    const request = sessionRequest();
    request.token = {
      clientId: "https://client.example",
      clientHost: "client.example",
      scopes: ["mcp:write"],
      tokenRowId: "access-1",
    };

    await expect(
      service.issue("signage", ["screen"], request, OPTIONS),
    ).rejects.toBeInstanceOf(DeviceTokenIssueRefusedError);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a route the manifest does not declare", async () => {
    const { service, create } = build();

    await expect(
      service.issue("signage", ["screen"], sessionRequest(), {
        ...OPTIONS,
        route: "admin",
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty subject", { subject: "" }],
    ["a subject with a space", { subject: "screen one" }],
    ["a subject over 64 characters", { subject: "s".repeat(65) }],
    ["an empty label", { label: "   " }],
    ["a label over 80 characters", { label: "l".repeat(81) }],
  ])("refuses %s", async (_, override) => {
    const { service, create } = build();

    await expect(
      service.issue("signage", ["screen"], sessionRequest(), {
        ...OPTIONS,
        ...override,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses beyond the live tokens a plugin may hold", async () => {
    const { service, create } = build({ live: MAX_LIVE_DEVICE_TOKENS });

    await expect(
      service.issue("signage", ["screen"], sessionRequest(), OPTIONS),
    ).rejects.toBeInstanceOf(DeviceTokenLimitError);
    expect(create).not.toHaveBeenCalled();
  });

  it("counts behind a lock per plugin, so two issues cannot both take the last place", async () => {
    const { service, count, lock } = build();

    await service.issue("signage", ["screen"], sessionRequest(), OPTIONS);

    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.calls[0]).toContain("device-tokens:signage");
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      count.mock.invocationCallOrder[0] ?? 0,
    );
  });
});
