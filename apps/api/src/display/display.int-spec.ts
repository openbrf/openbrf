import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { ScreenContent } from "@openbrf/display";
import { dateColumnOf, localDayOf } from "@openbrf/shared";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuthService } from "../auth/auth.service";
import { createApplication, loadPluginsAtBoot } from "../bootstrap";
import type { Env } from "../config/env";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runPhone,
  runSuffix,
} from "../testing/integration-env";

/**
 * The display mode's personal-data acceptance test (ADR 0050, "What is
 * tested"), against the core's display route through the HTTP stack and a
 * real database.
 *
 * The test the board accepted for the signage module, run against the core's
 * route: with a resident in the register whose name, email address, phone
 * number and apartment number appear in news items and events marked "show on
 * screens", in a meeting agenda and in the name of a bookable resource, the
 * display route's content holds no name, no apartment number, no other field
 * taken from the register, and no busy interval that ended before the fetch.
 * Beside each withheld item a clean one is marked too, so the suite fails on
 * a route that shows nothing as well as on one that shows too much.
 *
 * The register check reads the whole register and other suites share the
 * database, so every name and word here is this run's own, written in
 * letters, and a text expected to be shown holds no digit another suite's
 * apartment could number.
 */

const baseEnv = loadEnvForIntegrationTests();
const suffix = runSuffix();
/** The suffix in letters, so that it stays inside one word. */
const tag = suffix.replace(/\d/g, (digit) => "abcdefghij"[Number(digit)] ?? "");
const PASSWORD = "integration-password-1";

const board = {
  personId: `display-board-${suffix}`,
  email: `display-board-${suffix}@exempel.se`,
};

const RESIDENT = {
  id: `display-resident-${suffix}`,
  givenName: `Yrsa${tag}`,
  familyName: `Zorvik${tag}`,
  email: `yrsa.${tag}@example.se`,
  phone: runPhone(`display-${suffix}`),
};
/** Up to seven digits from the suffix, as an apartment number. */
const APARTMENT_NUMBER = String(
  Number.parseInt(suffix.slice(-6), 36) % 10_000_000,
);

const ids = {
  address: `display-address-${suffix}`,
  apartment: `display-apartment-${suffix}`,
  cleanNews: `display-news-clean-${suffix}`,
  unmarkedNews: `display-news-unmarked-${suffix}`,
  nameNews: `display-news-name-${suffix}`,
  emailNews: `display-news-email-${suffix}`,
  phoneNews: `display-news-phone-${suffix}`,
  apartmentNews: `display-news-apartment-${suffix}`,
  cleanEvent: `display-event-clean-${suffix}`,
  nameEvent: `display-event-name-${suffix}`,
  meeting: `display-meeting-${suffix}`,
  cleanRoom: `display-room-clean-${suffix}`,
  nameRoom: `display-room-name-${suffix}`,
};

const CLEAN = {
  news: `Vårstädning ${tag}`,
  unmarked: `Omärkt ${tag}`,
  event: `Grillkväll ${tag}`,
  room: `Tvättstuga ${tag}`,
};

const HOUR = 60 * 60 * 1000;

let app: NestFastifyApplication | undefined;
let prisma: PrismaService;
let boardCookie = "";
let token = "";

function application(): NestFastifyApplication {
  if (app === undefined) {
    throw new Error("The application was not started.");
  }
  return app;
}

let ipCounter = 0;
function inject(options: {
  method: "GET" | "POST";
  url: string;
  payload?: object;
  headers?: Record<string, string>;
}) {
  ipCounter += 1;
  return application()
    .getHttpAdapter()
    .getInstance()
    .inject({
      ...options,
      headers: {
        // 10.133.0.0/16 is this suite's.
        "x-forwarded-for": `10.133.0.${String((ipCounter % 254) + 1)}`,
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

const body = (text: string) => ({
  version: 1,
  blocks: [{ type: "paragraph", runs: [{ text }] }],
});

beforeAll(async () => {
  const env: Env = { ...baseEnv, OPENBRF_PLUGINS_ENABLED: false };
  const started = await createApplication(await loadPluginsAtBoot(env));
  app = started;
  await started.init();
  await started.getHttpAdapter().getInstance().ready();
  prisma = started.get(PrismaService);
  const encryption = started.get(FieldEncryptionService);

  const existing = await prisma.association.findUnique({ where: { id: 1 } });
  if (existing === null) {
    await prisma.association.create({
      data: { id: 1, name: "Brf Eksemplet", setupCompletedAt: new Date() },
    });
  }
  await prisma.person.create({
    // A name no text below uses: the register check reads the board member's
    // name too, and would withhold every item that used it.
    data: { id: board.personId, firstName: "Styrelse", lastName: "Ordförande" },
  });
  // The administrator holds site:manage, which issuing a display link needs.
  await prisma.systemRole.create({
    data: { personId: board.personId, role: "ADMIN" },
  });
  await started.get(AuthService).createAccountForPerson({
    personId: board.personId,
    email: board.email,
    name: "Styrelse",
    password: PASSWORD,
  });
  boardCookie = await signIn(board.email);

  const email = await encryption.encrypt("person.email", RESIDENT.email);
  const phone = await encryption.encrypt("person.phone", RESIDENT.phone);
  await prisma.person.create({
    data: {
      id: RESIDENT.id,
      firstName: RESIDENT.givenName,
      lastName: RESIDENT.familyName,
      emailCipher: email.cipher,
      emailIndex: email.index,
      phoneCipher: phone.cipher,
      phoneIndex: phone.index,
    },
  });
  await prisma.address.create({
    data: {
      id: ids.address,
      street: `Visningsgatan ${tag}`,
      number: "1",
      postalCode: "12345",
      city: "Staden",
    },
  });
  await prisma.apartment.create({
    data: {
      id: ids.apartment,
      addressId: ids.address,
      number: APARTMENT_NUMBER,
    },
  });

  const now = Date.now();
  const national = `0${RESIDENT.phone.slice(3)}`;
  const news = [
    [ids.cleanNews, CLEAN.news, "Ta med krattor.", true],
    [ids.unmarkedNews, CLEAN.unmarked, "Inte för skärmar.", false],
    [ids.nameNews, `Tack ${tag}`, `Tack till ${RESIDENT.familyName}.`, true],
    [ids.emailNews, `Frågor ${tag}`, `Mejla ${RESIDENT.email}.`, true],
    [ids.phoneNews, `Ring ${tag}`, `Ring ${national}.`, true],
    [
      ids.apartmentNews,
      `Nyckeln ${tag}`,
      `Hämtas i lgh ${APARTMENT_NUMBER}.`,
      true,
    ],
  ] as const;
  for (const [index, [id, title, text, onScreens]] of news.entries()) {
    await prisma.news.create({
      data: {
        id,
        slug: id,
        title,
        content: body(text),
        visibility: "MEMBER",
        published: true,
        // The newest of the instance, so that the ten the display mode shows
        // are this run's, whatever else is published.
        publishedAt: new Date(now + HOUR + index * 1000),
        onScreens,
      },
    });
  }

  const event = (id: string, title: string, description: string) =>
    prisma.event.create({
      data: {
        id,
        title,
        description,
        location: "Gården",
        visibility: "MEMBER",
        published: true,
        publishedAt: new Date(now),
        onScreens: true,
        authorPersonId: board.personId,
        firstOn: dateColumnOf(localDayOf(new Date(now + 24 * HOUR))),
        startsAtMinute: 1080,
        durationMinutes: 120,
        occurrences: {
          create: [
            {
              startsAt: new Date(now + 24 * HOUR),
              endsAt: new Date(now + 26 * HOUR),
            },
          ],
        },
      },
    });
  await event(ids.cleanEvent, CLEAN.event, "Alla är välkomna.");
  await event(
    ids.nameEvent,
    `Avtackning ${tag}`,
    `Vi tackar ${RESIDENT.givenName} för åren i styrelsen.`,
  );

  const heldOn = new Date(now + 10 * 24 * HOUR);
  await prisma.meeting.create({
    data: {
      id: ids.meeting,
      kind: "ORDINARY",
      heldOn: dateColumnOf(localDayOf(heldOn)),
      agendaItems: {
        create: [
          { position: 1, title: "Stämmans öppnande" },
          {
            position: 2,
            title: `Ansvarsfrihet för ${RESIDENT.givenName} ${RESIDENT.familyName}`,
          },
        ],
      },
      notice: {
        create: {
          startsAt: heldOn,
          place: "Föreningslokalen",
          issuedByPersonId: board.personId,
        },
      },
    },
  });

  await prisma.bookableResource.createMany({
    data: [
      {
        id: ids.cleanRoom,
        name: CLEAN.room,
        mode: "TIME_SLOTS",
        slotMinutes: 60,
        opensAtMinute: 0,
        closesAtMinute: 1440,
      },
      {
        id: ids.nameRoom,
        name: `Förråd ${RESIDENT.familyName}`,
        mode: "WHOLE_DAY",
      },
    ],
  });
  await prisma.booking.createMany({
    data: [
      // Ended before the fetch: in no answer.
      [now - 3 * HOUR, now - 2 * HOUR],
      // Under way: taken from the minute of the fetch.
      [now - HOUR, now + HOUR],
      // Ahead.
      [now + 3 * HOUR, now + 4 * HOUR],
    ].map(([start, end]) => ({
      resourceId: ids.cleanRoom,
      bookedByPersonId: RESIDENT.id,
      startsAt: new Date(start ?? now),
      endsAt: new Date(end ?? now),
      status: "BOOKED" as const,
    })),
  });

  const issued = await inject({
    method: "POST",
    url: "/api/display-links",
    headers: { cookie: boardCookie, origin: new URL(baseEnv.APP_URL).origin },
    payload: { label: "Entrance B, ground floor" },
  });
  expect(issued.statusCode).toBe(201);
  token = issued.json<{ token: string }>().token;
}, 180_000);

afterAll(async () => {
  if (app === undefined) {
    return;
  }
  try {
    await prisma.pluginDeviceToken.deleteMany({
      where: { issuedByPersonId: board.personId },
    });
    await prisma.booking.deleteMany({
      where: { bookedByPersonId: RESIDENT.id },
    });
    await prisma.bookableResource.deleteMany({
      where: { id: { in: [ids.cleanRoom, ids.nameRoom] } },
    });
    await prisma.meetingNotice.deleteMany({
      where: { meetingId: ids.meeting },
    });
    await prisma.agendaItem.deleteMany({ where: { meetingId: ids.meeting } });
    await prisma.meeting.deleteMany({ where: { id: ids.meeting } });
    await prisma.event.deleteMany({
      where: { id: { in: [ids.cleanEvent, ids.nameEvent] } },
    });
    await prisma.news.deleteMany({
      where: {
        id: {
          in: [
            ids.cleanNews,
            ids.unmarkedNews,
            ids.nameNews,
            ids.emailNews,
            ids.phoneNews,
            ids.apartmentNews,
          ],
        },
      },
    });
    await prisma.apartment.deleteMany({ where: { id: ids.apartment } });
    await prisma.address.deleteMany({ where: { id: ids.address } });
    await prisma.systemRole.deleteMany({ where: { personId: board.personId } });
    await prisma.user.deleteMany({ where: { personId: board.personId } });
    await prisma.person.deleteMany({
      where: { id: { in: [board.personId, RESIDENT.id] } },
    });
  } finally {
    await app.close();
  }
});

async function content(query = ""): Promise<{
  raw: string;
  document: ScreenContent;
}> {
  const response = await inject({
    method: "GET",
    url: `/api/display/content${query}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(response.statusCode).toBe(200);
  return { raw: response.body, document: response.json<ScreenContent>() };
}

describe("the display mode carries no personal data", () => {
  it("holds no name, contact detail or apartment number from the register", async () => {
    const { raw } = await content(
      `?resources=${ids.nameRoom},${ids.cleanRoom}`,
    );
    const national = `0${RESIDENT.phone.slice(3)}`;

    for (const word of [
      RESIDENT.givenName,
      RESIDENT.familyName,
      RESIDENT.email,
      RESIDENT.phone,
      national,
      `lgh ${APARTMENT_NUMBER}`,
    ]) {
      expect(raw.toLowerCase()).not.toContain(word.toLowerCase());
    }
    // Nor anybody's id: the booker's, the board member's or the resident's.
    expect(raw).not.toContain(RESIDENT.id);
    expect(raw).not.toContain(board.personId);
  });

  it("shows the marked items that name nobody, and only marked ones", async () => {
    const { document } = await content(
      `?resources=${ids.nameRoom},${ids.cleanRoom}`,
    );
    const news = document.rotation.flatMap((slide) =>
      slide.body.kind === "news" ? [slide.body.title] : [],
    );
    const occurrences = document.rotation.flatMap((slide) =>
      slide.body.kind === "events"
        ? slide.body.occurrences.map((occurrence) => occurrence.title)
        : [],
    );
    const rooms = document.rotation.flatMap((slide) =>
      slide.body.kind === "availability"
        ? slide.body.resources.map((resource) => resource.name)
        : [],
    );

    expect(news).toContain(CLEAN.news);
    expect(news).not.toContain(CLEAN.unmarked);
    expect(news.filter((title) => title.endsWith(tag))).toEqual([CLEAN.news]);
    expect(occurrences).toContain(CLEAN.event);
    expect(occurrences.filter((title) => title.endsWith(tag))).toEqual([
      CLEAN.event,
    ]);
    expect(rooms).toEqual([CLEAN.room]);
    expect(document.rotation.some((slide) => slide.source === "picture")).toBe(
      false,
    );
    expect(document.rotation.some((slide) => slide.source === "addon")).toBe(
      false,
    );
  });

  it("holds no busy interval that ended before the fetch", async () => {
    const { document } = await content(`?resources=${ids.cleanRoom}`);
    const availability = document.rotation.find(
      (slide) => slide.body.kind === "availability",
    )?.body;
    if (availability?.kind !== "availability") {
      throw new Error("The rotation has no availability slide.");
    }
    const fetchedAt = Date.parse(document.generatedAt);
    const busy = availability.resources[0]?.busy ?? [];

    expect(busy).toHaveLength(2);
    for (const interval of busy) {
      expect(Date.parse(interval.end)).toBeGreaterThan(fetchedAt);
      expect(Date.parse(interval.start)).toBeGreaterThanOrEqual(
        Date.parse(availability.from),
      );
    }
    // The one under way is taken from the fetch, not from when it began.
    expect(Date.parse(busy[0]?.start ?? "")).toBeLessThanOrEqual(fetchedAt);
  });
});

describe("the document", () => {
  it("names the token as the screen and shows the rotation all day", async () => {
    const { document } = await content(
      "?theme=light&orientation=90&header=none",
    );
    const row = await prisma.pluginDeviceToken.findFirstOrThrow({
      where: { issuedByPersonId: board.personId },
    });

    expect(document).toMatchObject({
      version: 1,
      screenId: row.id,
      refreshSeconds: 60,
      releaseChannel: "stable",
      timeZone: "Europe/Stockholm",
      layout: { orientation: 90, header: "none", theme: "light" },
      schedule: { on: [] },
    });
  });

  it("leaves out the sources the link does not ask for", async () => {
    const { document } = await content("?sources=availability");

    expect(
      document.rotation.every((slide) => slide.source === "availability"),
    ).toBe(true);
  });

  it("answers 304 to the tag it gave, and refuses an option it does not know", async () => {
    const first = await inject({
      method: "GET",
      url: "/api/display/content?sources=news",
      headers: { authorization: `Bearer ${token}` },
    });
    const etag = first.headers.etag;
    expect(typeof etag).toBe("string");

    const again = await inject({
      method: "GET",
      url: "/api/display/content?sources=news",
      headers: {
        authorization: `Bearer ${token}`,
        "if-none-match": String(etag),
      },
    });
    expect(again.statusCode).toBe(304);

    const refused = await inject({
      method: "GET",
      url: "/api/display/content?theme=sepia",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({
      reason: "display-options-invalid",
      options: ["theme"],
    });
    expect(refused.headers["access-control-allow-origin"]).toBe("*");
  });
});
