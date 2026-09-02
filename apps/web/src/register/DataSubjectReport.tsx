import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement, ReactNode } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import {
  DATA_CELL,
  DOCUMENT,
  DOCUMENT_ATTRIBUTE,
  FIELD_GRID,
  FIELD_LABEL,
  FIELD_TEXT,
  FIELD_VALUE,
  HEAD_CELL,
  ROW,
  SECTION,
  SECTION_HEADING,
  STAMP,
  TABLE,
  TABLE_SCROLL,
  TEXT_CELL,
} from "./report-document";
import {
  type ConsentScope,
  type DataSubjectReport as Report,
  type RegisterReportKind,
  type ReportAuditAction,
  type TerminationKind,
  fetchDataSubjectReport,
} from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

/**
 * The data subject access report (registerutdrag, GDPR art. 15).
 *
 * A document rather than a screen: it is printed and handed to the person it is
 * about, so it renders on a light surface, states what it is, and drops the
 * application frame when it prints. It replaces the board while it is open
 * rather than sitting beside it, because a document photographed with a
 * register behind it is a document with somebody else's data on the same page.
 *
 * The report is fetched once, on mount, and never on a render or a hover: every
 * request decrypts a personal identity number and writes an audit entry naming
 * whoever asked. Reopening it is a second deliberate act and a second entry,
 * which is the intended cost.
 *
 * Nothing here offers to send it. There is no email path in the API and there
 * is no button for one: the board member who produced it prints it and hands it
 * over.
 */

const ROLE_LABEL = {
  MEMBER: "register.sign.member",
  RESIDENT: "register.sign.resident",
} as const satisfies Record<string, TranslationKey>;

const POSITION_LABEL = {
  CHAIR: "register.sign.chair",
  BOARD_MEMBER: "register.sign.boardMember",
  DEPUTY_BOARD_MEMBER: "register.sign.deputyBoardMember",
} as const satisfies Record<string, TranslationKey>;

const SYSTEM_ROLE_LABEL = {
  ADMIN: "register.person.systemRole.admin",
  PROPERTY_MANAGER: "register.person.systemRole.propertyManager",
} as const satisfies Record<string, TranslationKey>;

const CONSENT_SCOPE_LABEL = {
  PHOTO: "register.person.consentScope.photo",
  NAME_ON_SITE: "register.person.consentScope.nameOnSite",
  BOARD_ROSTER: "register.person.consentScope.boardRoster",
} as const satisfies Record<ConsentScope, TranslationKey>;

const ISSUE_STATUS_LABEL = {
  NEW: "issues.status.NEW",
  IN_PROGRESS: "issues.status.IN_PROGRESS",
  DONE: "issues.status.DONE",
} as const satisfies Record<string, TranslationKey>;

const DOCUMENT_AUDIENCE_LABEL = {
  BOARD: "documents.audience.board",
  MEMBER: "documents.audience.member",
  PUBLIC: "documents.audience.public",
} as const satisfies Record<string, TranslationKey>;

const TERMINATION_KIND_LABEL = {
  GENERAL_MEETING_DECISION:
    "registers.apartment.terminations.kind.GENERAL_MEETING_DECISION",
  BUILDING_TRANSFERRED:
    "registers.apartment.terminations.kind.BUILDING_TRANSFERRED",
} as const satisfies Record<TerminationKind, TranslationKey>;

const REGISTER_REPORT_KIND_LABEL = {
  TRANSFER: "register.person.report.reportKind.TRANSFER",
  TERMINATION: "register.person.report.reportKind.TERMINATION",
} as const satisfies Record<RegisterReportKind, TranslationKey>;

const BOOKING_STATUS_LABEL = {
  BOOKED: "bookings.status.BOOKED",
  CANCELLED: "bookings.status.CANCELLED",
  RELEASED: "bookings.status.RELEASED",
} as const satisfies Record<string, TranslationKey>;

const MOTION_STATUS_LABEL = {
  SUBMITTED: "motions.status.SUBMITTED",
  ACKNOWLEDGED: "motions.status.ACKNOWLEDGED",
  WITHDRAWN: "motions.status.WITHDRAWN",
} as const satisfies Record<string, TranslationKey>;

/*
 * The general meeting's own vocabulary, under the meetings namespace rather
 * than the report's, on the precedent of the booking status and the motion
 * status above: an enum the module already has a word for keeps that word, so
 * the document and the board's own screens cannot come to call the same thing
 * two things.
 */
const MEETING_KIND_LABEL = {
  ORDINARY: "meetings.kind.ORDINARY",
  EXTRAORDINARY: "meetings.kind.EXTRAORDINARY",
} as const satisfies Record<string, TranslationKey>;

const ATTENDANCE_CAPACITY_LABEL = {
  MEMBER: "meetings.capacity.MEMBER",
  PROXY_HOLDER: "meetings.capacity.PROXY_HOLDER",
  ASSISTANT: "meetings.capacity.ASSISTANT",
} as const satisfies Record<string, TranslationKey>;

const ATTENDANCE_MODE_LABEL = {
  IN_PERSON: "meetings.mode.IN_PERSON",
  REMOTE: "meetings.mode.REMOTE",
} as const satisfies Record<string, TranslationKey>;

const PROXY_GROUND_LABEL = {
  MEMBER: "meetings.ground.MEMBER",
  SPOUSE_OR_COHABITANT: "meetings.ground.SPOUSE_OR_COHABITANT",
  BYLAWS: "meetings.ground.BYLAWS",
} as const satisfies Record<string, TranslationKey>;

/*
 * Every audit action, not the ones a resident is likely to have. The report
 * lists entries both about the person and of what they did, so a board
 * member's reaches the plugin and theme actions as readily as a resident's
 * reaches the register ones.
 *
 * A total map rather than a lookup with the code as its fallback: this column
 * is printed and handed to the person the report is about, and a fallback
 * would put PROTECTED_DATA_REVEALED on that page in English the day somebody
 * adds an action to the enum. Total, it is a build failure instead.
 */
const AUDIT_ACTION_LABEL = {
  PROTECTED_DATA_REVEALED:
    "register.person.report.action.PROTECTED_DATA_REVEALED",
  PROTECTED_FLAG_CHANGED:
    "register.person.report.action.PROTECTED_FLAG_CHANGED",
  MEMBER_REGISTER_EXTRACT_GENERATED:
    "register.person.report.action.MEMBER_REGISTER_EXTRACT_GENERATED",
  APARTMENT_REGISTER_EXTRACT_GENERATED:
    "register.person.report.action.APARTMENT_REGISTER_EXTRACT_GENERATED",
  APARTMENT_REGISTER_LIEN_NOTED:
    "register.person.report.action.APARTMENT_REGISTER_LIEN_NOTED",
  APARTMENT_REGISTER_LIEN_RELEASED:
    "register.person.report.action.APARTMENT_REGISTER_LIEN_RELEASED",
  APARTMENT_REGISTER_TERMINATION_RECORDED:
    "register.person.report.action.APARTMENT_REGISTER_TERMINATION_RECORDED",
  APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED:
    "register.person.report.action.APARTMENT_REGISTER_MEMBERSHIP_DECISION_RECORDED",
  ASSOCIATION_PROPERTY_DESIGNATION_RECORDED:
    "register.person.report.action.ASSOCIATION_PROPERTY_DESIGNATION_RECORDED",
  DATA_EXPORTED: "register.person.report.action.DATA_EXPORTED",
  SYSTEM_ROLE_GRANTED: "register.person.report.action.SYSTEM_ROLE_GRANTED",
  SYSTEM_ROLE_REVOKED: "register.person.report.action.SYSTEM_ROLE_REVOKED",
  PLUGIN_INSTALLED: "register.person.report.action.PLUGIN_INSTALLED",
  PLUGIN_REMOVED: "register.person.report.action.PLUGIN_REMOVED",
  THEME_INSTALLED: "register.person.report.action.THEME_INSTALLED",
  THEME_ACTIVATED: "register.person.report.action.THEME_ACTIVATED",
  THEME_COMPOSED: "register.person.report.action.THEME_COMPOSED",
  MEDIA_UPLOADED: "register.person.report.action.MEDIA_UPLOADED",
  MEDIA_DELETED: "register.person.report.action.MEDIA_DELETED",
  MEDIA_ACCESSED: "register.person.report.action.MEDIA_ACCESSED",
  INVITATION_SENT: "register.person.report.action.INVITATION_SENT",
  INVITATION_ACCEPTED: "register.person.report.action.INVITATION_ACCEPTED",
  SIGNUP_REQUEST_APPROVED:
    "register.person.report.action.SIGNUP_REQUEST_APPROVED",
  SIGNUP_REQUEST_REJECTED:
    "register.person.report.action.SIGNUP_REQUEST_REJECTED",
  CONSENT_RECORDED: "register.person.report.action.CONSENT_RECORDED",
  CONSENT_WITHDRAWN: "register.person.report.action.CONSENT_WITHDRAWN",
  PAGE_PUBLISHED: "register.person.report.action.PAGE_PUBLISHED",
  PAGE_VISIBILITY_CHANGED:
    "register.person.report.action.PAGE_VISIBILITY_CHANGED",
  NEWS_PUBLISHED: "register.person.report.action.NEWS_PUBLISHED",
  NEWS_EMAILED: "register.person.report.action.NEWS_EMAILED",
  NEWS_TEXTED: "register.person.report.action.NEWS_TEXTED",
  NEWS_COMMENT_POSTED: "register.person.report.action.NEWS_COMMENT_POSTED",
  NEWS_COMMENT_HIDDEN: "register.person.report.action.NEWS_COMMENT_HIDDEN",
  LEGAL_HOLD_PLACED: "register.person.report.action.LEGAL_HOLD_PLACED",
  LEGAL_HOLD_RELEASED: "register.person.report.action.LEGAL_HOLD_RELEASED",
  SERVICE_DATA_PURGED: "register.person.report.action.SERVICE_DATA_PURGED",
  BOARD_POSITION_ELECTED:
    "register.person.report.action.BOARD_POSITION_ELECTED",
  BOARD_POSITION_ENDED: "register.person.report.action.BOARD_POSITION_ENDED",
  BOOKING_RESOURCE_CREATED:
    "register.person.report.action.BOOKING_RESOURCE_CREATED",
  BOOKING_RESOURCE_UPDATED:
    "register.person.report.action.BOOKING_RESOURCE_UPDATED",
  BOOKING_RESOURCE_DEACTIVATED:
    "register.person.report.action.BOOKING_RESOURCE_DEACTIVATED",
  BOOKING_MADE: "register.person.report.action.BOOKING_MADE",
  BOOKING_CANCELLED: "register.person.report.action.BOOKING_CANCELLED",
  EVENT_SERIES_CREATED: "register.person.report.action.EVENT_SERIES_CREATED",
  EVENT_SERIES_UPDATED: "register.person.report.action.EVENT_SERIES_UPDATED",
  EVENT_SERIES_PUBLISHED:
    "register.person.report.action.EVENT_SERIES_PUBLISHED",
  EVENT_OCCURRENCE_CANCELLED:
    "register.person.report.action.EVENT_OCCURRENCE_CANCELLED",
  EVENT_OCCURRENCE_REINSTATED:
    "register.person.report.action.EVENT_OCCURRENCE_REINSTATED",
  MOTION_SUBMITTED: "register.person.report.action.MOTION_SUBMITTED",
  MOTION_ACKNOWLEDGED: "register.person.report.action.MOTION_ACKNOWLEDGED",
  MOTION_WITHDRAWN: "register.person.report.action.MOTION_WITHDRAWN",
  EVENT_SIGNUP_MADE: "register.person.report.action.EVENT_SIGNUP_MADE",
  EVENT_SIGNUP_WITHDRAWN:
    "register.person.report.action.EVENT_SIGNUP_WITHDRAWN",
  REGISTER_REPORT_OBLIGATION_RECORDED:
    "register.person.report.action.REGISTER_REPORT_OBLIGATION_RECORDED",
  REGISTER_REPORT_MADE: "register.person.report.action.REGISTER_REPORT_MADE",
  REGISTER_INITIAL_SUPPLY_EXPORTED:
    "register.person.report.action.REGISTER_INITIAL_SUPPLY_EXPORTED",
  MEETING_ARRANGED: "register.person.report.action.MEETING_ARRANGED",
  MEETING_HELD: "register.person.report.action.MEETING_HELD",
  MEETING_AGENDA_SET: "register.person.report.action.MEETING_AGENDA_SET",
  MEETING_ATTENDANCE_RECORDED:
    "register.person.report.action.MEETING_ATTENDANCE_RECORDED",
  MEETING_ATTENDANCE_WITHDRAWN:
    "register.person.report.action.MEETING_ATTENDANCE_WITHDRAWN",
  MEETING_PROXY_REGISTERED:
    "register.person.report.action.MEETING_PROXY_REGISTERED",
  MEETING_PROXY_WITHDRAWN:
    "register.person.report.action.MEETING_PROXY_WITHDRAWN",
  MEETING_DECISION_RECORDED:
    "register.person.report.action.MEETING_DECISION_RECORDED",
} as const satisfies Record<ReportAuditAction, TranslationKey>;

/** The day out of an instant. A document states days, not milliseconds. */
function day(instant: string | null): string | null {
  return instant === null ? null : instant.slice(0, 10);
}

export interface DataSubjectReportProps {
  personId: string;
  /** Back to the person the report is about. */
  onClose: () => void;
}

export function DataSubjectReport({
  personId,
  onClose,
}: DataSubjectReportProps): ReactElement {
  const { t } = useTranslation();
  /*
   * The report replaces the whole view, so the button that opened it unmounts
   * in the same commit and the browser drops focus to the document body - the
   * case the hook was written for, and worse here than for a panel, because
   * there is no register left beside it to fall back to.
   */
  const heading = usePanelHeadingFocus();
  const [report, setReport] = useState<Report | null>(null);
  const [failed, setFailed] = useState(false);

  /*
   * One request per mount. The route keys this component on the person, so
   * opening the report for somebody else remounts rather than refetching, and
   * a report on screen always belongs to the person whose name is on it.
   */
  useEffect(() => {
    const controller = new AbortController();

    void (async () => {
      try {
        setReport(await fetchDataSubjectReport(personId, controller.signal));
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        setFailed(true);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [personId]);

  const nothing = t("register.person.report.nothing");

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 print:hidden">
        <div className="flex flex-col gap-2">
          <h1 ref={heading} tabIndex={-1} className="text-display">
            {t("register.person.report.heading")}
          </h1>
          <p className="max-w-2xl text-body text-ink-muted">
            {t("register.person.report.logged")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
            {t("register.person.report.back")}
          </button>
          <button
            type="button"
            onClick={() => {
              window.print();
            }}
            disabled={report === null}
            className={SECONDARY_BUTTON}
          >
            {t("register.person.report.print")}
          </button>
        </div>
      </header>

      <p className="text-small text-ink-muted print:hidden">
        {t("register.person.report.printHint")}
      </p>

      {failed ? (
        <Notice tone="danger" live>
          {t("register.person.report.failed")}
        </Notice>
      ) : null}

      {report === null && !failed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("register.person.report.loading")}
        </p>
      ) : null}

      {report === null ? null : (
        <article {...DOCUMENT_ATTRIBUTE} className={DOCUMENT}>
          <header className="flex flex-col gap-1">
            <h2 className="text-headline">{report.housingCooperative.name}</h2>
            {report.housingCooperative.organizationNumber === null ? null : (
              <p className={STAMP}>
                {`${t("register.person.report.organizationNumber")} ${
                  report.housingCooperative.organizationNumber
                }`}
              </p>
            )}
            <p className="text-title">{t("register.person.report.heading")}</p>
            <p className="text-body text-ink">
              {`${report.person.firstName} ${report.person.lastName}`}
            </p>
          </header>

          {/*
           * Said on the document itself. Somebody handed this should be able to
           * see which half of what it lists is erased on the date below and
           * which half the law requires the association to keep.
           */}
          <p className="text-small text-ink-muted">
            {t("register.person.report.twoTiers")}
          </p>

          <Section titleKey="register.person.report.section.person">
            <dl className={FIELD_GRID}>
              <Field
                labelKey="register.person.report.field.name"
                value={`${report.person.firstName} ${report.person.lastName}`}
              />
              <Field
                labelKey="register.person.report.field.postalAddress"
                value={
                  [
                    report.person.postalAddress.street,
                    report.person.postalAddress.postalCode,
                    report.person.postalAddress.city,
                  ]
                    .filter((part): part is string => part !== null)
                    .join(", ") || null
                }
              />
              <Field
                labelKey="register.person.report.field.alternativeAddress"
                value={report.person.alternativePostalAddress}
              />
              <Field
                labelKey="register.person.report.field.email"
                value={report.person.email}
              />
              <Field
                labelKey="register.person.report.field.phone"
                value={report.person.phone}
              />
              <Field
                labelKey="register.person.report.field.personalIdentityNumber"
                value={report.person.personalIdentityNumber}
              />
              <Field
                labelKey="register.person.report.field.protectedPersonalData"
                value={t(
                  report.person.protectedPersonalData
                    ? "register.person.report.yes"
                    : "register.person.report.no",
                )}
              />
              <Field
                labelKey="register.person.report.field.preferredLocale"
                value={report.person.preferredLocale}
              />
              <Field
                labelKey="register.person.report.field.recordedAt"
                value={day(report.person.recordedAt)}
              />
            </dl>
          </Section>

          <Section titleKey="register.person.report.section.residencies">
            <Rows
              empty={report.residencies.length === 0}
              headings={[
                "register.person.report.field.apartment",
                "register.person.report.field.role",
                "register.person.report.field.movedIn",
                "register.person.report.field.movedOut",
                "register.person.report.field.purgeOn",
              ]}
            >
              {report.residencies.map((residency) => (
                <tr key={residency.residencyId} className={ROW}>
                  <td className={DATA_CELL}>
                    {`${residency.addressLabel} ${residency.apartmentNumber}`}
                  </td>
                  <td className={TEXT_CELL}>{t(ROLE_LABEL[residency.role])}</td>
                  <td className={DATA_CELL}>
                    {residency.movedInOn ?? nothing}
                  </td>
                  <td className={DATA_CELL}>
                    {residency.movedOutOn ?? nothing}
                  </td>
                  <td className={DATA_CELL}>{residency.purgeOn ?? nothing}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.boardPositions">
            <Rows
              empty={report.boardPositions.length === 0}
              headings={[
                "register.person.report.field.position",
                "register.person.report.field.elected",
                "register.person.report.field.ended",
              ]}
            >
              {report.boardPositions.map((position) => (
                <tr
                  key={`${position.position}-${position.electedOn ?? ""}`}
                  className={ROW}
                >
                  <td className={TEXT_CELL}>
                    {t(POSITION_LABEL[position.position])}
                  </td>
                  <td className={DATA_CELL}>{position.electedOn ?? nothing}</td>
                  <td className={DATA_CELL}>{position.endedOn ?? nothing}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.systemRoles">
            {report.systemRoles.length === 0 ? (
              <Empty />
            ) : (
              <ul className="flex flex-col gap-1">
                {report.systemRoles.map((role) => (
                  <li key={role} className={FIELD_TEXT}>
                    {t(SYSTEM_ROLE_LABEL[role])}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section titleKey="register.person.report.section.account">
            {report.account === null ? (
              <Empty />
            ) : (
              <dl className={FIELD_GRID}>
                <Field
                  labelKey="register.person.report.field.email"
                  value={report.account.email}
                />
                <Field
                  labelKey="register.person.report.field.twoFactor"
                  value={t(
                    report.account.twoFactorEnabled
                      ? "register.person.report.yes"
                      : "register.person.report.no",
                  )}
                />
                <Field
                  labelKey="register.person.report.field.recordedAt"
                  value={day(report.account.createdAt)}
                />
              </dl>
            )}
          </Section>

          <Section titleKey="register.person.report.section.memberRegister">
            <Rows
              empty={report.memberRegisterEntries.length === 0}
              headings={[
                "register.person.report.field.event",
                "register.person.report.field.date",
                "register.person.report.field.apartment",
                "register.person.report.field.recordedName",
                "register.person.report.field.note",
              ]}
            >
              {report.memberRegisterEntries.map((entry) => (
                <tr key={entry.entryId} className={ROW}>
                  <td className={TEXT_CELL}>
                    {t(`register.person.report.event.${entry.eventType}`)}
                  </td>
                  <td className={DATA_CELL}>{entry.eventOn}</td>
                  <td className={DATA_CELL}>{entry.apartment ?? nothing}</td>
                  <td className={TEXT_CELL}>{entry.recordedName}</td>
                  <td className={TEXT_CELL}>{entry.note ?? nothing}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.transfers">
            <Rows
              empty={report.transfers.length === 0}
              headings={[
                "register.person.report.field.apartment",
                "register.person.report.field.direction",
                "register.person.report.field.date",
                "register.person.report.field.membershipDecidedOn",
                "register.person.report.field.price",
                "register.person.report.field.agreementReference",
              ]}
            >
              {report.transfers.map((transfer) => (
                <tr key={transfer.transferId} className={ROW}>
                  <td className={DATA_CELL}>{transfer.apartment}</td>
                  <td className={TEXT_CELL}>
                    {t(
                      `register.person.report.direction.${transfer.direction}`,
                    )}
                  </td>
                  <td className={DATA_CELL}>{transfer.transferredOn}</td>
                  <td className={DATA_CELL}>
                    {transfer.membershipDecidedOn ?? nothing}
                  </td>
                  <td className={DATA_CELL}>{transfer.price ?? nothing}</td>
                  <td className={DATA_CELL}>
                    {transfer.agreementReference ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.terminations">
            <Rows
              empty={report.terminations.length === 0}
              headings={[
                "register.person.report.field.apartment",
                "register.person.report.field.terminationKind",
                "register.person.report.field.tookEffectOn",
                "register.person.report.field.terminationReference",
              ]}
            >
              {report.terminations.map((termination) => (
                <tr key={termination.terminationId} className={ROW}>
                  <td className={DATA_CELL}>{termination.apartment}</td>
                  <td className={TEXT_CELL}>
                    {t(TERMINATION_KIND_LABEL[termination.kind])}
                  </td>
                  <td className={DATA_CELL}>{termination.tookEffectOn}</td>
                  <td className={TEXT_CELL}>{termination.reference}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.lienNotes">
            <Rows
              empty={report.lienNotes.length === 0}
              headings={[
                "register.person.report.field.apartment",
                "register.person.report.field.creditor",
                "register.person.report.field.amount",
                "register.person.report.field.noted",
                "register.person.report.field.released",
              ]}
            >
              {report.lienNotes.map((lienNote) => (
                <tr key={lienNote.lienNoteId} className={ROW}>
                  <td className={DATA_CELL}>{lienNote.apartment}</td>
                  <td className={TEXT_CELL}>{lienNote.creditor}</td>
                  <td className={DATA_CELL}>{lienNote.amount ?? nothing}</td>
                  <td className={DATA_CELL}>{lienNote.notedOn}</td>
                  <td className={DATA_CELL}>
                    {lienNote.releasedOn ??
                      t("register.person.report.standing")}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.reportObligations">
            <Rows
              empty={report.registerReportObligations.length === 0}
              headings={[
                "register.person.report.field.apartment",
                "register.person.report.field.event",
                "register.person.report.field.triggeredOn",
                "register.person.report.field.dueOn",
              ]}
            >
              {report.registerReportObligations.map((obligation) => (
                <tr key={obligation.obligationId} className={ROW}>
                  <td className={DATA_CELL}>{obligation.apartment}</td>
                  <td className={TEXT_CELL}>
                    {t(REGISTER_REPORT_KIND_LABEL[obligation.kind])}
                  </td>
                  <td className={DATA_CELL}>{obligation.triggeredOn}</td>
                  <td className={DATA_CELL}>{obligation.dueOn}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.consents">
            <Rows
              empty={report.publicationConsents.length === 0}
              headings={[
                "register.person.report.field.scope",
                "register.person.report.field.granted",
                "register.person.report.field.withdrawn",
                "register.person.report.field.note",
              ]}
            >
              {report.publicationConsents.map((consent) => (
                <tr
                  key={`${consent.scope}-${consent.grantedOn}`}
                  className={ROW}
                >
                  <td className={TEXT_CELL}>
                    {t(CONSENT_SCOPE_LABEL[consent.scope])}
                  </td>
                  <td className={DATA_CELL}>{day(consent.grantedOn)}</td>
                  <td className={DATA_CELL}>
                    {day(consent.withdrawnOn) ?? nothing}
                  </td>
                  <td className={TEXT_CELL}>{consent.note ?? nothing}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.legalHolds">
            <Rows
              empty={report.legalHolds.length === 0}
              headings={[
                "register.person.report.field.reason",
                "register.person.report.field.placed",
                "register.person.report.field.released",
              ]}
            >
              {report.legalHolds.map((hold) => (
                <tr key={hold.holdId} className={ROW}>
                  <td className={TEXT_CELL}>{hold.reason}</td>
                  <td className={DATA_CELL}>{day(hold.placedAt)}</td>
                  <td className={DATA_CELL}>
                    {day(hold.releasedAt) ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.issues">
            <Rows
              empty={report.issues.length === 0}
              headings={[
                "register.person.report.field.type",
                "register.person.report.field.status",
                "register.person.report.field.date",
                "register.person.report.field.location",
                "register.person.report.field.description",
                "register.person.report.field.photographs",
              ]}
            >
              {report.issues.map((issue) => (
                <tr key={issue.issueId} className={ROW}>
                  <td className={TEXT_CELL}>{issue.typeName}</td>
                  <td className={TEXT_CELL}>
                    {t(ISSUE_STATUS_LABEL[issue.status])}
                  </td>
                  <td className={DATA_CELL}>{day(issue.reportedAt)}</td>
                  <td className={TEXT_CELL}>{issue.location ?? nothing}</td>
                  {/* Line breaks kept, as the motion and comment bodies
                      below keep them and as both issue panels already do.
                      A report is the person's own words handed back to
                      them, and a description written as a list of
                      observations reads as one sentence once the breaks
                      collapse. */}
                  <td className={TEXT_CELL}>
                    <span className="block whitespace-pre-line">
                      {issue.description}
                    </span>
                  </td>
                  <td className={DATA_CELL}>{String(issue.photographs)}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.documents">
            <Rows
              empty={report.documents.length === 0}
              headings={[
                "register.person.report.field.documentTitle",
                "register.person.report.field.binder",
                "register.person.report.field.audience",
                "register.person.report.field.filed",
              ]}
            >
              {report.documents.map((document) => (
                <tr key={document.documentId} className={ROW}>
                  <td className={TEXT_CELL}>{document.title}</td>
                  <td className={TEXT_CELL}>{document.category}</td>
                  <td className={TEXT_CELL}>
                    {t(DOCUMENT_AUDIENCE_LABEL[document.audience])}
                  </td>
                  <td className={DATA_CELL}>{day(document.filedAt)}</td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.bookings">
            <Rows
              empty={report.bookings.length === 0}
              headings={[
                "register.person.report.field.resource",
                "register.person.report.field.status",
                "register.person.report.field.apartment",
                "register.person.report.field.starts",
                "register.person.report.field.ends",
                "register.person.report.field.erasableFrom",
              ]}
            >
              {report.bookings.map((booking) => (
                <tr key={booking.bookingId} className={ROW}>
                  <td className={TEXT_CELL}>{booking.resourceName}</td>
                  <td className={TEXT_CELL}>
                    {t(BOOKING_STATUS_LABEL[booking.status])}
                  </td>
                  <td className={DATA_CELL}>{booking.apartment ?? nothing}</td>
                  <td className={DATA_CELL}>{day(booking.startsAt)}</td>
                  <td className={DATA_CELL}>{day(booking.endsAt)}</td>
                  {/*
                   * The row's own retention date and not the one at the foot of
                   * the document: a booking is purged a year after it ended,
                   * whether or not the person who made it still lives here.
                   *
                   * The earliest such date rather than the day it goes, because
                   * the legal hold in the retention section below suspends every
                   * purge for this person. A column promising an erasure while
                   * one stands would be telling the person a date that is not
                   * going to happen.
                   */}
                  <td className={DATA_CELL}>
                    {booking.erasableFrom ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.motions">
            <Rows
              empty={report.motions.length === 0}
              headings={[
                "register.person.report.field.motionTitle",
                "register.person.report.field.status",
                "register.person.report.field.submitted",
                "register.person.report.field.closed",
                "register.person.report.field.erasableFrom",
              ]}
            >
              {report.motions.map((motion) => (
                <tr key={motion.motionId} className={ROW}>
                  {/* The title and the proposal both: this is the person's own
                      writing, and the fullest answer art. 15 can give about it
                      is the words they used. A summary would be the association
                      paraphrasing them back to themselves. */}
                  <td className={TEXT_CELL}>
                    <span className="font-semibold">{motion.title}</span>
                    <span className="block whitespace-pre-line">
                      {motion.body}
                    </span>
                  </td>
                  <td className={TEXT_CELL}>
                    {t(MOTION_STATUS_LABEL[motion.status])}
                  </td>
                  <td className={DATA_CELL}>{day(motion.submittedAt)}</td>
                  <td className={DATA_CELL}>
                    {day(motion.closedAt) ?? nothing}
                  </td>
                  {/*
                   * The row's own retention date, two years after the motion was
                   * closed, on the same reasoning the bookings column above
                   * carries - and absent while the motion is open, because there
                   * is no closing date to count from and the association is still
                   * processing it.
                   */}
                  <td className={DATA_CELL}>
                    {motion.erasableFrom ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.eventSignups">
            <Rows
              empty={report.eventSignups.length === 0}
              headings={[
                "register.person.report.field.eventTitle",
                "register.person.report.field.date",
                "register.person.report.field.signedUp",
                "register.person.report.field.withdrawn",
                "register.person.report.field.calledOff",
                "register.person.report.field.erasableFrom",
              ]}
            >
              {report.eventSignups.map((signup) => (
                <tr key={signup.signupId} className={ROW}>
                  <td className={TEXT_CELL}>{signup.eventTitle}</td>
                  {/*
                   * The date the server stated, printed as it arrived. Reading it
                   * off the instant here would name the day before for anything
                   * starting in the first hours of the morning.
                   */}
                  <td className={DATA_CELL}>{signup.on}</td>
                  <td className={DATA_CELL}>{day(signup.signedUpAt)}</td>
                  {/*
                   * A withdrawal is a date and not an absence, which is what
                   * lets this document tell somebody who stood down from
                   * somebody who never signed up.
                   */}
                  <td className={DATA_CELL}>
                    {signup.withdrawnOn === null
                      ? nothing
                      : day(signup.withdrawnOn)}
                  </td>
                  <td className={TEXT_CELL}>
                    {t(
                      signup.calledOff
                        ? "register.person.report.yes"
                        : "register.person.report.no",
                    )}
                  </td>
                  <td className={DATA_CELL}>
                    {signup.erasableFrom ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.newsComments">
            <Rows
              empty={report.newsComments.length === 0}
              headings={[
                "register.person.report.field.newsItem",
                "register.person.report.field.written",
                "register.person.report.field.comment",
                "register.person.report.field.hidden",
                "register.person.report.field.erasableFrom",
              ]}
            >
              {report.newsComments.map((comment) => (
                <tr key={comment.commentId} className={ROW}>
                  <td className={TEXT_CELL}>{comment.newsTitle}</td>
                  <td className={DATA_CELL}>{day(comment.writtenAt)}</td>
                  {/*
                   * In full, and whether or not it was hidden. What somebody
                   * wrote is the personal data this section is about, and a
                   * moderated comment is still their words.
                   *
                   * Line breaks kept, as the motion body above keeps them. A
                   * comment runs to a couple of paragraphs and this is a printed
                   * document, so collapsing the newlines would hand its subject
                   * a run-on paragraph that is not what they wrote.
                   */}
                  <td className={TEXT_CELL}>
                    <span className="block whitespace-pre-line">
                      {comment.body}
                    </span>
                  </td>
                  <td className={TEXT_CELL}>
                    {t(
                      comment.hidden
                        ? "register.person.report.yes"
                        : "register.person.report.no",
                    )}
                  </td>
                  <td className={DATA_CELL}>
                    {comment.erasableFrom ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          {/*
           * Attendance at a general meeting, and the two things this section
           * says that "present" does not: in what capacity, and whether the
           * board struck the line off again.
           *
           * No erasure column, unlike the four sections above it, and the
           * absence is deliberate rather than a heading nobody filled in.
           * Nothing purges a line of the meeting's record: the voting register
           * (rostlangd) is taken into or appended to the protokoll under EFL
           * 6 kap. 39 §, which 40 § has kept safely. So this sits with the
           * register sections - kept because the law requires the record, and
           * printed because exemption from erasure is not exemption from
           * access.
           */}
          <Section titleKey="register.person.report.section.meetingAttendances">
            <Rows
              empty={report.meetingAttendances.length === 0}
              headings={[
                "register.person.report.field.meeting",
                "register.person.report.field.date",
                "register.person.report.field.capacity",
                "register.person.report.field.attendanceMode",
                "register.person.report.field.broughtBy",
                "register.person.report.field.withdrawn",
              ]}
            >
              {report.meetingAttendances.map((attendance) => (
                <tr key={attendance.attendanceId} className={ROW}>
                  <td className={TEXT_CELL}>
                    {t(MEETING_KIND_LABEL[attendance.meetingKind])}
                  </td>
                  <td className={DATA_CELL}>{attendance.meetingHeldOn}</td>
                  <td className={TEXT_CELL}>
                    {t(ATTENDANCE_CAPACITY_LABEL[attendance.capacity])}
                  </td>
                  <td className={TEXT_CELL}>
                    {t(ATTENDANCE_MODE_LABEL[attendance.mode])}
                  </td>
                  {/*
                   * The identifier of the member or proxy holder an assistant
                   * came with, and never their name. They are a third party on
                   * a document the association hands over, which is the same
                   * judgement the audit log's two person columns are printed
                   * under.
                   */}
                  <td className={DATA_CELL}>
                    {attendance.onBehalfOfPersonId ?? nothing}
                  </td>
                  <td className={DATA_CELL}>
                    {day(attendance.withdrawnAt) ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          {/*
           * Written authorities for a proxy holder (fullmakt) naming this
           * person, on either side of them. The role column is what makes the
           * section answer for both, exactly as it does on the audit log below.
           */}
          <Section titleKey="register.person.report.section.proxyAuthorisations">
            <Rows
              empty={report.proxyAuthorisations.length === 0}
              headings={[
                "register.person.report.field.meeting",
                "register.person.report.field.date",
                "register.person.report.field.role",
                "register.person.report.field.counterpart",
                "register.person.report.field.proxyGround",
                "register.person.report.field.authorised",
                "register.person.report.field.withdrawn",
              ]}
            >
              {report.proxyAuthorisations.map((authorisation) => (
                <tr key={authorisation.authorisationId} className={ROW}>
                  <td className={TEXT_CELL}>
                    {t(MEETING_KIND_LABEL[authorisation.meetingKind])}
                  </td>
                  <td className={DATA_CELL}>{authorisation.meetingHeldOn}</td>
                  <td className={TEXT_CELL}>
                    {t(
                      `register.person.report.proxyRole.${authorisation.role}`,
                    )}
                  </td>
                  <td className={DATA_CELL}>
                    {authorisation.counterpartPersonId}
                  </td>
                  <td className={TEXT_CELL}>
                    {t(PROXY_GROUND_LABEL[authorisation.ground])}
                  </td>
                  <td className={DATA_CELL}>{authorisation.authorisedOn}</td>
                  <td className={DATA_CELL}>
                    {day(authorisation.withdrawnAt) ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.audit">
            <Rows
              empty={report.auditEntries.length === 0}
              headings={[
                "register.person.report.field.action",
                "register.person.report.field.at",
                "register.person.report.field.about",
                "register.person.report.field.detail",
              ]}
            >
              {report.auditEntries.map((entry) => (
                <tr key={entry.entryId} className={ROW}>
                  <td className={TEXT_CELL}>
                    {t(AUDIT_ACTION_LABEL[entry.action])}
                  </td>
                  <td className={DATA_CELL}>{day(entry.at)}</td>
                  <td className={TEXT_CELL}>
                    {t(`register.person.report.auditRole.${entry.role}`)}
                  </td>
                  <td className={DATA_CELL}>
                    {contextLine(entry.context) ?? nothing}
                  </td>
                </tr>
              ))}
            </Rows>
          </Section>

          <Section titleKey="register.person.report.section.retention">
            <dl className={FIELD_GRID}>
              <Field
                labelKey="register.person.report.field.retentionDays"
                value={String(report.retention.daysAfterMoveOut)}
              />
              <Field
                labelKey="register.person.report.field.purgeOn"
                value={report.retention.purgeOn}
              />
              <Field
                labelKey="register.person.report.field.onLegalHold"
                value={t(
                  report.retention.onLegalHold
                    ? "register.person.report.yes"
                    : "register.person.report.no",
                )}
              />
            </dl>
          </Section>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
            <p className={STAMP}>
              {t("register.person.report.stamp", {
                date: report.generatedOn,
              })}
            </p>
            <p className="text-small text-ink-muted">
              {t("register.person.report.logged")}
            </p>
          </footer>
        </article>
      )}
    </div>
  );
}

/**
 * One audit entry's context on a single line.
 *
 * The log holds field names, identifiers, counts and dates rather than values,
 * so this can render whatever an entry carries without deciding per key what is
 * safe to print. An object or an array inside is written out as JSON rather
 * than as "[object Object]", which would be a cell that says nothing.
 */
function contextLine(context: Record<string, unknown> | null): string | null {
  if (context === null) {
    return null;
  }
  const parts = Object.entries(context).map(([key, value]) => {
    const written =
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      value === null
        ? String(value)
        : JSON.stringify(value);
    return `${key}: ${written}`;
  });
  return parts.length === 0 ? null : parts.join("; ");
}

function Section({
  titleKey,
  children,
}: {
  titleKey: TranslationKey;
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className={SECTION}>
      <h3 className={SECTION_HEADING}>{t(titleKey)}</h3>
      {children}
    </section>
  );
}

/**
 * A label and its value.
 *
 * An absent value is said in words rather than left blank: a printed document
 * with a gap in it reads as one that lost something, and this report's whole
 * job is to be a complete statement of what the association holds.
 */
function Field({
  labelKey,
  value,
}: {
  labelKey: TranslationKey;
  value: string | null;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-1">
      <dt className={FIELD_LABEL}>{t(labelKey)}</dt>
      <dd className={value === null ? "text-body text-ink-muted" : FIELD_VALUE}>
        {value ?? t("register.person.report.nothing")}
      </dd>
    </div>
  );
}

function Empty(): ReactElement {
  const { t } = useTranslation();

  return (
    <p className="text-body text-ink-muted">
      {t("register.person.report.nothing")}
    </p>
  );
}

/** A section's table, or the sentence that says the section is empty. */
function Rows({
  empty,
  headings,
  children,
}: {
  empty: boolean;
  headings: readonly TranslationKey[];
  children: ReactNode;
}): ReactElement {
  const { t } = useTranslation();

  if (empty) {
    return <Empty />;
  }

  return (
    <div className={TABLE_SCROLL}>
      <table className={TABLE}>
        <thead>
          <tr>
            {headings.map((heading) => (
              <th key={heading} scope="col" className={HEAD_CELL}>
                {t(heading)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
