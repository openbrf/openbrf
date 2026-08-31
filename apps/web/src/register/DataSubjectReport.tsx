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
  type ReportAuditAction,
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
  LEGAL_HOLD_PLACED: "register.person.report.action.LEGAL_HOLD_PLACED",
  LEGAL_HOLD_RELEASED: "register.person.report.action.LEGAL_HOLD_RELEASED",
  SERVICE_DATA_PURGED: "register.person.report.action.SERVICE_DATA_PURGED",
  BOARD_POSITION_ELECTED:
    "register.person.report.action.BOARD_POSITION_ELECTED",
  BOARD_POSITION_ENDED: "register.person.report.action.BOARD_POSITION_ENDED",
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
                  <td className={DATA_CELL}>{transfer.price ?? nothing}</td>
                  <td className={DATA_CELL}>
                    {transfer.agreementReference ?? nothing}
                  </td>
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
                  <td className={TEXT_CELL}>{issue.description}</td>
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
