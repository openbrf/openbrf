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
import {
  loadEnvForIntegrationTests,
  runIdentityNumber,
  runPhone,
  runSuffix,
} from "../testing/integration-env";
import type { Prisma } from "../generated/prisma/client";
import { lockIssue, lockWorkOrderSender } from "../issues/issue-lock";
import { IssuePurgeService } from "../issues/issue-purge.service";
import { IssueRedactionService } from "../issues/issue-redaction.service";
import { IssueTextPurgeService } from "../issues/issue-text-purge.service";
import { WORK_ORDER_BODY_RETENTION_DAYS } from "../issues/issue-retention";
import { waitFor } from "../testing/advisory-locks";
import { backendPid, waitersBehind } from "../testing/lock-waiters";
import { lockLegalHold } from "./legal-hold-lock";
import { LegalHoldService } from "./legal-hold.service";
import { computePurgeDate } from "./purge-date";
import { PurgeService } from "./purge.service";
import { erasureRequestedPersonIds } from "./withheld-persons";
import { sweepExpiredSignInSessions } from "./sign-in-session-sweep";
import { createIssueTypeFixture } from "../testing/issue-fixtures";

/**
 * The service-tier purge against a real database.
 *
 * The job is a promise about time - "your data is erased a year after you move
 * out" - and time is the one thing a suite cannot wait for. So the clock is
 * driven rather than awaited: every person here moved out on a fixed date in
 * 2015, and each test hands the service the instant it is to judge eligibility
 * at. Nothing sleeps, and nothing depends on when the suite is run.
 *
 * That fixed date also bounds the blast radius. `run` erases everybody who is
 * eligible, and the database is shared with the other integration suites; a
 * clock set to just after a 2015 move-out selects this suite's people and
 * nobody else's, because no other suite moves anyone out that long ago.
 *
 * What is pinned here is what the two-tier model means in practice: the service
 * tier goes, the statutory archive does not, and the archive is not merely
 * excluded from the query - it is never written to, because the database would
 * refuse and the code must not be built on believing otherwise.
 */

const env = loadEnvForIntegrationTests();

let app: NestFastifyApplication;
let prisma: PrismaService;
let purge: PurgeService;
let holds: LegalHoldService;
let encryption: FieldEncryptionService;
/** The association's own settings, read rather than set: they are shared. */
let retentionDays: number;
let defaultLocale: string;
/** A language that is not the association's, so the reset has something to do. */
let statedLocale: string;

const DAY = 24 * 60 * 60 * 1000;
const suffix = runSuffix();
const PASSWORD = "a-long-enough-password";

/**
 * The day every person in this suite left, chosen far enough back that an
 * instant just past their purge date is still in the past for everybody else
 * in the database.
 */
const MOVED_OUT = new Date("2015-03-01T00:00:00.000Z");
const MOVED_IN = new Date("2010-01-01T00:00:00.000Z");

const issueTypeId = `purge-type-${suffix}`;
const issueId = `purge-issue-${suffix}`;
/**
 * An open issue of the same person's that holds an entry permission and whose
 * text a handler has redacted: nothing of its free text stands, so the purge
 * detaches the person and takes the permission with them. Its work order holds
 * only a contractor's note a handler redacted, which stands as a blank row.
 */
const entryIssueId = `purge-entry-issue-${suffix}`;
/**
 * An open issue of the same person's that holds an entry permission and whose
 * text still stands: the purge leaves the person on it, and the permission
 * with them, until it closes (closing clears it).
 */
const standingEntryIssueId = `purge-entry-standing-${suffix}`;
/**
 * An older issue of theirs whose free text the clock has already removed: the
 * one the purge detaches them from (ADR 0057).
 */
const finishedIssueId = `purge-issue-finished-${suffix}`;
/** A note on the same issue by somebody else, which the purge leaves alone. */
const otherNoteId = `purge-note-other-${suffix}`;
const workOrderIssueId = `purge-sender-issue-${suffix}`;
const workOrderId = `purge-sender-order-${suffix}`;
const OTHER_NOTE = "Besiktning bokad nästa vecka";
const photoFileId = `purge-photo-${suffix}`;
const documentFileId = `purge-docfile-${suffix}`;
const documentId = `purge-doc-${suffix}`;
const binderEntryId = `purge-binder-entry-${suffix}`;
const binderFileId = `purge-binder-file-${suffix}`;

/**
 * What a reporter wrote, naming somebody else.
 *
 * The person purge never rewrites it, which is the whole reason the operation
 * is a detachment rather than something that could be called anonymous. The
 * issue's own clock removes it, or a handler redacts it on a request from the
 * person it names (ADR 0057).
 */
const ISSUE_DESCRIPTION = "Grannen i 1202 stallde cyklar i trapphuset";
/** What the person wrote in the conversation on that issue. */
const ISSUE_MESSAGE = "Cyklarna står kvar i trapphuset";

/** The moment the retention policy has run out on that move-out, and before. */
let dueAt: Date;
let notDueAt: Date;

// Both per run, because both carry a blind index that normalizes every
// spelling to one value - so a literal here is the answer to a lookup that was
// about somebody else. This suite leaves its archived person behind on purpose,
// so a literal would accumulate one such row per run.
const PHONE = runPhone(suffix);
const IDENTITY_NUMBER = runIdentityNumber(suffix);

const addressId = `purge-address-${suffix}`;

/**
 * The two motions the motion purge is standing in for here.
 *
 * Named so the suite can remove them itself: the closed one is deleted by a
 * test, standing in for the night that purge finally gets through, and the open
 * one outlives every assertion by design.
 */
const closedMotionId = `purge-motion-closed-${suffix}`;
const openMotionId = `purge-motion-open-${suffix}`;

/**
 * The connected app one of the fixture's accounts authorised.
 *
 * Named here because the clean-up has to find the client row: a client is
 * reached by its client id rather than by a person column, and it outlives
 * every account that consented to it.
 */
const CONNECTED_APP_CLIENT_ID = `https://app.exempel.test/${suffix}/klient.json`;
const connectedAppRowId = `purge-client-${suffix}`;
const connectedAppRefreshId = `purge-refresh-row-${suffix}`;

/**
 * A second app, on an account no rule lets the purge reach.
 *
 * The nightly sweep is not part of anybody's purge, so what it deletes has to
 * be shown on rows that survive every person the run erases. Its tokens are
 * dated against `dueAt` rather than against today, because that is the clock
 * the run judges expiry by.
 */
const SWEPT_APP_CLIENT_ID = `https://gammal.exempel.test/${suffix}/klient.json`;
const sweptAppRowId = `purge-swept-client-${suffix}`;

function apartmentId(name: string): string {
  return `purge-apartment-${name}-${suffix}`;
}

const people = {
  /** Nothing keeping them: the ordinary case the job exists for. */
  due: `purge-due-${suffix}`,
  /** Same, judged before the policy has run out. */
  early: `purge-early-${suffix}`,
  /** Under a legal hold. */
  held: `purge-held-${suffix}`,
  /** Held when the scan ran, so the second check is what refuses. */
  raced: `purge-raced-${suffix}`,
  /** Elected to the board and still sitting on it. */
  board: `purge-board-${suffix}`,
  /** An administrator who moved away but still administers the instance. */
  administrator: `purge-admin-${suffix}`,
  /** Moved out of one apartment and still lives in another. */
  staying: `purge-staying-${suffix}`,
  /** Carries statutory register rows and an audit trail. */
  archived: `purge-archived-${suffix}`,
  /** Has an account, a session, an invitation never accepted and one accepted. */
  accounted: `purge-accounted-${suffix}`,
  /** Purged twice, to prove the second run writes nothing. */
  twice: `purge-twice-${suffix}`,
  /** Reached through run() rather than through purgePerson(). */
  swept: `purge-swept-${suffix}`,
  /** Asked for a restriction, which suspends the purge as a hold does. */
  restricted: `purge-restricted-${suffix}`,
  /** Granted erasure while their retention window was still running. */
  requested: `purge-requested-${suffix}`,
  /** Granted erasure and never held a residency at all. */
  neverResident: `purge-never-${suffix}`,
  /**
   * Granted erasure, with a closed motion of theirs still on file.
   *
   * The motion purge runs at 03:29 and this job at 03:53. This is what the
   * database looks like when the earlier job threw for this person, stopped at
   * its bound before reaching them, or did not run at all: the rows it owes are
   * still there when the closing job arrives.
   */
  unfinished: `purge-unfinished-${suffix}`,
  /** Granted erasure, with a motion of theirs the association has not closed. */
  openMotion: `purge-open-motion-${suffix}`,
  /** Granted erasure and a legal hold, which the purge must not overrule. */
  heldRequest: `purge-held-request-${suffix}`,
  /**
   * Filed an issue, uploaded a document and a photograph, and filed an entry
   * into an apartment binder.
   */
  referenced: `purge-referenced-${suffix}`,
} as const;

const personIds = Object.values(people);

/** A person with contact details, an identity number and a locale to lose. */
async function seedPerson(
  personId: string,
  input: { firstName: string; locale?: string },
): Promise<void> {
  const email = await encryption.encrypt(
    "person.email",
    `${personId}@exempel.se`,
  );
  const phone = await encryption.encrypt("person.phone", PHONE);

  await prisma.person.create({
    data: {
      id: personId,
      firstName: input.firstName,
      lastName: `Gallring${suffix}`,
      postalStreet: "Storgatan 1",
      postalCode: "11122",
      postalCity: "Stockholm",
      emailCipher: email.cipher,
      emailIndex: email.index,
      phoneCipher: phone.cipher,
      phoneIndex: phone.index,
      preferredLocale: input.locale ?? "sv",
    },
  });
}

async function moveOut(
  personId: string,
  apartment: string,
  movedOutOn: Date | null = MOVED_OUT,
): Promise<void> {
  await prisma.residency.create({
    data: {
      personId,
      apartmentId: apartment,
      role: "MEMBER",
      movedInOn: MOVED_IN,
      movedOutOn,
    },
  });
}

async function personRow(personId: string) {
  return prisma.person.findUniqueOrThrow({
    where: { id: personId },
    select: {
      firstName: true,
      lastName: true,
      postalStreet: true,
      postalCode: true,
      postalCity: true,
      emailCipher: true,
      emailIndex: true,
      phoneCipher: true,
      phoneIndex: true,
      personalIdentityNumberCipher: true,
      preferredLocale: true,
    },
  });
}

/** The granted erasure request still open for this person. */
async function openErasureRequestFor(personId: string) {
  return prisma.dataSubjectRequest.findFirstOrThrow({
    where: {
      personId,
      kind: "ERASURE",
      decision: "GRANTED",
      executedAt: null,
      closedAt: null,
    },
    select: { executedAt: true, closedAt: true },
  });
}

async function purgeEntriesFor(personId: string) {
  return prisma.auditLogEntry.findMany({
    where: { action: "SERVICE_DATA_PURGED", targetPersonId: personId },
    orderBy: [{ createdAt: "asc" }],
  });
}

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
  purge = app.get(PurgeService);
  holds = app.get(LegalHoldService);
  encryption = app.get(FieldEncryptionService);

  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { retentionDaysAfterMoveOut: true, defaultLocale: true },
  });
  retentionDays = association?.retentionDaysAfterMoveOut ?? 365;
  defaultLocale = association?.defaultLocale ?? "sv";
  statedLocale = defaultLocale === "en" ? "sv" : "en";
  dueAt = new Date(MOVED_OUT.getTime() + (retentionDays + 1) * DAY);
  notDueAt = new Date(MOVED_OUT.getTime() + (retentionDays - 1) * DAY);

  await prisma.address.create({
    data: {
      id: addressId,
      street: `Gallringsgatan ${suffix}`,
      number: "1",
      postalCode: "11122",
      city: "Stockholm",
      apartments: {
        create: [
          ...personIds.map((personId, index) => ({
            id: apartmentId(String(index)),
            number: String(1001 + index),
            floor: 0,
          })),
          // The apartment the staying resident did not leave.
          { id: apartmentId("second-home"), number: "2001", floor: 1 },
        ],
      },
    },
  });

  for (const [index, personId] of personIds.entries()) {
    await seedPerson(personId, {
      firstName: "Person",
      // One of them states a language preference other than the association's,
      // so the reset to the association's own default has something to do.
      locale: personId === people.due ? statedLocale : defaultLocale,
    });
    if (personId !== people.neverResident) {
      // Everybody but the one whose whole point is having no residency to
      // anchor a purge date on.
      await moveOut(personId, apartmentId(String(index)));
    }
  }

  // The identity number is apartment register content, not service data. Put
  // one on file so the purge can be shown not to reach it.
  const identityNumber = await encryption.encrypt(
    "person.personalIdentityNumber",
    IDENTITY_NUMBER,
  );
  await prisma.person.update({
    where: { id: people.archived },
    data: {
      personalIdentityNumberCipher: identityNumber.cipher,
      personalIdentityNumberIndex: identityNumber.index,
    },
  });

  await prisma.boardPosition.create({
    data: {
      personId: people.board,
      position: "BOARD_MEMBER",
      electedOn: new Date("2014-01-01T00:00:00.000Z"),
      endedOn: null,
    },
  });
  await prisma.systemRole.create({
    data: { personId: people.administrator, role: "ADMIN" },
  });
  await prisma.residency.create({
    data: {
      personId: people.staying,
      apartmentId: apartmentId("second-home"),
      role: "RESIDENT",
      movedInOn: MOVED_IN,
      movedOutOn: null,
    },
  });

  await holds.place({
    personId: people.held,
    reason: "Tvist om andrahandsuthyrning",
    actorPersonId: people.board,
  });

  await holds.place({
    personId: people.heldRequest,
    reason: "Forsakringsarende om vattenskada",
    actorPersonId: people.board,
  });

  /*
   * Motions the motion purge has not erased. `unfinished`'s is closed, so it is
   * a row that purge owes and has not taken; `openMotion`'s is open, which that
   * purge leaves standing whatever the board granted - EFL 6 kap. 15 gives the
   * member who put it the right to have it treated at the meeting.
   */
  await prisma.motion.createMany({
    data: [
      {
        id: closedMotionId,
        title: `Byt portkod ${suffix}`,
        body: "Portkoden har varit densamma i fem ar.",
        submittedByPersonId: people.unfinished,
        submittedAt: new Date("2015-01-10T00:00:00.000Z"),
        status: "ACKNOWLEDGED" as const,
        closedAt: new Date("2015-05-10T00:00:00.000Z"),
      },
      {
        id: openMotionId,
        title: `Laddstolpar ${suffix}`,
        body: "Foreningen bor utreda laddstolpar pa garden.",
        submittedByPersonId: people.openMotion,
        submittedAt: new Date("2015-01-10T00:00:00.000Z"),
        status: "SUBMITTED" as const,
        closedAt: null,
      },
    ],
  });

  // A restriction under GDPR art. 18: the association keeps the data and stops
  // using it, so the one act it may not perform is the one this job performs.
  await prisma.person.update({
    where: { id: people.restricted },
    data: { processingRestrictedAt: new Date("2026-01-15T00:00:00.000Z") },
  });

  // The granted erasure requests. One from somebody whose retention window is
  // still running, one from somebody who never lived here at all, and three
  // the closing job must not call carried out: a job ahead of it left rows, a
  // motion of theirs is still open, and a legal hold stands.
  await prisma.dataSubjectRequest.createMany({
    data: [
      people.requested,
      people.neverResident,
      people.unfinished,
      people.openMotion,
      people.heldRequest,
    ].map((personId) => ({
      personId,
      kind: "ERASURE" as const,
      requestedOn: new Date("2026-01-10T00:00:00.000Z"),
      ground: "Jag vill inte finnas kvar hos foreningen.",
      erasureGround: "NO_LONGER_NECESSARY" as const,
      decision: "GRANTED" as const,
      erasureException: "NONE" as const,
      decisionGround: "Inget lagligt krav hindrar radering.",
      decidedAt: new Date("2026-01-12T00:00:00.000Z"),
      recordedByPersonId: people.board,
      decidedByPersonId: people.board,
    })),
  });

  // Somebody who filed an issue, uploaded a document and left a photograph on
  // the issue: the three things the purge detaches rather than deletes.
  const issueType = await createIssueTypeFixture(prisma, {
    id: issueTypeId,
    name: `Gallringsarende ${suffix}`,
    reporters: ["RESIDENTS"],
    defaultAssigneePersonId: people.referenced,
  });
  await prisma.issue.create({
    data: {
      id: issueId,
      typeId: issueTypeId,
      reporterPersonId: people.referenced,
      // The handler's part as well, which the purge detaches in one go.
      assigneePersonId: people.referenced,
      enteredByPersonId: people.referenced,
      enteredByHandler: true,
      location: "Trapphuset",
      description: ISSUE_DESCRIPTION,
      statusId: issueType.statusIds.DONE,
      closedAt: new Date(),
      outcome: "FIXED",
    },
  });
  // An open one, which can hold what its reporter said about letting somebody
  // into their home (decision 29). A handler has redacted its description and
  // nothing else of its text stands, so the purge detaches the person from it
  // and takes that answer with them.
  await prisma.issue.create({
    data: {
      id: entryIssueId,
      typeId: issueTypeId,
      reporterPersonId: people.referenced,
      description: "",
      descriptionRedactedAt: new Date(),
      statusId: issueType.statusIds.NEW,
      entryAnswer: "YES",
      entryNote: "Ring på hos grannen",
      entryPets: true,
      entryMasterKey: false,
      entryUntil: new Date("2027-12-31"),
    },
  });
  // An open one whose text still stands, with the same kind of answer.
  await prisma.issue.create({
    data: {
      id: standingEntryIssueId,
      typeId: issueTypeId,
      reporterPersonId: people.referenced,
      // About the apartment the answer is for, as a resident's own is: the
      // purge must clear and keep entry answers whatever they hang on.
      apartmentId: apartmentId(String(personIds.indexOf(people.referenced))),
      description: ISSUE_DESCRIPTION,
      statusId: issueType.statusIds.NEW,
      entryAnswer: "YES",
      entryNote: "Nyckel hos grannen",
      entryPets: false,
      entryMasterKey: true,
      entryUntil: new Date("2027-12-31"),
    },
  });
  // The same open issue's work order, whose text is gone and whose only note
  // from the contractor a handler has redacted: a blank row the clock has yet
  // to take, which does not keep the reporter attached.
  await prisma.workOrder.create({
    data: {
      issueId: entryIssueId,
      recipientName: null,
      recipientEmailCipher: null,
      body: null,
      sentByPersonId: null,
      deliveryStatus: "SENT",
      notes: { create: { body: "", redactedAt: new Date() } },
    },
  });
  // An earlier issue of theirs that the clock has finished: nothing of its
  // free text stands, so its reporter is what the purge detaches.
  await prisma.issue.create({
    data: {
      id: finishedIssueId,
      typeId: issueTypeId,
      reporterPersonId: people.referenced,
      description: "",
      freeTextRemovedAt: new Date(),
      statusId: issueType.statusIds.DONE,
      closedAt: new Date("2020-01-01T00:00:00.000Z"),
      outcome: "FIXED",
    },
  });
  // The conversation on it, as its reporter and as a handler writing a note:
  // each names its writer, and the words are the issue's.
  await prisma.issueMessage.create({
    data: {
      issueId,
      side: "REPORTER",
      authorPersonId: people.referenced,
      body: ISSUE_MESSAGE,
    },
  });
  await prisma.issueNote.create({
    data: { issueId, authorPersonId: people.referenced, body: ISSUE_MESSAGE },
  });
  await prisma.issueNote.create({
    data: {
      id: otherNoteId,
      issueId,
      authorPersonId: people.board,
      body: OTHER_NOTE,
    },
  });
  // A work order the same person sent, on an issue of its own (a standing text
  // would keep the reporter of this one): the order stays, the sender goes.
  await prisma.issue.create({
    data: {
      id: workOrderIssueId,
      typeId: issueTypeId,
      location: "Tvattstugan",
      description: "Stopp i avloppet.",
      statusId: issueType.statusIds.DONE,
      closedAt: new Date(),
      outcome: "FIXED",
    },
  });
  await prisma.workOrder.create({
    data: {
      id: workOrderId,
      issueId: workOrderIssueId,
      recipientName: `Rormokare ${suffix}`,
      recipientEmailCipher: "kept-as-it-was",
      body: "Spola avloppet.",
      sentByPersonId: people.referenced,
      deliveryStatus: "SENT",
    },
  });
  await prisma.mediaFile.createMany({
    data: [
      {
        id: photoFileId,
        storageKey: `purge/${suffix}/trapphus.jpg`,
        encryption: "NONE",
        contentType: "image/jpeg",
        byteSize: 2048,
        checksum: `sha-photo-${suffix}`,
        fileName: "trapphus.jpg",
        visibility: "INTERNAL",
        requiredCapability: "issues:handle",
        showsIdentifiablePersons: true,
        uploadedByPersonId: people.referenced,
      },
      {
        id: documentFileId,
        storageKey: `purge/${suffix}/stadgar.pdf`,
        encryption: "NONE",
        contentType: "application/pdf",
        byteSize: 1024,
        checksum: `sha-doc-${suffix}`,
        fileName: "stadgar.pdf",
        visibility: "MEMBER",
        uploadedByPersonId: people.referenced,
      },
      {
        id: binderFileId,
        storageKey: `purge/${suffix}/ritning.pdf`,
        encryption: "NONE",
        contentType: "application/pdf",
        byteSize: 1024,
        checksum: `sha-binder-${suffix}`,
        fileName: "ritning.pdf",
        visibility: "HOUSEHOLD",
        apartmentId: apartmentId(String(personIds.indexOf(people.referenced))),
        requiredCapability: "apartmentBinder:manage",
        uploadedByPersonId: people.referenced,
      },
    ],
  });
  await prisma.issuePhoto.create({
    data: { issueId, fileId: photoFileId },
  });
  await prisma.document.create({
    data: {
      id: documentId,
      title: `Stadgar ${suffix}`,
      category: "Stadgar",
      audience: "MEMBER",
      mediaFileId: documentFileId,
      uploadedByPersonId: people.referenced,
    },
  });
  await prisma.apartmentDocument.create({
    data: {
      id: binderEntryId,
      apartmentId: apartmentId(String(personIds.indexOf(people.referenced))),
      kind: "DRAWING",
      audience: "HOUSEHOLD",
      title: `Ritning badrum ${suffix}`,
      filedAs: "TENANT_OWNER",
      mediaFileId: binderFileId,
      filedByPersonId: people.referenced,
    },
  });

  // The statutory archive this suite must be able to show is untouched: an
  // entry and an exit in the member register, the transfer that granted the
  // tenant-ownership, and the termination that ended it.
  await prisma.memberRegisterEntry.createMany({
    data: [
      {
        personId: people.archived,
        apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
        eventType: "ENTRY",
        eventOn: MOVED_IN,
        recordedFirstName: "Person",
        recordedLastName: `Gallring${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
      {
        personId: people.archived,
        apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
        eventType: "EXIT",
        eventOn: MOVED_OUT,
        recordedFirstName: "Person",
        recordedLastName: `Gallring${suffix}`,
        recordedPostalStreet: "Storgatan 1",
        recordedPostalCode: "11122",
        recordedPostalCity: "Stockholm",
      },
    ],
  });
  await prisma.transfer.create({
    data: {
      apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
      kind: "TRANSFER",
      toPersonId: people.archived,
      transferredOn: MOVED_IN,
      agreementReference: `OVL-2010-${suffix}`,
    },
  });
  /*
   * Statutory tier, and therefore never purged, which is a decision and not an
   * omission. A termination is what the association reports to the cooperative
   * housing register (Lag (2026:484) 3 kap. 4 §), and the register it is
   * reported from is retained under EFL 5 kap. via BRL 9 kap. like the rest of
   * the archive. It also carries no personal data of its own - an apartment, a
   * date, a ground and a board reference - so an erasure request has nothing
   * here to reach.
   */
  await prisma.termination.create({
    data: {
      apartmentId: apartmentId(String(personIds.indexOf(people.archived))),
      kind: "GENERAL_MEETING_DECISION",
      tookEffectOn: MOVED_OUT,
      reference: `Stammoprotokoll ${suffix}`,
    },
  });

  const auth = app.get(AuthService);
  await auth.createAccountForPerson({
    personId: people.accounted,
    email: `${people.accounted}@exempel.se`,
    name: "Person Gallring",
    password: PASSWORD,
  });
  /*
   * An app that account connected, with both kinds of token behind it. Nothing
   * in the purge names these tables: they hang off the account through cascades
   * of their own, and this fixture is what says the single delete below really
   * does reach them.
   */
  const accountedUser = await prisma.user.findUniqueOrThrow({
    where: { personId: people.accounted },
    select: { id: true },
  });
  await prisma.oauthClient.create({
    data: {
      id: connectedAppRowId,
      clientId: CONNECTED_APP_CLIENT_ID,
      clientDiscoveryId: CONNECTED_APP_CLIENT_ID,
      name: `Anteckningsappen ${suffix}`,
      scopes: ["mcp:read", "offline_access"],
      createdAt: new Date(Date.now() - DAY),
      updatedAt: new Date(Date.now() - DAY),
      consents: {
        create: {
          userId: accountedUser.id,
          scopes: ["mcp:read"],
          createdAt: new Date(Date.now() - DAY),
          updatedAt: new Date(Date.now() - DAY),
        },
      },
    },
  });
  await prisma.oauthRefreshToken.create({
    data: {
      id: connectedAppRefreshId,
      token: `purge-refresh-${suffix}`,
      clientId: CONNECTED_APP_CLIENT_ID,
      userId: accountedUser.id,
      scopes: ["mcp:read", "offline_access"],
      createdAt: new Date(Date.now() - DAY),
      // Live, and relative to now, so the nightly sweep cannot reach it first:
      // what this fixture is about is the account cascade, not the expiry.
      expiresAt: new Date(Date.now() + 7 * DAY),
    },
  });
  await prisma.oauthAccessToken.create({
    data: {
      token: `purge-access-${suffix}`,
      clientId: CONNECTED_APP_CLIENT_ID,
      userId: accountedUser.id,
      refreshId: connectedAppRefreshId,
      scopes: ["mcp:read"],
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  /*
   * A second app, on the board member's account, holding one of each row the
   * nightly sweep decides about: an access token that has run out, a refresh
   * token revoked longer ago than the refresh lifetime, and a live access token
   * that has to survive. Every date is set against `dueAt`, which is the clock
   * the run judges expiry by, and the account is one no rule lets the purge
   * reach - so what the sweep does is visible after a whole run.
   */
  await auth.createAccountForPerson({
    personId: people.board,
    email: `${people.board}@exempel.se`,
    name: "Person Gallring",
    password: PASSWORD,
  });
  const boardUser = await prisma.user.findUniqueOrThrow({
    where: { personId: people.board },
    select: { id: true },
  });
  await prisma.oauthClient.create({
    data: {
      id: sweptAppRowId,
      clientId: SWEPT_APP_CLIENT_ID,
      clientDiscoveryId: SWEPT_APP_CLIENT_ID,
      name: `Gamla appen ${suffix}`,
      scopes: ["mcp:read", "offline_access"],
      createdAt: MOVED_OUT,
      updatedAt: MOVED_OUT,
      consents: {
        create: {
          userId: boardUser.id,
          scopes: ["mcp:read"],
          createdAt: MOVED_OUT,
          updatedAt: MOVED_OUT,
        },
      },
    },
  });
  await prisma.oauthAccessToken.createMany({
    data: [
      {
        token: `purge-spent-access-${suffix}`,
        clientId: SWEPT_APP_CLIENT_ID,
        userId: boardUser.id,
        scopes: ["mcp:read"],
        createdAt: MOVED_OUT,
        expiresAt: new Date(MOVED_OUT.getTime() + 15 * 60 * 1000),
      },
      {
        token: `purge-live-access-${suffix}`,
        clientId: SWEPT_APP_CLIENT_ID,
        userId: boardUser.id,
        scopes: ["mcp:read"],
        createdAt: MOVED_OUT,
        // Long past the run's clock, so the sweep has to leave it: deleting a
        // token an app can still present is a revocation, not a purge.
        expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      },
    ],
  });
  await prisma.oauthRefreshToken.create({
    data: {
      token: `purge-spent-refresh-${suffix}`,
      clientId: SWEPT_APP_CLIENT_ID,
      userId: boardUser.id,
      scopes: ["mcp:read", "offline_access"],
      createdAt: MOVED_OUT,
      expiresAt: new Date(MOVED_OUT.getTime() + 7 * DAY),
      // Revoked the day after it was issued, which is a year before the run's
      // clock: the window a replay could still have been recognised in is long
      // closed.
      revoked: new Date(MOVED_OUT.getTime() + DAY),
    },
  });
  await prisma.invitation.createMany({
    data: [
      {
        personId: people.accounted,
        tokenHash: `purge-open-${suffix}`,
        expiresAt: new Date(Date.now() + DAY),
      },
      {
        personId: people.accounted,
        tokenHash: `purge-accepted-${suffix}`,
        expiresAt: new Date(Date.now() + DAY),
        acceptedAt: new Date("2015-01-01T00:00:00.000Z"),
      },
    ],
  });
}, 180_000);

/**
 * Runs every cleanup step, then reports whichever of them failed.
 *
 * One step must not be able to stop the next: this database is shared with the
 * other integration suites, so a row this one leaves behind turns up later as a
 * stranger in a suite that scans the person table.
 */
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
      "The purge suite could not clean up after itself.",
    );
  }
}

afterAll(async () => {
  try {
    if (prisma !== undefined) {
      await cleanUp([
        /*
         * The client takes its consents and its tokens with it, through the
         * cascades every table in that section reaches a client by. It has to
         * go whether or not the purge under test reached the account first.
         */
        () =>
          prisma.oauthClient.deleteMany({
            where: {
              clientId: { in: [CONNECTED_APP_CLIENT_ID, SWEPT_APP_CLIENT_ID] },
            },
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
          prisma.invitation.deleteMany({
            where: { personId: { in: personIds } },
          }),
        () =>
          prisma.legalHold.deleteMany({
            where: { personId: { in: personIds } },
          }),
        /*
         * The rows the detachment left behind, in foreign-key order: the photo
         * link before the issue, the document before the file it points at.
         * They no longer name anybody, which is the point, so they have to be
         * found by their own ids.
         */
        () => prisma.issuePhoto.deleteMany({ where: { issueId } }),
        () =>
          prisma.issue.deleteMany({
            where: {
              id: {
                in: [
                  issueId,
                  entryIssueId,
                  standingEntryIssueId,
                  workOrderIssueId,
                  finishedIssueId,
                ],
              },
            },
          }),
        () => prisma.issueType.deleteMany({ where: { id: issueTypeId } }),
        () => prisma.document.deleteMany({ where: { id: documentId } }),
        () =>
          prisma.apartmentDocument.deleteMany({
            where: { id: binderEntryId },
          }),
        () =>
          prisma.mediaFile.deleteMany({
            where: { id: { in: [photoFileId, documentFileId, binderFileId] } },
          }),
        () =>
          prisma.motion.deleteMany({
            where: { submittedByPersonId: { in: personIds } },
          }),
        () =>
          prisma.dataSubjectRequest.deleteMany({
            where: { personId: { in: personIds } },
          }),
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
         * Everyone but the archived person, whose member register entries and
         * transfer keep both them and their apartment: the archive is
         * append-only by design, and the rows that reference them cannot be
         * removed to make room. Audit entries stay for the same reason.
         */
        () =>
          prisma.person.deleteMany({
            where: {
              id: { in: personIds.filter((id) => id !== people.archived) },
            },
          }),
        /*
         * The apartments too, once no residency points at them. Only the
         * archived person's is held by anything - their member register
         * entries and their transfer - so the rest would otherwise be left as
         * strangers in the shared apartment table, one set per run. The
         * address stays with the apartment that stays, which is what its
         * foreign key requires.
         */
        () =>
          prisma.apartment.deleteMany({
            where: {
              addressId,
              NOT: {
                id: apartmentId(String(personIds.indexOf(people.archived))),
              },
            },
          }),
      ]);
    }
  } finally {
    await app?.close();
  }
});

describe("what the purge erases", () => {
  it("clears the contact details and the stated language of somebody past their purge date", async () => {
    const before = await personRow(people.due);
    expect(before.emailCipher).not.toBeNull();

    const outcome = await purge.purgePerson(people.due, dueAt);

    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toEqual(
      expect.arrayContaining(["email", "phone", "preferredLocale"]),
    );

    const after = await personRow(people.due);
    expect(after.emailCipher).toBeNull();
    // The blind index goes with the cipher. An index left behind would still
    // answer "is this address in the register" for anyone who could guess it.
    expect(after.emailIndex).toBeNull();
    expect(after.phoneCipher).toBeNull();
    expect(after.phoneIndex).toBeNull();
    // Back to the association's own default rather than to nothing: the column
    // is not nullable, and it is the stated preference that is personal data.
    expect(after.preferredLocale).toBe(defaultLocale);
  });

  it("keeps the name and the postal address, which are member register content", async () => {
    const after = await personRow(people.due);

    // The register is public on request. One that lost its members' names
    // would not be a register, which is why the purge is a service-tier act
    // and not a deletion of the person.
    expect(after.firstName).toBe("Person");
    expect(after.lastName).toBe(`Gallring${suffix}`);
    expect(after.postalStreet).toBe("Storgatan 1");
    expect(after.postalCity).toBe("Stockholm");
  });

  it("leaves the person row, so somebody who moves back in is the same person", async () => {
    // The UI reads the absent contact data as "not recorded" rather than as a
    // missing person, which is only true because the row survives.
    await expect(
      prisma.person.findUnique({ where: { id: people.due } }),
    ).resolves.not.toBeNull();
  });

  it("deletes the account and every invitation", async () => {
    /*
     * The grant and the tokens behind a connected app are here before the run,
     * so their absence afterwards means the cascade reached them rather than
     * that the fixture never wrote them.
     */
    await expect(
      prisma.oauthConsent.count({
        where: { clientId: CONNECTED_APP_CLIENT_ID },
      }),
    ).resolves.toBe(1);

    const outcome = await purge.purgePerson(people.accounted, dueAt);

    expect(outcome?.accountDeleted).toBe(true);
    // The one never accepted and the one accepted.
    expect(outcome?.invitationsDeleted).toBe(2);

    await expect(
      prisma.user.count({ where: { personId: people.accounted } }),
    ).resolves.toBe(0);
    // The sessions and credentials go with the account, by the cascades on it.
    await expect(
      prisma.session.count({ where: { user: { personId: people.accounted } } }),
    ).resolves.toBe(0);
    /*
     * And so do the connected apps, which the purge names nowhere: the grant
     * and both kinds of token hang off the account through cascades of their
     * own. An app that still held a live token for somebody the register has
     * erased would be the clearest possible sign that the purge is cosmetic.
     */
    await expect(
      prisma.oauthConsent.count({
        where: { clientId: CONNECTED_APP_CLIENT_ID },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.oauthAccessToken.count({
        where: { clientId: CONNECTED_APP_CLIENT_ID },
      }),
    ).resolves.toBe(0);
    await expect(
      prisma.oauthRefreshToken.count({
        where: { clientId: CONNECTED_APP_CLIENT_ID },
      }),
    ).resolves.toBe(0);
    /*
     * The client row itself stays. It is not this person's - other members may
     * have connected the same app - and deleting it would disconnect every one
     * of them, with no board decision behind it.
     */
    await expect(
      prisma.oauthClient.count({
        where: { clientId: CONNECTED_APP_CLIENT_ID },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.invitation.count({
        where: { personId: people.accounted, acceptedAt: null },
      }),
    ).resolves.toBe(0);
    /*
     * And the accepted one. It is a spent record of an activation rather than
     * a live way in, and the audit log already holds the fact as
     * INVITATION_ACCEPTED - so kept past the account, it would be held for no
     * purpose at all.
     */
    await expect(
      prisma.invitation.count({
        where: { personId: people.accounted, NOT: { acceptedAt: null } },
      }),
    ).resolves.toBe(0);
  });

  it("records the purge naming what was cleared and none of the values", async () => {
    const [entry, ...rest] = await purgeEntriesFor(people.due);

    expect(entry).toBeDefined();
    expect(rest).toHaveLength(0);
    // Nobody clicked this: the job ran because a date arrived.
    expect(entry?.actorPersonId).toBeNull();
    expect(entry?.context).toMatchObject({
      cleared: expect.arrayContaining(["email", "phone"]),
      retentionDaysAfterMoveOut: retentionDays,
      lastMovedOutOn: "2015-03-01",
    });

    // The entry outlives the data it describes, so a value copied into it
    // would be the one copy the purge did not reach.
    const written = JSON.stringify(entry?.context);
    expect(written).not.toContain("@exempel.se");
    expect(written).not.toContain(PHONE);
  });

  it("states the purge date the register had been promising", async () => {
    const [entry] = await purgeEntriesFor(people.due);
    const promised = computePurgeDate(MOVED_OUT, retentionDays);

    expect(entry?.context).toMatchObject({
      purgeOn: promised?.toISOString().slice(0, 10),
    });
  });
});

describe("what the purge never touches", () => {
  it("leaves the member register, the transfer, the termination and the audit log alone", async () => {
    const heldApartmentId = apartmentId(
      String(personIds.indexOf(people.archived)),
    );
    const before = {
      entries: await prisma.memberRegisterEntry.count({
        where: { personId: people.archived },
      }),
      transfers: await prisma.transfer.count({
        where: { toPersonId: people.archived },
      }),
      terminations: await prisma.termination.count({
        where: { apartmentId: heldApartmentId },
      }),
    };
    expect(before.entries).toBe(2);
    expect(before.transfers).toBe(1);
    expect(before.terminations).toBe(1);

    const outcome = await purge.purgePerson(people.archived, dueAt);
    expect(outcome).not.toBeNull();

    // Not "the query excluded them": these tables are append-only at the
    // database level, so an attempt would have raised rather than erased.
    await expect(
      prisma.memberRegisterEntry.count({
        where: { personId: people.archived },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.transfer.count({ where: { toPersonId: people.archived } }),
    ).resolves.toBe(1);
    // The termination with it, and with its reference intact: the purge clears
    // service-tier fields as well as rows, and a statutory record blanked in
    // place would be as lost as one deleted.
    const termination = await prisma.termination.findFirstOrThrow({
      where: { apartmentId: heldApartmentId },
    });
    expect(termination.reference).toBe(`Stammoprotokoll ${suffix}`);

    const entry = await prisma.memberRegisterEntry.findFirstOrThrow({
      where: { personId: people.archived, eventType: "EXIT" },
    });
    expect(entry.recordedLastName).toBe(`Gallring${suffix}`);
    expect(entry.recordedPostalStreet).toBe("Storgatan 1");
  });

  it("leaves the personal identity number, which is apartment register content", async () => {
    const after = await personRow(people.archived);

    // Confidential register content under BRL 9 kap., not service data: it is
    // masked from every screen and reachable only through the audited reveal,
    // and the retention policy does not govern it.
    expect(after.personalIdentityNumberCipher).not.toBeNull();
    expect(after.emailCipher).toBeNull();
  });
});

describe("who the purge leaves alone", () => {
  it("leaves somebody whose retention has not run out", async () => {
    await expect(
      purge.eligible(notDueAt, retentionDays),
    ).resolves.not.toContain(people.early);

    await expect(purge.purgePerson(people.early, notDueAt)).resolves.toBeNull();

    const after = await personRow(people.early);
    expect(after.emailCipher).not.toBeNull();

    // And nothing at all at an instant before the move-out itself, which is
    // the same rule read from its other end.
    const beforeTheMoveOut = new Date(MOVED_OUT.getTime() - DAY);
    await expect(
      purge.eligible(beforeTheMoveOut, retentionDays),
    ).resolves.not.toContain(people.early);
  });

  it("leaves somebody under a legal hold, and reaches them once it is released", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.held,
    );
    await expect(purge.purgePerson(people.held, dueAt)).resolves.toBeNull();
    expect((await personRow(people.held)).emailCipher).not.toBeNull();

    await holds.release({
      personId: people.held,
      reason: "Tvisten avgjord",
      actorPersonId: people.board,
    });

    // Releasing does not erase: it makes the person eligible again, and the
    // job acts on that in its own time.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.toContain(
      people.held,
    );
    await expect(purge.purgePerson(people.held, dueAt)).resolves.not.toBeNull();
    expect((await personRow(people.held)).emailCipher).toBeNull();
  });

  it("refuses a person held after the scan selected them", async () => {
    const scanned = await purge.eligible(dueAt, retentionDays);
    expect(scanned).toContain(people.raced);

    // Between the scan and the erasure, which is the window a board member
    // clicking the button falls into.
    await holds.place({
      personId: people.raced,
      reason: "Forsakringsarende",
      actorPersonId: people.board,
    });

    await expect(purge.purgePerson(people.raced, dueAt)).resolves.toBeNull();
    expect((await personRow(people.raced)).emailCipher).not.toBeNull();
  });

  it("leaves somebody who still sits on the board", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.board,
    );
    await expect(purge.purgePerson(people.board, dueAt)).resolves.toBeNull();
    expect((await personRow(people.board)).emailCipher).not.toBeNull();
  });

  it("leaves an administrator, whose account is not a residency", async () => {
    // Erasing the account of the only administrator because they moved away
    // is a lockout rather than a purge.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.administrator,
    );
    await expect(
      purge.purgePerson(people.administrator, dueAt),
    ).resolves.toBeNull();
  });

  it("leaves somebody who moved out of one apartment and lives in another", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.staying,
    );
    await expect(purge.purgePerson(people.staying, dueAt)).resolves.toBeNull();
    expect((await personRow(people.staying)).emailCipher).not.toBeNull();
  });
});

describe("issues, documents, binder entries and files the person left behind", () => {
  it("detaches them from the person and keeps every one of them", async () => {
    /*
     * Run while somebody else holds the lock on the person's issue, as a
     * reply their reporter is writing does: the purge waits for it. One that
     * did not could detach the message authors, finish, and leave the reply
     * that commits afterwards still naming a person the erasure is recorded as
     * having cleared.
     */
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: (pid: number) => void = () => undefined;
    const holding = new Promise<number>((resolve) => {
      reached = resolve;
    });
    const reply = prisma.$transaction(
      async (tx) => {
        await lockIssue(tx, issueId);
        reached(await backendPid(tx));
        await gate;
      },
      { timeout: 30_000 },
    );
    const holder = await holding;

    /*
     * And while a sending by the person holds the lock it takes before it
     * checks the handler's access: once the issue's lock is released, the
     * purge waits for this one before it detaches the work orders. One that
     * did not could detach, finish, and leave a sending that read the role
     * before it was removed still naming the sender after the commit.
     */
    let releaseSending: () => void = () => undefined;
    const sendingGate = new Promise<void>((resolve) => {
      releaseSending = resolve;
    });
    let reachedSending: (pid: number) => void = () => undefined;
    const holdingSending = new Promise<number>((resolve) => {
      reachedSending = resolve;
    });
    const sending = prisma.$transaction(
      async (tx) => {
        await lockWorkOrderSender(tx, people.referenced);
        reachedSending(await backendPid(tx));
        await sendingGate;
      },
      { timeout: 30_000 },
    );
    const sendingHolder = await holdingSending;

    let finished = false;
    const erasure = purge.purgePerson(people.referenced, dueAt).finally(() => {
      finished = true;
    });
    let waited = false;
    let waitedForSender = false;
    try {
      await waitFor(
        async () => finished || (await waitersBehind(prisma, holder)) > 0,
      );
      waited = !finished;
      release();
      await reply;
      await waitFor(
        async () =>
          finished || (await waitersBehind(prisma, sendingHolder)) > 0,
      );
      waitedForSender = !finished;
    } finally {
      release();
      releaseSending();
      await reply;
      await sending;
    }
    expect(waited, "the purge waits for the issue's lock").toBe(true);
    expect(
      waitedForSender,
      "the purge waits for the sender's lock before it detaches their work orders",
    ).toBe(true);
    const outcome = await erasure;

    expect(outcome?.issuesDetachedFromPerson).toBe(2);
    expect(outcome?.documentsDetachedFromPerson).toBe(1);
    expect(outcome?.binderEntriesDetachedFromPerson).toBe(1);
    // Three files: the document's own, the photograph on the issue and the
    // binder entry's.
    expect(outcome?.mediaDetachedFromPerson).toBe(3);

    const issue = await prisma.issue.findUniqueOrThrow({
      where: { id: issueId },
      select: {
        reporterPersonId: true,
        description: true,
        assigneePersonId: true,
        enteredByPersonId: true,
        enteredByHandler: true,
      },
    });
    /*
     * Its free text still stands, so it keeps its reporter: the one reference
     * that lets an erasure request granted later find it, and the access
     * report show it (ADR 0057). The finished one is detached, with the
     * ciphers a public-form reporter would have left.
     */
    expect(issue.reporterPersonId).toBe(people.referenced);
    await expect(
      prisma.issue.findUniqueOrThrow({
        where: { id: finishedIssueId },
        select: { reporterPersonId: true },
      }),
    ).resolves.toEqual({ reporterPersonId: null });
    // What the person said about letting somebody into their home goes with
    // them where the purge detaches them, and the issue it was said on stays.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: entryIssueId },
        select: {
          reporterPersonId: true,
          entryAnswer: true,
          entryNote: true,
          entryPets: true,
          entryMasterKey: true,
          entryUntil: true,
        },
      }),
    ).toEqual({
      reporterPersonId: null,
      entryAnswer: null,
      entryNote: null,
      entryPets: null,
      entryMasterKey: null,
      entryUntil: null,
    });
    // Where the text still stands the person stays on the issue, as the
    // reference an erasure request granted later finds it by, and what they
    // said about their home stays with them until the issue closes.
    expect(
      await prisma.issue.findUniqueOrThrow({
        where: { id: standingEntryIssueId },
        select: {
          reporterPersonId: true,
          entryAnswer: true,
          entryNote: true,
          entryPets: true,
          entryMasterKey: true,
          entryUntil: true,
          apartmentId: true,
        },
      }),
    ).toEqual({
      reporterPersonId: people.referenced,
      entryAnswer: "YES",
      entryNote: "Nyckel hos grannen",
      entryPets: false,
      entryMasterKey: true,
      entryUntil: new Date("2027-12-31"),
      apartmentId: apartmentId(String(personIds.indexOf(people.referenced))),
    });
    // Unassigned and no longer entered by anybody in particular, and the issue
    // still says that a handler entered it.
    expect(issue.assigneePersonId).toBeNull();
    expect(issue.enteredByPersonId).toBeNull();
    expect(issue.enteredByHandler).toBe(true);
    // The type's default assignee is a link to the person as well.
    expect(
      (
        await prisma.issueType.findUniqueOrThrow({
          where: { id: issueTypeId },
          select: { defaultAssigneePersonId: true },
        })
      ).defaultAssigneePersonId,
    ).toBeNull();
    // The record of the problem stays, and so does what the reporter wrote -
    // including the neighbour it names - until the issue's own clock removes
    // it. That is why this is a detachment and why nothing calls the result
    // anonymous.
    expect(issue.description).toBe(ISSUE_DESCRIPTION);

    // The conversation is detached from its writer as the issue is, and its
    // words stay with the issue, on the issue's own clock (ADR 0057).
    const message = await prisma.issueMessage.findFirstOrThrow({
      where: { issueId },
      select: { authorPersonId: true, body: true },
    });
    const note = await prisma.issueNote.findFirstOrThrow({
      where: { issueId, body: ISSUE_MESSAGE },
      select: { authorPersonId: true, body: true },
    });
    expect(message).toEqual({ authorPersonId: null, body: ISSUE_MESSAGE });
    expect(note).toEqual({ authorPersonId: null, body: ISSUE_MESSAGE });
    // Somebody else's note on the same issue keeps its writer.
    await expect(
      prisma.issueNote.findUniqueOrThrow({
        where: { id: otherNoteId },
        select: { authorPersonId: true, body: true },
      }),
    ).resolves.toEqual({ authorPersonId: people.board, body: OTHER_NOTE });
    expect(outcome?.cleared).toContain("issueConversation");

    // The work order stays with whom it went to and what it said, and stops
    // naming the handler who sent it.
    expect(outcome?.cleared).toContain("workOrders");
    await expect(
      prisma.workOrder.findUniqueOrThrow({
        where: { id: workOrderId },
        select: { sentByPersonId: true, body: true, recipientName: true },
      }),
    ).resolves.toEqual({
      sentByPersonId: null,
      body: "Spola avloppet.",
      recipientName: `Rormokare ${suffix}`,
    });

    const document = await prisma.document.findUniqueOrThrow({
      where: { id: documentId },
      select: { uploadedByPersonId: true, title: true },
    });
    expect(document.uploadedByPersonId).toBeNull();
    expect(document.title).toBe(`Stadgar ${suffix}`);

    /*
     * The entry stays with the apartment, and so does the capacity it was
     * filed in: what the next household reads is that the board decided
     * something, or that a tenant-owner put a drawing in, and neither survives
     * as a fact if the row only ever said who the person was.
     */
    const binderEntry = await prisma.apartmentDocument.findUniqueOrThrow({
      where: { id: binderEntryId },
      select: { filedByPersonId: true, filedAs: true, title: true },
    });
    expect(binderEntry.filedByPersonId).toBeNull();
    expect(binderEntry.filedAs).toBe("TENANT_OWNER");
    expect(binderEntry.title).toBe(`Ritning badrum ${suffix}`);

    const photo = await prisma.mediaFile.findUniqueOrThrow({
      where: { id: photoFileId },
      select: { uploadedByPersonId: true, storageKey: true },
    });
    expect(photo.uploadedByPersonId).toBeNull();
    // Nothing is removed from storage. A photograph of a stairwell is the
    // record of the problem, and the flag saying somebody may be in it is a
    // default the upload path writes rather than a finding about the picture.
    expect(photo.storageKey).toBe(`purge/${suffix}/trapphus.jpg`);
  });

  it("selects a person whose only remaining trace is a row it detaches", async () => {
    // reporterPersonId and uploadedByPersonId are plain columns, so no relation
    // filter reaches them: without the reference scan this person would never
    // be selected at all and their link would stay for good.
    const [entry] = await purgeEntriesFor(people.referenced);

    expect(entry?.context).toMatchObject({
      issuesDetachedFromPerson: 2,
      documentsDetachedFromPerson: 1,
      binderEntriesDetachedFromPerson: 1,
      mediaDetachedFromPerson: 3,
    });
  });

  it("does not select them a second time once the links are gone", async () => {
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.referenced,
    );
  });
});

describe("a restriction of processing", () => {
  it("suspends the purge as a legal hold does", async () => {
    // GDPR art. 18(2) lets the association store the data and little else, so
    // erasing it is the one act the person has asked it not to perform.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.restricted,
    );
    await expect(
      purge.purgePerson(people.restricted, dueAt),
    ).resolves.toBeNull();
  });
});

describe("an erasure request the board has granted", () => {
  it("brings the purge forward before the retention window has run out", async () => {
    // notDueAt is inside the window, so nothing but the request could select
    // this person: that is what "brings the purge forward" means.
    await expect(purge.eligible(notDueAt, retentionDays)).resolves.toContain(
      people.requested,
    );

    const outcome = await purge.purgePerson(
      people.requested,
      notDueAt,
      retentionDays,
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toEqual(expect.arrayContaining(["email"]));
  });

  it("closes the request it executed, without naming a person who closed it", async () => {
    const request = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId: people.requested, kind: "ERASURE" },
      select: {
        executedAt: true,
        closedAt: true,
        closeReason: true,
        closedByPersonId: true,
      },
    });

    expect(request.executedAt).not.toBeNull();
    expect(request.closedAt).not.toBeNull();
    expect(request.closeReason).toBe("purged");
    // The absence of a person is what distinguishes the purge executing a
    // request from a board member closing it by hand.
    expect(request.closedByPersonId).toBeNull();
  });

  it("does not select the person again once the request is closed", async () => {
    await expect(
      purge.eligible(notDueAt, retentionDays),
    ).resolves.not.toContain(people.requested);
  });

  it("reaches somebody who never held a residency at all", async () => {
    /*
     * The scheduled job leaves them alone for ever: there is no move-out to
     * anchor a purge date on. A granted request is a different authority - it
     * names this person, and an external board member's contact details are
     * service data like anybody else's.
     */
    const outcome = await purge.purgePerson(
      people.neverResident,
      notDueAt,
      retentionDays,
    );

    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toEqual(expect.arrayContaining(["email"]));
  });
});

describe("closing a granted erasure request on evidence", () => {
  it("erases its own share and leaves the request open while a job ahead of it owes rows", async () => {
    /*
     * The defect this exists for. Running the domain purges first settles how
     * quickly a granted erasure finishes and not whether it finished: the
     * motion purge threw for this person, or stopped at its bound before
     * reaching them, and its rows are still here. Closing the request now would
     * be the association recording an erasure it had not carried out, and no
     * later run would come back for the rest - every job that reads the request
     * selects only open ones.
     */
    const outcome = await purge.purgePerson(
      people.unfinished,
      dueAt,
      retentionDays,
    );

    expect(outcome).not.toBeNull();
    // The contact details still go tonight. What waits is the record, not the
    // erasure: holding this back would leave them on file for as long as the
    // motion did.
    expect(outcome?.cleared).toEqual(expect.arrayContaining(["email"]));
    expect(outcome?.erasureRequestClosed).toBe(false);
    expect(outcome?.erasureRemainder).toEqual([
      { domain: "motions", owed: 1, kept: 0 },
    ]);

    const request = await openErasureRequestFor(people.unfinished);
    expect(request.executedAt).toBeNull();
    expect(request.closedAt).toBeNull();
  });

  it("records what was still standing in the entry for the night it could not close", async () => {
    const [entry] = await purgeEntriesFor(people.unfinished);
    const context = entry?.context as Record<string, unknown>;

    expect(context.requested).toBe(true);
    expect(context.erasureRequestLeftOpen).toEqual([
      "motions: 1 not erased yet",
    ]);
    expect(context).not.toHaveProperty("verifiedEmptyOf");
  });

  it("writes no second entry on a night it still cannot close", async () => {
    // The person is selected every night while the request is open, and there
    // is nothing left for this job to clear. An entry each time would be one a
    // night for ever, in a table nobody can tidy.
    await expect(
      purge.purgePerson(people.unfinished, dueAt, retentionDays),
    ).resolves.toBeNull();

    await expect(purgeEntriesFor(people.unfinished)).resolves.toHaveLength(1);
  });

  it("closes the request on the next run once the rows are gone", async () => {
    // The night the motion purge finally gets through them.
    await prisma.motion.delete({ where: { id: closedMotionId } });

    const outcome = await purge.purgePerson(
      people.unfinished,
      dueAt,
      retentionDays,
    );

    expect(outcome?.erasureRequestClosed).toBe(true);
    expect(outcome?.erasureRemainder).toEqual([]);

    const request = await prisma.dataSubjectRequest.findFirstOrThrow({
      where: { personId: people.unfinished, kind: "ERASURE" },
      select: { executedAt: true, closedAt: true, closeReason: true },
    });
    expect(request.executedAt).not.toBeNull();
    expect(request.closedAt).not.toBeNull();
    expect(request.closeReason).toBe("purged");
  });

  it("names the domains it verified empty in the entry that closes it", async () => {
    const entries = await purgeEntriesFor(people.unfinished);
    const context = entries[entries.length - 1]?.context as Record<
      string,
      unknown
    >;

    /*
     * The evidence the close rests on, in the one record that outlives the
     * rows. Names and nothing out of them: this entry is exempt from every
     * purge, so a title or a line of chat copied in here would be the one copy
     * the erasure did not reach - ADR 0007.
     */
    expect(context.verifiedEmptyOf).toEqual([
      "board mailbox threads",
      "bookings",
      "event sign-ups",
      "feed",
      "issues",
      "key orders",
      "motions",
      "plugin records",
      "subletting applications",
    ]);
  });

  it("keeps the request open while a motion of theirs is still open", async () => {
    /*
     * The one row in the product a granted erasure does not reach. EFL 6 kap.
     * 15 gives the member who put it the right to have it treated at the
     * meeting, so the motion purge leaves it standing - and the request says so
     * rather than claiming an erasure that has not happened.
     */
    const outcome = await purge.purgePerson(
      people.openMotion,
      dueAt,
      retentionDays,
    );

    expect(outcome?.erasureRequestClosed).toBe(false);
    expect(outcome?.erasureRemainder).toEqual([
      {
        domain: "motions",
        owed: 0,
        kept: 1,
        keptBecause:
          "an open motion, or one on the agenda of a meeting not yet held, is a matter the association is still dealing with",
      },
    ]);

    const request = await openErasureRequestFor(people.openMotion);
    expect(request.executedAt).toBeNull();
  });

  it("leaves a held person's request open and does not touch their data", async () => {
    // A hold is the board deciding it needs the data. The request waits for the
    // hold to be released, and this job neither erases nor closes anything.
    await expect(
      purge.purgePerson(people.heldRequest, dueAt, retentionDays),
    ).resolves.toBeNull();

    expect((await personRow(people.heldRequest)).emailCipher).not.toBeNull();
    await expect(
      openErasureRequestFor(people.heldRequest),
    ).resolves.toBeDefined();
  });

  it("takes the people a granted request names before anybody the window selected", async () => {
    /*
     * The per-run bound is applied by the database, and these people are
     * selected by a flag this job clears rather than by a date. Somebody cut
     * off the end of a bounded run is somebody no later run would select, so
     * they are taken first and the window takes what is left.
     */
    const requested = await erasureRequestedPersonIds(prisma, dueAt);
    // More of them than the bound, and people the window would take besides,
    // or the ordering would hold by construction.
    expect(requested.length).toBeGreaterThan(0);
    expect((await purge.eligible(dueAt, retentionDays)).length).toBeGreaterThan(
      requested.length,
    );

    const eligible = await purge.eligible(dueAt, retentionDays, 0);

    // Every one of them, although the bound is none, and nobody the window
    // selected: the bound was spent before the window was asked.
    expect([...eligible].sort()).toEqual([...requested].sort());
  });
});

describe("running the job", () => {
  it("is idempotent: a second run writes no second entry", async () => {
    const first = await purge.purgePerson(people.twice, dueAt);
    expect(first).not.toBeNull();

    // Nothing left to erase, so the eligibility query does not select them
    // again - which is what stops a purged person collecting an entry a night
    // for ever in a table nobody can tidy.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      people.twice,
    );
    await expect(purge.purgePerson(people.twice, dueAt)).resolves.toBeNull();

    await expect(purgeEntriesFor(people.twice)).resolves.toHaveLength(1);
  });

  it("erases everybody eligible and reports what it did", async () => {
    const summary = await purge.run(dueAt);

    expect(summary.considered).toBeGreaterThanOrEqual(1);
    expect(summary.purged).toBeGreaterThanOrEqual(1);
    expect(summary.failed).toBe(0);

    expect((await personRow(people.swept)).emailCipher).toBeNull();
    // The people the rules protect are still untouched after a full run.
    expect((await personRow(people.board)).emailCipher).not.toBeNull();
    expect((await personRow(people.staying)).emailCipher).not.toBeNull();
    expect((await personRow(people.raced)).emailCipher).not.toBeNull();
  });

  it("sweeps the tokens that have run out on the same run", async () => {
    /*
     * The record of processing says an access or refresh row is erased once it
     * expires or is revoked. Nothing in the product would make that true except
     * a job that does it, and this is the run it rides - so the assertion is on
     * a whole run rather than on the sweep called by hand.
     *
     * The rows belong to a board member's account, which no rule lets the purge
     * reach: what is being shown is the sweep, not a person's erasure.
     */
    await purge.run(dueAt);

    const left = await prisma.oauthAccessToken.findMany({
      where: { clientId: SWEPT_APP_CLIENT_ID },
      select: { token: true },
    });
    // The one an app can still present stays. Deleting it would be a
    // revocation, which is a deliberate act with an entry behind it.
    expect(left.map((row) => row.token)).toEqual([
      `purge-live-access-${suffix}`,
    ]);

    await expect(
      prisma.oauthRefreshToken.count({
        where: { clientId: SWEPT_APP_CLIENT_ID },
      }),
    ).resolves.toBe(0);

    /*
     * The grant itself stays. A consent is not held on a clock: it lasts until
     * the person disconnects the app, and a sweep that removed one would
     * disconnect somebody because a token had expired.
     */
    await expect(
      prisma.oauthConsent.count({ where: { clientId: SWEPT_APP_CLIENT_ID } }),
    ).resolves.toBe(1);
  });
});

/** How many connections to this database are waiting for an advisory lock. */
async function advisoryLockWaiters(): Promise<number> {
  const [row] = await prisma.$queryRaw<{ waiting: number }[]>`
    SELECT count(*)::int AS waiting
      FROM pg_stat_activity
     WHERE datname = current_database()
       AND wait_event_type = 'Lock'
       AND wait_event = 'advisory'`;
  return row?.waiting ?? 0;
}

describe("the nightly sweep of sign-in sessions", () => {
  it("sweeps an ended session, and keeps a held person's and a restricted person's", async () => {
    /*
     * The record of processing says a signed-in session is deleted the night
     * after it ends, unless a legal hold or a restriction stands for the
     * person, and the access report says a hold suspends every purge for the
     * person it stands against. Both are true only because a run does it, so
     * the assertion is on a whole run, against the database's own reading of
     * the hold and of the restriction.
     *
     * Four rows written here rather than in the fixture, so no earlier run in
     * this file reaches them: an ended session of the board member, whom no
     * rule lets the purge reach; one of a person under a legal hold; one of a
     * person granted a restriction under art. 18; and a live one. Dated
     * against `dueAt`, the clock the run judges the end by; every session
     * another suite leaves in this database ends a month after today, long
     * after that clock.
     */
    const boardUser = await prisma.user.findUniqueOrThrow({
      where: { personId: people.board },
      select: { id: true },
    });
    const [heldUser, restrictedUser] = await Promise.all(
      [people.heldRequest, people.restricted].map((personId) =>
        prisma.user.create({
          data: {
            name: "Person Gallring",
            email: `${personId}@exempel.se`,
            personId,
          },
          select: { id: true },
        }),
      ),
    );
    const ended = new Date(dueAt.getTime() - DAY);
    const tokens = {
      ended: `purge-session-ended-${suffix}`,
      held: `purge-session-held-${suffix}`,
      restricted: `purge-session-restricted-${suffix}`,
      live: `purge-session-live-${suffix}`,
    };
    await prisma.session.createMany({
      data: [
        { token: tokens.ended, userId: boardUser.id, expiresAt: ended },
        { token: tokens.held, userId: heldUser?.id ?? "", expiresAt: ended },
        {
          token: tokens.restricted,
          userId: restrictedUser?.id ?? "",
          expiresAt: ended,
        },
        {
          token: tokens.live,
          userId: boardUser.id,
          expiresAt: new Date("2099-01-01T00:00:00.000Z"),
        },
      ],
    });

    const summary = await purge.run(dueAt);

    expect(summary.signInSessionsSwept).toBe(1);
    const left = await prisma.session.findMany({
      where: { token: { in: Object.values(tokens) } },
      select: { token: true },
    });
    expect(left.map((row) => row.token).toSorted()).toEqual(
      [tokens.held, tokens.restricted, tokens.live].toSorted(),
    );
  });

  it.each([
    {
      recorded: "a legal hold",
      // What `LegalHoldService.place` writes once it holds the key.
      write: (tx: Prisma.TransactionClient) =>
        tx.legalHold.create({
          data: {
            personId: people.board,
            reason: "Tvist om en inloggning",
            placedByPersonId: people.board,
          },
        }),
      undo: () =>
        prisma.legalHold.deleteMany({
          where: { personId: people.board, reason: "Tvist om en inloggning" },
        }),
    },
    {
      recorded: "a restriction",
      // What `DataSubjectRequestService.decide` writes on a granted
      // restriction once it holds the key.
      write: (tx: Prisma.TransactionClient) =>
        tx.person.update({
          where: { id: people.board },
          data: { processingRestrictedAt: new Date() },
        }),
      undo: () =>
        prisma.person.update({
          where: { id: people.board },
          data: { processingRestrictedAt: null },
        }),
    },
  ])(
    "keeps the sessions of a person $recorded is recorded for while the sweep runs",
    async ({ recorded, write, undo }) => {
      /*
       * The ordering, forced rather than left to timing. A concurrent
       * transaction does what the writer does - takes the person's legal hold
       * key, then writes - and holds its commit until the sweep is waiting for
       * that key. The sweep's scan has already seen an unprotected person with
       * an ended session; what it must not do is act on that reading. Taking the
       * key before it reads whether they are withheld is what makes it wait,
       * and read the committed hold or restriction afterwards.
       *
       * A sweep that read the withheld list once and deleted set-wide would not
       * wait at all: it would delete the session while the writer's row was
       * still uncommitted, finish, and the writer would stop holding its commit
       * because the sweep had settled. The assertion on the session is what
       * fails then, not a timeout.
       */
      const boardUser = await prisma.user.findUniqueOrThrow({
        where: { personId: people.board },
        select: { id: true },
      });
      const token = `purge-session-raced-${recorded.replace(/ /g, "-")}-${suffix}`;
      await prisma.session.create({
        data: {
          token,
          userId: boardUser.id,
          expiresAt: new Date(dueAt.getTime() - DAY),
        },
      });

      let sweepSettled = false;
      let writerWrote: () => void = () => undefined;
      const wrote = new Promise<void>((resolve) => {
        writerWrote = resolve;
      });

      try {
        const writer = prisma.$transaction(
          async (tx) => {
            await lockLegalHold(tx, people.board);
            await write(tx);
            writerWrote();
            const deadline = Date.now() + 10_000;
            while (!sweepSettled && (await advisoryLockWaiters()) === 0) {
              if (Date.now() > deadline) {
                throw new Error(
                  "The sweep neither waited for the legal hold key nor finished.",
                );
              }
              await new Promise((resolve) => setTimeout(resolve, 20));
            }
          },
          { timeout: 20_000 },
        );

        await wrote;
        const sweep = sweepExpiredSignInSessions(prisma, dueAt).finally(() => {
          sweepSettled = true;
        });
        await writer;
        await sweep;

        await expect(prisma.session.count({ where: { token } })).resolves.toBe(
          1,
        );
      } finally {
        await undo();
        await prisma.session.deleteMany({ where: { token } });
      }
    },
  );
});

describe("what a run says about the erasures it did not finish", () => {
  it("tells a request held open by a hold from one held open by work not done", async () => {
    const summary = await purge.run(dueAt);

    const held = summary.erasureRequestsOpen.find(
      (open) => open.personId === people.heldRequest,
    );
    const openMotion = summary.erasureRequestsOpen.find(
      (open) => open.personId === people.openMotion,
    );

    /*
     * Both are open and neither is a fault, which is the distinction the
     * summary exists to draw: a run that reported them the way it reports a
     * failure would send somebody looking for a broken job every night a hold
     * stood, and one that reported a failure the way it reports a hold would
     * hide the only case anybody has to act on.
     */
    expect(held?.status).toBe("blocked");
    expect(held?.because).toContain("a legal hold stands");
    expect(openMotion?.status).toBe("blocked");
    expect(openMotion?.because).toContain("motions: 1 kept because");

    // And a held person is not a failure: nothing threw, and the count that
    // would send somebody to the log stays at nothing.
    expect(summary.failed).toBe(0);
  });

  it("reports a request as incomplete while a job ahead of it owes rows", async () => {
    /*
     * Put the motion back, the way the night before a failing motion purge
     * leaves the database, and the same request is reported the other way.
     */
    await prisma.motion.create({
      data: {
        id: closedMotionId,
        title: `Byt portkod igen ${suffix}`,
        body: "Portkoden har varit densamma i fem ar till.",
        submittedByPersonId: people.unfinished,
        submittedAt: new Date("2015-01-10T00:00:00.000Z"),
        status: "ACKNOWLEDGED",
        closedAt: new Date("2015-05-10T00:00:00.000Z"),
      },
    });
    await prisma.dataSubjectRequest.updateMany({
      where: { personId: people.unfinished, kind: "ERASURE" },
      data: { executedAt: null, closedAt: null, closeReason: null },
    });

    const summary = await purge.run(dueAt);
    const unfinished = summary.erasureRequestsOpen.find(
      (open) => open.personId === people.unfinished,
    );

    expect(unfinished?.status).toBe("incomplete");
    expect(unfinished?.because).toBe("motions: 1 not erased yet");
  });
});

describe("an issue a work order's text still stands on", () => {
  /*
   * The reporter column is what ties the text to the person who reported the
   * issue, and the work-order purge reads a hold or a restriction placed on
   * them only through it (ADR 0057: no case whose text stands may lose its
   * selector). Detached with the rest of the person's links, a hold placed a
   * year later would reach nothing and the text would go at its ten years.
   */
  const reporter = `purge-wo-reporter-${suffix}`;
  const requester = `purge-wo-requester-${suffix}`;
  const woPersonIds = [reporter, requester];
  const woApartmentId = apartmentId("work-order");
  const reportedId = `purge-wo-issue-${suffix}`;
  const requestedId = `purge-wo-issue-requested-${suffix}`;
  // Issues of the same requester's, written after the request was carried
  // out: free text stands on each beside the work order's.
  const workOrderFirstId = `purge-wo-issue-wo-first-${suffix}`;
  const freeTextFirstId = `purge-wo-issue-text-first-${suffix}`;
  const redactedId = `purge-wo-issue-redacted-${suffix}`;
  const fileRedactedId = `purge-wo-issue-file-${suffix}`;
  const messageRedactedId = `purge-wo-issue-message-${suffix}`;
  const fileRedactedFileId = `purge-wo-file-${suffix}`;
  const laterIds = [
    workOrderFirstId,
    freeTextFirstId,
    redactedId,
    fileRedactedId,
    messageRedactedId,
  ];
  const WORK_ORDER_TEXT = "Byt packningen i koket hos grannen i 1202.";
  let issuePurge: IssuePurgeService;
  let textPurge: IssueTextPurgeService;

  /**
   * An issue the person reported, closed today, with a work order sent. Its
   * free text is already gone (an empty description, as the issue text purge
   * leaves it), so that only the work order's text keeps the reporter.
   */
  async function reportedWithWorkOrder(
    id: string,
    personId: string,
  ): Promise<void> {
    const done = await prisma.issueStatus.findFirstOrThrow({
      where: { typeId: issueTypeId, meaning: "DONE" },
      select: { id: true },
    });
    await prisma.issue.create({
      data: {
        id,
        typeId: issueTypeId,
        reporterPersonId: personId,
        description: "",
        freeTextRemovedAt: new Date(),
        statusId: done.id,
        closedAt: new Date(),
        outcome: "FIXED",
      },
    });
    await prisma.workOrder.create({
      data: {
        issueId: id,
        recipientName: `Rormokare ${suffix}`,
        recipientEmailCipher: "kept-as-it-was",
        body: WORK_ORDER_TEXT,
        deliveryStatus: "SENT",
      },
    });
  }

  /** Winds the closing back past the work order's ten years. */
  async function pastTheTenYears(id: string): Promise<void> {
    await prisma.issue.update({
      where: { id },
      data: {
        closedAt: new Date(
          Date.now() - (WORK_ORDER_BODY_RETENTION_DAYS + 1) * DAY,
        ),
      },
    });
  }

  async function reporterOf(id: string): Promise<string | null> {
    return (
      await prisma.issue.findUniqueOrThrow({
        where: { id },
        select: { reporterPersonId: true },
      })
    ).reporterPersonId;
  }

  async function textOn(id: string): Promise<string | null> {
    return (
      await prisma.workOrder.findFirstOrThrow({
        where: { issueId: id },
        select: { body: true },
      })
    ).body;
  }

  beforeAll(async () => {
    issuePurge = app.get(IssuePurgeService);
    textPurge = app.get(IssueTextPurgeService);
    await prisma.apartment.create({
      data: { id: woApartmentId, addressId, number: "3001", floor: 2 },
    });
    await seedPerson(reporter, { firstName: "Anmalare" });
    await moveOut(reporter, woApartmentId);
    // Never a resident: only a granted request ever selects them.
    await seedPerson(requester, { firstName: "Begarande" });
    await prisma.dataSubjectRequest.create({
      data: {
        personId: requester,
        kind: "ERASURE",
        requestedOn: new Date("2026-01-10T00:00:00.000Z"),
        ground: "Jag vill inte finnas kvar hos foreningen.",
        erasureGround: "NO_LONGER_NECESSARY",
        decision: "GRANTED",
        erasureException: "NONE",
        decisionGround: "Inget lagligt krav hindrar radering.",
        decidedAt: new Date("2026-01-12T00:00:00.000Z"),
        recordedByPersonId: people.board,
        decidedByPersonId: people.board,
      },
    });
    await reportedWithWorkOrder(reportedId, reporter);
    await reportedWithWorkOrder(requestedId, requester);
  });

  afterAll(async () => {
    // Before the suite's own clean-up, which removes the issue type these
    // issues are of. The work orders go with their issue.
    await cleanUp([
      () =>
        prisma.issue.deleteMany({
          where: { id: { in: [reportedId, requestedId, ...laterIds] } },
        }),
      () => prisma.mediaFile.deleteMany({ where: { id: fileRedactedFileId } }),
      () =>
        prisma.legalHold.deleteMany({
          where: { personId: { in: woPersonIds } },
        }),
      () =>
        prisma.dataSubjectRequest.deleteMany({
          where: { personId: { in: woPersonIds } },
        }),
      () =>
        prisma.residency.deleteMany({
          where: { personId: { in: woPersonIds } },
        }),
      () => prisma.person.deleteMany({ where: { id: { in: woPersonIds } } }),
      () => prisma.apartment.deleteMany({ where: { id: woApartmentId } }),
    ]);
  });

  it("keeps its reporter past the person's purge, so a hold placed later keeps the text", async () => {
    const outcome = await purge.purgePerson(reporter, dueAt, retentionDays);

    // The person's contact details go tonight; the issue keeps its reporter.
    expect(outcome).not.toBeNull();
    expect(outcome?.cleared).toContain("email");
    expect(outcome?.issuesDetachedFromPerson).toBe(0);
    expect(await reporterOf(reportedId)).toBe(reporter);
    // And the kept link selects nobody: the person is not purged again every
    // night the text stands.
    await expect(purge.eligible(dueAt, retentionDays)).resolves.not.toContain(
      reporter,
    );

    // A year on, a hold is placed on them, and then the ten years run out.
    await holds.place({
      personId: reporter,
      reason: "Tvist om vattenskadan",
      actorPersonId: people.board,
    });
    try {
      await pastTheTenYears(reportedId);

      await expect(
        issuePurge.eligibleWorkOrderTexts(
          new Date(),
          WORK_ORDER_BODY_RETENTION_DAYS,
        ),
      ).resolves.not.toContain(reportedId);
      await expect(issuePurge.purgeWorkOrderTexts(reportedId)).resolves.toBe(
        false,
      );
      expect(await textOn(reportedId)).toBe(WORK_ORDER_TEXT);
    } finally {
      await holds.release({
        personId: reporter,
        reason: "Tvisten avgjord",
        actorPersonId: people.board,
      });
    }

    // Released, the text goes. The reporter column outlives it until the
    // person purge's next run, which now selects the person and detaches it.
    await expect(issuePurge.purgeWorkOrderTexts(reportedId)).resolves.toBe(
      true,
    );
    expect(await textOn(reportedId)).toBeNull();
    expect(await reporterOf(reportedId)).toBe(reporter);

    await expect(purge.eligible(dueAt, retentionDays)).resolves.toContain(
      reporter,
    );
    const later = await purge.purgePerson(reporter, dueAt, retentionDays);
    expect(later?.issuesDetachedFromPerson).toBe(1);
    expect(await reporterOf(reportedId)).toBeNull();
  });

  it("clears the reporter of an executed erasure request with the last text", async () => {
    // The request is carried out tonight and closed. The issue keeps its
    // reporter while the text stands.
    const outcome = await purge.purgePerson(requester, notDueAt, retentionDays);
    expect(outcome).not.toBeNull();
    expect(outcome?.issuesDetachedFromPerson).toBe(0);
    expect(await reporterOf(requestedId)).toBe(requester);
    await expect(
      purge.eligible(notDueAt, retentionDays),
    ).resolves.not.toContain(requester);

    // No job selects them again, so the transaction that erases the text is
    // the one that clears the link.
    await pastTheTenYears(requestedId);
    await expect(issuePurge.purgeWorkOrderTexts(requestedId)).resolves.toBe(
      true,
    );
    expect(await textOn(requestedId)).toBeNull();
    expect(await reporterOf(requestedId)).toBeNull();

    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "issue",
        targetId: requestedId,
      },
      select: { context: true },
    });
    expect(entries.map((entry) => entry.context)).toEqual([
      {
        workOrderTexts: 1,
        retentionDaysAfterClosing: WORK_ORDER_BODY_RETENTION_DAYS,
        reporterDetached: true,
      },
    ]);
  });

  /*
   * Text written on a case after its reporter's request was carried out, as a
   * note added once the issue was reopened: the request is closed, so no job
   * erases it on the request, and it waits on the clock. The link stays while
   * either text stands, and whichever removal takes the last of them clears it.
   * Each test carries the request out itself when no earlier test did, so one
   * run alone (a name filter) fails on what it tests and not on its set-up.
   */
  async function requesterErased(): Promise<void> {
    const executed = () =>
      prisma.dataSubjectRequest.count({
        where: {
          personId: requester,
          kind: "ERASURE",
          executedAt: { not: null },
        },
      });
    if ((await executed()) === 0) {
      await purge.purgePerson(requester, notDueAt, retentionDays);
    }
    await expect(executed()).resolves.toBe(1);
  }

  async function laterIssueWithFreeText(id: string): Promise<void> {
    await requesterErased();
    await reportedWithWorkOrder(id, requester);
    await prisma.issueNote.create({
      data: { issueId: id, body: "Grannen i 1202 var inte hemma." },
    });
    await pastTheTenYears(id);
  }

  async function purgeEntriesOn(id: string) {
    const entries = await prisma.auditLogEntry.findMany({
      where: {
        action: "SERVICE_DATA_PURGED",
        targetKind: "issue",
        targetId: id,
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { context: true },
    });
    return entries.map((entry) => entry.context);
  }

  it("keeps the reporter of an executed request while the free text stands, and the text's removal clears it", async () => {
    await laterIssueWithFreeText(workOrderFirstId);

    // The work order's text goes first, at its ten years. The note still
    // stands, so the link does too.
    await expect(
      issuePurge.purgeWorkOrderTexts(workOrderFirstId),
    ).resolves.toBe(true);
    expect(await textOn(workOrderFirstId)).toBeNull();
    expect(await reporterOf(workOrderFirstId)).toBe(requester);

    // The clock then takes the note, the last text on the case, and the link
    // goes with it: no run of the person purge selects the requester again.
    await expect(
      textPurge.purgeIssue(workOrderFirstId, new Date(), 10),
    ).resolves.toBe("removed");
    expect(await reporterOf(workOrderFirstId)).toBeNull();

    expect(await purgeEntriesOn(workOrderFirstId)).toEqual([
      {
        workOrderTexts: 1,
        retentionDaysAfterClosing: WORK_ORDER_BODY_RETENTION_DAYS,
      },
      {
        layer: "freeText",
        issueMessages: 0,
        internalNotes: 1,
        files: 0,
        reporterDetached: true,
        retentionYearsAfterClosing: 10,
      },
    ]);
  });

  it("keeps the reporter of an executed request while a work order's text stands after the free text went", async () => {
    await laterIssueWithFreeText(freeTextFirstId);

    await expect(
      textPurge.purgeIssue(freeTextFirstId, new Date(), 10),
    ).resolves.toBe("removed");
    expect(await textOn(freeTextFirstId)).toBe(WORK_ORDER_TEXT);
    expect(await reporterOf(freeTextFirstId)).toBe(requester);

    await expect(issuePurge.purgeWorkOrderTexts(freeTextFirstId)).resolves.toBe(
      true,
    );
    expect(await reporterOf(freeTextFirstId)).toBeNull();
  });

  it("clears the reporter of an executed request when a handler redacts the last text", async () => {
    await requesterErased();
    await reportedWithWorkOrder(redactedId, requester);
    await prisma.workOrder.updateMany({
      where: { issueId: redactedId },
      data: { body: null },
    });
    await prisma.issue.update({
      where: { id: redactedId },
      data: { description: "Lackage under diskbanken hos grannen." },
    });

    await app
      .get(IssueRedactionService)
      .redact(people.board, redactedId, { target: "description" });
    expect(await reporterOf(redactedId)).toBeNull();

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "ISSUE_REDACTED", targetId: redactedId },
      select: { context: true },
    });
    expect(entry.context).toEqual({
      target: "description",
      reporterDetached: true,
    });
  });

  it("keeps the reporter of an executed request after a redaction of a message or a note, whose rows still stand", async () => {
    await requesterErased();
    await reportedWithWorkOrder(messageRedactedId, requester);
    await prisma.workOrder.updateMany({
      where: { issueId: messageRedactedId },
      data: { body: null },
    });
    const message = await prisma.issueMessage.create({
      data: {
        issueId: messageRedactedId,
        side: "REPORTER",
        body: "Det droppar fortfarande hos grannen i 1202.",
      },
    });
    const note = await prisma.issueNote.create({
      data: { issueId: messageRedactedId, body: "Grannen heter Karlsson." },
    });
    const redaction = app.get(IssueRedactionService);

    // A redacted message or note is an empty row until the purge takes it, and
    // the issue counts it as text standing, so the link stays after each.
    await redaction.redact(people.board, messageRedactedId, {
      target: "message",
      id: message.id,
    });
    expect(await reporterOf(messageRedactedId)).toBe(requester);
    await redaction.redact(people.board, messageRedactedId, {
      target: "note",
      id: note.id,
    });
    expect(await reporterOf(messageRedactedId)).toBe(requester);
    await expect(
      prisma.issueMessage.findUniqueOrThrow({
        where: { id: message.id },
        select: { body: true, redactedAt: true },
      }),
    ).resolves.toEqual({ body: "", redactedAt: expect.any(Date) });
    await expect(
      prisma.issueNote.findUniqueOrThrow({
        where: { id: note.id },
        select: { body: true, redactedAt: true },
      }),
    ).resolves.toEqual({ body: "", redactedAt: expect.any(Date) });

    const entries = await prisma.auditLogEntry.findMany({
      where: { action: "ISSUE_REDACTED", targetId: messageRedactedId },
      select: { context: true },
    });
    expect(entries.map((entry) => entry.context)).toEqual(
      expect.arrayContaining([
        { target: "message", id: message.id },
        { target: "note", id: note.id },
      ]),
    );
    expect(JSON.stringify(entries)).not.toContain("reporterDetached");

    // The purge of the free text takes the empty rows, the last text standing,
    // and the link goes with them.
    await pastTheTenYears(messageRedactedId);
    await expect(
      textPurge.purgeIssue(messageRedactedId, new Date(), 10),
    ).resolves.toBe("removed");
    expect(await reporterOf(messageRedactedId)).toBeNull();
  });

  it("clears the reporter of an executed request when a handler removes the last file", async () => {
    await laterIssueWithFreeText(fileRedactedId);
    // The work order's text and the note are gone already; a photograph is
    // the last free text standing, and the link stays while it does.
    await prisma.workOrder.updateMany({
      where: { issueId: fileRedactedId },
      data: { body: null },
    });
    await prisma.issueNote.deleteMany({ where: { issueId: fileRedactedId } });
    await prisma.mediaFile.create({
      data: {
        id: fileRedactedFileId,
        storageKey: `purge/${suffix}/redacted-photo.jpg`,
        encryption: "NONE",
        contentType: "image/jpeg",
        byteSize: 1024,
        checksum: `sha-redacted-photo-${suffix}`,
        fileName: "redacted-photo.jpg",
        visibility: "INTERNAL",
        requiredCapability: "issues:handle",
        uploadedByPersonId: people.board,
      },
    });
    const photo = await prisma.issuePhoto.create({
      data: { issueId: fileRedactedId, fileId: fileRedactedFileId },
    });
    expect(await reporterOf(fileRedactedId)).toBe(requester);

    await app.get(IssueRedactionService).redact(people.board, fileRedactedId, {
      target: "photo",
      id: photo.id,
    });
    expect(await reporterOf(fileRedactedId)).toBeNull();

    const entry = await prisma.auditLogEntry.findFirstOrThrow({
      where: { action: "ISSUE_REDACTED", targetId: fileRedactedId },
      select: { context: true },
    });
    expect(entry.context).toEqual({
      target: "photo",
      id: photo.id,
      reporterDetached: true,
    });
  });
});

describe("the environment the worker runs in", () => {
  it("registers no worker under test, so nothing races a suite", () => {
    // onModuleInit returns early when NODE_ENV is "test": the suites drive the
    // job with a clock of their own, and a real worker waking mid-suite would
    // erase rows a test was about to assert on.
    expect(env.NODE_ENV).toBe("test");
  });
});
