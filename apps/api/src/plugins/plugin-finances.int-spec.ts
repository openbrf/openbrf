import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import type {
  PluginDeliveryReceipt,
  PluginFeeNotice,
  PluginFinanceEvent,
  PluginHost,
  PluginMemberCharge,
} from "@openbrf/plugin-sdk";
import { PluginDeliveryRefusedError } from "@openbrf/plugin-sdk";
import { testPersonalIdentityNumber } from "@openbrf/shared/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { MemberChargeService } from "../charges/member-charge.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import type { DeliveryReceiptRow } from "../delivery-receipts/delivery-receipt";
import { DeliveryReceiptService } from "../delivery-receipts/delivery-receipt.service";
import { FeeNotificationService } from "../fees/fee-notification.service";
import {
  financeEventQueue,
  FinanceEventsService,
} from "../finance-events/finance-events.service";
import { waitFor } from "../testing/advisory-locks";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import { PluginFinancesService } from "./plugin-finances.service";
import {
  createPluginHost,
  PluginHostBinding,
  type PluginHostServices,
} from "./plugin-host";

/**
 * The association's finances as a plugin reads them, against a real database.
 *
 * What the acceptance for the plugin finance API asks to be proved, and what a
 * unit test cannot prove because each turns on rows the register holds:
 *
 * **A protected person is never named to a plugin.** Not on a notice for their
 * household, whether they hold the apartment or only live there, and not on a
 * charge put on them - where the debiting list itself names them and withholds
 * only where they live. The plugin is told the value is withheld rather than
 * handed an empty one.
 *
 * **A restriction of processing withholds the same way**, which the files the
 * board hands over do not do.
 *
 * **Nothing a plugin reads carries a payment, a balance, a status or a
 * personal identity number**, walked over every object the reads return.
 *
 * **A delivery receipt is recorded once, audited without its reference, and
 * refused in every shape the host does not accept** - and the table refuses
 * the same shapes on its own.
 *
 * **The free text on a charge to a masked household is withheld** - the board's
 * reason and the plugins' references - whether the charge is on the apartment
 * or on somebody living there with a protected or restricted person, by the
 * household on the day of the charge. The person charged is still named.
 *
 * **A reference is withheld with the row it is on**, by the register as it
 * stands at the read: one recorded while a household could be named, naming
 * it, is withheld from the plugin once protection or a restriction is applied,
 * and stays on the board's own documents. **And another plugin's reference is
 * withheld on every row**, while its receipt stays.
 *
 * **An event is enqueued with the act that caused it**, for a plugin serving
 * and listening and for no other, carries identifiers only, and is never
 * enqueued for an act that rolled back.
 */

loadEnvForIntegrationTests();

const suffix = runSuffix();
const PLUGIN_ID = `ekonomi-${suffix}`;
const QUEUE = financeEventQueue(PLUGIN_ID);

/**
 * A period no other suite issues. A run is one per period across the
 * instance, so a suite sharing a database with this one must not be able to
 * take it.
 */
const PERIOD = { from: "2032-03-01", to: "2032-03-31" };
/** Charges are dated in the past, and in this suite's own month of them. */
const CHARGES = { from: "2026-09-01", to: "2026-09-30" };

const addressId = `pf-address-${suffix}`;
const apartment = {
  visible: `pf-apartment-1-${suffix}`,
  protectedHolder: `pf-apartment-2-${suffix}`,
  restrictedResident: `pf-apartment-3-${suffix}`,
  protectedPartner: `pf-apartment-4-${suffix}`,
  laterProtected: `pf-apartment-5-${suffix}`,
  laterRestricted: `pf-apartment-6-${suffix}`,
  formerlyShared: `pf-apartment-7-${suffix}`,
};
const apartmentIds = Object.values(apartment);

const person = {
  /** Holds the visible apartment, and is charged in the visible case. */
  astrid: {
    id: `pf-astrid-${suffix}`,
    firstName: "Astrid",
    lastName: "Synlig",
  },
  /** Protected, and holds an apartment. */
  signe: { id: `pf-signe-${suffix}`, firstName: "Signe", lastName: "Skyddad" },
  /** Holds the apartment a restricted person lives in. */
  rolf: { id: `pf-rolf-${suffix}`, firstName: "Rolf", lastName: "Granne" },
  /** Restricted under GDPR art. 18; lives with Rolf. */
  berit: {
    id: `pf-berit-${suffix}`,
    firstName: "Berit",
    lastName: "Begransad",
  },
  /** Holds an apartment where a protected partner lives. */
  hanna: {
    id: `pf-hanna-${suffix}`,
    firstName: "Hanna",
    lastName: "Halvskyddad",
  },
  /** Protected, and lives with Hanna without holding the apartment. */
  pelle: { id: `pf-pelle-${suffix}`, firstName: "Pelle", lastName: "Partner" },
  /** Holds an apartment, and is protected only after a delivery. */
  lova: { id: `pf-lova-${suffix}`, firstName: "Lova", lastName: "Senare" },
  /** Holds the apartment Ture lives in. */
  rut: { id: `pf-rut-${suffix}`, firstName: "Rut", lastName: "Kvar" },
  /** Lives with Rut, and is restricted only after a delivery. */
  ture: { id: `pf-ture-${suffix}`, firstName: "Ture", lastName: "Tidigare" },
  /** Holds the apartment Vera lived in until the end of September. */
  gunnar: {
    id: `pf-gunnar-${suffix}`,
    firstName: "Gunnar",
    lastName: "Kvarboende",
  },
  /** Protected, and moved out of Gunnar's apartment on 30 September. */
  vera: { id: `pf-vera-${suffix}`, firstName: "Vera", lastName: "Flyttad" },
};
const personIds = Object.values(person).map((entry) => entry.id);
/** Names a plugin must never be shown. */
const WITHHELD_NAMES = [
  "Signe",
  "Skyddad",
  "Berit",
  "Begransad",
  "Pelle",
  "Partner",
  "Vera",
  "Flyttad",
];
/** Every person in the suite carries one, so its absence is a real absence. */
const identityNumbers = personIds.map((_, index) =>
  testPersonalIdentityNumber(Number.parseInt(suffix.slice(-6), 36) + index),
);

let app: NestFastifyApplication;
let prisma: PrismaService;
let finances: PluginFinancesService;
let feeNotifications: FeeNotificationService;
let memberCharges: MemberChargeService;
let receipts: DeliveryReceiptService;
let events: FinanceEventsService;
/** What a plugin holding both finance permissions is handed. */
let host: PluginHost;

let serving = true;
const heard: PluginFinanceEvent[] = [];
let runId = "";
const chargeIds = {
  visible: "",
  protectedPerson: "",
  restrictedPerson: "",
  erasedPerson: "",
  protectedApartment: "",
  laterProtected: "",
  laterRestricted: "",
  visibleApartment: "",
  restrictedApartment: "",
  protectedPartnerHolder: "",
  restrictedPartnerHolder: "",
  sharedApartment: "",
  apartmentMovedOutOf: "",
};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();

  prisma = app.get(PrismaService);
  finances = app.get(PluginFinancesService);
  feeNotifications = app.get(FeeNotificationService);
  memberCharges = app.get(MemberChargeService);
  receipts = app.get(DeliveryReceiptService);
  events = app.get(FinanceEventsService);
  const encryption = app.get(FieldEncryptionService);

  // The host object a plugin is given, over the application's own services.
  const binding = new PluginHostBinding();
  binding.bind({ finances, receipts } as unknown as PluginHostServices);
  host = createPluginHost(binding, {
    manifest: {
      apiVersion: 1,
      id: PLUGIN_ID,
      entry: { server: "./dist/server.cjs" },
      permissions: ["finances:read", "finances:recordDelivery"],
      personalData: ["name", "financial"],
      actions: [],
      deviceRoutes: [],
      blocks: [],
      recipients: [],
      ai: false,
    },
    consented: ["finances:read", "finances:recordDelivery"],
    serving: true,
    bufferedActions: [],
    bufferedBlocks: [],
  });

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });
  // A run this suite left behind when an earlier run of it crashed. The period
  // is this suite's alone.
  await prisma.feeNotification.deleteMany({
    where: { periodFrom: new Date(PERIOD.from) },
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Ekonomigatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  for (const [index, id] of apartmentIds.entries()) {
    await prisma.apartment.create({
      data: { id, addressId, number: `170${String(index + 1)}`, floor: 7 },
    });
  }

  for (const [index, entry] of Object.values(person).entries()) {
    const pin = await encryption.encrypt(
      "person.personalIdentityNumber",
      identityNumbers[index] ?? "",
    );
    await prisma.person.create({
      data: {
        id: entry.id,
        firstName: entry.firstName,
        lastName: entry.lastName,
        personalIdentityNumberCipher: pin.cipher,
        personalIdentityNumberIndex: pin.index,
        protectedPersonalData:
          entry.id === person.signe.id ||
          entry.id === person.pelle.id ||
          entry.id === person.vera.id,
        processingRestrictedAt:
          entry.id === person.berit.id ? new Date() : null,
      },
    });
  }

  const residencies: [string, string, "MEMBER" | "RESIDENT", string?][] = [
    [person.astrid.id, apartment.visible, "MEMBER"],
    [person.signe.id, apartment.protectedHolder, "MEMBER"],
    [person.rolf.id, apartment.restrictedResident, "MEMBER"],
    [person.berit.id, apartment.restrictedResident, "RESIDENT"],
    [person.hanna.id, apartment.protectedPartner, "MEMBER"],
    [person.pelle.id, apartment.protectedPartner, "RESIDENT"],
    [person.lova.id, apartment.laterProtected, "MEMBER"],
    [person.rut.id, apartment.laterRestricted, "MEMBER"],
    [person.ture.id, apartment.laterRestricted, "RESIDENT"],
    [person.gunnar.id, apartment.formerlyShared, "MEMBER"],
    // The move-out date is the first day she no longer lives there.
    [person.vera.id, apartment.formerlyShared, "RESIDENT", "2026-09-30"],
  ];
  for (const [personId, apartmentId, role, movedOutOn] of residencies) {
    await prisma.residency.create({
      data: {
        personId,
        apartmentId,
        role,
        movedInOn: new Date("2026-01-01"),
        movedOutOn: movedOutOn === undefined ? null : new Date(movedOutOn),
      },
    });
  }

  for (const apartmentId of apartmentIds) {
    await prisma.fee.create({
      data: {
        apartmentId,
        kind: "ANNUAL_FEE",
        appliesFrom: new Date("2032-01-01"),
        financialYearStartMonth: 1,
        monthlyAmount: "1000.00",
        vatTreatment: "EXEMPT",
        recordedByPersonId: person.astrid.id,
      },
    });
  }

  // As the binder would, for one plugin serving and subscribed.
  events.bindServing((pluginId) => pluginId === PLUGIN_ID && serving);
  await events.listen(PLUGIN_ID, (event) => {
    heard.push(event);
  });

  const run = await feeNotifications.issue({
    actorPersonId: person.astrid.id,
    from: PERIOD.from,
    to: PERIOD.to,
    dueOn: PERIOD.to,
  });
  runId = run.notificationId;

  const record = async (
    party: { personId: string } | { apartmentId: string },
    reason: string,
    chargedOn = "2026-09-15",
  ): Promise<string> =>
    (
      await memberCharges.record({
        actorPersonId: person.astrid.id,
        ...party,
        chargedOn,
        amount: "450.00",
        reason,
        vatTreatment: "EXEMPT",
      })
    ).chargeId;

  chargeIds.visible = await record(
    { personId: person.astrid.id },
    "Nyckel till cykelrummet",
  );
  chargeIds.protectedPerson = await record(
    { personId: person.signe.id },
    "Ny tagg till Signe",
  );
  chargeIds.restrictedPerson = await record(
    { personId: person.berit.id },
    "Ny tagg",
  );
  chargeIds.protectedApartment = await record(
    { apartmentId: apartment.protectedHolder },
    "Reparation av dörr",
  );
  chargeIds.laterProtected = await record(
    { personId: person.lova.id },
    "Ny tagg",
  );
  chargeIds.laterRestricted = await record(
    { personId: person.ture.id },
    "Ny tagg",
  );
  chargeIds.visibleApartment = await record(
    { apartmentId: apartment.visible },
    "Byte av lås",
  );
  // Each reason names the masked person in the household, as the board's own
  // words about a household can.
  chargeIds.restrictedApartment = await record(
    { apartmentId: apartment.restrictedResident },
    "Berits balkongdörr",
  );
  chargeIds.protectedPartnerHolder = await record(
    { personId: person.hanna.id },
    "Ny tagg till Pelle",
  );
  chargeIds.restrictedPartnerHolder = await record(
    { personId: person.rolf.id },
    "Ny tagg till Berit",
  );
  chargeIds.sharedApartment = await record(
    { apartmentId: apartment.formerlyShared },
    "Veras flyttstädning",
  );
  chargeIds.apartmentMovedOutOf = await record(
    { apartmentId: apartment.formerlyShared },
    "Byte av lås efter flytt",
    "2026-09-30",
  );
  // A charge whose person the register has since erased, which the purges
  // can leave behind in one ordering. Written straight in: the service
  // refuses a person it cannot find.
  chargeIds.erasedPerson = (
    await prisma.memberCharge.create({
      data: {
        personId: `pf-gone-${suffix}`,
        chargedOn: new Date("2026-09-16"),
        financialYearStartMonth: 1,
        amount: "100.00",
        reason: "Borttappad nyckel",
        vatTreatment: "EXEMPT",
        recordedByPersonId: person.astrid.id,
      },
      select: { id: true },
    })
  ).id;
}, 180_000);

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  // Receipts go with their notices and charges.
  if (runId !== "") {
    await prisma.feeNotification.deleteMany({ where: { id: runId } });
  }
  await prisma.memberCharge.deleteMany({
    where: {
      OR: [
        { id: { in: Object.values(chargeIds) } },
        { personId: { in: personIds } },
        { apartmentId: { in: apartmentIds } },
      ],
    },
  });
  await prisma.fee.deleteMany({ where: { apartmentId: { in: apartmentIds } } });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
});

/** This suite's own notices, by apartment. */
async function ownNotices(): Promise<Map<string, PluginFeeNotice>> {
  const run = await finances.notification(PLUGIN_ID, runId);
  expect(run).not.toBeNull();
  return new Map(
    (run?.notices ?? [])
      .filter((notice) => apartmentIds.includes(notice.apartment.id))
      .map((notice) => [notice.apartment.id, notice]),
  );
}

/** This suite's own charges, by id. */
async function ownCharges(): Promise<Map<string, PluginMemberCharge>> {
  const ids = Object.values(chargeIds);
  return new Map(
    (await finances.charges(PLUGIN_ID, CHARGES))
      .filter((charge) => ids.includes(charge.id))
      .map((charge) => [charge.id, charge]),
  );
}

/**
 * The suite's plugin records `reference` on a charge, and the charge is read
 * as that plugin is shown it: by id, and in the period's list. The two are one
 * answer.
 */
async function referenceOn(
  chargeId: string,
  reference: string,
): Promise<{ one: PluginMemberCharge | null; listed: PluginMemberCharge }> {
  await receipts.record(PLUGIN_ID, {
    target: { kind: "memberCharge", id: chargeId },
    channel: "fortnox",
    reference,
  });
  const one = await finances.charge(PLUGIN_ID, chargeId);
  const listed = (await ownCharges()).get(chargeId);
  expect(listed).toBeDefined();
  expect(listed).toEqual(one);
  return { one, listed: listed as PluginMemberCharge };
}

/** Every key anywhere in a value, so a field cannot hide in a nested object. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(keysOf);
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, nested]) => [
      key,
      ...keysOf(nested),
    ]);
  }
  return [];
}

/** How many jobs a queue has ever been sent for one charge or run. */
async function jobsFor(field: string, id: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*) AS count FROM pgboss.job WHERE name = $1 AND data->>'${field}' = $2`,
    QUEUE,
    id,
  );
  return Number(rows[0]?.count ?? 0);
}

describe("finances:read, the fee notices", () => {
  it("names a household nothing stands against, and withholds every other", async () => {
    const notices = await ownNotices();

    expect(notices.get(apartment.visible)?.holders).toEqual({
      state: "visible",
      names: ["Astrid Synlig"],
    });
    // A protected holder, a restricted resident and a protected partner each
    // withhold the whole household's names, Hanna's and Rolf's included:
    // naming the others on a flat of two names the household.
    for (const id of [
      apartment.protectedHolder,
      apartment.restrictedResident,
      apartment.protectedPartner,
    ]) {
      expect(notices.get(id)?.holders).toEqual({ state: "withheld" });
    }
    // The apartment and the amount stay on every row: the apartment is the
    // party the fee is fixed on, and a notice that could not say which flat it
    // was for would not be a notice.
    for (const notice of notices.values()) {
      expect(notice.apartment.label).toContain("Ekonomigatan");
      expect(notice.amount).toBe("1000.00");
      expect(notice.paymentReference).toMatch(/^3203\d{5}$/);
    }
  });

  it("withholds no less than the file the board hands over, and a restricted household more", async () => {
    const document = await feeNotifications.read(runId);
    const file = new Map(
      (document?.rows ?? []).map((row) => [row.apartmentId, row]),
    );

    // The file's own rule is the floor...
    expect(file.get(apartment.protectedHolder)?.holders.state).toBe("withheld");
    expect(file.get(apartment.protectedPartner)?.holders.state).toBe(
      "withheld",
    );
    // ...and the plugin's is stricter: the board bills a restricted household
    // by name, while a plugin carrying the notice further is not told it.
    expect(file.get(apartment.restrictedResident)?.holders).toEqual({
      state: "visible",
      names: ["Rolf Granne"],
    });
    expect(
      (await ownNotices()).get(apartment.restrictedResident)?.holders,
    ).toEqual({
      state: "withheld",
    });
  });

  it("lists the run, and answers null for one that does not exist", async () => {
    const runs = await finances.notifications();
    const own = runs.find((run) => run.id === runId);

    expect(own).toMatchObject({
      from: PERIOD.from,
      to: PERIOD.to,
      dueOn: PERIOD.to,
    });
    expect(Number.isNaN(Date.parse(own?.issuedAt ?? ""))).toBe(false);
    expect(
      await finances.notification(PLUGIN_ID, `missing-${suffix}`),
    ).toBeNull();
  });
});

describe("finances:read, the charges", () => {
  it("names a person nothing stands against", async () => {
    const charge = (await ownCharges()).get(chargeIds.visible);

    expect(charge).toMatchObject({
      chargedOn: "2026-09-15",
      chargedTo: {
        kind: "person",
        state: "visible",
        personId: person.astrid.id,
        name: "Astrid Synlig",
      },
      amount: "450.00",
      vatTreatment: "EXEMPT",
      vatRatePercent: null,
      reason: { state: "visible", text: "Nyckel till cykelrummet" },
    });
    expect(
      charge?.chargedTo.kind === "person" &&
        charge.chargedTo.state === "visible"
        ? charge.chargedTo.apartment
        : null,
    ).toContain("Ekonomigatan");
  });

  it("withholds who, where and why for a protected, a restricted and an erased person", async () => {
    const charges = await ownCharges();

    for (const id of [
      chargeIds.protectedPerson,
      chargeIds.restrictedPerson,
      chargeIds.erasedPerson,
    ]) {
      const charge = charges.get(id);
      expect(charge?.chargedTo).toEqual({ kind: "person", state: "withheld" });
      // The board's own words can name the person as well as a name can;
      // "Ny tagg till Signe" is the case.
      expect(charge?.reason).toEqual({ state: "withheld" });
      // What the books need to stay whole is still there.
      expect(charge?.amount).toMatch(/^\d+\.\d{2}$/);
      expect(charge?.chargedOn).toMatch(/^2026-09-1[56]$/);
    }
  });

  it("is stricter than the debiting list, which names a protected person", async () => {
    const list = await memberCharges.list(CHARGES.from, CHARGES.to);
    const row = list.rows.find(
      (entry) => entry.chargeId === chargeIds.protectedPerson,
    );

    // The debiting list goes to whoever keeps the books, who has to know whom
    // to invoice: it names her and withholds where she lives.
    expect(row?.chargedTo).toMatchObject({
      kind: "person",
      name: "Signe Skyddad",
      apartment: { state: "masked" },
    });
  });

  it("states a charge on an apartment by its apartment, as the debiting list does", async () => {
    const charge = (await ownCharges()).get(chargeIds.visibleApartment);

    expect(charge?.chargedTo).toMatchObject({
      kind: "apartment",
      apartmentId: apartment.visible,
    });
    expect(charge?.reason).toEqual({ state: "visible", text: "Byte av lås" });
  });

  it("withholds why on a charge to an apartment a protected or restricted person lives in", async () => {
    const charges = await ownCharges();

    for (const [id, apartmentId] of [
      [chargeIds.protectedApartment, apartment.protectedHolder],
      [chargeIds.restrictedApartment, apartment.restrictedResident],
    ] as const) {
      const charge = charges.get(id);
      // The apartment is the party and stays, as it does on the notice...
      expect(charge?.chargedTo).toMatchObject({
        kind: "apartment",
        apartmentId,
      });
      expect(
        charge?.chargedTo.kind === "apartment"
          ? charge.chargedTo.apartment
          : null,
      ).toContain("Ekonomigatan");
      // ...and what the board wrote about the household goes, as the names on
      // the notice do: "Berits balkongdörr" says who lives there.
      expect(charge?.reason).toEqual({ state: "withheld" });

      // What the plugin itself wrote on the charge goes too, though nobody
      // charged is masked: the party is the apartment, and it is the household
      // that the reference could be about. The receipt stays.
      const reference = `VER-apt-${id}`;
      const { one, listed } = await referenceOn(id, reference);
      for (const read of [one, listed]) {
        expect(read?.deliveries).toMatchObject([
          { channel: "fortnox", reference: { state: "withheld" } },
        ]);
        expect(JSON.stringify(read)).not.toContain(reference);
      }
    }
  });

  it("names a person sharing a flat with a protected or restricted person, and withholds why", async () => {
    const charges = await ownCharges();

    for (const [id, charged] of [
      [chargeIds.protectedPartnerHolder, person.hanna],
      [chargeIds.restrictedPartnerHolder, person.rolf],
    ] as const) {
      const charge = charges.get(id);
      // Named, because the address book names the same person at the same door
      // to any plugin that reads it: withholding them here would only stop a
      // plugin invoicing somebody nothing stands against.
      expect(charge?.chargedTo).toMatchObject({
        kind: "person",
        state: "visible",
        personId: charged.id,
        name: `${charged.firstName} ${charged.lastName}`,
      });
      // The reason is about the household, and "Ny tagg till Pelle" names the
      // one the notice withholds every name for.
      expect(charge?.reason).toEqual({ state: "withheld" });

      // The person charged is nameable, but a reference the plugin wrote about
      // this charge could say who they live with: it is withheld, as the
      // reason is, and the receipt stays.
      const reference = `VER-partner-${id}`;
      const { one, listed } = await referenceOn(id, reference);
      for (const read of [one, listed]) {
        expect(read?.deliveries).toMatchObject([
          { channel: "fortnox", reference: { state: "withheld" } },
        ]);
        expect(JSON.stringify(read)).not.toContain(reference);
      }
    }
  });

  it("asks who lived there on the day of the charge", async () => {
    const charges = await ownCharges();

    // Vera lived in the flat on the 15th, and the reason for that day's charge
    // names her...
    expect(charges.get(chargeIds.sharedApartment)?.reason).toEqual({
      state: "withheld",
    });
    // ...and had moved out by the 30th, so that day's charge is the household
    // Gunnar lives in alone.
    expect(charges.get(chargeIds.apartmentMovedOutOf)?.reason).toEqual({
      state: "visible",
      text: "Byte av lås efter flytt",
    });

    // The reference a plugin wrote follows the same day: withheld on the
    // charge Vera lived under, shown on the charge dated the day she was gone.
    const whileShared = await referenceOn(
      chargeIds.sharedApartment,
      `VER-shared-${suffix}`,
    );
    const afterMoveOut = await referenceOn(
      chargeIds.apartmentMovedOutOf,
      `VER-after-${suffix}`,
    );
    for (const read of [whileShared.one, whileShared.listed]) {
      expect(read?.deliveries).toMatchObject([
        { reference: { state: "withheld" } },
      ]);
      expect(JSON.stringify(read)).not.toContain(`VER-shared-${suffix}`);
    }
    for (const read of [afterMoveOut.one, afterMoveOut.listed]) {
      expect(read?.deliveries).toMatchObject([
        { reference: { state: "visible", text: `VER-after-${suffix}` } },
      ]);
    }
  });

  it("reads one charge as the list states it, and null for one that does not exist", async () => {
    expect(await finances.charge(PLUGIN_ID, chargeIds.protectedPerson)).toEqual(
      (await ownCharges()).get(chargeIds.protectedPerson),
    );
    expect(await finances.charge(PLUGIN_ID, `missing-${suffix}`)).toBeNull();
  });

  it("refuses a period that is not two dates", async () => {
    await expect(
      finances.charges(PLUGIN_ID, { from: "2026-09-01" } as never),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

describe("what no read carries", () => {
  it("carries no payment, balance or status, and no personal identity number", async () => {
    const read = [
      await finances.notifications(),
      await finances.notification(PLUGIN_ID, runId),
      await finances.charges(PLUGIN_ID, CHARGES),
      await finances.charge(PLUGIN_ID, chargeIds.protectedPerson),
    ];

    for (const key of keysOf(read)) {
      // `paymentReference` is the number a payment is made under, stated on
      // the notice; it says nothing about whether one was.
      expect(key).not.toMatch(
        /paid|balance|outstanding|status|settled|overdue|personalIdentityNumber/i,
      );
    }

    // Only this suite's own rows: the database is shared, and another suite's
    // charge may carry one of these names legitimately.
    const text = JSON.stringify([
      [...(await ownNotices()).values()],
      [...(await ownCharges()).values()],
      await finances.charge(PLUGIN_ID, chargeIds.protectedPerson),
    ]);
    for (const number of identityNumbers) {
      expect(text).not.toContain(number);
      // The ten-digit form, which is how one is usually written.
      expect(text).not.toContain(number.slice(2));
    }
    for (const name of WITHHELD_NAMES) {
      expect(text).not.toContain(name);
    }
    for (const id of [person.signe.id, person.berit.id, person.pelle.id]) {
      expect(text).not.toContain(id);
    }
  });
});

describe("delivery receipts", () => {
  it("records one, shows it on the notice, and audits it without its reference", async () => {
    const notice = (await ownNotices()).get(apartment.visible);
    const reference = `VER-${suffix}`;

    const receipt = await receipts.record(PLUGIN_ID, {
      target: { kind: "feeNotice", id: notice?.id ?? "" },
      channel: "fortnox",
      reference,
      deliveredAt: new Date("2026-10-01T09:00:00.000Z"),
    });

    expect(receipt).toMatchObject({
      pluginId: PLUGIN_ID,
      channel: "fortnox",
      reference,
      deliveredAt: "2026-10-01T09:00:00.000Z",
    });
    // On the plugin's read and on the board's document alike...
    expect((await ownNotices()).get(apartment.visible)?.deliveries).toEqual([
      { ...receipt, reference: { state: "visible", text: reference } },
    ]);
    const document = await feeNotifications.read(runId);
    expect(
      document?.rows.find((row) => row.apartmentId === apartment.visible)
        ?.deliveries,
    ).toEqual([receipt]);

    // ...and in the log as the plugin's act, with the route but never the
    // reference, which goes with the receipt when the notice is erased.
    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "DELIVERY_RECEIPT_RECORDED", targetId: notice?.id },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      channel: "PLUGIN",
      actorPersonId: null,
      targetPersonId: null,
      targetKind: "feeNotice",
      context: {
        pluginId: PLUGIN_ID,
        channel: "fortnox",
        receiptId: receipt.id,
      },
    });
    expect(JSON.stringify(entries[0]?.context)).not.toContain(reference);
  });

  it("answers a delivery recorded twice with the first receipt and one entry", async () => {
    const input = {
      target: { kind: "memberCharge", id: chargeIds.visible },
      channel: "autogiro",
      reference: `AG-${suffix}`,
    } as const;

    const first = await receipts.record(PLUGIN_ID, input);
    const again = await receipts.record(PLUGIN_ID, input);
    const together = await Promise.all([
      receipts.record(PLUGIN_ID, input),
      receipts.record(PLUGIN_ID, input),
    ]);

    expect(again.id).toBe(first.id);
    expect(together.map((receipt) => receipt.id)).toEqual([first.id, first.id]);
    expect(
      await prisma.deliveryReceipt.count({
        where: { memberChargeId: chargeIds.visible },
      }),
    ).toBe(1);
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "DELIVERY_RECEIPT_RECORDED",
        targetId: chargeIds.visible,
      },
    });
    expect(entries).toHaveLength(1);
    // The person charged is the subject, so the delivery is on her own access
    // report beside the charge.
    expect(entries[0]?.targetPersonId).toBe(person.astrid.id);
    expect(
      (await finances.charge(PLUGIN_ID, chargeIds.visible))?.deliveries,
    ).toEqual([
      { ...first, reference: { state: "visible", text: input.reference } },
    ]);
  });

  it.each([
    ["channel-invalid", { channel: "Fortnox AB", reference: "VER-1" }],
    ["reference-invalid", { channel: "fortnox", reference: "" }],
    ["reference-invalid", { channel: "fortnox", reference: "VER\n1" }],
    [
      "reference-holds-personal-identity-number",
      {
        channel: "fortnox",
        reference: `Kund ${testPersonalIdentityNumber(7)}`,
      },
    ],
    [
      "delivered-in-the-future",
      {
        channel: "fortnox",
        reference: "VER-1",
        deliveredAt: new Date(Date.now() + 60_000),
      },
    ],
  ] as const)("refuses %s and writes nothing", async (reason, fields) => {
    const before = await prisma.deliveryReceipt.count({
      where: { memberChargeId: chargeIds.restrictedPerson },
    });

    const refusal = await receipts
      .record(PLUGIN_ID, {
        target: { kind: "memberCharge", id: chargeIds.restrictedPerson },
        ...fields,
      })
      .catch((cause: unknown) => cause);

    expect(refusal).toBeInstanceOf(PluginDeliveryRefusedError);
    expect((refusal as PluginDeliveryRefusedError).reason).toBe(reason);
    expect(
      await prisma.deliveryReceipt.count({
        where: { memberChargeId: chargeIds.restrictedPerson },
      }),
    ).toBe(before);
  });

  it("shows a plugin its own references and withholds every other plugin's", async () => {
    const other = `annan-${suffix}`;
    const chargeId = (
      await memberCharges.record({
        actorPersonId: person.astrid.id,
        personId: person.astrid.id,
        chargedOn: "2026-09-16",
        amount: "20.00",
        reason: "Extra nyckel",
        vatTreatment: "EXEMPT",
      })
    ).chargeId;
    const noticeId = (await ownNotices()).get(apartment.visible)?.id ?? "";
    const recorded = async (
      pluginId: string,
      reference: string,
    ): Promise<{ charge: DeliveryReceiptRow; notice: DeliveryReceiptRow }> => ({
      charge: await receipts.record(pluginId, {
        target: { kind: "memberCharge", id: chargeId },
        channel: "fortnox",
        reference,
      }),
      notice: await receipts.record(pluginId, {
        target: { kind: "feeNotice", id: noticeId },
        channel: "fortnox",
        reference,
      }),
    });
    const own = await recorded(PLUGIN_ID, `VER-own-${suffix}`);
    const theirs = await recorded(other, `VER-theirs-${suffix}`);

    const shown = (
      receipt: DeliveryReceiptRow,
      visible: boolean,
    ): PluginDeliveryReceipt => ({
      ...receipt,
      reference: visible
        ? { state: "visible", text: receipt.reference }
        : { state: "withheld" },
    });
    const byId = (
      entries: readonly PluginDeliveryReceipt[] | undefined,
    ): PluginDeliveryReceipt[] =>
      [...(entries ?? [])].sort((a, b) => a.id.localeCompare(b.id));

    // Each plugin sees both receipts, so either can tell the row went, and
    // reads only its own reference.
    for (const [reader, mine, others] of [
      [PLUGIN_ID, own, theirs],
      [other, theirs, own],
    ] as const) {
      const charge = await finances.charge(reader, chargeId);
      expect(byId(charge?.deliveries)).toEqual(
        byId([shown(mine.charge, true), shown(others.charge, false)]),
      );
      const listed = (await finances.charges(reader, CHARGES)).find(
        (entry) => entry.id === chargeId,
      );
      expect(listed?.deliveries).toEqual(charge?.deliveries);

      const notice = (await finances.notification(reader, runId))?.notices.find(
        (entry) => entry.id === noticeId,
      );
      expect(
        notice?.deliveries.find((entry) => entry.id === others.notice.id),
      ).toEqual(shown(others.notice, false));
      expect(
        notice?.deliveries.find((entry) => entry.id === mine.notice.id),
      ).toEqual(shown(mine.notice, true));
    }

    // The board's own screen keeps both.
    expect(
      (await memberCharges.find(chargeId))?.deliveries
        .map((entry) => entry.reference)
        .sort(),
    ).toEqual([`VER-own-${suffix}`, `VER-theirs-${suffix}`]);
  });

  it("refuses a target that does not exist", async () => {
    for (const kind of ["feeNotice", "memberCharge"] as const) {
      await expect(
        receipts.record(PLUGIN_ID, {
          target: { kind, id: `missing-${suffix}` },
          channel: "fortnox",
          reference: "VER-1",
        }),
      ).rejects.toMatchObject({ reason: "target-not-found" });
    }
  });

  it("is refused by the table in the shapes the host refuses", async () => {
    const insert = (
      columns: string,
      values: string,
      ...parameters: string[]
    ): Promise<unknown> =>
      prisma
        .$executeRawUnsafe(
          `INSERT INTO "delivery_receipt" ("id", ${columns}, "pluginId", "deliveredAt") VALUES ('pf-raw-${suffix}', ${values}, 'raw', now())`,
          ...parameters,
        )
        .then(() => null)
        .catch((cause: unknown) => cause);

    // Both targets, and neither.
    expect(
      await insert(
        `"feeNoticeId", "memberChargeId", "channel", "reference"`,
        `$1, $2, 'x', 'y'`,
        (await ownNotices()).get(apartment.visible)?.id ?? "",
        chargeIds.visible,
      ),
    ).toBeInstanceOf(Error);
    expect(await insert(`"channel", "reference"`, `'x', 'y'`)).toBeInstanceOf(
      Error,
    );
    // A channel and a reference the host would not take.
    expect(
      await insert(
        `"memberChargeId", "channel", "reference"`,
        `$1, 'Fortnox AB', 'y'`,
        chargeIds.visible,
      ),
    ).toBeInstanceOf(Error);
    expect(
      await insert(
        `"memberChargeId", "channel", "reference"`,
        `$1, 'x', E'a\\nb'`,
        chargeIds.visible,
      ),
    ).toBeInstanceOf(Error);
  });

  it("goes with a charge the board removes", async () => {
    const charge = await memberCharges.record({
      actorPersonId: person.astrid.id,
      personId: person.rolf.id,
      chargedOn: "2026-09-20",
      amount: "75.00",
      reason: "Felaktigt registrerad",
      vatTreatment: "EXEMPT",
    });
    await receipts.record(PLUGIN_ID, {
      target: { kind: "memberCharge", id: charge.chargeId },
      channel: "email",
      reference: `MSG-${suffix}`,
    });

    await memberCharges.remove(charge.chargeId, person.astrid.id);

    expect(
      await prisma.deliveryReceipt.count({
        where: { memberChargeId: charge.chargeId },
      }),
    ).toBe(0);
  });
});

describe("a reference recorded while the row could be named", () => {
  it.each([
    {
      change: "protection",
      apartmentId: apartment.laterProtected,
      chargeId: () => chargeIds.laterProtected,
      // The household on the notice and the person charged are one here.
      onNotice: person.lova,
      charged: person.lova,
      apply: { protectedPersonalData: true },
    },
    {
      change: "a restriction of processing",
      apartmentId: apartment.laterRestricted,
      chargeId: () => chargeIds.laterRestricted,
      // Rut is on the notice; Ture, restricted, lives with her.
      onNotice: person.rut,
      charged: person.ture,
      apply: { processingRestrictedAt: new Date() },
    },
  ])(
    "is withheld from a plugin once $change is applied, on the notice and the charge",
    async ({ apartmentId, chargeId, onNotice, charged, apply }) => {
      const notice = (await host.finances.notification(runId))?.notices.find(
        (entry) => entry.apartment.id === apartmentId,
      );
      // A legitimate reference, of the kind a plugin builds from what it was
      // shown: nothing in it is a personal identity number.
      const noticeReference = `${onNotice.firstName}-${onNotice.lastName}-2026-09`;
      const chargeReference = `Faktura ${charged.firstName} ${charged.lastName}`;

      await host.finances.recordDelivery({
        target: { kind: "feeNotice", id: notice?.id ?? "" },
        channel: "email",
        reference: noticeReference,
      });
      await host.finances.recordDelivery({
        target: { kind: "memberCharge", id: chargeId() },
        channel: "fortnox",
        reference: chargeReference,
      });

      const read = async (): Promise<{
        notice: PluginFeeNotice | undefined;
        charge: PluginMemberCharge | null;
      }> => ({
        notice: (await host.finances.notification(runId))?.notices.find(
          (entry) => entry.apartment.id === apartmentId,
        ),
        charge: await host.finances.charge(chargeId()),
      });

      // While nothing stands against naming them, the plugin is told.
      const before = await read();
      expect(before.notice?.holders.state).toBe("visible");
      expect(before.notice?.deliveries.map((entry) => entry.reference)).toEqual(
        [{ state: "visible", text: noticeReference }],
      );
      expect(before.charge?.deliveries.map((entry) => entry.reference)).toEqual(
        [{ state: "visible", text: chargeReference }],
      );

      await prisma.person.update({ where: { id: charged.id }, data: apply });

      const after = await read();
      expect(after.notice?.holders).toEqual({ state: "withheld" });
      expect(after.charge?.chargedTo).toEqual({
        kind: "person",
        state: "withheld",
      });
      // The receipts stay, so a plugin can tell the row went and does not send
      // it again; only what the plugin wrote about it is withheld.
      expect(after.notice?.deliveries).toMatchObject([
        { channel: "email", reference: { state: "withheld" } },
      ]);
      expect(after.charge?.deliveries).toMatchObject([
        { channel: "fortnox", reference: { state: "withheld" } },
      ]);
      // Not through the list either, nor anywhere else in what is read.
      const listed = (await host.finances.charges(CHARGES)).find(
        (entry) => entry.id === chargeId(),
      );
      expect(listed).toEqual(after.charge);
      const text = JSON.stringify([after, listed]);
      for (const name of [
        onNotice.firstName,
        onNotice.lastName,
        charged.firstName,
        charged.lastName,
      ]) {
        expect(text).not.toContain(name);
      }

      // The board's own documents keep the receipt and what it says.
      const document = await feeNotifications.read(runId);
      expect(
        document?.rows
          .find((row) => row.apartmentId === apartmentId)
          ?.deliveries.map((entry) => entry.reference),
      ).toEqual([noticeReference]);
      expect(
        (await memberCharges.find(chargeId()))?.deliveries.map(
          (entry) => entry.reference,
        ),
      ).toEqual([chargeReference]);
    },
  );
});

describe("finance events", () => {
  it("enqueues the issue of a run with it, carrying identifiers only", async () => {
    const rows = await prisma.$queryRawUnsafe<{ data: unknown }[]>(
      `SELECT data FROM pgboss.job WHERE name = $1 AND data->>'notificationId' = $2`,
      QUEUE,
      runId,
    );

    expect(rows).toHaveLength(1);
    const event = rows[0]?.data as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "eventId",
      "notificationId",
      "occurredAt",
      "type",
      "version",
    ]);
    expect(event).toMatchObject({
      type: "feeNotification.issued",
      version: 1,
      notificationId: runId,
    });
  });

  it("is handed to the plugin's handler", async () => {
    await waitFor(async () =>
      heard.some(
        (event) =>
          event.type === "feeNotification.issued" &&
          event.notificationId === runId,
      ),
    );
  });

  it("enqueues a charge recorded, corrected and removed, once each", async () => {
    const charge = await memberCharges.record({
      actorPersonId: person.astrid.id,
      personId: person.astrid.id,
      chargedOn: "2026-09-21",
      amount: "120.00",
      reason: "Extra nyckel",
      vatTreatment: "EXEMPT",
    });
    await memberCharges.correct(charge.chargeId, {
      actorPersonId: person.astrid.id,
      amount: "130.00",
    });
    await memberCharges.remove(charge.chargeId, person.astrid.id);

    const rows = await prisma.$queryRawUnsafe<{ type: string }[]>(
      `SELECT data->>'type' AS type FROM pgboss.job WHERE name = $1 AND data->>'chargeId' = $2 ORDER BY created_on`,
      QUEUE,
      charge.chargeId,
    );
    expect(rows.map((row) => row.type).sort()).toEqual([
      "memberCharge.corrected",
      "memberCharge.recorded",
      "memberCharge.removed",
    ]);
  });

  it("enqueues nothing for a plugin the board has switched off", async () => {
    serving = false;
    try {
      const charge = await memberCharges.record({
        actorPersonId: person.astrid.id,
        apartmentId: apartment.visible,
        chargedOn: "2026-09-22",
        amount: "50.00",
        reason: "Städning",
        vatTreatment: "EXEMPT",
      });
      expect(await jobsFor("chargeId", charge.chargeId)).toBe(0);
    } finally {
      serving = true;
    }
  });

  it("enqueues nothing for an act that rolled back", async () => {
    // Published inside the writer's transaction, as the fee and charge services
    // publish, and then the writer fails: the job goes with the rows.
    const chargeId = `pf-rolled-back-${suffix}`;
    await expect(
      prisma.$transaction(async (tx) => {
        await events.publish(tx, { type: "memberCharge.recorded", chargeId });
        throw new Error("The act failed after it published.");
      }),
    ).rejects.toThrow(/failed after it published/);

    expect(await jobsFor("chargeId", chargeId)).toBe(0);
  });

  it("refuses a plugin subscribing twice", async () => {
    await expect(events.listen(PLUGIN_ID, () => undefined)).rejects.toThrow(
      /twice/,
    );
  });
});
