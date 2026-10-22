import { sign } from "node:crypto";

import {
  LICENCE_FILE_MAX_BYTES,
  LICENCE_PRESENTATION_MAX_BYTES,
} from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { AuditLogService } from "../audit/audit-log.service";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import type { LicenceReader, StoredLicence } from "./entitlement-judgement";
import { EntitlementsService } from "./entitlements.service";
import { InstanceIdentityService } from "./instance-identity.service";
import { PRESENTATION_SIGNED_PREFIX } from "./licence-file";
import {
  fingerprintOf,
  issueLicence,
  testKey,
  testLicenceManifest,
  testPayload,
  verifyPresentation,
} from "./testing/licence-fixtures";

const ENV = {
  NODE_ENV: "test",
  OPENBRF_ENCRYPTION_KEY: "d".repeat(64),
} as Env;

const AUDIENCE = "https://themes.example.org";
const issuer = testKey();

interface IdentityRow {
  id: number;
  instanceId: string;
  publicKey: string;
  privateKeyCipher: string;
}

/** The two tables, in memory. */
function database(licences: StoredLicence[] = []) {
  let identity: IdentityRow | null = null;
  return {
    get identityRow() {
      return identity;
    },
    licences,
    prisma: {
      instanceIdentity: {
        findUnique: async () => identity,
        findUniqueOrThrow: async () => {
          if (identity === null) {
            throw new Error("no identity");
          }
          return identity;
        },
        createMany: async ({ data }: { data: IdentityRow[] }) => {
          identity ??= data[0] ?? null;
          return { count: 1 };
        },
      },
      licence: {
        findMany: async ({
          where,
        }: {
          where: { verifiedKeyFingerprint: { in: string[] } };
        }) =>
          licences.filter(
            (licence) =>
              licence.verifiedKeyFingerprint !== null &&
              where.verifiedKeyFingerprint.in.includes(
                licence.verifiedKeyFingerprint,
              ),
          ),
      },
    } as unknown as PrismaService,
  };
}

function services(
  db: ReturnType<typeof database>,
  encryptionKey = ENV.OPENBRF_ENCRYPTION_KEY,
) {
  const identity = new InstanceIdentityService(
    db.prisma,
    new FieldEncryptionService({
      ...ENV,
      OPENBRF_ENCRYPTION_KEY: encryptionKey,
    }),
    {} as AuditLogService,
  );
  return {
    identity,
    entitlements: new EntitlementsService(db.prisma, identity),
  };
}

/** Enters a licence for this instance, checked under the issuer's key. */
async function enter(
  db: ReturnType<typeof database>,
  identity: InstanceIdentityService,
  options: {
    entitlement?: string;
    validUntil?: string;
    padTo?: number;
  } = {},
): Promise<string> {
  const binding = await identity.binding();
  const payload = testPayload({
    ...binding,
    entitlements: {
      [options.entitlement ?? "mcp-connector"]:
        options.validUntil === undefined
          ? {}
          : { validUntil: options.validUntil },
    },
  });
  db.licences.push({
    id: `licence-${String(db.licences.length)}`,
    file: issueLicence({ key: issuer, payload, padTo: options.padTo }),
    enteredAt: new Date(),
    verifiedKeyFingerprint: fingerprintOf(issuer),
    entitlements: Object.keys(payload.entitlements),
  });
  return payload.licenceId;
}

function readerFor(
  entitlement = "mcp-connector",
  audiences = [AUDIENCE],
): LicenceReader {
  return testLicenceManifest({
    entitlement,
    keys: { "test-1": issuer },
    audiences,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EntitlementsService", () => {
  it("ends a licence at the Stockholm midnight after its last day, before the UTC one", async () => {
    const db = database();
    const { identity, entitlements } = services(db);
    await enter(db, identity, { validUntil: "2026-12-15" });
    const reader = readerFor();

    // 23:30 in Stockholm on the last day, 22:30 in UTC.
    expect(
      (await entitlements.judge(reader, new Date("2026-12-15T22:30:00Z"))).state
        .status,
    ).toBe("active");
    // 00:30 in Stockholm the next day, while the UTC day has not ended.
    expect(
      (await entitlements.judge(reader, new Date("2026-12-15T23:30:00Z"))).state
        .status,
    ).toBe("expired");
  });

  it("creates the instance's identity once and keeps its private key encrypted", async () => {
    const db = database();
    const { identity } = services(db);

    const first = await identity.binding();
    const again = await services(db).identity.binding();
    expect(again).toEqual(first);
    expect(first.instanceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const row = db.identityRow;
    expect(row?.publicKey).toBe(first.instanceKey);
    // The seed is 43 base64url characters; none of the stored value is it.
    expect(row?.privateKeyCipher).not.toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row?.privateKeyCipher.length).toBeGreaterThan(43);
  });

  describe("present()", () => {
    it("presents the active licence so the issuer's service accepts it", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      const licenceId = await enter(db, identity);

      const presentation = await entitlements.present(readerFor(), AUDIENCE);
      const verdict = verifyPresentation(presentation ?? "", {
        issuerKey: issuer,
        audience: AUDIENCE,
        entitlement: "mcp-connector",
        now: new Date(),
      });

      expect(verdict.ok).toBe(true);
      if (verdict.ok) {
        expect(verdict.claims).toMatchObject({
          audience: AUDIENCE,
          licenceId,
          entitlement: "mcp-connector",
        });
        expect(verdict.claims.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(verdict.claims.issuedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
        );
      }
    });

    it("refuses an audience the manifest does not declare", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      await enter(db, identity);

      await expect(
        entitlements.present(readerFor(), "https://elsewhere.example.org"),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it("presents nothing without an active licence", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      await enter(db, identity, { validUntil: "2020-01-01" });

      await expect(
        entitlements.present(readerFor(), AUDIENCE),
      ).resolves.toBeNull();
    });

    it("grants and presents nothing for an entitlement the licence inherits rather than names", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      await enter(db, identity, { entitlement: "themes" });
      // A valid entitlement name, and a property every ordinary object has.
      const reader = readerFor("constructor");

      await expect(entitlements.get(reader)).resolves.toEqual({
        status: "absent",
      });
      await expect(entitlements.present(reader, AUDIENCE)).resolves.toBeNull();
    });

    it("writes a presentation no other audience, entitlement or instance key passes", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      await enter(db, identity);
      const presentation = (await entitlements.present(
        readerFor(),
        AUDIENCE,
      )) as string;
      const expected = {
        issuerKey: issuer,
        audience: AUDIENCE,
        entitlement: "mcp-connector",
        now: new Date(),
      };

      expect(
        verifyPresentation(presentation, {
          ...expected,
          audience: "https://gateway.example.org",
        }),
      ).toEqual({ ok: false, reason: "wrong-audience" });
      expect(
        verifyPresentation(presentation, {
          ...expected,
          entitlement: "ai-package",
        }),
      ).toEqual({ ok: false, reason: "wrong-entitlement" });
      expect(
        verifyPresentation(presentation, {
          ...expected,
          now: new Date(Date.now() + 6 * 60_000),
        }),
      ).toEqual({ ok: false, reason: "stale" });

      // The same claims signed by any other key than the one the licence names.
      const outer = JSON.parse(presentation) as Record<string, string>;
      const claims = Buffer.from(outer.claims ?? "", "base64url");
      const forged = JSON.stringify({
        ...outer,
        signature: sign(
          null,
          Buffer.concat([PRESENTATION_SIGNED_PREFIX, claims]),
          testKey().privateKey,
        ).toString("base64url"),
      });
      expect(verifyPresentation(forged, expected)).toEqual({
        ok: false,
        reason: "instance-signature-invalid",
      });
    });

    it("fits the largest licence, audience and entitlement name in 24 KiB", async () => {
      const db = database();
      const { identity, entitlements } = services(db);
      const entitlement = `a${"b".repeat(47)}`;
      const audience = `https://${["a", "b", "c"].map((label) => label.repeat(63)).join(".")}.${"d".repeat(56)}`;
      expect(audience).toHaveLength(256);
      await enter(db, identity, {
        entitlement,
        padTo: LICENCE_FILE_MAX_BYTES,
      });
      expect(db.licences[0]?.file.byteLength).toBe(LICENCE_FILE_MAX_BYTES);

      const presentation = (await entitlements.present(
        readerFor(entitlement, [audience]),
        audience,
      )) as string;

      expect(Buffer.byteLength(presentation)).toBeLessThanOrEqual(
        LICENCE_PRESENTATION_MAX_BYTES,
      );
      expect(
        verifyPresentation(presentation, {
          issuerKey: issuer,
          audience,
          entitlement,
          now: new Date(),
        }).ok,
      ).toBe(true);
    });

    it("presents nothing from a database restored without its encryption key", async () => {
      const db = database();
      const original = services(db);
      await enter(db, original.identity);

      // The same rows, read by an instance whose encryption key is another.
      const copy = services(db, "e".repeat(64));
      expect((await copy.entitlements.get(readerFor())).status).toBe("active");
      await expect(
        copy.entitlements.present(readerFor(), AUDIENCE),
      ).rejects.toThrow();
    });

    it("says the key cannot be read, and generates none in its place", async () => {
      const db = database();
      const original = services(db);
      const binding = await original.identity.binding();
      expect(await original.identity.keyReadable()).toBe(true);

      const copy = services(db, "e".repeat(64));
      expect(await copy.identity.keyReadable()).toBe(false);
      // The licence screen tells the board why; the key stays as it was.
      expect(await copy.identity.binding()).toEqual(binding);
    });
  });
});
