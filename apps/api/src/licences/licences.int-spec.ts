import { createPrivateKey, createPublicKey } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PluginManifest } from "@openbrf/plugin-sdk";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { dataPaths } from "../packaging/data-paths";
import { loadPlugins } from "../plugins/plugin-boot";
import { pluginModulesDirectory } from "../plugins/plugin-directory";
import { PluginHostBinding } from "../plugins/plugin-host";
import { PluginLoaderService } from "../plugins/plugin-loader.service";
import { PluginRegistryService } from "../plugins/plugin-registry.service";
import {
  loadEnvForIntegrationTests,
  restoreEnvironmentVariable,
  runSuffix,
} from "../testing/integration-env";
import { EntitlementsService } from "./entitlements.service";
import { InstanceIdentityService } from "./instance-identity.service";
import {
  LicenceAdminService,
  type LicenceView,
  MAX_LICENCES,
} from "./licence-admin.service";
import { LicenceRefusedError } from "./licence.errors";
import {
  issueLicence,
  type TestKey,
  testKey,
  testLicenceManifest,
  testPayload,
} from "./testing/licence-fixtures";

/**
 * Entering, checking and removing licences against a real database
 * (ADR 0042), with what each writes to the audit log.
 *
 * The installed plugins are a list this suite changes, standing in for the
 * loader: installing a plugin ends by replacing the process, and a licence
 * entered before it is checked at the next start.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaService;
let encryption: FieldEncryptionService;
let audit: AuditLogService;
let identity: InstanceIdentityService;
let entitlements: EntitlementsService;
let licences: LicenceAdminService;
let installed: PluginManifest[] = [];

const issuer = testKey();
const BOARD = { personId: null, channel: "SYSTEM" as const };

function plugin(
  id: string,
  keys: Record<string, TestKey>,
  entitlement = "mcp-connector",
): PluginManifest {
  return {
    apiVersion: 1,
    id,
    entry: { server: "./dist/server.cjs" },
    permissions: [],
    personalData: [],
    actions: [],
    blocks: [],
    recipients: [],
    deviceRoutes: [],
    ai: false,
    ...testLicenceManifest({ keys, entitlement }),
  } as PluginManifest;
}

async function licenceFor(
  overrides: Parameters<typeof testPayload>[0] = {},
  key: TestKey = issuer,
  keyId = "test-1",
): Promise<Buffer> {
  const binding = await identity.binding();
  return issueLicence({
    key,
    keyId,
    payload: testPayload({ ...binding, ...overrides }),
  });
}

/**
 * The entries about one licence, in the order of the acts. Sorted here rather
 * than by time: the entries of one transaction share their timestamp.
 */
async function auditFor(targetId: string) {
  const order = ["LICENCE_ADDED", "LICENCE_VERIFIED", "LICENCE_REMOVED"];
  const entries = await prisma.auditLogEntry.findMany({
    where: { targetKind: "licence", targetId },
    select: { action: true, channel: true, context: true },
  });
  return entries.sort(
    (left, right) => order.indexOf(left.action) - order.indexOf(right.action),
  );
}

beforeAll(async () => {
  prisma = new PrismaService(env);
  await prisma.$connect();
  encryption = new FieldEncryptionService(env);
  audit = new AuditLogService(prisma);
  identity = new InstanceIdentityService(prisma, encryption, audit);
  entitlements = new EntitlementsService(prisma, identity);
  licences = new LicenceAdminService(
    prisma,
    audit,
    identity,
    entitlements,
    { installedManifests: () => installed } as unknown as PluginLoaderService,
    env,
  );
});

beforeEach(async () => {
  await prisma.licence.deleteMany();
  installed = [plugin("mcp-connector", { "test-1": issuer })];
});

afterAll(async () => {
  await prisma.licence.deleteMany();
  await prisma.$disconnect();
});

describe("the instance's identity", () => {
  it("is created once and stores the private key only as ciphertext", async () => {
    const first = await identity.binding();
    const second = await new InstanceIdentityService(
      prisma,
      new FieldEncryptionService(env),
      audit,
    ).binding();
    expect(second).toEqual(first);

    const row = await prisma.instanceIdentity.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(row.instanceId).toBe(first.instanceId);
    expect(row.publicKey).toBe(first.instanceKey);
    const seed = await encryption.decrypt(
      "instanceIdentity.privateKey",
      row.privateKeyCipher,
    );
    expect(seed).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.privateKeyCipher).not.toContain(seed);
    const derived = createPublicKey(
      createPrivateKey({
        key: { kty: "OKP", crv: "Ed25519", d: seed, x: row.publicKey },
        format: "jwk",
      }),
    ).export({ format: "jwk" }).x;
    expect(derived).toBe(row.publicKey);
  });
});

describe("entering a licence", () => {
  it("stores a licence a plugin's key verifies, and logs it with what it grants", async () => {
    const file = await licenceFor({
      entitlements: { "mcp-connector": { validUntil: "2099-12-31" } },
    });

    const view = await licences.enter(file, BOARD);

    expect(view.check).toBe("verified");
    expect(view.verified?.issuer.name).toBe("Test Issuer AB");
    expect(view.verified?.pluginId).toBe("mcp-connector");
    expect(
      (
        await entitlements.get({
          licence: installed[0]!.licence!,
          released: "2026-12-01",
        })
      ).status,
    ).toBe("active");

    const audit = await auditFor(view.id);
    expect(audit.map((entry) => entry.action)).toEqual([
      "LICENCE_ADDED",
      "LICENCE_VERIFIED",
    ]);
    expect(audit[0]?.context).toEqual({
      sha256: view.sha256,
      keyId: "test-1",
      verified: true,
    });
    expect(audit[1]?.context).toEqual({
      licenceId: view.licenceId,
      pluginId: "mcp-connector",
      issuer: "Test Issuer AB",
      entitlements: [
        { name: "mcp-connector", validUntil: "2099-12-31", updatesUntil: null },
      ],
    });
  });

  it("refuses a file that does not verify under the keys declared for its key id", async () => {
    const forged = await licenceFor({}, testKey());

    await expect(licences.enter(forged, BOARD)).rejects.toMatchObject({
      refusal: "signature-invalid",
    });
    expect(await prisma.licence.count()).toBe(0);
  });

  it.each([
    ["too-large", Buffer.alloc(16_385, " ")],
    ["not-a-licence", Buffer.from('{"a":1,"a":2}')],
  ])("refuses a file that is %s", async (refusal, file) => {
    await expect(licences.enter(file, BOARD)).rejects.toMatchObject({
      refusal,
    });
  });

  it("refuses the same file twice", async () => {
    const file = await licenceFor();
    await licences.enter(file, BOARD);

    await expect(licences.enter(file, BOARD)).rejects.toBeInstanceOf(
      LicenceRefusedError,
    );
    await expect(licences.enter(file, BOARD)).rejects.toMatchObject({
      refusal: "already-entered",
    });
  });

  it("stores a wrong-instance licence and reports it as such", async () => {
    const file = await licenceFor({
      instanceId: "00000000-0000-4000-8000-000000000000",
    });
    await licences.enter(file, BOARD);

    const overview = await licences.overview();
    expect(overview.plugins).toEqual([
      expect.objectContaining({
        pluginId: "mcp-connector",
        state: { status: "wrong-instance", licenceId: expect.any(String) },
      }),
    ]);
  });
});

describe("the limit of 50 licences", () => {
  it("holds when two files are entered at once with 49 stored", async () => {
    await prisma.licence.createMany({
      data: Array.from({ length: MAX_LICENCES - 1 }, (_, index) => ({
        file: Buffer.from(`stored ${String(index)}`),
        sha256: String(index).padStart(64, "0"),
        keyId: "elsewhere-1",
      })),
    });
    const files = await Promise.all([licenceFor(), licenceFor()]);

    const results = await Promise.allSettled(
      files.map((file) => licences.enter(file, BOARD)),
    );

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.flatMap((result) =>
        result.status === "rejected" ? [result.reason as unknown] : [],
      ),
    ).toEqual([expect.objectContaining({ refusal: "limit-reached" })]);
    expect(await prisma.licence.count()).toBe(MAX_LICENCES);
  });
});

describe("a licence for a plugin not installed yet", () => {
  it("is kept unread, then checked when a plugin declaring its key id arrives", async () => {
    installed = [];
    const file = await licenceFor({}, issuer, "later-1");

    const view = await licences.enter(file, BOARD);
    expect(view).toMatchObject({
      check: "not-yet-checked",
      keyId: "later-1",
      licenceId: null,
      verified: null,
    });
    const before = await auditFor(view.id);
    expect(before.map((entry) => entry.action)).toEqual(["LICENCE_ADDED"]);
    // Nothing from the payload: no licence id, no association, no entitlement.
    expect(before[0]?.context).toEqual({
      sha256: view.sha256,
      keyId: "later-1",
      verified: false,
    });

    // A plugin declaring the key id with another key leaves it waiting.
    installed = [plugin("lookalike", { "later-1": testKey() })];
    expect(await licences.checkPending(BOARD)).toBe(0);

    installed = [plugin("mcp-connector", { "later-1": issuer })];
    expect(await licences.checkPending(BOARD)).toBe(1);
    expect(await licences.checkPending(BOARD)).toBe(0);

    const [after] = (await licences.overview()).licences;
    expect(after?.check).toBe("verified");
    expect((await auditFor(view.id)).map((entry) => entry.action)).toEqual([
      "LICENCE_ADDED",
      "LICENCE_VERIFIED",
    ]);
  });
});

describe("two plugins declaring one key id with different keys", () => {
  it("verifies each licence for its own plugin only", async () => {
    const otherIssuer = testKey();
    installed = [
      plugin("mcp-connector", { "test-1": issuer }),
      plugin("themes", { "test-1": otherIssuer }, "themes"),
    ];

    const connector = await licences.enter(await licenceFor(), BOARD);
    const themes = await licences.enter(
      await licenceFor({ entitlements: { themes: {} } }, otherIssuer),
      BOARD,
    );
    expect(connector.verified?.pluginId).toBe("mcp-connector");
    expect(themes.verified?.pluginId).toBe("themes");

    const states = (await licences.overview()).plugins.map((entry) => [
      entry.pluginId,
      entry.state.status,
    ]);
    expect(states).toEqual([
      ["mcp-connector", "active"],
      ["themes", "active"],
    ]);
  });
});

describe("a licence changed after it was entered", () => {
  it("is tampered, on the licence screen and to the plugin", async () => {
    const view = await licences.enter(
      await licenceFor({
        entitlements: { "mcp-connector": { validUntil: "2026-01-31" } },
      }),
      BOARD,
    );
    const later = await licenceFor({
      entitlements: { "mcp-connector": { validUntil: "2099-12-31" } },
    });
    // Another payload under the old signature, written into the row.
    const spoiled = JSON.parse(later.toString()) as Record<string, string>;
    const original = JSON.parse(
      Buffer.from(
        (await prisma.licence.findUniqueOrThrow({ where: { id: view.id } }))
          .file,
      ).toString(),
    ) as Record<string, string>;
    await prisma.licence.update({
      where: { id: view.id },
      data: {
        file: Buffer.from(
          JSON.stringify({ ...original, payload: spoiled.payload }),
        ),
      },
    });

    const overview = await licences.overview();
    expect(overview.licences[0]?.check).toBe("tampered");
    expect(overview.plugins[0]?.state).toEqual({ status: "tampered" });
  });
});

describe("removing a licence", () => {
  it("deletes it and logs its hash and id", async () => {
    const view = await licences.enter(await licenceFor(), BOARD);

    await licences.remove(view.id, BOARD);

    expect(await prisma.licence.count()).toBe(0);
    const audit = await auditFor(view.id);
    expect(audit.at(-1)).toMatchObject({
      action: "LICENCE_REMOVED",
      channel: "SYSTEM",
      context: { sha256: view.sha256, licenceId: view.licenceId },
    });
    expect((await licences.overview()).plugins[0]?.state).toEqual({
      status: "absent",
    });
  });

  it("refuses an id that is not entered", async () => {
    await expect(licences.remove("missing", BOARD)).rejects.toMatchObject({
      reason: "licence-not-found",
    });
  });
});

describe("replacing the instance key", () => {
  const AUDIENCE = "https://issuer.example/presentations";
  const reader = testLicenceManifest({
    keys: { "test-1": issuer },
    audiences: [AUDIENCE],
  });
  const REASON = "A plugin since removed read the key.";

  beforeAll(async () => {
    // Another suite in this worker's database may have created the identity
    // under an encryption key of its own, which this suite could not sign
    // with. These tests present, so they start from one created here.
    await prisma.instanceIdentity.deleteMany();
    await identity.binding();
  });

  /** The log entry the replacement that wrote `publicKey` made. */
  async function replacementEntry(publicKey: string) {
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "INSTANCE_KEY_REPLACED" },
    });
    return entries.find(
      (entry) =>
        (entry.context as { publicKey?: unknown } | null)?.publicKey ===
        publicKey,
    );
  }

  it("keeps the id, deletes the old key, and leaves each licence stored and wrong-instance", async () => {
    const before = await prisma.instanceIdentity.findUniqueOrThrow({
      where: { id: 1 },
    });
    const entered = await licences.enter(await licenceFor(), BOARD);
    expect((await entitlements.get(reader)).status).toBe("active");
    await expect(entitlements.present(reader, AUDIENCE)).resolves.toEqual(
      expect.any(String),
    );

    const after = await identity.replaceKey({ newId: false, reason: REASON });

    expect(after.instanceId).toBe(before.instanceId);
    expect(after.instanceKey).not.toBe(before.publicKey);
    await expect(identity.binding()).resolves.toEqual(after);
    const row = await prisma.instanceIdentity.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(row.publicKey).toBe(after.instanceKey);
    expect(row.privateKeyCipher).not.toBe(before.privateKeyCipher);

    // Stored still, names a key the instance no longer has, presents nothing.
    expect(await prisma.licence.count({ where: { id: entered.id } })).toBe(1);
    await expect(entitlements.get(reader)).resolves.toEqual({
      status: "wrong-instance",
      licenceId: entered.licenceId,
    });
    await expect(entitlements.present(reader, AUDIENCE)).resolves.toBeNull();

    // The licence the issuer reissues to the new key applies.
    const reissued = await licences.enter(await licenceFor(), BOARD);
    await expect(entitlements.get(reader)).resolves.toMatchObject({
      status: "active",
      licenceId: reissued.licenceId,
    });

    const entry = await replacementEntry(after.instanceKey);
    expect(entry).toMatchObject({
      channel: "SYSTEM",
      actorPersonId: null,
      targetPersonId: null,
      targetKind: "instance",
      targetId: after.instanceId,
      context: {
        instanceId: after.instanceId,
        publicKey: after.instanceKey,
        reason: REASON,
      },
    });
    const seed = await encryption.decrypt(
      "instanceIdentity.privateKey",
      row.privateKeyCipher,
    );
    expect(JSON.stringify(entry)).not.toContain(seed);
  });

  it("gives the instance a new id as well when asked to", async () => {
    const before = await identity.binding();

    const after = await identity.replaceKey({ newId: true, reason: REASON });

    expect(after.instanceId).not.toBe(before.instanceId);
    expect(after.instanceKey).not.toBe(before.instanceKey);
    expect((await replacementEntry(after.instanceKey))?.context).toEqual({
      instanceId: after.instanceId,
      publicKey: after.instanceKey,
      reason: REASON,
      previousInstanceId: before.instanceId,
    });
  });

  it("refuses to replace the key without a reason", async () => {
    const before = await identity.binding();

    await expect(
      identity.replaceKey({ newId: false, reason: "  " }),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(identity.binding()).resolves.toEqual(before);
  });
});

/**
 * Which plugins' keys a licence is tried against. The server reads the
 * manifests its boot kept; the command-line tool runs no plugin and reads the
 * packages on the volume against the consent records. Both are to count the
 * same packages, so each case runs on both.
 */
describe("which packages count as installed", () => {
  let dataDir: string;
  const suffix = runSuffix();
  const consentedId = `consented-${suffix}`;
  const disabledId = `disabled-${suffix}`;
  const strayId = `stray-${suffix}`;
  const staleId = `stale-${suffix}`;
  const misplacedId = `misplaced-${suffix}`;
  const disabledKey = testKey();
  const strayKey = testKey();
  const staleKey = testKey();
  const misplacedKey = testKey();

  /** Lays a package out on the volume the way npm would. */
  async function lay(
    id: string,
    version: string,
    key: TestKey,
    keyId: string,
    directoryName = id,
  ) {
    const directory = join(
      pluginModulesDirectory(dataPaths(dataDir).plugins),
      directoryName,
    );
    await mkdir(join(directory, "dist"), { recursive: true });
    await writeFile(join(directory, "dist", "server.cjs"), "");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        name: id,
        version,
        openbrf: plugin(id, { [keyId]: key }),
      }),
    );
  }

  function record(id: string, version: string, enabled = true) {
    return {
      id,
      packageName: id,
      version,
      checksum: "sha512-test",
      status: "INSTALLED" as const,
      enabled,
    };
  }

  /** Runs `work` as the given process, restoring the role after. */
  async function asProcess<T>(
    role: "cli" | "server",
    work: () => Promise<T>,
  ): Promise<T> {
    const before = process.env.OPENBRF_PROCESS_ROLE;
    process.env.OPENBRF_PROCESS_ROLE = role;
    try {
      return await work();
    } finally {
      restoreEnvironmentVariable("OPENBRF_PROCESS_ROLE", before);
    }
  }

  function volumeEnv() {
    return { ...env, OPENBRF_DATA_DIR: dataDir, OPENBRF_PLUGINS_ENABLED: true };
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "openbrf-licences-"));
    await lay(consentedId, "1.0.0", issuer, "test-1");
    await lay(disabledId, "1.0.0", disabledKey, "disabled-1");
    await lay(strayId, "1.0.0", strayKey, "stray-1");
    // Consent is for 1.0.0, and the volume holds 2.0.0.
    await lay(staleId, "2.0.0", staleKey, "stale-1");
    // The consented name and version, in a directory npm installed some other
    // package into.
    await lay(
      misplacedId,
      "1.0.0",
      misplacedKey,
      "misplaced-1",
      `elsewhere-${suffix}`,
    );
    await prisma.installedPlugin.createMany({
      data: [
        record(consentedId, "1.0.0"),
        record(disabledId, "1.0.0", false),
        record(staleId, "1.0.0"),
        record(misplacedId, "1.0.0"),
      ],
    });
  });

  afterAll(async () => {
    await prisma.installedPlugin.deleteMany({
      where: {
        id: { in: [consentedId, disabledId, strayId, staleId, misplacedId] },
      },
    });
    await rm(dataDir, { recursive: true, force: true });
  });

  const cases: [string, string, () => TestKey, () => string | null][] = [
    ["a plugin the board installed", "test-1", () => issuer, () => consentedId],
    [
      "a plugin the board installed and switched off",
      "disabled-1",
      () => disabledKey,
      () => disabledId,
    ],
    [
      "a package on the volume with no record",
      "stray-1",
      () => strayKey,
      () => null,
    ],
    [
      "a package at a version the board did not consent to",
      "stale-1",
      () => staleKey,
      () => null,
    ],
    [
      "a package with the consented name in another directory",
      "misplaced-1",
      () => misplacedKey,
      () => null,
    ],
  ];

  function expectCounted(view: LicenceView, pluginId: string | null) {
    if (pluginId === null) {
      expect(view).toMatchObject({ check: "not-yet-checked", verified: null });
    } else {
      expect(view.check).toBe("verified");
      expect(view.verified?.pluginId).toBe(pluginId);
    }
  }

  describe("from the command-line tool", () => {
    function cliService(): LicenceAdminService {
      return new LicenceAdminService(
        prisma,
        audit,
        identity,
        entitlements,
        {} as unknown as PluginLoaderService,
        volumeEnv(),
      );
    }

    it.each(cases)(
      "with the key of %s",
      async (_name, keyId, key, pluginId) => {
        const view = await asProcess("cli", async () =>
          cliService().enter(await licenceFor({}, key(), keyId), BOARD),
        );

        expectCounted(view, pluginId());
      },
    );
  });

  describe("on the server's licence screen", () => {
    let serverLicences: LicenceAdminService;

    beforeAll(async () => {
      // The boot bridges module resolution for the bundles it requires. Each
      // bundle here is empty, so none loads: every consented one is kept as
      // a manifest, as a disabled or refused plugin is.
      const nodePath = process.env.NODE_PATH;
      try {
        const boot = await asProcess("server", async () =>
          loadPlugins({
            env: volumeEnv(),
            records: await new PluginRegistryService(prisma).list(),
            binding: new PluginHostBinding(),
          }),
        );
        serverLicences = new LicenceAdminService(
          prisma,
          audit,
          identity,
          entitlements,
          new PluginLoaderService(
            boot,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
          ),
          env,
        );
      } finally {
        restoreEnvironmentVariable("NODE_PATH", nodePath);
      }
    });

    it.each(cases)(
      "with the key of %s",
      async (_name, keyId, key, pluginId) => {
        const view = await asProcess("server", async () =>
          serverLicences.enter(await licenceFor({}, key(), keyId), BOARD),
        );

        expectCounted(view, pluginId());
      },
    );
  });
});
