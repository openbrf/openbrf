import { describe, expect, it } from "vite-plus/test";

import type { ReportSection } from "../data-protection/section-processing";
import type { Prisma } from "../generated/prisma/client";
import { erasureSourceFacts } from "../testing/erasure-source-facts";
import { personColumns, type ColumnsOf } from "../testing/person-columns";
import type { ReportAuditAction } from "./report-audit-actions";

/**
 * That the data subject access report answers for every column that names a
 * person, as a test.
 *
 * Art. 15 is a right to what is held, and the report's own list of sections is
 * the checklist a reviewer reads (`data-subject-report.ts`). The map in
 * `section-processing.ts` holds each section to a row of the record of
 * processing activities, and cannot see the other side: a table with rows about
 * a person and no section reading it is absent from the map without anything
 * failing.
 *
 * So the schema is walked (`testing/person-columns.ts` states the rule) and
 * every column it finds must be answered for below: by the sections that read
 * the rows it reaches, by the audit actions through which the act it records
 * reaches the actor's report, or by the reason neither does. Checked in both
 * directions, for the reason `erasure-domains.spec.ts` gives about its own
 * list: an entry nothing uses is inherited by the next edit without anybody
 * deciding to keep it.
 *
 * The `satisfies` makes an entry for a model or a column that does not exist a
 * compile error, as the map's does for a section.
 */

type Coverage =
  /** Rows reached by the column are on the report, in these sections. */
  | { readonly sections: readonly [ReportSection, ...ReportSection[]] }
  /**
   * The column names who acted for the association on a row about something
   * or somebody else, and the act reaches their report through the audit log
   * as one of these actions.
   *
   * Deliberately not a section per table: the report names the act, not every
   * row a board member ever touched.
   */
  | { readonly actedAs: readonly [ReportAuditAction, ...ReportAuditAction[]] }
  /**
   * Keyed by an address the register holds nobody under, and answered by an
   * extract mailed to that address and to no other. Never on a person's
   * report: joining the row to whoever the register holds at the address would
   * attribute it to them, and an address can be shared or change hands.
   */
  | { readonly mailedToAddress: "BrokerUpdateRequestService.sendAccessReport" }
  | {
      readonly notReported:
        /** The row is a secret that opens the account. */
        | "credential"
        /** No production file writes the model. */
        | "neverWritten"
        /** Keyed by an address, which identifies nobody. */
        | "addressOnly"
        /** A named art. 15 gap, each closed in a change of its own. */
        | "gap";
    };

const COLUMN_COVERAGE = {
  // The blind index of the address, which is decrypted onto the section.
  Person: { emailIndex: { sections: ["person"] } },
  /*
   * The residency, and what is reached through the apartment it names: a
   * charge on the apartment, a fee rate and a fee notice name no person, and
   * which of them are this person's is answered by where they lived.
   */
  Residency: {
    personId: {
      sections: ["residencies", "memberCharges", "fees", "feeNotices"],
    },
  },
  BoardPosition: { personId: { sections: ["boardPositions"] } },
  SystemRole: { personId: { sections: ["systemRoles"] } },
  /*
   * The administrator who opened support access, and the one who closed it.
   * The instruction reaches their report as the act, and every request a
   * supporter made under it reaches the opener's as a SUPPORT entry (ADR 0028).
   */
  SupportAccess: {
    openedById: { actedAs: ["SUPPORT_ACCESS_OPENED"] },
    closedById: { actedAs: ["SUPPORT_ACCESS_CLOSED"] },
  },
  Invitation: {
    personId: { sections: ["invitations"] },
    // Not on the invited person's report: the act is the board member's.
    invitedById: { actedAs: ["INVITATION_SENT"] },
  },
  SignupRequest: {
    /*
     * An approved request - the name, the phone, the claimed address and the
     * apartment the person typed - is kept, and reachable from the person
     * through the SIGNUP_REQUEST_APPROVED entry whose target it is. A section
     * before its retention is decided would print "kept for good".
     */
    emailIndex: { notReported: "gap" },
    decidedById: {
      actedAs: ["SIGNUP_REQUEST_APPROVED", "SIGNUP_REQUEST_REJECTED"],
    },
  },
  /*
   * The member register entry, and the holdings read from it: a termination
   * and a lien note name an apartment and never a person.
   */
  MemberRegisterEntry: {
    personId: {
      sections: ["memberRegisterEntries", "terminations", "lienNotes"],
    },
  },
  /*
   * Both parties to a transfer, and what hangs off the transfer: a reversal
   * and a reporting obligation name the event rather than a person.
   */
  Transfer: {
    fromPersonId: {
      sections: ["transfers", "transferReversals", "registerReportObligations"],
    },
    toPersonId: {
      sections: ["transfers", "transferReversals", "registerReportObligations"],
    },
  },
  AuditLogEntry: {
    actorPersonId: { sections: ["auditEntries"] },
    targetPersonId: { sections: ["auditEntries"] },
  },
  User: { personId: { sections: ["account"] } },
  Session: { userId: { sections: ["signInSessions"] } },
  // The password hash. That a password exists is true of every account.
  Account: { userId: { notReported: "credential" } },
  // The TOTP secret and the backup codes; `account.twoFactorEnabled` says so.
  TwoFactor: { userId: { notReported: "credential" } },
  // Inside the account section: its name, its date and whether it is synced.
  Passkey: { userId: { sections: ["account"] } },
  /*
   * The administrator who registered the client by hand, through the one
   * route that registers one and records the act with them as actor. A client
   * that registers itself from its metadata document names no account.
   */
  OauthClient: { userId: { actedAs: ["OAUTH_CLIENT_REGISTERED"] } },
  // A board member issued or revoked a device token; the token names a device,
  // never a person. A revocation the plugin made with no person asking names
  // nobody.
  PluginDeviceToken: {
    issuedByPersonId: { actedAs: ["DEVICE_TOKEN_ISSUED"] },
    revokedByPersonId: { actedAs: ["DEVICE_TOKEN_REVOKED"] },
  },
  // The date only: the newest token issued for a grant is `lastUsedAt`.
  OauthRefreshToken: { userId: { sections: ["connectedApps"] } },
  OauthAccessToken: { userId: { sections: ["connectedApps"] } },
  OauthConsent: { userId: { sections: ["connectedApps"] } },
  // An upload of the member list is not audited; the session expires.
  ImportSession: { createdById: { notReported: "gap" } },
  MediaFile: { uploadedByPersonId: { actedAs: ["MEDIA_UPLOADED"] } },
  PublicationConsent: {
    personId: { sections: ["publicationConsents"] },
    recordedByPersonId: { actedAs: ["CONSENT_RECORDED"] },
  },
  Issue: {
    reporterPersonId: { sections: ["issues"] },
    /*
     * A report filed without an account keeps the address it gave, and an
     * address identifies nobody: two people can share one, and one can change
     * hands.
     */
    reporterEmailIndex: { notReported: "addressOnly" },
  },
  Document: { uploadedByPersonId: { sections: ["documents"] } },
  ApartmentDocument: { filedByPersonId: { sections: ["apartmentDocuments"] } },
  LegalHold: {
    personId: { sections: ["legalHolds"] },
    placedByPersonId: { actedAs: ["LEGAL_HOLD_PLACED"] },
    releasedByPersonId: { actedAs: ["LEGAL_HOLD_RELEASED"] },
  },
  PersonalDataBreach: {
    decidedByPersonId: { actedAs: ["PERSONAL_DATA_BREACH_DECIDED"] },
    closedByPersonId: { actedAs: ["PERSONAL_DATA_BREACH_CLOSED"] },
    recordedByPersonId: { actedAs: ["PERSONAL_DATA_BREACH_RECORDED"] },
  },
  PersonalDataBreachSubject: {
    personId: { sections: ["personalDataBreaches"] },
  },
  ProcessingActivity: {
    recordedByPersonId: { actedAs: ["PROCESSING_ACTIVITY_RECORDED"] },
    // Written by the entry that records the row as well as by a change to it.
    updatedByPersonId: {
      actedAs: ["PROCESSING_ACTIVITY_UPDATED", "PROCESSING_ACTIVITY_RECORDED"],
    },
  },
  ProcessorAgreement: {
    endedByPersonId: { actedAs: ["PROCESSOR_AGREEMENT_ENDED"] },
    recordedByPersonId: { actedAs: ["PROCESSOR_AGREEMENT_RECORDED"] },
  },
  DataSubjectRequest: {
    personId: { sections: ["dataSubjectRequests"] },
    decidedByPersonId: { actedAs: ["DATA_SUBJECT_REQUEST_DECIDED"] },
    closedByPersonId: { actedAs: ["DATA_SUBJECT_REQUEST_CLOSED"] },
    recordedByPersonId: { actedAs: ["DATA_SUBJECT_REQUEST_RECORDED"] },
  },
  ContactSubmission: {
    // The contact form's sender, by the address they gave.
    emailIndex: { notReported: "addressOnly" },
    // Marking a message handled writes no audit entry.
    handledByPersonId: { notReported: "gap" },
  },
  // A broker asking for updated facts, by the address they gave.
  BrokerUpdateRequest: {
    emailIndex: {
      mailedToAddress: "BrokerUpdateRequestService.sendAccessReport",
    },
  },
  News: {
    mailingRequestedByPersonId: { actedAs: ["NEWS_MAILING_REQUESTED"] },
    // The entry that creates the item carries `created: true`.
    authorPersonId: { actedAs: ["NEWS_CONTENT_CHANGED"] },
  },
  NewsDelivery: { personId: { sections: ["newsDeliveries"] } },
  Booking: { bookedByPersonId: { sections: ["bookings"] } },
  Event: { authorPersonId: { actedAs: ["EVENT_SERIES_CREATED"] } },
  Motion: {
    submittedByPersonId: { sections: ["motions"] },
    closedByPersonId: { actedAs: ["MOTION_ACKNOWLEDGED", "MOTION_WITHDRAWN"] },
  },
  EventSignup: { personId: { sections: ["eventSignups"] } },
  MeetingDecision: {
    recordedByPersonId: { actedAs: ["MEETING_DECISION_RECORDED"] },
  },
  MeetingAttendance: {
    personId: { sections: ["meetingAttendances"] },
    /*
     * Printed on the assistant's report as an identifier, but the member they
     * came with is not told on theirs: the attendance entry targets the
     * assistant only.
     */
    onBehalfOfPersonId: { notReported: "gap" },
  },
  ProxyAuthorisation: {
    memberPersonId: { sections: ["proxyAuthorisations"] },
    proxyHolderPersonId: { sections: ["proxyAuthorisations"] },
    recordedByPersonId: { actedAs: ["MEETING_PROXY_REGISTERED"] },
  },
  /*
   * Nothing outside a test writes `meeting_vote`; the model comment says the
   * section arrives with the module that casts a vote. The last case below
   * fails the day a production file starts writing it.
   */
  MeetingVote: { voterPersonId: { notReported: "neverWritten" } },
  MeetingNotice: { issuedByPersonId: { actedAs: ["MEETING_NOTICE_ISSUED"] } },
  MeetingNoticeDelivery: {
    personId: { sections: ["meetingNoticeDeliveries"] },
  },
  MemberCharge: {
    personId: { sections: ["memberCharges"] },
    recordedByPersonId: { actedAs: ["MEMBER_CHARGE_RECORDED"] },
  },
  BoardMailboxThread: {
    /*
     * The address an envelope asserted. The thread reaches the report through
     * `correspondentPersonId`, which the mailbox establishes on arrival.
     */
    correspondentEmailIndex: { notReported: "addressOnly" },
    correspondentPersonId: { sections: ["boardMailboxThreads"] },
    // Taken by hand, or by answering a thread nobody had taken.
    takenByPersonId: {
      actedAs: ["BOARD_MAILBOX_THREAD_TAKEN", "BOARD_MAILBOX_REPLY_SENT"],
    },
    closedByPersonId: { actedAs: ["BOARD_MAILBOX_THREAD_CLOSED"] },
  },
  BoardMailboxMessage: {
    sentByPersonId: { actedAs: ["BOARD_MAILBOX_REPLY_SENT"] },
  },
  SubletApplication: {
    appliedByPersonId: { sections: ["subletApplications"] },
    closedByPersonId: {
      actedAs: [
        "SUBLET_APPLICATION_CONSENTED",
        "SUBLET_APPLICATION_REFUSED",
        "SUBLET_APPLICATION_WITHDRAWN",
      ],
    },
  },
  KeyOrder: {
    orderedByPersonId: { sections: ["keyOrders"] },
    closedByPersonId: {
      actedAs: [
        "KEY_ORDER_HANDED_OVER",
        "KEY_ORDER_DECLINED",
        "KEY_ORDER_WITHDRAWN",
      ],
    },
  },
  // Only a group has a maker; Alla and Styrelsen are derived from the
  // registers.
  Audience: { createdByPersonId: { actedAs: ["CHAT_GROUP_CREATED"] } },
  /*
   * A post written as Styrelsen is on its writer's report too, with its news
   * item's title: the row names them whichever way they wrote it.
   */
  Post: {
    authorPersonId: { sections: ["feed"] },
    struckByPersonId: { actedAs: ["CHAT_MESSAGE_STRUCK"] },
  },
  /*
   * A comment under any post, a news item's included. Struck from the news
   * screen's thread, which is the only place a comment is struck today.
   */
  PostComment: {
    authorPersonId: { sections: ["comments"] },
    struckByPersonId: { actedAs: ["NEWS_COMMENT_HIDDEN"] },
  },
  /*
   * What a person liked and which posts they opened, counted on the audience
   * each sits in: every such row names somebody else's words.
   */
  PostLike: { personId: { sections: ["feed"] } },
  PostCommentLike: { personId: { sections: ["feed"] } },
  PostRead: { personId: { sections: ["feed"] } },
  // The read marker, which is a field of the audience on the report.
  AudienceRead: { personId: { sections: ["feed"] } },
  GroupMember: {
    personId: { sections: ["feed"] },
    // Somebody else, or the person who made the group putting themselves in it.
    addedByPersonId: {
      actedAs: ["CHAT_GROUP_MEMBER_ADDED", "CHAT_GROUP_CREATED"],
    },
  },
  PostReport: {
    reporterPersonId: { sections: ["postReports"] },
    resolvedByPersonId: { sections: ["postReports"] },
  },
  /*
   * A pending change lives a week at most and only while it waits. Proposing is
   * an act of the person's, on their report as PENDING_CHANGE_PROPOSED with the
   * action named, and so is each way it ends; the input is never copied there.
   */
  PendingChange: {
    proposedByPersonId: {
      actedAs: [
        "PENDING_CHANGE_PROPOSED",
        "PENDING_CHANGE_CONFIRMED",
        "PENDING_CHANGE_REJECTED",
        "PENDING_CHANGE_EXPIRED",
      ],
    },
  },
  Fee: { recordedByPersonId: { actedAs: ["FEE_RECORDED"] } },
  FeeNotification: {
    issuedByPersonId: { actedAs: ["FEE_NOTIFICATION_ISSUED"] },
  },
} as const satisfies {
  readonly [M in Prisma.ModelName]?: {
    readonly [C in ColumnsOf[M]]?: Coverage;
  };
};

/**
 * The art. 15 gaps named rather than closed, written out so a new one cannot
 * be declared without editing this list in review - as a new document part
 * cannot be declared without editing `section-processing.spec.ts`.
 *
 * ADR 0019 names each, with what closing it waits on.
 */
const NAMED_GAPS = [
  "ContactSubmission.handledByPersonId",
  "ImportSession.createdById",
  "MeetingAttendance.onBehalfOfPersonId",
  "SignupRequest.emailIndex",
];

/** Every entry, as `<Model>.<column>` and what answers for it. */
const ENTRIES = Object.entries(
  COLUMN_COVERAGE as Record<string, Record<string, Coverage>>,
).flatMap(([model, columns]) =>
  Object.entries(columns).map(
    ([column, coverage]) => [`${model}.${column}`, coverage] as const,
  ),
);

const COVERED = new Map<string, Coverage>(ENTRIES);

const walked = personColumns();

describe("what the access report answers for", () => {
  it("is asserted over a schema with person columns in it", () => {
    // Without this, a moved schema or a broken rule would turn every assertion
    // below into one that passes because it found nothing to check.
    expect(walked.length).toBeGreaterThan(80);
    expect(walked).toContain("Person.emailIndex");
    expect(walked).toContain("Session.userId");
  });

  it("answers for every column that names a person", () => {
    const unanswered = walked
      .filter((column) => !COVERED.has(column))
      .map(
        (column) =>
          `${column} names a person and nothing says what the data subject ` +
          "access report does with it: give it the section that reads it, the " +
          "audit action the act it records reaches the actor's report as, or " +
          "the reason none does, in COLUMN_COVERAGE",
      );

    expect(unanswered).toEqual([]);
  });

  it("lists only columns that name a person", () => {
    const strangers = ENTRIES.filter(
      ([column]) => !walked.includes(column),
    ).map(
      ([column]) =>
        `${column} is in COLUMN_COVERAGE and the walk of the schema does not ` +
        "find it: take it off the list, or it answers for nothing",
    );

    expect(strangers).toEqual([]);
  });

  it("names the gaps it has not closed, and no others", () => {
    const gaps = ENTRIES.filter(
      ([, coverage]) =>
        "notReported" in coverage && coverage.notReported === "gap",
    )
      .map(([column]) => column)
      .toSorted();

    expect(gaps).toEqual(NAMED_GAPS);
  });

  it("answers by a mailed extract only where one is built", () => {
    // broker-update-requests.int-spec.ts proves the extract carries the rows.
    const mailed = ENTRIES.filter(
      ([, coverage]) => "mailedToAddress" in coverage,
    )
      .map(([column]) => column)
      .toSorted();

    expect(mailed).toEqual(["BrokerUpdateRequest.emailIndex"]);
  });

  it("calls unwritten only what nothing writes", () => {
    /*
     * "Never written" is a fact about the code, and the walk of the source the
     * erasure specs use is what can state it. A production file that starts to
     * write the model is the moment the column needs a section or another
     * reason.
     */
    const facts = erasureSourceFacts();
    const offenders = ENTRIES.filter(
      ([, coverage]) =>
        "notReported" in coverage && coverage.notReported === "neverWritten",
    ).flatMap(([column]) => {
      const model = column.slice(0, column.indexOf("."));
      const delegate = `${model.charAt(0).toLowerCase()}${model.slice(1)}`;
      return facts
        .filter((file) => file.writtenDelegates.includes(delegate))
        .map(
          (file) =>
            `${column} is listed as never written, and ${file.path} writes ` +
            `${delegate}: give it the section that reads it`,
        );
    });

    // A walk that found no writes at all would pass this for every entry.
    expect(facts.flatMap((file) => file.writtenDelegates)).toContain(
      "meetingAttendance",
    );
    expect(offenders).toEqual([]);
  });
});
