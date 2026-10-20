import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { AppModule } from "../app.module";
import { PrismaService } from "../database/prisma.service";
import {
  MAX_NOTICES_PER_RUN,
  paymentReferenceFor,
} from "../fees/payment-reference";
import {
  loadEnvForIntegrationTests,
  runSuffix,
} from "../testing/integration-env";
import type {
  DataSubjectReport,
  ReportDeliveryReceipt,
} from "./data-subject-report";
import { DataSubjectReportService } from "./data-subject-report.service";

/**
 * Delivery receipts on the data subject access report, against a real database.
 *
 * A fee notice and an apartment's charge reach a person's report through their
 * residency, and are the household's rows as much as theirs. A plugin's
 * reference on such a row is free text that may name the others there, and the
 * report is handed to its subject. What this proves:
 *
 * **A protected co-resident's name never reaches the other's report**, on a
 * notice or an apartment's charge for the flat they share, nor on a notice
 * whose period spans one household moving out and a protected one moving in.
 * The receipt stays, with its plugin, route and day, and says its reference is
 * withheld.
 *
 * **The subject's own data is not withheld**: a charge on them keeps its
 * reference, and so does a shared row nobody else on it is protected on - the
 * protected person's own report included, where the name is their own.
 */

loadEnvForIntegrationTests();

const suffix = runSuffix();

/**
 * A quarter of this run's own year. A period is unique on the instance and the
 * suites share one database, so a fixed quarter would be another run's too.
 */
const YEAR = 2100 + (Number.parseInt(suffix.slice(-6), 36) % 7_900);
const PERIOD = { from: `${YEAR}-07-01`, to: `${YEAR}-09-30` };
/** The day the successive households change over, inside the period. */
const CHANGE_OVER = `${YEAR}-08-16`;
/** When the receipts were recorded: before the period opens, as a notice is. */
const DELIVERED_ON = `${YEAR}-06-25T08:00:00.000Z`;

const addressId = `dr-address-${suffix}`;
const apartment = {
  /** Erik and Signe, who is protected, live here together. */
  shared: `dr-apartment-1-${suffix}`,
  /** Frida moves out during the period and Nils, protected, moves in. */
  successive: `dr-apartment-2-${suffix}`,
};
const apartmentIds = Object.values(apartment);

const person = {
  board: { id: `dr-board-${suffix}`, firstName: "Bo", lastName: "Styrelse" },
  erik: { id: `dr-erik-${suffix}`, firstName: "Erik", lastName: "Eget" },
  signe: { id: `dr-signe-${suffix}`, firstName: "Signe", lastName: "Skyddad" },
  frida: { id: `dr-frida-${suffix}`, firstName: "Frida", lastName: "Forra" },
  nils: { id: `dr-nils-${suffix}`, firstName: "Nils", lastName: "Nyinflyttad" },
};
const personIds = Object.values(person).map((entry) => entry.id);

/** References a plugin built from the names it was shown, as ADR 0048 says. */
const reference = {
  sharedNotice: "Signe-Skyddad-2026-09",
  sharedCharge: "Faktura Signe Skyddad",
  successiveNotice: "Nils-Nyinflyttad-2026-09",
  ownCharge: "Faktura Erik Eget",
};

let app: NestFastifyApplication;
let prisma: PrismaService;
let reports: DataSubjectReportService;
let notificationId = "";
const noticeIds = { shared: "", successive: "" };
const chargeIds = { shared: "", own: "" };

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  await app.init();
  prisma = app.get(PrismaService);
  reports = app.get(DataSubjectReportService);

  await prisma.association.upsert({
    where: { id: 1 },
    create: { id: 1, name: "Brf Eksemplet" },
    update: {},
  });

  await prisma.address.create({
    data: {
      id: addressId,
      street: "Kvittogatan",
      number: suffix,
      postalCode: "11122",
      city: "Stockholm",
    },
  });
  for (const [index, id] of apartmentIds.entries()) {
    await prisma.apartment.create({
      data: { id, addressId, number: `180${String(index + 1)}`, floor: 8 },
    });
  }
  for (const entry of Object.values(person)) {
    await prisma.person.create({
      data: {
        id: entry.id,
        firstName: entry.firstName,
        lastName: entry.lastName,
        protectedPersonalData:
          entry.id === person.signe.id || entry.id === person.nils.id,
      },
    });
  }

  const residencies: {
    personId: string;
    apartmentId: string;
    role: "MEMBER" | "RESIDENT";
    movedInOn: string;
    movedOutOn?: string;
  }[] = [
    {
      personId: person.erik.id,
      apartmentId: apartment.shared,
      role: "MEMBER",
      movedInOn: "2026-01-01",
    },
    {
      personId: person.signe.id,
      apartmentId: apartment.shared,
      role: "RESIDENT",
      movedInOn: "2026-01-01",
    },
    {
      personId: person.frida.id,
      apartmentId: apartment.successive,
      role: "MEMBER",
      movedInOn: "2026-01-01",
      movedOutOn: CHANGE_OVER,
    },
    {
      personId: person.nils.id,
      apartmentId: apartment.successive,
      role: "MEMBER",
      movedInOn: CHANGE_OVER,
    },
  ];
  for (const residency of residencies) {
    await prisma.residency.create({
      data: {
        personId: residency.personId,
        apartmentId: residency.apartmentId,
        role: residency.role,
        movedInOn: new Date(residency.movedInOn),
        movedOutOn:
          residency.movedOutOn === undefined
            ? null
            : new Date(residency.movedOutOn),
      },
    });
  }

  // Written straight in: what is under test is the report, not the run.
  const notification = await prisma.feeNotification.create({
    data: {
      periodFrom: new Date(PERIOD.from),
      periodTo: new Date(PERIOD.to),
      dueOn: new Date(PERIOD.from),
      financialYearStartMonth: 1,
      issuedByPersonId: person.board.id,
    },
    select: { id: true },
  });
  notificationId = notification.id;
  // A reference is unique across the instance and the suites share one
  // database, so each run starts at a position of its own.
  const firstPosition =
    (Number.parseInt(suffix.slice(-6), 36) % (MAX_NOTICES_PER_RUN - 1)) + 1;
  for (const [key, apartmentId] of Object.entries(apartment)) {
    const notice = await prisma.feeNotice.create({
      data: {
        notificationId,
        apartmentId,
        amount: "3000.00",
        paymentReference: paymentReferenceFor(
          PERIOD.from,
          firstPosition + (key === "shared" ? 0 : 1),
        ),
      },
      select: { id: true },
    });
    noticeIds[key as keyof typeof noticeIds] = notice.id;
  }

  const charge = async (
    party: { personId: string } | { apartmentId: string },
    reason: string,
  ): Promise<string> =>
    (
      await prisma.memberCharge.create({
        data: {
          ...party,
          chargedOn: new Date("2026-09-15"),
          financialYearStartMonth: 1,
          amount: "450.00",
          reason,
          vatTreatment: "EXEMPT",
          recordedByPersonId: person.board.id,
        },
        select: { id: true },
      })
    ).id;
  chargeIds.shared = await charge(
    { apartmentId: apartment.shared },
    "Reparation av dorr",
  );
  chargeIds.own = await charge({ personId: person.erik.id }, "Ny tagg");

  const deliveredAt = new Date(DELIVERED_ON);
  await prisma.deliveryReceipt.createMany({
    data: [
      {
        feeNoticeId: noticeIds.shared,
        pluginId: "avier",
        channel: "email",
        reference: reference.sharedNotice,
        deliveredAt,
      },
      {
        feeNoticeId: noticeIds.successive,
        pluginId: "avier",
        channel: "email",
        reference: reference.successiveNotice,
        deliveredAt,
      },
      {
        memberChargeId: chargeIds.shared,
        pluginId: "avier",
        channel: "fortnox",
        reference: reference.sharedCharge,
        deliveredAt: new Date("2026-09-20T08:00:00.000Z"),
      },
      {
        memberChargeId: chargeIds.own,
        pluginId: "avier",
        channel: "fortnox",
        reference: reference.ownCharge,
        deliveredAt: new Date("2026-09-20T08:00:00.000Z"),
      },
    ],
  });
}, 180_000);

afterAll(async () => {
  if (prisma === undefined) {
    return;
  }
  // Receipts go with their notices and charges.
  if (notificationId !== "") {
    await prisma.feeNotification.deleteMany({ where: { id: notificationId } });
  }
  await prisma.memberCharge.deleteMany({
    where: { id: { in: Object.values(chargeIds) } },
  });
  await prisma.residency.deleteMany({ where: { personId: { in: personIds } } });
  await prisma.person.deleteMany({ where: { id: { in: personIds } } });
  await prisma.apartment.deleteMany({ where: { id: { in: apartmentIds } } });
  await prisma.address.deleteMany({ where: { id: addressId } });
  await app.close();
});

/** The report the board hands its subject, as the API sends it. */
async function reportOf(personId: string): Promise<DataSubjectReport> {
  const report = await reports.generate({
    personId,
    actorPersonId: person.board.id,
  });
  return JSON.parse(JSON.stringify(report)) as DataSubjectReport;
}

function noticeReceipts(
  report: DataSubjectReport,
  noticeId: string,
): ReportDeliveryReceipt[] | undefined {
  return report.feeNotices.find((notice) => notice.noticeId === noticeId)
    ?.deliveries;
}

function chargeReceipts(
  report: DataSubjectReport,
  chargeId: string,
): ReportDeliveryReceipt[] | undefined {
  return report.memberCharges.find((charge) => charge.chargeId === chargeId)
    ?.deliveries;
}

describe("a delivery receipt on a row the household shares", () => {
  it("withholds the reference from a co-resident of a protected person, and keeps the receipt", async () => {
    const report = await reportOf(person.erik.id);

    expect(noticeReceipts(report, noticeIds.shared)).toEqual([
      {
        plugin: "avier",
        channel: "email",
        reference: { state: "withheld" },
        deliveredAt: DELIVERED_ON,
      },
    ]);
    expect(chargeReceipts(report, chargeIds.shared)).toEqual([
      {
        plugin: "avier",
        channel: "fortnox",
        reference: { state: "withheld" },
        deliveredAt: "2026-09-20T08:00:00.000Z",
      },
    ]);

    // Nowhere else on the report either.
    const payload = JSON.stringify(report);
    for (const name of [person.signe.firstName, person.signe.lastName]) {
      expect(payload).not.toContain(name);
    }
  });

  it("keeps the reference on a charge on the subject themselves", async () => {
    const report = await reportOf(person.erik.id);

    expect(chargeReceipts(report, chargeIds.own)).toEqual([
      {
        plugin: "avier",
        channel: "fortnox",
        reference: { state: "visible", text: reference.ownCharge },
        deliveredAt: "2026-09-20T08:00:00.000Z",
      },
    ]);
  });

  it("withholds it from the household that moved out, on a notice whose period the protected one moved in during", async () => {
    const report = await reportOf(person.frida.id);

    // On Frida's report at all, because her residency overlaps the period.
    expect(noticeReceipts(report, noticeIds.successive)).toEqual([
      {
        plugin: "avier",
        channel: "email",
        reference: { state: "withheld" },
        deliveredAt: DELIVERED_ON,
      },
    ]);
    const payload = JSON.stringify(report);
    for (const name of [person.nils.firstName, person.nils.lastName]) {
      expect(payload).not.toContain(name);
    }
  });

  it("keeps it on the protected person's own report, where nobody else on the row is protected", async () => {
    const report = await reportOf(person.signe.id);

    expect(
      noticeReceipts(report, noticeIds.shared)?.map((entry) => entry.reference),
    ).toEqual([{ state: "visible", text: reference.sharedNotice }]);
    expect(
      chargeReceipts(report, chargeIds.shared)?.map((entry) => entry.reference),
    ).toEqual([{ state: "visible", text: reference.sharedCharge }]);
  });

  it("carries no payment on a receipt", async () => {
    const report = await reportOf(person.erik.id);
    const receipts = [
      ...report.feeNotices.flatMap((notice) => notice.deliveries),
      ...report.memberCharges.flatMap((charge) => charge.deliveries),
    ];

    expect(receipts.length).toBeGreaterThan(0);
    for (const receipt of receipts) {
      expect(Object.keys(receipt).sort()).toEqual([
        "channel",
        "deliveredAt",
        "plugin",
        "reference",
      ]);
    }
  });
});
