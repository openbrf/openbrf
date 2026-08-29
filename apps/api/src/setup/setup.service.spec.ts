import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { AuditLogService } from "../audit/audit-log.service";
import type { AuthService } from "../auth/auth.service";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import { I18nService } from "../i18n/i18n.service";
import type { PagesService } from "../site/pages.service";
import { SetupError, SetupService } from "./setup.service";

/**
 * The first-boot guard, tested against the real field encryption and a fake
 * database.
 *
 * What matters here is not that the wizard works but that it CLOSES: an
 * instance holding a statutory register of personal data must never keep
 * serving an unauthenticated "create an administrator" form. Every assertion
 * below is about the conditions under which the public path is open.
 */

const TEST_ENV = {
  NODE_ENV: "test",
  PORT: 3000,
  DATABASE_URL: "postgresql://unused",
  APP_URL: "https://brf.example.se",
  OPENBRF_DATA_DIR: "./.data",
  OPENBRF_ENCRYPTION_KEY: "b".repeat(64),
  BETTER_AUTH_SECRET: "test-secret-at-least-16-chars",
  OPENBRF_PLUGINS_ENABLED: false,
  OPENBRF_UNCURATED_PLUGINS_ENABLED: false,
} as Env;

/**
 * The real translator, so the seeded page's slug is asserted against the
 * catalog rather than against a fake that would agree with anything.
 */
const i18n = new I18nService();

beforeAll(async () => {
  await i18n.init();
});

const ADMINISTRATOR = {
  firstName: "Holger",
  lastName: "Jensen",
  email: "holger@exempel.se",
  password: "correct horse battery",
};

interface Fakes {
  service: SetupService;
  prisma: {
    user: {
      count: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
    association: {
      findUnique: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    person: {
      create: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    systemRole: {
      create: ReturnType<typeof vi.fn>;
      deleteMany: ReturnType<typeof vi.fn>;
    };
  };
  auth: { createAccountForPerson: ReturnType<typeof vi.fn> };
  audit: { record: ReturnType<typeof vi.fn> };
  pages: {
    seedDefaultPage: ReturnType<typeof vi.fn>;
    seedPrivacyNotice: ReturnType<typeof vi.fn>;
  };
}

/**
 * Builds the service over fakes.
 *
 * `accounts` and `setupCompletedAt` are the two inputs the guard reads, so they
 * are the knobs each test turns.
 */
function build(
  options: { accounts?: number; setupCompletedAt?: Date | null } = {},
): Fakes {
  const association = {
    setupCompletedAt:
      options.setupCompletedAt === undefined ? null : options.setupCompletedAt,
    name: "Brf Talgoxen",
    organizationNumber: "769600-1234",
    defaultLocale: "sv",
  };

  const prisma = {
    user: {
      count: vi.fn().mockResolvedValue(options.accounts ?? 0),
      deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    association: {
      findUnique: vi.fn().mockResolvedValue(association),
      update: vi.fn().mockResolvedValue(association),
    },
    person: {
      create: vi.fn().mockResolvedValue({ id: "person-1" }),
      delete: vi.fn().mockResolvedValue({ id: "person-1" }),
    },
    systemRole: {
      create: vi.fn().mockResolvedValue({ id: "role-1" }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };

  // The transaction client is the same fake: what these tests check is the
  // sequence of writes, not that Postgres isolates them.
  const client = {
    ...prisma,
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) =>
      run(client),
    ),
  };

  const auth = {
    createAccountForPerson: vi.fn().mockResolvedValue({ userId: "user-1" }),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const pages = {
    seedDefaultPage: vi.fn().mockResolvedValue({ created: true }),
    seedPrivacyNotice: vi.fn().mockResolvedValue({ created: true }),
  };

  const service = new SetupService(
    client as unknown as PrismaService,
    auth as unknown as AuthService,
    new FieldEncryptionService(TEST_ENV),
    audit as unknown as AuditLogService,
    pages as unknown as PagesService,
    i18n,
    TEST_ENV,
  );

  return { service, prisma, auth, audit, pages };
}

describe("setup state", () => {
  it("is required on an instance nobody has claimed", async () => {
    const { service } = build();
    await expect(service.state()).resolves.toEqual({ setupRequired: true });
  });

  it("is not required once an account exists", async () => {
    // One account means a human has been here and the register is theirs.
    const { service } = build({ accounts: 1 });
    await expect(service.state()).resolves.toEqual({ setupRequired: false });
  });

  it("is not required once setup has been completed, even with no accounts", async () => {
    // The catch for an instance whose accounts were later removed: reopening
    // public administrator creation on a database full of residents' personal
    // data is the hole this guard exists to close.
    const { service } = build({
      accounts: 0,
      setupCompletedAt: new Date("2026-08-01T10:00:00Z"),
    });
    await expect(service.state()).resolves.toEqual({ setupRequired: false });
  });

  it("is required when no association row exists at all", async () => {
    const { service, prisma } = build();
    prisma.association.findUnique.mockResolvedValue(null);
    await expect(service.state()).resolves.toEqual({ setupRequired: true });
  });
});

describe("creating the first administrator", () => {
  let fakes: Fakes;

  beforeEach(() => {
    fakes = build();
  });

  it("creates the person, the ADMIN grant and the account", async () => {
    await expect(
      fakes.service.createFirstAdministrator(ADMINISTRATOR),
    ).resolves.toEqual({ personId: "person-1" });

    expect(fakes.prisma.person.create).toHaveBeenCalledTimes(1);
    expect(fakes.prisma.systemRole.create).toHaveBeenCalledWith({
      data: { personId: "person-1", role: "ADMIN" },
    });
    expect(fakes.auth.createAccountForPerson).toHaveBeenCalledWith({
      personId: "person-1",
      email: ADMINISTRATOR.email,
      name: "Holger Jensen",
      password: ADMINISTRATOR.password,
    });
  });

  it("stores the address encrypted and indexed, never in plaintext", async () => {
    await fakes.service.createFirstAdministrator(ADMINISTRATOR);

    const written = fakes.prisma.person.create.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(written.data.emailCipher).toBeTypeOf("string");
    expect(written.data.emailCipher).not.toContain(ADMINISTRATOR.email);
    expect(written.data.emailIndex).toBeTypeOf("string");
  });

  it("logs the ADMIN grant", async () => {
    await fakes.service.createFirstAdministrator(ADMINISTRATOR);

    expect(fakes.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SYSTEM_ROLE_GRANTED",
        actorPersonId: "person-1",
        targetPersonId: "person-1",
      }),
      expect.anything(),
    );
  });

  it("refuses once an account exists", async () => {
    const claimed = build({ accounts: 1 });

    await expect(
      claimed.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toMatchObject({ reason: "already-claimed" });
    expect(claimed.prisma.person.create).not.toHaveBeenCalled();
  });

  it("refuses once setup has been completed", async () => {
    const completed = build({
      accounts: 0,
      setupCompletedAt: new Date("2026-08-01T10:00:00Z"),
    });

    await expect(
      completed.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toMatchObject({ reason: "already-claimed" });
    expect(completed.prisma.person.create).not.toHaveBeenCalled();
  });

  it("refuses inside the transaction when an account appears mid-request", async () => {
    // The outer check passed and the inner one has to catch it, which is what
    // narrows the window between the guard and the account creation.
    fakes.prisma.user.count.mockResolvedValueOnce(0).mockResolvedValueOnce(1);

    await expect(
      fakes.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toBeInstanceOf(SetupError);
    expect(fakes.prisma.person.create).not.toHaveBeenCalled();
  });

  it("refuses an address that cannot be indexed", async () => {
    await expect(
      fakes.service.createFirstAdministrator({ ...ADMINISTRATOR, email: "" }),
    ).rejects.toMatchObject({ reason: "invalid-email" });
  });

  it("removes the person when the account cannot be created", async () => {
    // Otherwise the instance is stuck: somebody holds ADMIN with no way to
    // sign in, and the guard now refuses to let anyone try again.
    fakes.auth.createAccountForPerson.mockRejectedValue(
      new Error("hashing failed"),
    );

    await expect(
      fakes.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toThrow("hashing failed");

    expect(fakes.prisma.systemRole.deleteMany).toHaveBeenCalledWith({
      where: { personId: "person-1" },
    });
    expect(fakes.prisma.person.delete).toHaveBeenCalledWith({
      where: { id: "person-1" },
    });
  });

  it("records the withdrawn grant, because the log cannot be edited", async () => {
    fakes.auth.createAccountForPerson.mockRejectedValue(new Error("nope"));

    await expect(
      fakes.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toThrow();

    expect(fakes.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "SYSTEM_ROLE_REVOKED",
        targetPersonId: "person-1",
      }),
      expect.anything(),
    );
  });

  it("removes a half-created account, which would block the person delete", async () => {
    /*
     * Account creation writes the auth user and its credential through an
     * adapter that takes no transaction, so a failure between the two can leave
     * a user row behind. User.person is onDelete: Restrict, so that row blocks
     * the person delete and the guard - which counts user rows - then keeps
     * setup closed with nothing able to reopen it.
     */
    fakes.auth.createAccountForPerson.mockRejectedValue(
      new Error("linking failed"),
    );

    await expect(
      fakes.service.createFirstAdministrator(ADMINISTRATOR),
    ).rejects.toThrow("linking failed");

    expect(fakes.prisma.user.deleteMany).toHaveBeenCalledWith({
      where: { personId: "person-1" },
    });
    // The ORDER is the fix, and the fake enforces no foreign key: in Postgres
    // the person delete fails while the account row still references it.
    const accountDeletedAt =
      fakes.prisma.user.deleteMany.mock.invocationCallOrder.at(0) ?? -1;
    const personDeletedAt =
      fakes.prisma.person.delete.mock.invocationCallOrder.at(0) ?? -1;
    expect(accountDeletedAt).toBeGreaterThan(0);
    expect(accountDeletedAt).toBeLessThan(personDeletedAt);
  });

  it("does not mint a session of its own", async () => {
    // Sessions come from the ordinary sign-in path, so the rate limiting, the
    // second-factor policy and the cookie settings all apply to them.
    const result = await fakes.service.createFirstAdministrator(ADMINISTRATOR);

    // Asserted on the answer rather than on the fake: the id is all the caller
    // gets, and nothing in it could authenticate the next request.
    expect(Object.keys(result)).toEqual(["personId"]);
  });
});

describe("completing setup", () => {
  it("refuses while the housing cooperative has no name", async () => {
    const { service, prisma } = build();
    prisma.association.findUnique.mockResolvedValue(null);

    await expect(service.complete("person-1")).rejects.toMatchObject({
      reason: "housing-cooperative-missing",
    });
  });

  it("stamps the completion date", async () => {
    const { service, prisma } = build();

    const result = await service.complete("person-1");

    expect(result.completedAt).toBeInstanceOf(Date);
    expect(prisma.association.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { setupCompletedAt: result.completedAt },
    });
  });

  it("keeps the original completion date when run again", async () => {
    const first = new Date("2026-08-01T10:00:00Z");
    const { service } = build({ accounts: 1, setupCompletedAt: first });

    await expect(service.complete("person-1")).resolves.toEqual({
      completedAt: first,
    });
  });

  it("asks for the association's first page, in the association's language", async () => {
    const { service, pages } = build();

    await service.complete("person-1");

    expect(pages.seedDefaultPage).toHaveBeenCalledTimes(1);
    const [translator, association] = pages.seedDefaultPage.mock.calls[0] as [
      (key: string) => string,
      { name: string; organizationNumber: string | null },
    ];
    expect(association).toEqual({
      name: "Brf Talgoxen",
      organizationNumber: "769600-1234",
    });
    // The wizard's own language, not a visitor's: the seeded page is what the
    // association's website says before anyone has edited it.
    expect(translator("site.seed.slug")).toBe("hem");
  });

  it("re-completing does not ask for a second page", async () => {
    // The service is asked once per completion and answers "already written"
    // itself; what this pins is that a second completion cannot produce a page
    // the board has to go and delete.
    const { service, pages } = build({
      accounts: 1,
      setupCompletedAt: new Date("2026-08-01T10:00:00Z"),
    });
    pages.seedDefaultPage.mockResolvedValue({ created: false });

    await service.complete("person-1");

    expect(pages.seedDefaultPage).toHaveBeenCalledTimes(1);
    expect(await pages.seedDefaultPage.mock.results[0]?.value).toEqual({
      created: false,
    });
  });

  it("still completes when the first page cannot be written", async () => {
    // The page is a courtesy; the completion is a state change that has already
    // been stamped. Undoing it because the courtesy failed would leave the
    // instance unclaimed with an administrator already in it.
    const { service, pages } = build();
    pages.seedDefaultPage.mockRejectedValue(new Error("no database"));

    await expect(service.complete("person-1")).resolves.toMatchObject({
      completedAt: expect.any(Date) as Date,
    });
  });
});
