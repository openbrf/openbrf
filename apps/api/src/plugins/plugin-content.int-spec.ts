import { dateColumnOf, localDayOf } from "@openbrf/shared";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AuditLogService } from "../audit/audit-log.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import { derivedAudience } from "../feed/feed-audience";
import { MediaService } from "../media/media.service";
import { pngBytes } from "../media/testing/image-fixtures";
import { RegisterCheckService } from "../register-check/register-check.service";
import { StorageService } from "../storage/storage.service";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PluginAddressesService } from "./plugin-addresses.service";
import { PluginBookingsService } from "./plugin-bookings.service";
import { PluginCalendarService } from "./plugin-calendar.service";
import { PluginMediaService } from "./plugin-media.service";
import { PluginNewsService } from "./plugin-news.service";

/**
 * The content a plugin may read (ADR 0032), against a real database.
 *
 * The unit tests hold the shapes and the selects. This suite holds that the
 * queries mean what they say on PostgreSQL: which items are published, which
 * occurrences fall in a window, which meetings are still to come on the
 * association's own calendar day, which bookings are live and which stored
 * pictures a plugin may open - and that a person who booked, signed up or wrote
 * something, or lives at an address, is in none of the answers, and an item the
 * board wrote to Styrelsen or Administratörer in none either.
 *
 * The fixtures sit years ahead, where nothing else in the database is, and
 * every answer is narrowed to this run's own rows before it is compared.
 */

const env = loadEnvForIntegrationTests();

let prisma: PrismaService;
let news: PluginNewsService;
let calendar: PluginCalendarService;
let bookings: PluginBookingsService;
let media: MediaService;
let pictures: PluginMediaService;
let addresses: PluginAddressesService;
/** Where this run's pictures are stored, removed with them. */
let dataDir: string | undefined;
/** The pictures this run stored, by what each is. */
const files: Record<
  "open" | "ofPeople" | "members" | "internal",
  string | undefined
> = {
  open: undefined,
  ofPeople: undefined,
  members: undefined,
  internal: undefined,
};

const suffix = runSuffix();
/** A plugin with no device route. */
const OPEN = { forDevices: false };
/** The person behind every booking, sign-up and item here, named in no answer. */
const BOOKER_ID = `content-booker-${suffix}`;

const ids = {
  publicNews: `content-news-public-${suffix}`,
  memberNews: `content-news-member-${suffix}`,
  draftNews: `content-news-draft-${suffix}`,
  allPostNews: `content-news-all-post-${suffix}`,
  boardPostNews: `content-news-board-post-${suffix}`,
  adminPostNews: `content-news-admin-post-${suffix}`,
  publicEvent: `content-event-public-${suffix}`,
  draftEvent: `content-event-draft-${suffix}`,
  laundry: `content-laundry-${suffix}`,
  withdrawnRoom: `content-withdrawn-${suffix}`,
  calledMeeting: `content-meeting-called-${suffix}`,
  heldMeeting: `content-meeting-held-${suffix}`,
  pastMeeting: `content-meeting-past-${suffix}`,
  firstAddress: `content-address-1-${suffix}`,
  secondAddress: `content-address-2-${suffix}`,
  apartment: `content-apartment-${suffix}`,
};

const YEAR = new Date().getUTCFullYear() + 5;
const at = (month: number, day: number, time: string): Date =>
  new Date(
    `${String(YEAR)}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T${time}:00Z`,
  );

function ours<T>(items: readonly T[], id: (item: T) => string): T[] {
  return items.filter((item) => id(item).endsWith(suffix));
}

beforeAll(async () => {
  prisma = new PrismaService(env);
  await prisma.$connect();
  // Every read here is a plugin's with no device route; the register check
  // has its own suite (register-check.int-spec.ts).
  const registerCheck = new RegisterCheckService(
    prisma,
    new FieldEncryptionService(env),
  );
  news = new PluginNewsService(prisma, registerCheck);
  calendar = new PluginCalendarService(prisma, registerCheck);
  bookings = new PluginBookingsService(prisma, registerCheck);
  addresses = new PluginAddressesService(prisma);
  dataDir = await mkdtemp(join(tmpdir(), "plugin-content-"));
  media = new MediaService(
    prisma,
    new StorageService({
      ...env,
      OPENBRF_STORAGE_DRIVER: "local",
      OPENBRF_DATA_DIR: dataDir,
    }),
    new AuditLogService(prisma),
    new FieldEncryptionService(env),
  );
  pictures = new PluginMediaService(media);

  const picture = async (
    visibility: "PUBLIC" | "MEMBER" | "INTERNAL",
    showsIdentifiablePersons: boolean,
  ) =>
    (
      await media.upload({
        bytes: pngBytes(4, 3),
        fileName: "Anna på gården.png",
        visibility,
        requiredCapability:
          visibility === "INTERNAL" ? "documents:manage" : undefined,
        showsIdentifiablePersons,
        uploadedByPersonId: BOOKER_ID,
        channel: "SYSTEM",
      })
    ).id;
  files.open = await picture("PUBLIC", false);
  files.ofPeople = await picture("PUBLIC", true);
  files.members = await picture("MEMBER", false);
  files.internal = await picture("INTERNAL", false);

  // The second sorts first, as the board arranged the house tabs.
  await prisma.address.createMany({
    data: [
      {
        id: ids.firstAddress,
        street: `Storgatan ${suffix}`,
        number: "12",
        postalCode: "111 22",
        city: "Stockholm",
        sortOrder: 2,
      },
      {
        id: ids.secondAddress,
        street: `Storgatan ${suffix}`,
        number: "12 B",
        postalCode: "111 22",
        city: "Stockholm",
        sortOrder: 1,
      },
    ],
  });
  await prisma.apartment.create({
    data: { id: ids.apartment, addressId: ids.firstAddress, number: "1101" },
  });

  const body = {
    version: 1,
    blocks: [{ type: "paragraph", runs: [{ text: "Välkomna!" }] }],
  };
  await prisma.news.createMany({
    data: [
      {
        id: ids.publicNews,
        slug: ids.publicNews,
        title: "Till alla",
        content: body,
        visibility: "PUBLIC",
        published: true,
        publishedAt: at(3, 2, "08:00"),
        authorPersonId: BOOKER_ID,
      },
      {
        id: ids.memberNews,
        slug: ids.memberNews,
        title: "Till medlemmarna",
        content: body,
        visibility: "MEMBER",
        published: true,
        publishedAt: at(3, 3, "08:00"),
        authorPersonId: BOOKER_ID,
      },
      {
        id: ids.draftNews,
        slug: ids.draftNews,
        title: "Utkast",
        content: body,
        visibility: "PUBLIC",
        published: false,
        authorPersonId: BOOKER_ID,
      },
    ],
  });
  /*
   * Posts the board wrote as Styrelsen, each a published news item. The one to
   * Alla is the house's; the ones to Styrelsen and Administratörer carry an
   * audience each, so that either audience asked for would find one of them
   * were the audience on the post not asked about.
   */
  for (const [id, kind, visibility, day] of [
    [ids.allPostNews, "ALL", "MEMBER", 4],
    [ids.boardPostNews, "BOARD", "MEMBER", 5],
    [ids.adminPostNews, "ADMIN", "PUBLIC", 6],
  ] as const) {
    const audience = await derivedAudience(prisma, kind);
    await prisma.news.create({
      data: {
        id,
        slug: id,
        title: `Från styrelsen ${kind}`,
        content: body,
        visibility,
        published: true,
        publishedAt: at(3, day, "08:00"),
        authorPersonId: BOOKER_ID,
        post: {
          create: {
            audienceId: audience.id,
            authorPersonId: BOOKER_ID,
            byBoard: true,
          },
        },
      },
    });
  }

  const event = {
    category: null,
    location: "Gården",
    description: null,
    authorPersonId: BOOKER_ID,
    firstOn: dateColumnOf(localDayOf(at(4, 10, "08:00"))),
    startsAtMinute: 540,
    durationMinutes: 120,
  };
  await prisma.event.create({
    data: {
      ...event,
      id: ids.publicEvent,
      title: "Städdag",
      visibility: "PUBLIC",
      published: true,
      publishedAt: at(3, 1, "08:00"),
      signupOpen: true,
      capacity: 10,
      occurrences: {
        create: [
          {
            id: `content-occurrence-1-${suffix}`,
            startsAt: at(4, 10, "08:00"),
            endsAt: at(4, 10, "10:00"),
            signups: {
              create: [
                { personId: BOOKER_ID },
                { personId: `${BOOKER_ID}-2`, withdrawnAt: new Date() },
              ],
            },
          },
          {
            id: `content-occurrence-2-${suffix}`,
            startsAt: at(4, 17, "08:00"),
            endsAt: at(4, 17, "10:00"),
            cancelledAt: new Date(),
          },
          // Outside the window asked for below.
          {
            id: `content-occurrence-3-${suffix}`,
            startsAt: at(6, 1, "08:00"),
            endsAt: at(6, 1, "10:00"),
          },
        ],
      },
    },
  });
  await prisma.event.create({
    data: {
      ...event,
      id: ids.draftEvent,
      title: "Utkast",
      visibility: "PUBLIC",
      published: false,
      occurrences: {
        create: [
          {
            id: `content-occurrence-draft-${suffix}`,
            startsAt: at(4, 11, "08:00"),
            endsAt: at(4, 11, "10:00"),
          },
        ],
      },
    },
  });

  await prisma.bookableResource.createMany({
    data: [
      {
        id: ids.laundry,
        name: `Tvättstuga ${suffix}`,
        mode: "TIME_SLOTS",
        slotMinutes: 120,
        opensAtMinute: 420,
        closesAtMinute: 1260,
      },
      {
        id: ids.withdrawnRoom,
        name: `Bastu ${suffix}`,
        mode: "WHOLE_DAY",
        deactivatedAt: new Date(),
      },
    ],
  });
  await prisma.booking.createMany({
    data: [
      // Two households, back to back: one interval to a plugin.
      ["07:00", "09:00", "BOOKED", ids.laundry],
      ["09:00", "11:00", "BOOKED", ids.laundry],
      ["13:00", "15:00", "CANCELLED", ids.laundry],
      ["13:00", "15:00", "BOOKED", ids.withdrawnRoom],
    ].map(([from, to, status, resourceId]) => ({
      resourceId: resourceId as string,
      bookedByPersonId: BOOKER_ID,
      startsAt: at(5, 4, from as string),
      endsAt: at(5, 4, to as string),
      status: status as "BOOKED" | "CANCELLED",
    })),
  });

  const meeting = (id: string, heldOn: Date, concludedAt: Date | null) =>
    prisma.meeting.create({
      data: {
        id,
        kind: "ORDINARY",
        heldOn: dateColumnOf(localDayOf(heldOn)),
        concludedAt,
        agendaItems: {
          create: [
            { position: 2, title: "Val av ordförande" },
            { position: 1, title: "Stämmans öppnande" },
          ],
        },
        notice: {
          create: {
            startsAt: heldOn,
            place: "Föreningslokalen",
            issuedByPersonId: BOOKER_ID,
          },
        },
      },
    });
  await meeting(ids.calledMeeting, at(5, 20, "17:00"), null);
  await meeting(ids.heldMeeting, at(5, 21, "17:00"), new Date());
  // Never recorded as held, and its day has passed.
  await meeting(ids.pastMeeting, new Date(Date.now() - 86_400_000 * 3), null);
});

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  const meetingIds = [ids.calledMeeting, ids.heldMeeting, ids.pastMeeting];
  await prisma.meetingNotice.deleteMany({
    where: { meetingId: { in: meetingIds } },
  });
  await prisma.agendaItem.deleteMany({
    where: { meetingId: { in: meetingIds } },
  });
  await prisma.meeting.deleteMany({ where: { id: { in: meetingIds } } });
  await prisma.booking.deleteMany({ where: { bookedByPersonId: BOOKER_ID } });
  await prisma.bookableResource.deleteMany({
    where: { id: { in: [ids.laundry, ids.withdrawnRoom] } },
  });
  await prisma.event.deleteMany({
    where: { id: { in: [ids.publicEvent, ids.draftEvent] } },
  });
  await prisma.news.deleteMany({
    where: {
      id: {
        in: [
          ids.publicNews,
          ids.memberNews,
          ids.draftNews,
          ids.allPostNews,
          ids.boardPostNews,
          ids.adminPostNews,
        ],
      },
    },
  });
  await prisma.apartment.deleteMany({ where: { id: ids.apartment } });
  await prisma.address.deleteMany({
    where: { id: { in: [ids.firstAddress, ids.secondAddress] } },
  });
  for (const id of Object.values(files)) {
    if (id !== undefined) {
      await media.remove(id, null, "SYSTEM");
    }
  }
  if (dataDir !== undefined) {
    await rm(dataDir, { recursive: true, force: true });
  }
  await prisma.$disconnect();
});

describe("news:read", () => {
  it("reads the published items of both audiences, newest first, and no draft", async () => {
    const items = ours(
      await news.published({ since: at(1, 1, "00:00").toISOString() }, OPEN),
      (item) => item.id,
    );

    expect(items.map((item) => [item.id, item.audience])).toEqual([
      [ids.allPostNews, "members"],
      [ids.memberNews, "members"],
      [ids.publicNews, "anyone"],
    ]);
    expect(items[0]?.paragraphs).toEqual(["Välkomna!"]);
    expect(JSON.stringify(items)).not.toContain(BOOKER_ID);
  });

  it("reads one audience when asked", async () => {
    const items = ours(
      await news.published(
        {
          since: at(1, 1, "00:00").toISOString(),
          audience: "anyone",
        },
        OPEN,
      ),
      (item) => item.id,
    );

    expect(items.map((item) => item.id)).toEqual([ids.publicNews]);
  });

  it.each([
    ["unasked", {}],
    ["since a date", { since: at(1, 1, "00:00").toISOString() }],
    ["for the members", { audience: "members" }],
    ["for anyone", { audience: "anyone" }],
    [
      "for the members since a date",
      { audience: "members", since: at(1, 1, "00:00").toISOString() },
    ],
  ] as const)(
    "reads no item the board wrote to Styrelsen or Administratörer, %s",
    async (_how, options) => {
      const read = ours(
        await news.published(options, OPEN),
        (item) => item.id,
      ).map((item) => item.id);

      // The read found this run's items for the house, so it reached the rows.
      expect(read.length).toBeGreaterThan(0);
      expect(read).not.toContain(ids.boardPostNews);
      expect(read).not.toContain(ids.adminPostNews);
    },
  );

  it("reads the item the board wrote to Alla, as the house's", async () => {
    const items = ours(await news.published({}, OPEN), (item) => item.id);

    expect(items.find((item) => item.id === ids.allPostNews)).toMatchObject({
      title: "Från styrelsen ALL",
      audience: "members",
    });
  });
});

describe("calendar:read", () => {
  it("reads the published occurrences in the window, called-off ones included", async () => {
    const occurrences = ours(
      await calendar.occurrences(
        {
          from: at(4, 1, "00:00").toISOString(),
          to: at(5, 1, "00:00").toISOString(),
        },
        OPEN,
      ),
      (occurrence) => occurrence.eventId,
    );

    expect(
      occurrences.map((occurrence) => [
        occurrence.occurrenceId,
        occurrence.calledOff,
        occurrence.placesLeft,
      ]),
    ).toEqual([
      // One standing sign-up of ten places; the withdrawn one is not counted.
      [`content-occurrence-1-${suffix}`, false, 9],
      [`content-occurrence-2-${suffix}`, true, 10],
    ]);
    expect(JSON.stringify(occurrences)).not.toContain(BOOKER_ID);
  });

  it("reads the notice of a meeting called and not yet held, and of no other", async () => {
    const notices = ours(
      await calendar.meetingNotices(OPEN),
      (notice) => notice.meetingId,
    );

    expect(notices).toEqual([
      {
        meetingId: ids.calledMeeting,
        kind: "ordinary",
        startsAt: at(5, 20, "17:00").toISOString(),
        place: "Föreningslokalen",
        digitalParticipation: null,
        agenda: [
          { position: 1, title: "Stämmans öppnande" },
          { position: 2, title: "Val av ordförande" },
        ],
      },
    ]);
  });
});

describe("bookings:readAvailability", () => {
  it("lists the offered resources and not a withdrawn one", async () => {
    const resources = ours(
      await bookings.resources(OPEN),
      (resource) => resource.id,
    );

    expect(resources).toEqual([
      {
        id: ids.laundry,
        name: `Tvättstuga ${suffix}`,
        mode: "timeSlots",
        slotMinutes: 120,
        opensAtMinute: 420,
        closesAtMinute: 1260,
      },
    ]);
  });

  it("reads when a resource is taken as merged intervals, and never by whom", async () => {
    const busy = await bookings.busy(
      {
        from: at(5, 4, "00:00").toISOString(),
        to: at(5, 5, "00:00").toISOString(),
        resourceIds: [ids.laundry, ids.withdrawnRoom],
      },
      OPEN,
    );

    // The cancelled booking gave its slot back, and the withdrawn room is not
    // offered.
    expect(busy).toEqual([
      {
        resourceId: ids.laundry,
        start: at(5, 4, "07:00").toISOString(),
        end: at(5, 4, "11:00").toISOString(),
      },
    ]);
    expect(JSON.stringify(busy)).not.toContain(BOOKER_ID);
  });
});

describe("media:read", () => {
  async function bytesOf(stream: unknown): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  it.each([
    ["open", "anyone"],
    ["members", "members"],
  ] as const)(
    "opens a picture declared to show nobody recognisable (%s), decrypted from storage, with its audience",
    async (which, audience) => {
      const opened = await pictures.open(files[which] as string);

      expect(opened).toMatchObject({ contentType: "image/png", audience });
      expect(opened?.byteSize).toBe(pngBytes(4, 3).length);
      expect(await bytesOf(opened?.stream)).toEqual(pngBytes(4, 3));
    },
  );

  it("answers a picture of people, the board's file and a missing one alike: null", async () => {
    await expect(pictures.open(files.ofPeople as string)).resolves.toBeNull();
    await expect(pictures.open(files.internal as string)).resolves.toBeNull();
    await expect(
      pictures.open(`content-missing-${suffix}`),
    ).resolves.toBeNull();
  });

  it("writes no access to the audit log", async () => {
    await pictures.open(files.open as string);

    const accessed = await prisma.auditLogEntry.count({
      where: { action: "MEDIA_ACCESSED", targetId: files.open as string },
    });
    expect(accessed).toBe(0);
  });
});

describe("addresses:read", () => {
  it("lists the addresses in the house tabs' order, and nobody at them", async () => {
    const listed = ours(await addresses.list(), (address) => address.id);

    expect(listed).toEqual([
      { id: ids.secondAddress, street: `Storgatan ${suffix}`, number: "12 B" },
      { id: ids.firstAddress, street: `Storgatan ${suffix}`, number: "12" },
    ]);
    expect(JSON.stringify(listed)).not.toContain("1101");
  });
});
