import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AuthService } from "../auth/auth.service";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { PrismaService } from "../database/prisma.service";
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runPhone,
  runSuffix,
} from "../testing/integration-env";
import type { DataSubjectReport } from "./data-subject-report";

/**
 * The data subject access report (registerutdrag, GDPR art. 15) over HTTP.
 *
 * Two things only a real database can show, and both are the point of the
 * endpoint.
 *
 * Completeness. The report is the association's answer to "what do you hold
 * about me", and an answer that quietly omits a table is worse than no answer,
 * because nobody reading it can tell. So the fixture puts something in every
 * store the product has - both register tiers, an account, a consent, a hold,
 * an issue, an archived document, a booking, a sign-up to one of the
 * association's own dates and an audit trail - and each section is asserted to
 * have found it.
 *
 * The gate. This is the one endpoint that decrypts a personal identity number,
 * so the capability that opens it is checked as four different callers rather
 * than assumed from the decorator.
 */

loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;

const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";
// Both per run, because both carry a blind index that normalizes every
// spelling to one value - so a literal here is the answer to a lookup that was
// about somebody else, and this suite leaves its subject behind on purpose.
const IDENTITY_NUMBER = runIdentityNumber(suffix);
const PHONE = runPhone(suffix);

const addressId = `dsar-address-${suffix}`;
const apartmentId = `dsar-apartment-${suffix}`;
const issueTypeId = `dsar-issue-type-${suffix}`;
const mediaFileId = `dsar-media-${suffix}`;
const bookableResourceId = `dsar-resource-${suffix}`;
const eventId = `dsar-event-${suffix}`;
const occurrenceId = `dsar-occurrence-${suffix}`;

/**
 * When the fixture booking ended.
 *
 * Relative to now and only a week back, so no purge another suite drives can
 * reach it: a booking is erased on its own clock a year after it ended, and a
 * fixture dated a year ago would survive or vanish depending on which suite ran
 * first.
 */
const bookingEndedAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const bookingStartedAt = new Date(
  bookingEndedAt.getTime() - 2 * 60 * 60 * 1000,
);

/**
 * When the fixture cleaning day ran, and when the subject stood down from it.
 *
 * A week back rather than a year, for the reason the booking's own dates are: a
 * sign-up is erased on its own clock a year after the date it was for, and a
 * fixture dated a year ago would survive or vanish depending on which suite ran
 * first in this worker.
 *
 * At 23:30 UTC, which is the boundary this section has to get right rather than
 * an arbitrary hour. Stockholm is an hour ahead of UTC in winter and two in
 * summer, so half past eleven at night in UTC is half past midnight or half past
 * one in the morning on the FOLLOWING local day, whichever season this runs in.
 * The local date and the instant's own date therefore always differ, and a
 * document deriving the day from the instant names the day before the one the
 * notice in the stairwell did.
 */
const aWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
const occurrenceStartedAt = new Date(
  Date.UTC(
    aWeekAgo.getUTCFullYear(),
    aWeekAgo.getUTCMonth(),
    aWeekAgo.getUTCDate(),
    23,
    30,
  ),
);
const occurrenceEndedAt = new Date(
  occurrenceStartedAt.getTime() + 2 * 60 * 60 * 1000,
);
const signupWithdrawnAt = new Date(
  occurrenceStartedAt.getTime() - 24 * 60 * 60 * 1000,
);

/** The Stockholm wall clock the fixture's own date and time are stated from. */
const STOCKHOLM_FIELDS = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * The series' own wall-clock fields for that instant.
 *
 * Read off the instant rather than written out, so the series says the same thing
 * its occurrence does whichever season this runs in - and so that nothing here
 * depends on the module under test to say what those fields are.
 */
function stockholmFieldsOf(instant: Date): {
  firstOn: Date;
  startsAtMinute: number;
} {
  const [day, time] = STOCKHOLM_FIELDS.format(instant).split(" ");
  const [year, month, date] = (day ?? "").split("-").map(Number);
  const [hour, minute] = (time ?? "").split(":").map(Number);
  return {
    // A date column, so midnight UTC for that calendar date and no time zone at
    // all. The report never reads it: the date it states comes from the
    // occurrence's own instant.
    firstOn: new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, date ?? 1)),
    startsAtMinute: (hour ?? 0) * 60 + (minute ?? 0),
  };
}

const board = {
  personId: `dsar-board-${suffix}`,
  email: `dsar-board-${suffix}@exempel.se`,
};
const manager = {
  personId: `dsar-manager-${suffix}`,
  email: `dsar-manager-${suffix}@exempel.se`,
};
const resident = {
  personId: `dsar-resident-${suffix}`,
  email: `dsar-resident-${suffix}@exempel.se`,
};
/** The person the report is about. */
const subject = {
  personId: `dsar-subject-${suffix}`,
  email: `dsar-subject-${suffix}@exempel.se`,
};
/**
 * Whoever took the apartment over from the subject.
 *
 * Not one of the actors below: it signs nothing in and only has to exist,
 * because a transfer names an acquirer. Left behind at the end like the subject
 * and the apartment, and for the same reason - the transfer that references it
 * is append-only, so the row cannot be deleted without the guard being turned
 * off for every connection.
 */
const ACQUIRER_PERSON_ID = `dsar-acquirer-${suffix}`;

const actors = [board, manager, resident, subject];
const personIds = actors.map((actor) => actor.personId);

let ipCounter = 0;
function nextForwardedFor(): string {
  ipCounter += 1;
  const host = ipCounter % 254;
  const subnet = Math.floor(ipCounter / 254) % 254;
  // 10.22.0.0/16 is this suite's; the others each hold their own second octet.
  return `10.22.${String(subnet)}.${String(host + 1)}`;
}

function inject(options: {
  method: "GET" | "POST";
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

async function reportFor(cookie: string): Promise<DataSubjectReport> {
  const response = await inject({
    method: "POST",
    url: `/api/data-subject-reports/persons/${subject.personId}`,
    payload: {},
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as DataSubjectReport;
}

let boardCookie: string;
let managerCookie: string;
let residentCookie: string;

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
  const encryption = app.get(FieldEncryptionService);

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Utdragsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: { create: [{ id: apartmentId, number: "1001", floor: 0 }] },
    },
  });

  await prisma.person.createMany({
    data: [
      { id: board.personId, firstName: "Bo", lastName: `Utdrag${suffix}` },
      { id: manager.personId, firstName: "Mia", lastName: `Utdrag${suffix}` },
      { id: resident.personId, firstName: "Rut", lastName: `Utdrag${suffix}` },
      {
        id: ACQUIRER_PERSON_ID,
        firstName: "Kim",
        lastName: `Utdrag${suffix}`,
      },
    ],
  });

  const email = await encryption.encrypt("person.email", subject.email);
  const phone = await encryption.encrypt("person.phone", PHONE);
  const identityNumber = await encryption.encrypt(
    "person.personalIdentityNumber",
    IDENTITY_NUMBER,
  );
  await prisma.person.create({
    data: {
      id: subject.personId,
      firstName: "Siv",
      lastName: `Utdrag${suffix}`,
      postalStreet: "Storgatan 1",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      phoneCipher: phone.cipher,
      phoneIndex: phone.index,
      personalIdentityNumberCipher: identityNumber.cipher,
      personalIdentityNumberIndex: identityNumber.index,
      preferredLocale: "sv",
    },
  });

  await prisma.boardPosition.createMany({
    data: [
      {
        personId: board.personId,
        position: "BOARD_MEMBER",
        electedOn: new Date("2026-01-01"),
      },
      {
        personId: subject.personId,
        position: "DEPUTY_BOARD_MEMBER",
        electedOn: new Date("2021-05-01"),
        endedOn: new Date("2023-05-01"),
      },
    ],
  });
  await prisma.systemRole.create({
    data: { personId: manager.personId, role: "PROPERTY_MANAGER" },
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
        personId: subject.personId,
        apartmentId,
        role: "MEMBER",
        movedInOn: new Date("2020-03-01"),
        movedOutOn: new Date("2026-02-01"),
      },
    ],
  });

  // Statutory tier: the entry and exit in the member register, and the
  // transfer that granted the tenant-ownership. Exempt from erasure, and
  // therefore exactly what the report has to be able to say is kept.
  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: subject.personId,
        apartmentId,
        eventType: "ENTRY",
        eventOn: new Date("2020-03-01"),
        recordedFirstName: "Siv",
        recordedLastName: `Utdrag${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: subject.personId,
        apartmentId,
        eventType: "EXIT",
        eventOn: new Date("2026-02-01"),
        recordedFirstName: "Siv",
        recordedLastName: `Utdrag${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
        note: "Overlatelse",
      },
    ],
  });
  await prisma.transfer.create({
    data: {
      apartmentId,
      toPersonId: subject.personId,
      transferredOn: new Date("2020-03-01"),
      // Before the transfer, which is the ordinary order: the board approves
      // membership when it meets, and the transfer completes on the
      // tilltradesdag. This is the day the register's two-week window opened.
      membershipDecidedOn: new Date("2020-02-12"),
      price: "1875000",
      agreementReference: `OVL-2020-${suffix}`,
    },
  });

  /*
   * The transfer the subject sold on, and the reason it is here: it carries a
   * membership decision that is about the acquirer and not about the subject.
   * The report covers both directions, so this row reaches the subject's own
   * document - and the decision date on it must not.
   */
  await prisma.transfer.create({
    data: {
      apartmentId,
      fromPersonId: subject.personId,
      toPersonId: ACQUIRER_PERSON_ID,
      transferredOn: new Date("2026-02-01"),
      membershipDecidedOn: new Date("2026-01-14"),
      price: "2450000",
      agreementReference: `OVL-2026-${suffix}`,
    },
  });

  /*
   * Two terminations on the one apartment, and the boundary case is the point.
   * The subject held it from 2020-03-01 to 2026-02-01, so the one dated the day
   * their holding ended is theirs - the termination is normally what ended it -
   * and the one after it belongs to whoever came next. This is the mirror of
   * the pledge fixture below: there the boundary day excludes, here it
   * includes, and a rule copied from one to the other fails on exactly these
   * two rows.
   */
  await prisma.termination.createMany({
    data: [
      {
        id: `dsar-termination-theirs-${suffix}`,
        apartmentId,
        kind: "GENERAL_MEETING_DECISION",
        tookEffectOn: new Date("2026-02-01"),
        reference: `Stammoprotokoll ${suffix}`,
      },
      {
        id: `dsar-termination-after-${suffix}`,
        apartmentId,
        kind: "BUILDING_TRANSFERRED",
        tookEffectOn: new Date("2026-08-01"),
        reference: `Kopeavtal ${suffix}`,
      },
    ],
  });

  /*
   * Three pledges on the one apartment, which is the only way to show the
   * bounding rule doing its work: the subject held it from 2020-03-01 to
   * 2026-02-01, and only the middle one is theirs. The other two land on the
   * transfer days themselves, where the wrong rule would disclose the seller's
   * or the buyer's creditor on this person's document.
   */
  await prisma.lienNote.createMany({
    data: [
      {
        id: `dsar-lien-theirs-${suffix}`,
        apartmentId,
        creditor: `Bolanebanken ${suffix}`,
        notedOn: new Date("2021-05-01"),
        amount: "450000",
      },
      {
        id: `dsar-lien-before-${suffix}`,
        apartmentId,
        creditor: `Tidigare panthavare ${suffix}`,
        notedOn: new Date("2011-01-01"),
        // Redeemed as the sale to the subject completed, which is how a
        // transfer ordinarily ends. It is the seller's, not theirs.
        releasedOn: new Date("2020-03-01"),
      },
      {
        id: `dsar-lien-after-${suffix}`,
        apartmentId,
        creditor: `Senare panthavare ${suffix}`,
        // Taken out as the sale away from the subject completed: the buyer's.
        notedOn: new Date("2026-02-01"),
      },
    ],
  });

  await prisma.publicationConsent.create({
    data: {
      personId: subject.personId,
      scope: "NAME_ON_SITE",
      grantedAt: new Date("2024-06-01"),
      recordedByPersonId: board.personId,
      note: "Sagt ja pa arsstamman",
    },
  });
  await prisma.legalHold.create({
    data: {
      personId: subject.personId,
      reason: "Forsakringsarende efter vattenskada",
      placedByPersonId: board.personId,
      placedAt: new Date("2026-02-10"),
    },
  });

  await prisma.issueType.create({
    data: {
      id: issueTypeId,
      name: `Vattenskada ${suffix}`,
      audience: "MEMBER",
    },
  });
  await prisma.issue.create({
    data: {
      typeId: issueTypeId,
      reporterPersonId: subject.personId,
      apartmentId,
      location: "Badrummet",
      description: "Vatten pa golvet under handfatet",
    },
  });

  await prisma.mediaFile.create({
    data: {
      id: mediaFileId,
      storageKey: `dsar/${suffix}/stadgar.pdf`,
      contentType: "application/pdf",
      byteSize: 1024,
      checksum: `sha-${suffix}`,
      fileName: "stadgar.pdf",
      visibility: "MEMBER",
      uploadedByPersonId: subject.personId,
    },
  });
  await prisma.document.create({
    data: {
      title: `Stadgar ${suffix}`,
      category: "Stadgar",
      audience: "MEMBER",
      mediaFileId,
      uploadedByPersonId: subject.personId,
    },
  });

  await prisma.bookableResource.create({
    data: {
      id: bookableResourceId,
      name: `Tvattstuga ${suffix}`,
      mode: "TIME_SLOTS",
      slotMinutes: 120,
      opensAtMinute: 7 * 60,
      closesAtMinute: 21 * 60,
    },
  });
  await prisma.booking.create({
    data: {
      resourceId: bookableResourceId,
      apartmentId,
      bookedByPersonId: subject.personId,
      startsAt: bookingStartedAt,
      endsAt: bookingEndedAt,
    },
  });

  await prisma.event.create({
    data: {
      id: eventId,
      title: `Stadag ${suffix}`,
      category: "Stadag",
      location: "Innergarden",
      published: true,
      publishedAt: new Date(occurrenceStartedAt.getTime() - 30 * 86_400_000),
      signupOpen: true,
      capacity: 20,
      authorPersonId: board.personId,
      ...stockholmFieldsOf(occurrenceStartedAt),
      durationMinutes: 2 * 60,
    },
  });
  await prisma.eventOccurrence.create({
    data: {
      id: occurrenceId,
      eventId,
      startsAt: occurrenceStartedAt,
      endsAt: occurrenceEndedAt,
    },
  });
  // Stood down rather than standing, because a withdrawal is the case a report
  // can be silently wrong about: the row is still held and a section listing
  // only the standing ones would say nothing about it.
  await prisma.eventSignup.create({
    data: {
      occurrenceId,
      personId: subject.personId,
      signedUpAt: new Date(occurrenceStartedAt.getTime() - 14 * 86_400_000),
      withdrawnAt: signupWithdrawnAt,
    },
  });

  // One entry each way round, so the report can be shown to carry both what
  // was done to this person and what they did.
  await prisma.auditLogEntry.createMany({
    data: [
      {
        action: "PROTECTED_DATA_REVEALED",
        actorPersonId: board.personId,
        targetPersonId: subject.personId,
        context: { fields: ["phone"] },
      },
      {
        action: "MEMBER_REGISTER_EXTRACT_GENERATED",
        actorPersonId: subject.personId,
        context: { scope: "current" },
      },
    ],
  });

  const auth = app.get(AuthService);
  for (const actor of actors) {
    await auth.createAccountForPerson({
      personId: actor.personId,
      email: actor.email,
      name: "Test Person",
      password: PASSWORD,
    });
  }

  boardCookie = await signIn(board.email);
  managerCookie = await signIn(manager.email);
  residentCookie = await signIn(resident.email);
}, 180_000);

async function cleanUp(
  steps: readonly (() => Promise<unknown>)[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    await step().catch((cause: unknown) => failures.push(cause));
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      "The data subject report suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        () => prisma.eventSignup.deleteMany({ where: { occurrenceId } }),
        () => prisma.event.deleteMany({ where: { id: eventId } }),
        () =>
          prisma.booking.deleteMany({
            where: { resourceId: bookableResourceId },
          }),
        () =>
          prisma.bookableResource.deleteMany({
            where: { id: bookableResourceId },
          }),
        () => prisma.document.deleteMany({ where: { mediaFileId } }),
        () => prisma.mediaFile.deleteMany({ where: { id: mediaFileId } }),
        () => prisma.issue.deleteMany({ where: { typeId: issueTypeId } }),
        () => prisma.issueType.deleteMany({ where: { id: issueTypeId } }),
        () =>
          prisma.publicationConsent.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.session.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.account.deleteMany({
            where: { user: { personId: { in: personIds } } },
          }),
        () =>
          prisma.user.deleteMany({ where: { personId: { in: personIds } } }),
        () =>
          prisma.boardPosition.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.systemRole.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.residency.deleteMany({
            where: { personId: { in: personIds } },
          }),
        /*
         * Everyone but the subject, whose member register entries and transfer
         * keep both them and the apartment: the archive is append-only by
         * design. Audit entries stay for the same reason.
         */
        () =>
          prisma.person.deleteMany({
            where: {
              id: { in: personIds.filter((id) => id !== subject.personId) },
            },
          }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("who may produce a data subject access report", () => {
  it("refuses a request with no session", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${subject.personId}`,
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it("refuses a resident", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${subject.personId}`,
      payload: {},
      headers: { cookie: residentCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("refuses the property manager, who never reaches the address book", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${subject.personId}`,
      payload: {},
      headers: { cookie: managerCookie },
    });

    expect(response.statusCode).toBe(403);
  });

  it("answers 404 for somebody the register does not hold", async () => {
    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/nobody-${suffix}`,
      payload: {},
      headers: { cookie: boardCookie },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ reason: "person-not-found" });
  });
});

describe("what the report contains", () => {
  it("decrypts everything the register holds about the person", async () => {
    const report = await reportFor(boardCookie);

    expect(report.person.firstName).toBe("Siv");
    expect(report.person.email).toBe(subject.email);
    expect(report.person.phone).toBe(PHONE);
    // The one payload in the product that carries this. Every other view
    // masks it, which is why the endpoint is gated on protectedData:reveal.
    expect(report.person.personalIdentityNumber).toBe(IDENTITY_NUMBER);
    expect(report.person.postalAddress.street).toBe("Storgatan 1");
  });

  it("carries the service tier: residencies, roles, consents, holds and the account", async () => {
    const report = await reportFor(boardCookie);

    expect(report.residencies).toHaveLength(1);
    expect(report.residencies[0]?.movedOutOn).toBe("2026-02-01");
    // Derived at read time from the policy, never stored.
    expect(report.residencies[0]?.purgeOn).not.toBeNull();

    expect(report.boardPositions).toHaveLength(1);
    expect(report.boardPositions[0]?.position).toBe("DEPUTY_BOARD_MEMBER");

    expect(report.publicationConsents).toHaveLength(1);
    expect(report.publicationConsents[0]?.scope).toBe("NAME_ON_SITE");
    expect(report.publicationConsents[0]?.withdrawnOn).toBeNull();

    expect(report.legalHolds).toHaveLength(1);
    expect(report.legalHolds[0]?.reason).toBe(
      "Forsakringsarende efter vattenskada",
    );

    expect(report.account?.email).toBe(subject.email);
  });

  it("carries the statutory tier, which the purge is exempt from but access is not", async () => {
    const report = await reportFor(boardCookie);

    expect(report.memberRegisterEntries).toHaveLength(2);
    expect(
      report.memberRegisterEntries.map((entry) => entry.eventType),
    ).toEqual(["ENTRY", "EXIT"]);
    expect(report.memberRegisterEntries[1]?.note).toBe("Overlatelse");

    // Both directions, oldest first: the one they took the apartment on and
    // the one they sold it on.
    expect(report.transfers).toHaveLength(2);
    expect(report.transfers.map((transfer) => transfer.direction)).toEqual([
      "acquired",
      "relinquished",
    ]);
    // A string read off the Decimal rather than a number: a price an apartment
    // sold for must not travel through a float. Compared by value, because
    // whether the scale survives serialisation is the driver's business and
    // not something this document depends on.
    expect(typeof report.transfers[0]?.price).toBe("string");
    expect(Number(report.transfers[0]?.price)).toBe(1_875_000);
    expect(report.transfers[0]?.agreementReference).toBe(`OVL-2020-${suffix}`);
    // The day the cooperative housing register's two-week window opened for
    // this transfer, which is a decision taken about this person and not the
    // day the transfer completed.
    expect(report.transfers[0]?.membershipDecidedOn).toBe("2020-02-12");
  });

  it("keeps the acquirer's membership decision off the seller's report", async () => {
    const report = await reportFor(boardCookie);

    const relinquished = report.transfers.find(
      (transfer) => transfer.direction === "relinquished",
    );
    // The transfer is on the report - it is an event about this person, and
    // art. 15 asks for the personal data the cooperative holds on them.
    expect(relinquished?.agreementReference).toBe(`OVL-2026-${suffix}`);
    // The membership decision on it is not. The association decided whether to
    // admit the person taking over, so 2026-01-14 is that person's data, and
    // handing it to the seller would answer one access request with another
    // party's personal data. It is on the acquirer's own report instead.
    expect(relinquished?.membershipDecidedOn).toBeNull();
  });

  it("lists the termination that ended this person's tenant-ownership", async () => {
    const report = await reportFor(boardCookie);

    // Dated the day their holding ended, which is the case a rule copied from
    // the pledge bounding would drop: there the boundary day belongs to the
    // other party, here it is the very event being reported.
    expect(report.terminations).toHaveLength(1);
    expect(report.terminations[0]?.tookEffectOn).toBe("2026-02-01");
    expect(report.terminations[0]?.kind).toBe("GENERAL_MEETING_DECISION");
    expect(report.terminations[0]?.reference).toBe(`Stammoprotokoll ${suffix}`);
    // Statutory tier: on the report because exemption from erasure is not
    // exemption from access, and with no erasure date because there is none.
    expect(report.terminations[0]).not.toHaveProperty("erasableFrom");
  });

  it("keeps a later holder's termination off this person's report", async () => {
    const report = await reportFor(boardCookie);

    expect(
      report.terminations.map((termination) => termination.reference),
    ).not.toContain(`Kopeavtal ${suffix}`);
  });

  it("lists the pledges on the apartment while this person held it", async () => {
    const report = await reportFor(boardCookie);

    expect(report.lienNotes).toHaveLength(1);
    expect(report.lienNotes[0]?.creditor).toBe(`Bolanebanken ${suffix}`);
    expect(report.lienNotes[0]?.notedOn).toBe("2021-05-01");
    // Still standing, which the document has to say rather than leave blank.
    expect(report.lienNotes[0]?.releasedOn).toBeNull();
    expect(Number(report.lienNotes[0]?.amount)).toBe(450_000);
  });

  it("keeps another holder's pledge off this person's report", async () => {
    // GDPR art. 15(4): the copy must not adversely affect the rights of
    // others, and a creditor is somebody's financial position. Both boundary
    // cases are on the same apartment, so only the rule separates them.
    const report = await reportFor(boardCookie);

    const creditors = report.lienNotes.map((note) => note.creditor);
    expect(creditors).not.toContain(`Tidigare panthavare ${suffix}`);
    expect(creditors).not.toContain(`Senare panthavare ${suffix}`);
  });

  it("lists the issues and archived documents that reference the person", async () => {
    const report = await reportFor(boardCookie);

    // Listed although this train does not purge either: a report that omitted
    // rows because their retention story was unfinished would be an incomplete
    // answer to an access request.
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]?.description).toBe(
      "Vatten pa golvet under handfatet",
    );
    expect(report.documents).toHaveLength(1);
    expect(report.documents[0]?.title).toBe(`Stadgar ${suffix}`);
  });

  it("lists the bookings with the earliest date each can be erased on", async () => {
    const report = await reportFor(boardCookie);

    expect(report.bookings).toHaveLength(1);
    const booking = report.bookings[0];
    expect(booking?.resourceName).toBe(`Tvattstuga ${suffix}`);
    expect(booking?.status).toBe("BOOKED");
    expect(booking?.endsAt).toBe(bookingEndedAt.toISOString());
    expect(booking?.apartment).toContain("1001");

    /*
     * The booking's own retention date, a year after it ended, and not the one
     * at the foot of the document. The person this is handed to is entitled to
     * be told when each thing goes, and a booking goes on its own clock whether
     * or not they still live here - which is why this section states a date per
     * row where the issues and the documents beside it state none.
     */
    const expected = new Date(
      bookingEndedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(booking?.erasableFrom).toBe(expected.toISOString().slice(0, 10));

    /*
     * And the fixture's subject is under a standing legal hold, which is what
     * makes the field an eligibility date rather than a promise. A hold
     * suspends every purge for the person it stands against, so nothing of
     * theirs is erased on the date above until the board releases it. The
     * report has to be readable as true by the person it is handed to: the date
     * is the earliest the purge can reach the row, and whether anything is
     * reaching it at all is what the retention section answers. A hold can only
     * defer that date, never bring it forward.
     */
    expect(report.retention.onLegalHold).toBe(true);
  });

  it("lists the event sign-ups with the withdrawal and the association's own day", async () => {
    const report = await reportFor(boardCookie);

    expect(report.eventSignups).toHaveLength(1);
    const signup = report.eventSignups[0];
    expect(signup?.eventTitle).toBe(`Stadag ${suffix}`);
    expect(signup?.endsAt).toBe(occurrenceEndedAt.toISOString());
    expect(signup?.calledOff).toBe(false);

    /*
     * The withdrawal, stated as a date. This is the case a report can be
     * silently wrong about: the row is still held, so a section listing only the
     * standing sign-ups would tell the person nothing about a record that says
     * they had put their name down and then stood down.
     */
    expect(signup?.withdrawnOn).toBe(signupWithdrawnAt.toISOString());

    /*
     * The date on the association's own clock, and the boundary this section has
     * to get right. The fixture's cleaning day starts at 23:30 UTC, which is the
     * small hours of the FOLLOWING day in Stockholm in every season - so a
     * document deriving the day from the instant names the day before the one the
     * notice in the stairwell did.
     */
    expect(signup?.on).toBe(
      STOCKHOLM_FIELDS.format(occurrenceStartedAt).split(" ")[0],
    );
    expect(signup?.on).not.toBe(occurrenceStartedAt.toISOString().slice(0, 10));

    /*
     * And its own retention date, a year after the date it was for ended -
     * anchored on the occurrence and not on the withdrawal, because the row is
     * about a date and it is the date that decides when the association has no
     * further use for it. A withdrawal a fortnight early does not erase it a
     * fortnight early.
     */
    const expected = new Date(
      occurrenceEndedAt.getTime() + 365 * 24 * 60 * 60 * 1000,
    );
    expect(signup?.erasableFrom).toBe(expected.toISOString().slice(0, 10));
  });

  it("carries the audit trail both ways round", async () => {
    const report = await reportFor(boardCookie);

    const asSubject = report.auditEntries.filter(
      (entry) => entry.role === "subject",
    );
    const asActor = report.auditEntries.filter(
      (entry) => entry.role === "actor",
    );

    expect(asSubject.map((entry) => entry.action)).toContain(
      "PROTECTED_DATA_REVEALED",
    );
    // Somebody's own accesses are personal data about them too, and a board
    // member asking what is held about them is asking for these.
    expect(asActor.map((entry) => entry.action)).toContain(
      "MEMBER_REGISTER_EXTRACT_GENERATED",
    );
  });

  it("states what is kept, until when, and that a hold suspends it", async () => {
    const report = await reportFor(boardCookie);

    expect(report.retention.daysAfterMoveOut).toBeGreaterThan(0);
    expect(report.retention.purgeOn).not.toBeNull();
    expect(report.retention.onLegalHold).toBe(true);
  });
});

describe("what producing the report records", () => {
  it("writes one DATA_EXPORTED entry naming the sections and no values", async () => {
    const before = await prisma.auditLogEntry.count({
      where: { action: "DATA_EXPORTED", targetPersonId: subject.personId },
    });

    await reportFor(boardCookie);

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "DATA_EXPORTED", targetPersonId: subject.personId },
      orderBy: [{ createdAt: "desc" }],
    });
    expect(entries).toHaveLength(before + 1);

    const entry = entries[0];
    expect(entry?.actorPersonId).toBe(board.personId);
    expect(entry?.context).toMatchObject({ report: "dataSubjectAccess" });

    // The sections, never what they held: the entry outlives the data it
    // describes, and this report carries a personal identity number.
    const written = JSON.stringify(entry?.context);
    expect(written).toContain("memberRegisterEntries");
    expect(written).not.toContain(IDENTITY_NUMBER);
    expect(written).not.toContain(subject.email);
  });

  it("writes no entry when the report cannot be produced", async () => {
    // Counted on the person this request names rather than on the whole table:
    // audit_log_entry is append-only and this database is shared, so a report
    // produced by another suite between the two counts would fail this test for
    // a reason that has nothing to do with the 404 path.
    const missingPersonId = `nobody-else-${suffix}`;
    const before = await prisma.auditLogEntry.count({
      where: { action: "DATA_EXPORTED", targetPersonId: missingPersonId },
    });

    const response = await inject({
      method: "POST",
      url: `/api/data-subject-reports/persons/${missingPersonId}`,
      payload: {},
      headers: { cookie: boardCookie },
    });
    expect(response.statusCode).toBe(404);

    // An entry claiming an export that never happened would be worse than no
    // entry: the read and the record share one transaction.
    await expect(
      prisma.auditLogEntry.count({
        where: { action: "DATA_EXPORTED", targetPersonId: missingPersonId },
      }),
    ).resolves.toBe(before);
  });
});
