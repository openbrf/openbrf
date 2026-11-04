import type { ReactElement } from "react";
import { WORK_ORDER_LIMITS } from "@openbrf/shared";

import {
  WORK_ORDER_LINK_PHOTO_SEGMENT,
  type WorkOrderLinkPageView,
} from "../issues/work-order-link.service";
import { formConfirmation, formRefusal } from "./site-forms";
import {
  formatEventTime,
  formatNewsDate,
  isoDate,
  renderDocument,
  type SiteChrome,
} from "./site-html";

/**
 * The page a contractor's link opens, the page that answers a decline or a
 * done, and the refusal every link that opens nothing gets (decision 24, ADR
 * 0055), as HTML.
 *
 * Pure, as site-html.tsx is: handed the view the issues module built field by
 * field and the chrome, and reads nothing. What it can print is therefore what
 * `WorkOrderLinkPageView` holds: the work order's text, whom it was written
 * to, the day it was sent, the photographs chosen for it, and the
 * contractor's own answer, notes and photographs. There is no field for an
 * issue number, a type, a report, a reporter, an address, a handler or
 * another work order, so no branch here can print one (controls H1, H3).
 *
 * The title is the same generic word on every link's page and on the refusal,
 * so a chat or SMS preview that unfurls the link shows nothing (control F3).
 * Every string is a React child and so escaped; text is shown as written, with
 * no markdown and no link made of an address (H6). A photograph's address is
 * the page's own and a file's identifier, and its alternative text a number,
 * never a file name.
 */

/** What the contractor has just done, read from a closed set in the query. */
export type WorkOrderLinkNotice =
  | "accepted"
  | "noted"
  | "refused"
  | "identity"
  | "note-limited"
  | "note-full"
  | "photo-added"
  | "photo-refused"
  | "photo-too-large"
  | "photo-limited"
  | "photo-full";

/** The query parameter the answer to an act names its outcome in. */
export const WORK_ORDER_LINK_NOTICE_PARAM = "svar";

/** The field that names which of the page's buttons was pressed. */
export const WORK_ORDER_LINK_ACT_FIELD = "act";

/** The field a note is written in. */
export const WORK_ORDER_LINK_BODY_FIELD = "body";

/** The field a photograph is sent in. */
export const WORK_ORDER_LINK_FILE_FIELD = "photo";

const NOTICES: ReadonlySet<string> = new Set<WorkOrderLinkNotice>([
  "accepted",
  "noted",
  "refused",
  "identity",
  "note-limited",
  "note-full",
  "photo-added",
  "photo-refused",
  "photo-too-large",
  "photo-limited",
  "photo-full",
]);

/** The notice a query value names, or none for anything else. */
export function workOrderLinkNotice(
  value: unknown,
): WorkOrderLinkNotice | null {
  return typeof value === "string" && NOTICES.has(value)
    ? (value as WorkOrderLinkNotice)
    : null;
}

/** The notices that say something went through, and the rest refuse. */
const CONFIRMATIONS: ReadonlySet<WorkOrderLinkNotice> = new Set([
  "accepted",
  "noted",
  "photo-added",
]);

/** The types a photograph may be, as the media layer identifies them. */
const PHOTO_TYPES = "image/jpeg,image/png,image/webp,image/gif";

export function renderWorkOrderLinkPage(
  chrome: SiteChrome,
  view: WorkOrderLinkPageView,
  notice: WorkOrderLinkNotice | null,
  /** The page's own address, which the forms post back to. */
  pagePath: string,
): string {
  const { t, locale } = chrome;
  const photoPath = `${pagePath}/${WORK_ORDER_LINK_PHOTO_SEGMENT}`;
  return renderDocument(
    chrome,
    t("site.workOrderLink.title"),
    <>
      <h1 className="site-title">{t("site.workOrderLink.title")}</h1>

      <dl className="site-issue-facts">
        <dt>{t("site.workOrderLink.to")}</dt>
        <dd>{view.recipientName}</dd>
        <dt>{t("site.workOrderLink.sent")}</dt>
        <dd>
          <time className="site-issue-date" dateTime={isoDate(view.sentAt)}>
            {formatNewsDate(view.sentAt, locale)}
          </time>
        </dd>
        <dt>{t("site.workOrderLink.state")}</dt>
        <dd>
          {view.accepted
            ? t("site.workOrderLink.stateAccepted")
            : t("site.workOrderLink.stateOpen")}
        </dd>
        <dt>{t("site.workOrderLink.until")}</dt>
        <dd>
          <time className="site-issue-date" dateTime={isoDate(view.expiresAt)}>
            {formatNewsDate(view.expiresAt, locale)}
          </time>
        </dd>
      </dl>

      {notice === null
        ? null
        : CONFIRMATIONS.has(notice)
          ? formConfirmation(t(`site.workOrderLink.notice.${notice}`))
          : formRefusal(t(`site.workOrderLink.notice.${notice}`))}

      <section aria-labelledby="site-work-order-text">
        <h2 id="site-work-order-text">{t("site.workOrderLink.text")}</h2>
        <p className="site-issue-message">{view.body}</p>
      </section>

      {view.photos.length === 0 ? null : (
        <section aria-labelledby="site-work-order-photos">
          <h2 id="site-work-order-photos">{t("site.workOrderLink.photos")}</h2>
          {renderPhotos(chrome, photoPath, view.photos)}
        </section>
      )}

      <section aria-labelledby="site-work-order-answer">
        <h2 id="site-work-order-answer">{t("site.workOrderLink.answer")}</h2>
        <div className="site-work-order-actions">
          {view.accepted ? null : (
            <form method="post" action={pagePath}>
              <input
                type="hidden"
                name={WORK_ORDER_LINK_ACT_FIELD}
                value="accept"
              />
              <button type="submit">{t("site.workOrderLink.accept")}</button>
            </form>
          )}
          <form method="post" action={pagePath}>
            <input
              type="hidden"
              name={WORK_ORDER_LINK_ACT_FIELD}
              value="done"
            />
            <button type="submit">{t("site.workOrderLink.done")}</button>
          </form>
          <form method="post" action={pagePath}>
            <input
              type="hidden"
              name={WORK_ORDER_LINK_ACT_FIELD}
              value="decline"
            />
            <button type="submit">{t("site.workOrderLink.decline")}</button>
          </form>
        </div>
        <p className="site-field-hint">{t("site.workOrderLink.answerHint")}</p>
      </section>

      <section aria-labelledby="site-work-order-notes">
        <h2 id="site-work-order-notes">{t("site.workOrderLink.notes")}</h2>
        {view.notes.length === 0 ? (
          <p>{t("site.workOrderLink.noNotes")}</p>
        ) : (
          <ol className="site-news-list">
            {view.notes.map((note) => (
              <li key={note.id} className="site-news-item">
                <p className="site-news-date">
                  <time dateTime={note.createdAt.toISOString()}>
                    {`${formatNewsDate(note.createdAt, locale)} ${formatEventTime(note.createdAt, locale)}`}
                  </time>
                </p>
                {note.redacted ? (
                  <p className="site-issue-message">
                    <em>{t("site.workOrderLink.removed")}</em>
                  </p>
                ) : (
                  <p className="site-issue-message">{note.body}</p>
                )}
              </li>
            ))}
          </ol>
        )}
        {view.acceptsNotes ? (
          <form className="site-form" method="post" action={pagePath}>
            <input
              type="hidden"
              name={WORK_ORDER_LINK_ACT_FIELD}
              value="note"
            />
            <label className="site-field">
              <span>{t("site.workOrderLink.note")}</span>
              <textarea
                name={WORK_ORDER_LINK_BODY_FIELD}
                rows={4}
                maxLength={WORK_ORDER_LIMITS.note}
                required
              />
              <span className="site-field-hint">
                {t("site.workOrderLink.noteHint")}
              </span>
            </label>
            <button type="submit">{t("site.workOrderLink.addNote")}</button>
          </form>
        ) : (
          <p>{t("site.workOrderLink.notice.note-full")}</p>
        )}
      </section>

      <section aria-labelledby="site-work-order-own-photos">
        <h2 id="site-work-order-own-photos">
          {t("site.workOrderLink.ownPhotos")}
        </h2>
        {view.ownPhotos.length === 0
          ? null
          : renderPhotos(chrome, photoPath, view.ownPhotos)}
        {view.acceptsPhotos ? (
          <form
            className="site-form"
            method="post"
            action={photoPath}
            encType="multipart/form-data"
          >
            <label className="site-field">
              <span>{t("site.workOrderLink.photo")}</span>
              <input
                type="file"
                name={WORK_ORDER_LINK_FILE_FIELD}
                accept={PHOTO_TYPES}
                required
              />
              <span className="site-field-hint">
                {t("site.workOrderLink.photoHint")}
              </span>
            </label>
            <button type="submit">{t("site.workOrderLink.addPhoto")}</button>
          </form>
        ) : (
          <p>{t("site.workOrderLink.notice.photo-full")}</p>
        )}
      </section>

      <p className="site-field-hint">{t("site.workOrderLink.private")}</p>
    </>,
  );
}

function renderPhotos(
  chrome: SiteChrome,
  photoPath: string,
  fileIds: readonly string[],
): ReactElement {
  const { t } = chrome;
  return (
    <ul className="site-work-order-photos">
      {fileIds.map((fileId, index) => {
        const href = `${photoPath}/${encodeURIComponent(fileId)}`;
        return (
          <li key={fileId}>
            <a href={href}>
              <img
                src={href}
                alt={t("site.workOrderLink.photoAlt", { number: index + 1 })}
                loading="lazy"
              />
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The page that answers a decline or a done. The link ends with either, so
 * this page carries no address of it: a redirect to the link would meet the
 * refusal (control E6). It says what was recorded and nothing about the work
 * order.
 */
export function renderWorkOrderLinkEnded(
  chrome: SiteChrome,
  ended: "declined" | "done",
): string {
  const { t } = chrome;
  return renderDocument(
    chrome,
    t("site.workOrderLink.title"),
    <>
      <h1 className="site-title">{t(`site.workOrderLink.ended.${ended}`)}</h1>
      <p>{t("site.workOrderLink.ended.body")}</p>
    </>,
  );
}

/**
 * Every link that opens nothing: never issued, malformed, expired, withdrawn,
 * declined, done, of a ring-fenced or closed issue, of a reporter, or behind a
 * switch that is off. One document for all of them, deterministic for a given
 * language, so a caller learns nothing from which it was (ADR 0055).
 */
export function renderWorkOrderLinkNotFound(chrome: SiteChrome): string {
  const { t } = chrome;
  return renderDocument(
    chrome,
    t("site.workOrderLink.title"),
    <>
      <h1 className="site-title">{t("site.workOrderLink.notFoundTitle")}</h1>
      <p>{t("site.workOrderLink.notFoundBody")}</p>
    </>,
  );
}
