import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type { PluginProcessing } from "@openbrf/plugin-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import { DataSubjectRequestError } from "../data-protection/data-subject-request.error";
import { DataSubjectRequestService } from "../data-protection/data-subject-request.service";
import { ProcessingActivityService } from "../data-protection/processing-activity.service";
import { pluginProcessorKey } from "../data-protection/processor-key";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PluginAddressBookService } from "./plugin-address-book.service";

/**
 * A plugin's processing, and objecting to it (ADR 0035), against a real
 * database.
 *
 * The objection is carried out by a query - the host leaves out every person
 * with a granted, open objection naming the reading plugin's row in the record
 * of processing activities - so what is asserted is what the address book
 * returns after the board grants and closes one, not that the service asks.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let requests: DataSubjectRequestService;
let processing: ProcessingActivityService;
let addressBook: PluginAddressBookService;

const suffix = runSuffix();

/** Two plugins, so an objection to one can be seen not to reach the other. */
const signage = `signage-${suffix}`;
const other = `occupancy-${suffix}`;
/** A plugin that handles nobody's personal data. */
const weather = `weather-${suffix}`;
/** A plugin published before the declaration existed. */
const legacy = `legacy-${suffix}`;

const addresses = {
  north: `pp-address-north-${suffix}`,
  south: `pp-address-south-${suffix}`,
};
const apartments = {
  north: `pp-apartment-north-${suffix}`,
  south: `pp-apartment-south-${suffix}`,
};
const persons = {
  board: `pp-board-${suffix}`,
  objector: `pp-objector-${suffix}`,
  neighbour: `pp-neighbour-${suffix}`,
  southerner: `pp-southerner-${suffix}`,
};
const personIds = Object.values(persons);

const PROCESSING: PluginProcessing = {
  purpose: {
    sv: "Visa vilket hushåll som bor bakom vilken dörr.",
    en: "Show which household lives behind which door.",
  },
  legalBasis: "legitimateInterest",
  legitimateInterest: {
    sv: "Att hitta rätt dörr.",
    en: "Finding the right door.",
  },
  retention: {
    sv: "Så länge boendet varar.",
    en: "For as long as the residency lasts.",
  },
  dataSubjects: ["residents"],
};

const LONG_AGO = new Date("2020-01-01T00:00:00.000Z");
const requestedOn = new Date(
  `${new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)}T00:00:00.000Z`,
);

let originalLocale: string;
const createdBoardRows: string[] = [];

async function activityId(pluginId: string): Promise<string> {
  const row = await prisma.processingActivity.findUniqueOrThrow({
    where: { sourceKey: pluginProcessorKey(pluginId) },
    select: { id: true },
  });
  return row.id;
}

async function residentIds(
  pluginId: string,
  filter?: { addressId?: string },
): Promise<string[]> {
  const rows = await addressBook.residents(pluginId, {
    contact: false,
    filter,
  });
  return rows
    .map((row) => row.personId)
    .filter((id) => personIds.includes(id))
    .sort();
}

async function objectTo(
  personId: string,
  pluginId: string | null,
): Promise<string> {
  const recorded = await requests.record({
    personId,
    kind: "OBJECTION",
    requestedOn,
    ground: "Vill inte stå på skärmen.",
    processingActivityId: pluginId === null ? null : await activityId(pluginId),
    actorPersonId: persons.board,
  });
  await requests.decide(recorded.requestId, {
    decision: "GRANTED",
    ground: "Inga tvingande skäl väger tyngre.",
    actorPersonId: persons.board,
  });
  return recorded.requestId;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();

  prisma = app.get(PrismaService);
  requests = app.get(DataSubjectRequestService);
  processing = app.get(ProcessingActivityService);
  addressBook = app.get(PluginAddressBookService);

  const association = await prisma.association.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      name: "Brf Eksemplet",
      organizationNumber: "769600-0000",
      setupCompletedAt: new Date(),
    },
    update: {},
    select: { defaultLocale: true },
  });
  originalLocale = association.defaultLocale;

  await prisma.address.createMany({
    data: [
      {
        id: addresses.north,
        street: "Norrgatan",
        number: suffix,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 940,
      },
      {
        id: addresses.south,
        street: "Södergatan",
        number: suffix,
        postalCode: "11122",
        city: "Stockholm",
        sortOrder: 941,
      },
    ],
  });
  await prisma.apartment.createMany({
    data: [
      { id: apartments.north, addressId: addresses.north, number: "1101" },
      { id: apartments.south, addressId: addresses.south, number: "1201" },
    ],
  });
  await prisma.person.createMany({
    data: personIds.map((id) => ({
      id,
      firstName: "Förnamn",
      lastName: `Efternamn${id.split("-")[1] ?? ""}`,
    })),
  });
  await prisma.residency.createMany({
    data: [
      {
        personId: persons.objector,
        apartmentId: apartments.north,
        role: "RESIDENT",
        movedInOn: LONG_AGO,
      },
      {
        personId: persons.neighbour,
        apartmentId: apartments.north,
        role: "MEMBER",
        movedInOn: LONG_AGO,
      },
      {
        personId: persons.southerner,
        apartmentId: apartments.south,
        role: "MEMBER",
        movedInOn: LONG_AGO,
      },
    ],
  });

  for (const pluginId of [signage, other]) {
    await processing.seedPlugin(pluginId, {
      name: `@openbrf/${pluginId}`,
      permissions: ["addressBook:read"],
      personalDataCategories: ["name", "apartment"],
      processing: PROCESSING,
    });
  }
}, 180_000);

afterAll(async () => {
  try {
    await prisma.association.update({
      where: { id: 1 },
      data: { defaultLocale: originalLocale },
    });
    await prisma.publicationConsent.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.dataSubjectRequest.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.residency.deleteMany({
      where: { personId: { in: personIds } },
    });
    await prisma.processingActivity.deleteMany({
      where: {
        OR: [
          {
            sourceKey: {
              in: [signage, other, weather, legacy].map(pluginProcessorKey),
            },
          },
          { id: { in: createdBoardRows } },
        ],
      },
    });
    await prisma.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma.apartment.deleteMany({
      where: { id: { in: Object.values(apartments) } },
    });
    await prisma.address.deleteMany({
      where: { id: { in: Object.values(addresses) } },
    });
  } finally {
    await app.close();
  }
});

describe("the record of processing activities, seeded from the declaration", () => {
  it("states what the plugin is for, on what basis, for how long and about whom", async () => {
    const row = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(signage) },
    });

    expect(row).toMatchObject({
      source: "PLUGIN",
      purpose: PROCESSING.purpose.sv,
      legalBasis: "LEGITIMATE_INTEREST",
      legalBasisNote: PROCESSING.legitimateInterest?.sv,
      retention: PROCESSING.retention.sv,
      dataSubjectCategories: ["resident"],
      personalDataCategories: ["name", "apartment"],
      endedAt: null,
    });
  });

  it("writes it in the association's language, and refreshes it until the board edits the row", async () => {
    await prisma.association.update({
      where: { id: 1 },
      data: { defaultLocale: "en" },
    });
    await processing.seedPlugin(signage, {
      name: `@openbrf/${signage}`,
      permissions: ["addressBook:read"],
      personalDataCategories: ["name", "apartment"],
      processing: PROCESSING,
    });
    const english = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(signage) },
    });
    expect(english.purpose).toBe(PROCESSING.purpose.en);

    await processing.update(english.id, {
      purpose: "Styrelsens egen formulering.",
      actorPersonId: persons.board,
    });
    await processing.seedPlugin(signage, {
      name: `@openbrf/${signage}`,
      permissions: ["addressBook:read"],
      personalDataCategories: ["name"],
      processing: {
        ...PROCESSING,
        purpose: { sv: "Ny text.", en: "New text." },
      },
    });
    const edited = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(signage) },
    });

    // The board's words win over a republished declaration; the categories
    // are the new version's, as they always were.
    expect(edited.purpose).toBe("Styrelsens egen formulering.");
    expect(edited.personalDataCategories).toEqual(["name"]);
  });

  it("gives a plugin that handles no personal data no row, and ends one an earlier version left, unless it reads the address book", async () => {
    await processing.seedPlugin(weather, {
      name: `@openbrf/${weather}`,
      permissions: [],
      personalDataCategories: [],
    });
    expect(
      await prisma.processingActivity.findUnique({
        where: { sourceKey: pluginProcessorKey(weather) },
      }),
    ).toBeNull();

    await processing.seedPlugin(legacy, {
      name: `@openbrf/${legacy}`,
      permissions: ["addressBook:read"],
      personalDataCategories: ["name"],
    });
    const placeholder = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(legacy) },
    });
    // Published before the declaration: seeded as every plugin was.
    expect(placeholder).toMatchObject({
      purpose: `@openbrf/${legacy}`,
      retention: "",
      endedAt: null,
    });

    // A version that still reads the address book keeps its row, declared
    // personal data or not: the row is what a person objects to.
    await processing.seedPlugin(legacy, {
      name: `@openbrf/${legacy}`,
      permissions: ["addressBook:read"],
      personalDataCategories: [],
    });
    const kept = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(legacy) },
    });
    expect(kept.endedAt).toBeNull();

    await processing.seedPlugin(legacy, {
      name: `@openbrf/${legacy}`,
      permissions: [],
      personalDataCategories: [],
    });
    const ended = await prisma.processingActivity.findUniqueOrThrow({
      where: { sourceKey: pluginProcessorKey(legacy) },
    });
    expect(ended.endedAt).not.toBeNull();
  });
});

describe("an objection to a plugin's processing", () => {
  it("takes the person out of that plugin's reads, and of no other plugin's", async () => {
    expect(await residentIds(signage)).toEqual(
      [persons.neighbour, persons.objector, persons.southerner].sort(),
    );

    const requestId = await objectTo(persons.objector, signage);

    expect(await residentIds(signage)).toEqual(
      [persons.neighbour, persons.southerner].sort(),
    );
    expect(await residentIds(other)).toContain(persons.objector);

    // Counted the same way it is listed.
    const before = await addressBook.summary(other);
    const after = await addressBook.summary(signage);
    expect(after.residents).toBe(before.residents - 1);

    // Not the communications: that objection is a separate thing.
    const objector = await prisma.person.findUniqueOrThrow({
      where: { id: persons.objector },
      select: { communicationObjectionAt: true },
    });
    expect(objector.communicationObjectionAt).toBeNull();

    await requests.close(requestId, {
      reason: "withdrawn",
      actorPersonId: persons.board,
    });

    expect(await residentIds(signage)).toContain(persons.objector);
  });

  it("stands beside an objection to the communications, and closing it leaves that one standing", async () => {
    const communications = await objectTo(persons.neighbour, null);
    const toSignage = await objectTo(persons.neighbour, signage);

    await requests.close(toSignage, {
      reason: "withdrawn",
      actorPersonId: persons.board,
    });
    const neighbour = await prisma.person.findUniqueOrThrow({
      where: { id: persons.neighbour },
      select: { communicationObjectionAt: true },
    });
    expect(neighbour.communicationObjectionAt).not.toBeNull();
    expect(await residentIds(signage)).toContain(persons.neighbour);

    await requests.close(communications, {
      reason: "withdrawn",
      actorPersonId: persons.board,
    });
  });

  it("is one open request per processing", async () => {
    const first = await objectTo(persons.southerner, signage);

    await expect(
      requests.record({
        personId: persons.southerner,
        kind: "OBJECTION",
        requestedOn,
        ground: "Igen.",
        processingActivityId: await activityId(signage),
        actorPersonId: persons.board,
      }),
    ).rejects.toMatchObject({ reason: "already-open" });

    // Another plugin's processing is another question.
    const second = await objectTo(persons.southerner, other);

    for (const requestId of [first, second]) {
      await requests.close(requestId, {
        reason: "withdrawn",
        actorPersonId: persons.board,
      });
    }
  });

  it("offers the running plugins' rows to the recording form", async () => {
    const offered = (await requests.objectableProcessings()).map(
      (row) => row.activityId,
    );

    expect(offered).toContain(await activityId(signage));
    expect(offered).toContain(await activityId(other));
    // Ended when its last version declared no personal data.
    expect(offered).not.toContain(await activityId(legacy));
  });

  it("names a running plugin's row and nothing else, and only on an objection", async () => {
    // A row the board wrote: nothing reads a plugin's register through it.
    const boardRow = await processing.record({
      name: `Styrelsens pärm ${suffix}`,
      purpose: "Protokoll på papper.",
      legalBasis: "LEGAL_OBLIGATION",
      dataSubjectCategories: ["member"],
      personalDataCategories: ["name"],
      thirdCountryTransfer: false,
      retention: "För alltid.",
      actorPersonId: persons.board,
    });
    createdBoardRows.push(boardRow.activityId);
    const ended = await activityId(legacy);

    for (const processingActivityId of [
      boardRow.activityId,
      ended,
      "no-such-row",
    ]) {
      await expect(
        requests.record({
          personId: persons.southerner,
          kind: "OBJECTION",
          requestedOn,
          ground: "Vill inte.",
          processingActivityId,
          actorPersonId: persons.board,
        }),
      ).rejects.toMatchObject({ reason: "processing-not-found" });
    }

    const refused = await requests
      .record({
        personId: persons.southerner,
        kind: "RESTRICTION",
        requestedOn,
        ground: "Begränsa.",
        processingActivityId: await activityId(signage),
        actorPersonId: persons.board,
      })
      .catch((cause: unknown) => cause);
    expect(refused).toBeInstanceOf(DataSubjectRequestError);
    expect(refused).toMatchObject({ reason: "processing-kind-inconsistent" });
  });
});

describe("the address book reads less", () => {
  it("reads one entrance when asked for one", async () => {
    expect(await residentIds(other, { addressId: addresses.south })).toEqual([
      persons.southerner,
    ]);
    expect(await residentIds(other, { addressId: "no-such-address" })).toEqual(
      [],
    );
  });

  it("gives the family name, and whether a name on screens in the building is consented to", async () => {
    await prisma.publicationConsent.create({
      data: {
        personId: persons.southerner,
        scope: "NAME_IN_BUILDING",
        grantedAt: new Date(Date.now() - 86_400_000),
        recordedByPersonId: persons.board,
      },
    });
    // A name on the website is a different consent, and says nothing here.
    await prisma.publicationConsent.create({
      data: {
        personId: persons.neighbour,
        scope: "NAME_ON_SITE",
        grantedAt: new Date(Date.now() - 86_400_000),
        recordedByPersonId: persons.board,
      },
    });

    const rows = await addressBook.residents(other, { contact: false });
    const southerner = rows.find((row) => row.personId === persons.southerner);
    const neighbour = rows.find((row) => row.personId === persons.neighbour);

    expect(southerner).toMatchObject({
      lastName: "Efternamnsoutherner",
      nameInBuilding: true,
    });
    expect(neighbour?.nameInBuilding).toBe(false);
  });
});
