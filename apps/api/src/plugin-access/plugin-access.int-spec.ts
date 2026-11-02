import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { hashToken } from "../invitations/invitation.service";
import { lockResidencyTransitions } from "../registers/residency-lock";
import { DataSubjectReportService } from "../retention/data-subject-report.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type { PluginAccessesView } from "./plugin-access";
import {
  PLUGIN_ACCESS_CLASS,
  type PluginAccessClass,
} from "./plugin-access-class";

/**
 * A plugin access (tilläggsåtkomst, ADR 0053), over HTTP and against a real
 * database: how a person who does not live here, such as somebody who rents a
 * garage, comes to be served by a plugin and to have an account, with no
 * residency created for them.
 *
 * The board adds the person to the address book without a residency, grants
 * the access on their page, and sends the invitation; the person accepts it.
 * The suite also pins what keeps an access to that person: the grant is
 * refused for anybody with a residency on record, a residency recorded later
 * ends it, and a grant racing a move-in cannot slip past it.
 *
 * Whether an install serves the class is the plugin system's to say, so the
 * suite binds that answer itself: one plugin serves the class, another is
 * installed and does not.
 */

loadEnvForIntegrationTests();

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const servingPlugin = `pa-serving-${suffix}`;
const otherPlugin = `pa-other-${suffix}`;
const removedPlugin = `pa-removed-${suffix}`;
const pluginIds = [servingPlugin, otherPlugin, removedPlugin];

const lastName = `Åtkomst${suffix}`;
const addressId = `pa-address-${suffix}`;
const apartmentId = `pa-apartment-${suffix}`;

const board = {
  personId: `pa-board-${suffix}`,
  email: `pa-board-${suffix}@exempel.se`,
};
const resident = {
  personId: `pa-resident-${suffix}`,
  email: `pa-resident-${suffix}@exempel.se`,
};
/** Rents a garage and has never lived here. */
const renter = {
  personId: `pa-renter-${suffix}`,
  email: `pa-renter-${suffix}@exempel.se`,
};
const movedOut = { personId: `pa-moved-out-${suffix}` };
const movingInLater = { personId: `pa-later-${suffix}` };
/** Granted an access, and then moved in. */
const mover = { personId: `pa-mover-${suffix}` };
/** Granted while a move-in for them is being recorded. */
const racer = { personId: `pa-racer-${suffix}` };
/** Holds an access and a board seat, so the access is not their only tie. */
const seated = { personId: `pa-seated-${suffix}` };
const withdrawn = { personId: `pa-withdrawn-${suffix}` };

const personIds = [
  board.personId,
  resident.personId,
  renter.personId,
  movedOut.personId,
  movingInLater.personId,
  mover.personId,
  racer.personId,
  seated.personId,
  withdrawn.personId,
];

const SERVING: PluginAccessClass = {
  pluginsServingAccess: () =>
    Promise.resolve(new Set([servingPlugin, removedPlugin])),
};

let app: NestFastifyApplication;
let prisma: PrismaService;
let boardCookie: string;
let residentCookie: string;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.93.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.93.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PATCH";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: { "x-forwarded-for": nextForwardedFor(), ...options.headers },
    });
}

async function signIn(email: string): Promise<string> {
  const response = await inject({
    method: "POST",
    url: "/api/auth/sign-in/email",
    payload: { email, password: PASSWORD },
  });
  const setCookie = response.headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : setCookie === undefined
      ? []
      : [setCookie];
  return cookies.map((value) => value.split(";")[0]).join("; ");
}

function setAccess(
  cookie: string,
  personId: string,
  pluginId: string,
  granted: boolean,
) {
  return inject({
    method: "PATCH",
    url: `/api/plugin-accesses/persons/${personId}`,
    payload: { pluginId, granted },
    headers: { cookie },
  });
}

function entries(personId: string) {
  return prisma.auditLogEntry.findMany({
    where: {
      targetPersonId: personId,
      action: {
        in: [
          "PLUGIN_ACCESS_GRANTED",
          "PLUGIN_ACCESS_WITHDRAWN",
          "PLUGIN_ACCESS_ENDED",
        ],
      },
    },
    orderBy: [{ createdAt: "asc" }],
    select: { action: true, actorPersonId: true, channel: true, context: true },
  });
}

/** Today on the association's calendar, shifted by whole days. */
function day(offset: number): Date {
  const now = new Date();
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + offset,
    ),
  );
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PLUGIN_ACCESS_CLASS)
    .useValue(SERVING)
    .compile();

  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  prisma = app.get(PrismaService);

  await prisma.installedPlugin.createMany({
    data: pluginIds.map((id) => ({
      id,
      packageName: `@test/${id}`,
      version: "1.0.0",
      checksum: "sha512-test",
    })),
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Garagegatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  await prisma.person.createMany({
    data: personIds.map((id, index) => ({
      id,
      firstName: `Person${String(index)}`,
      lastName,
    })),
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: board.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
      {
        personId: seated.personId,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
    ],
  });

  await prisma.residency.createMany({
    data: [
      {
        personId: resident.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2026-01-01"),
      },
      {
        personId: movedOut.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: new Date("2025-01-01"),
        movedOutOn: new Date("2025-12-31"),
      },
      {
        personId: movingInLater.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: day(30),
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of [board, resident]) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }
  boardCookie = await signIn(board.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      const where = { personId: { in: personIds } };
      await prisma.session.deleteMany({ where: { user: where } });
      await prisma.account.deleteMany({ where: { user: where } });
      await prisma.user.deleteMany({ where });
      await prisma.invitation.deleteMany({ where });
      await prisma.pluginAccess.deleteMany({ where });
      await prisma.boardPosition.deleteMany({ where });
      await prisma.residency.deleteMany({ where });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.installedPlugin.deleteMany({
        where: { id: { in: pluginIds } },
      });
      // Audit entries stay: the table is append-only.
    }
  } finally {
    await app?.close();
  }
});

describe("a person who does not live here", () => {
  it("is granted an access by the board, with no residency created", async () => {
    const response = await setAccess(
      boardCookie,
      renter.personId,
      servingPlugin,
      true,
    );

    expect(response.statusCode, response.body).toBe(200);
    const view = response.json() as PluginAccessesView;
    expect(view.personId).toBe(renter.personId);
    expect(view.accesses.map((access) => access.pluginId)).toEqual([
      servingPlugin,
    ]);
    // No row names the plugin in the record of processing activities, so the
    // plugin is named by its id.
    expect(view.accesses[0]?.pluginName).toBe(servingPlugin);

    expect(
      await prisma.residency.count({ where: { personId: renter.personId } }),
    ).toBe(0);
    expect(await entries(renter.personId)).toEqual([
      {
        action: "PLUGIN_ACCESS_GRANTED",
        actorPersonId: board.personId,
        channel: "WEB",
        context: { plugin: servingPlugin },
      },
    ]);
  });

  it("is answered with the state as it is on a second grant, which writes nothing", async () => {
    const response = await setAccess(
      boardCookie,
      renter.personId,
      servingPlugin,
      true,
    );

    expect(response.statusCode).toBe(200);
    expect(await entries(renter.personId)).toHaveLength(1);
  });

  it("is shown with the access on their page", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/address-book/persons/${renter.personId}`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const detail = response.json() as {
      residencies: unknown[];
      pluginAccesses: { pluginId: string; grantedAt: string }[];
    };
    expect(detail.residencies).toEqual([]);
    expect(detail.pluginAccesses.map((access) => access.pluginId)).toEqual([
      servingPlugin,
    ]);
  });

  it("gets an account through the board's invitation, still with no residency", async () => {
    // The invitation the board sends from the person's page, accepted with
    // the token its mail would carry.
    const token = `pa-token-${suffix}`;
    await prisma.invitation.create({
      data: {
        personId: renter.personId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + 60_000),
        invitedById: board.personId,
      },
    });
    const fields = app.get(FieldEncryptionService);
    const email = await fields.encrypt("person.email", renter.email);
    await prisma.person.update({
      where: { id: renter.personId },
      data: {
        emailCipher: email.cipher,
        emailIndex: await fields.computeIndex("person.email", renter.email),
      },
    });

    const accepted = await inject({
      method: "POST",
      url: "/api/invitations/accept",
      payload: { token, password: PASSWORD },
    });
    expect(accepted.statusCode, accepted.body).toBe(201);

    const cookie = await signIn(renter.email);
    expect(cookie).toContain("session_token");
    expect(
      await prisma.residency.count({ where: { personId: renter.personId } }),
    ).toBe(0);
    expect(
      await prisma.pluginAccess.count({ where: { personId: renter.personId } }),
    ).toBe(1);
  });

  it("is listed under the address book's plugin access filter", async () => {
    await prisma.pluginAccess.create({
      data: { personId: seated.personId, pluginId: servingPlugin },
    });

    const response = await inject({
      method: "GET",
      url: `/api/address-book?filter=pluginAccess&search=${encodeURIComponent(lastName)}&pageSize=100`,
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const page = response.json() as { rows: { personId: string }[] };
    // The renter, whose only tie is the access, and not the board member who
    // also holds one.
    expect(page.rows.map((row) => row.personId)).toEqual([renter.personId]);
  });

  it("is not listed to a resident under that filter", async () => {
    const response = await inject({
      method: "GET",
      url: `/api/resident-directory?filter=pluginAccess&search=${encodeURIComponent(lastName)}`,
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { rows: unknown[] }).rows).toEqual([]);
  });

  it("finds the access on their access report", async () => {
    const report = await app.get(DataSubjectReportService).generate({
      personId: renter.personId,
      actorPersonId: board.personId,
    });

    expect(report.pluginAccesses.map((access) => access.pluginId)).toEqual([
      servingPlugin,
    ]);
  });
});

describe("who and what the grant refuses", () => {
  it.each([
    ["a resident", resident.personId],
    ["a former resident", movedOut.personId],
    ["a person whose residency begins later", movingInLater.personId],
  ])("refuses %s, who has a residency on record", async (_who, personId) => {
    const response = await setAccess(
      boardCookie,
      personId,
      servingPlugin,
      true,
    );

    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason: string }).reason).toBe(
      "person-has-residency",
    );
    expect(await prisma.pluginAccess.count({ where: { personId } })).toBe(0);
    expect(await entries(personId)).toEqual([]);
  });

  it("refuses a plugin whose install does not serve people given access", async () => {
    const response = await setAccess(
      boardCookie,
      withdrawn.personId,
      otherPlugin,
      true,
    );

    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason: string }).reason).toBe(
      "plugin-access-not-served",
    );
  });

  it("refuses a plugin that is not installed", async () => {
    const response = await setAccess(
      boardCookie,
      withdrawn.personId,
      `pa-absent-${suffix}`,
      true,
    );

    expect(response.statusCode).toBe(404);
    expect((response.json() as { reason: string }).reason).toBe(
      "plugin-not-found",
    );
  });

  it("refuses a person the register does not hold", async () => {
    const response = await setAccess(
      boardCookie,
      `pa-nobody-${suffix}`,
      servingPlugin,
      true,
    );

    expect(response.statusCode).toBe(404);
  });

  it("refuses a resident, who may not write the address book", async () => {
    const response = await setAccess(
      residentCookie,
      withdrawn.personId,
      servingPlugin,
      true,
    );

    expect(response.statusCode).toBe(403);
    expect(
      await prisma.pluginAccess.count({
        where: { personId: withdrawn.personId },
      }),
    ).toBe(0);
  });

  it("offers only the plugins that serve people given access", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/plugin-accesses/plugins",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const ids = (
      response.json() as { plugins: { pluginId: string }[] }
    ).plugins.map((plugin) => plugin.pluginId);
    expect(ids).toContain(servingPlugin);
    expect(ids).not.toContain(otherPlugin);
  });
});

describe("how an access ends", () => {
  it("is withdrawn by the board, once", async () => {
    await setAccess(boardCookie, withdrawn.personId, servingPlugin, true);

    const first = await setAccess(
      boardCookie,
      withdrawn.personId,
      servingPlugin,
      false,
    );
    const second = await setAccess(
      boardCookie,
      withdrawn.personId,
      servingPlugin,
      false,
    );

    expect(first.statusCode).toBe(200);
    expect((first.json() as PluginAccessesView).accesses).toEqual([]);
    expect(second.statusCode).toBe(200);
    expect(
      (await entries(withdrawn.personId)).map((entry) => entry.action),
    ).toEqual(["PLUGIN_ACCESS_GRANTED", "PLUGIN_ACCESS_WITHDRAWN"]);
  });

  it("ends when the person is moved in, with an entry naming who moved them", async () => {
    await setAccess(boardCookie, mover.personId, servingPlugin, true);

    const response = await inject({
      method: "POST",
      url: "/api/moves/move-in",
      payload: {
        personId: mover.personId,
        apartmentId,
        role: "RESIDENT",
        movedInOn: "2026-06-01",
      },
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode, response.body).toBe(201);
    expect(
      await prisma.pluginAccess.count({ where: { personId: mover.personId } }),
    ).toBe(0);
    expect(await entries(mover.personId)).toEqual([
      expect.objectContaining({ action: "PLUGIN_ACCESS_GRANTED" }),
      {
        action: "PLUGIN_ACCESS_ENDED",
        actorPersonId: board.personId,
        channel: "WEB",
        context: { plugin: servingPlugin },
      },
    ]);
  });

  it("is not granted past a move-in that is being recorded", async () => {
    /*
     * A move-in for the person holds their transition lock from before it
     * writes the residency until it commits. A grant that did not take the
     * same lock would read no residency, since the move-in has not committed,
     * and grant an access the move-in never sees to end.
     */
    let locked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const moveIn = prisma.$transaction(
      async (tx) => {
        await lockResidencyTransitions(tx, racer.personId);
        await tx.residency.create({
          data: {
            personId: racer.personId,
            apartmentId,
            role: "RESIDENT",
            movedInOn: new Date("2026-06-01"),
          },
        });
        locked();
        await released;
      },
      { timeout: 20_000 },
    );
    await lockHeld;

    const grant = setAccess(boardCookie, racer.personId, servingPlugin, true);
    // The grant is waiting on the lock before the move-in commits, which is
    // read off this lock's own key and no other.
    await expect
      .poll(
        async () => {
          const rows = await prisma.$queryRaw<{ waiting: bigint }[]>`
            SELECT count(*) AS waiting FROM pg_locks
            WHERE locktype = 'advisory' AND NOT granted
              AND ((classid::bigint << 32) | objid::bigint)
                = hashtext(${`residency:${racer.personId}`})::bigint`;
          return Number(rows[0]?.waiting ?? 0);
        },
        { timeout: 10_000, interval: 50 },
      )
      .toBe(1);

    release();
    await moveIn;
    const response = await grant;

    expect(response.statusCode).toBe(409);
    expect((response.json() as { reason: string }).reason).toBe(
      "person-has-residency",
    );
    expect(
      await prisma.pluginAccess.count({ where: { personId: racer.personId } }),
    ).toBe(0);
  });

  it("goes with the plugin when it is removed", async () => {
    await setAccess(boardCookie, seated.personId, removedPlugin, true);
    expect(
      await prisma.pluginAccess.count({ where: { pluginId: removedPlugin } }),
    ).toBe(1);

    await prisma.installedPlugin.delete({ where: { id: removedPlugin } });

    expect(
      await prisma.pluginAccess.count({ where: { pluginId: removedPlugin } }),
    ).toBe(0);
  });
});
