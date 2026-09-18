import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import {
  type ActionCaller,
  ActionCallerFactory,
  type RequestWithToken,
} from "./action-caller";
import { markAuthenticated } from "./authenticated-request";
import { ActionRegistryService } from "./action-registry.service";

/**
 * What an action may reach, against a real instance.
 *
 * Three things only this suite can show.
 *
 * That the catalogue a caller is actually offered is the catalogue the contract
 * test asserts. That test builds registrars by hand against stubbed services;
 * this one asks a running application what it holds, so a registrar that is not
 * a provider of its module is absent here and present there.
 *
 * That a write dispatched through an action leaves an audit entry carrying the
 * channel the caller arrived on. The channel is the one field the whole audit
 * change exists to make unforgeable, the log is append-only so an entry written
 * wrongly cannot be tidied up afterwards, and the association's facts had no
 * entry at all until this slice.
 *
 * And that the capability is re-derived from the register on every call rather
 * than carried: the board member here is refused the moment their position is
 * taken away, with nothing about the caller having changed.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let registry: ActionRegistryService;
let callers: ActionCallerFactory;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

const board = {
  personId: `action-data-board-${suffix}`,
  email: `action-data-board-${suffix}@exempel.se`,
};
const resident = { personId: `action-data-resident-${suffix}` };
const personIds = [board.personId, resident.personId];

const addressId = `action-data-address-${suffix}`;
const apartmentId = `action-data-apartment-${suffix}`;

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.48.0.0/16 is this suite's; every other suite holds its own second octet.
  return `10.48.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST" | "PUT" | "DELETE";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  return app
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        "x-forwarded-for": nextForwardedFor(),
        "accept-language": "sv-SE,sv;q=0.9",
        ...options.headers,
      },
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

/**
 * A caller as a connected app, built where the authorization guard stands.
 *
 * There is no core route that dispatches an action - the connector plugin owns
 * that address - so this suite stands in the guard's place rather than
 * inventing a second dispatch path. What it does not stand in for is anything
 * the registry decides: the person, their capabilities, the surface, the scopes
 * and the audit entry are all the application's own.
 */
function connectedApp(): ActionCaller {
  const request = {
    id: `request-${suffix}`,
    principal: { personId: board.personId, capabilities: new Set<string>() },
    token: {
      clientId: `client-${suffix}`,
      clientHost: "app.example",
      scopes: ["mcp:read", "mcp:write"],
    },
  } as unknown as RequestWithToken;
  markAuthenticated(request);
  return callers.forRequest(request);
}

let boardCookie: string;

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  prisma = app.get(PrismaService);
  registry = app.get(ActionRegistryService);
  callers = app.get(ActionCallerFactory);

  await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: { setupCompletedAt: new Date() },
  });

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Atgard${suffix}` },
      {
        id: resident.personId,
        firstName: "Rut",
        lastName: `Atgard${suffix}`,
        // The case rule 1 is about. Her name is withheld from the thread by the
        // service itself, which is what lets the action declare `name` without
        // declaring `protected`.
        protectedPersonalData: true,
      },
    ],
  });
  await prisma.boardPosition.create({
    data: {
      personId: board.personId,
      position: "BOARD_MEMBER",
      electedOn: new Date("2026-01-01"),
    },
  });
  await prisma.address.create({
    data: {
      id: addressId,
      street: `Atgardsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });
  await prisma.residency.create({
    data: {
      personId: resident.personId,
      apartmentId,
      role: "MEMBER",
      movedInOn: new Date("2020-01-01"),
    },
  });

  const auth = app.get(AuthService);
  await auth.createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: "Test Person",
    password: PASSWORD,
  });

  boardCookie = await signIn(board.email);
});

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      /*
       * The entries this suite wrote stay. The log is append-only and outlives
       * what it describes, and every other suite leaves its own for the same
       * reason. The facts row is the association's single row, so it is emptied
       * rather than deleted.
       */
      await prisma.newsComment.deleteMany({
        where: { authorPersonId: { in: personIds } },
      });
      await prisma.news.deleteMany({ where: { slug: `atgard-${suffix}` } });
      await prisma.residency.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.apartment.deleteMany({ where: { id: apartmentId } });
      await prisma.address.deleteMany({ where: { id: addressId } });
      await prisma.boardPosition.deleteMany({
        where: { personId: { in: personIds } },
      });
      await prisma.session.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.account.deleteMany({
        where: { user: { personId: { in: personIds } } },
      });
      await prisma.user.deleteMany({ where: { personId: { in: personIds } } });
      await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    }
  } finally {
    await app?.close();
  }
});

describe("the catalogue a real instance offers", () => {
  it("holds every action this slice registers", async () => {
    const response = await inject({
      method: "GET",
      url: "/api/actions?surface=mcp",
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(200);
    const names = (
      JSON.parse(response.body) as { actions: { name: string }[] }
    ).actions.map((action) => action.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "association_facts_get",
        "association_facts_update",
        "news_comment_list",
        "news_comment_hide",
        "motion_queue_list",
        "motion_acknowledge",
        "motion_set_meeting",
      ]),
    );
  });

  it("offers nothing that touches protected personal data beyond the instance", async () => {
    /*
     * Rule 1 read over the catalogue a connected app is actually handed, rather
     * than over the definitions. The registry refuses such an action at
     * registration, so an empty answer here is the proof that the refusal held
     * for every registrar the application loaded.
     */
    const response = await inject({
      method: "GET",
      url: "/api/actions?surface=mcp",
      headers: { cookie: boardCookie },
    });

    const offered = (
      JSON.parse(response.body) as {
        actions: { name: string; personalData: string[] }[];
      }
    ).actions;
    expect(offered.length).toBeGreaterThan(0);
    for (const action of offered) {
      expect(action.personalData, action.name).not.toContain("protected");
    }
  });
});

describe("what a facts write through an action records", () => {
  it("writes an entry carrying the channel the caller arrived on", async () => {
    const before = new Date();

    await registry.invoke(connectedApp(), "association_facts_update", {
      parking: `Tolv platser ${suffix}.`,
    });

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "ASSOCIATION_FACTS_RECORDED",
        actorPersonId: board.personId,
        createdAt: { gte: before },
      },
      select: {
        channel: true,
        targetKind: true,
        targetPersonId: true,
        context: true,
      },
    });

    // Not WEB, and not a default: the value comes from how the caller reached
    // the records, which is what makes it evidence.
    expect(entry.channel).toBe("MCP");
    expect(entry.targetKind).toBe("associationFacts");
    // The facts name nobody, so there is no subject to record.
    expect(entry.targetPersonId).toBeNull();
    expect(entry.context).toMatchObject({ fields: ["parking"] });
    // And never the text, because the log outlives what it describes.
    expect(JSON.stringify(entry.context)).not.toContain("Tolv platser");
  });

  it("names the connected app beside the person it acted as", async () => {
    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: {
        action: "ASSOCIATION_FACTS_RECORDED",
        actorPersonId: board.personId,
      },
      orderBy: [{ createdAt: "desc" }],
      select: { context: true },
    });

    expect(entry.context).toMatchObject({
      client: { id: `client-${suffix}`, host: "app.example" },
    });
  });
});

describe("what a comment read through an action carries", () => {
  it("withholds a protected author's name and says that it did", async () => {
    /*
     * The shape rule, over a real register. A model reading an empty name
     * concludes the association holds nothing; one reading a branch called
     * `protected` concludes the value is withheld, and the difference decides
     * whether it asks a person or decides there is nobody to ask about.
     */
    const news = await prisma.news.create({
      data: {
        slug: `atgard-${suffix}`,
        title: "Porten byts",
        content: { version: 1, blocks: [] },
        published: true,
        publishedAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.newsComment.create({
      data: {
        newsId: news.id,
        authorPersonId: resident.personId,
        body: "Tack for beskedet.",
      },
    });

    const page = (await registry.invoke(connectedApp(), "news_comment_list", {
      newsId: news.id,
    })) as { comments: { author: Record<string, unknown>; body: string }[] };

    expect(page.comments).toHaveLength(1);
    expect(page.comments[0]?.author).toEqual({
      kind: "protected",
      personId: resident.personId,
    });
    // The comment itself travels unchanged: what is withheld is the name.
    expect(page.comments[0]?.body).toBe("Tack for beskedet.");
  });
});

describe("what a caller may do the moment they may not", () => {
  it("refuses once the board position ends, with nothing else changed", async () => {
    /*
     * The capability is re-derived from the register on every call - no cache,
     * no snapshot, no claim carried on a token - so a board term ending narrows
     * what an already-connected app may do the same night it narrows the
     * person. The caller handle here is minted exactly as before.
     */
    await prisma.boardPosition.updateMany({
      where: { personId: board.personId },
      data: { endedOn: new Date("2026-06-01") },
    });

    await expect(
      registry.invoke(connectedApp(), "association_facts_get", {}),
    ).rejects.toMatchObject({ reason: "forbidden-capability" });
  });
});
