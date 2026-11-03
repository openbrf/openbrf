import type { ReactElement } from "react";
import { ISSUE_CONVERSATION_LIMITS } from "@openbrf/shared";

import type { ReporterLinkPageView } from "../issues/issue-reporter-link.service";
import { formConfirmation, formRefusal } from "./site-forms";
import {
  formatEventTime,
  formatNewsDate,
  isoDate,
  renderDocument,
  type SiteChrome,
} from "./site-html";

/**
 * The page a reporter's private link opens, and the refusal every link that
 * opens nothing gets (decision 20, ADR 0055), as HTML.
 *
 * Pure, as site-html.tsx is: handed the view the issues module built field by
 * field and the chrome, and reads nothing. What it can print is therefore what
 * `ReporterLinkPageView` holds: the type, where the issue stands as a meaning,
 * the date it came in, and the conversation, each handler's message signed by
 * a role. There is no field for an assignee, a handler's name, a note, a file,
 * a priority, a waiting reason, a description, a location or anybody's name,
 * so no branch here can print one.
 *
 * The title is the same generic sentence on every link's page and on the
 * refusal, so a chat or SMS preview that unfurls the link shows nothing about
 * the issue. Every string is a React child and so escaped; a message is shown
 * as the characters written, with no markdown and no link made of an address.
 */

/** What the reporter has just done, read from a closed set in the query. */
export type IssueLinkNotice =
  "sent" | "refused" | "identity" | "closed" | "limited";

/** The query parameter the answer to a message names its outcome in. */
export const ISSUE_LINK_NOTICE_PARAM = "svar";

const NOTICES: ReadonlySet<string> = new Set<IssueLinkNotice>([
  "sent",
  "refused",
  "identity",
  "closed",
  "limited",
]);

/** The notice a query value names, or none for anything else. */
export function issueLinkNotice(value: unknown): IssueLinkNotice | null {
  return typeof value === "string" && NOTICES.has(value)
    ? (value as IssueLinkNotice)
    : null;
}

/** The name of the field a message is written in. */
export const ISSUE_LINK_BODY_FIELD = "body";

export function renderIssueLinkPage(
  chrome: SiteChrome,
  view: ReporterLinkPageView,
  notice: IssueLinkNotice | null,
  /** The page's own address, which the form posts back to. */
  pagePath: string,
): string {
  const { t, locale } = chrome;
  return renderDocument(
    chrome,
    t("site.issueLink.title"),
    <>
      <h1 className="site-title">{t("site.issueLink.title")}</h1>

      <dl className="site-issue-facts">
        <dt>{t("site.issueLink.type")}</dt>
        <dd>{view.typeName}</dd>
        <dt>{t("site.issueLink.status")}</dt>
        <dd>{t(`site.issueLink.meaning.${view.meaning}`)}</dd>
        <dt>{t("site.issueLink.received")}</dt>
        <dd>
          <time className="site-issue-date" dateTime={isoDate(view.createdAt)}>
            {formatNewsDate(view.createdAt, locale)}
          </time>
        </dd>
      </dl>

      {renderNotice(chrome, notice)}

      <section aria-labelledby="site-issue-conversation">
        <h2 id="site-issue-conversation">{t("site.issueLink.conversation")}</h2>
        {view.messages.length === 0 ? (
          <p>{t("site.issueLink.empty")}</p>
        ) : (
          <ol className="site-news-list">
            {view.messages.map((message) => (
              <li key={message.id} className="site-news-item">
                <p className="site-news-date">
                  <strong>
                    {message.side === "HANDLER"
                      ? t(`site.issueLink.signature.${message.signature}`)
                      : t("site.issueLink.you")}
                  </strong>{" "}
                  <time dateTime={message.createdAt}>
                    {`${formatNewsDate(new Date(message.createdAt), locale)} ${formatEventTime(new Date(message.createdAt), locale)}`}
                  </time>
                </p>
                <p className="site-issue-message">{message.body}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {view.acceptsMessages ? (
        <form className="site-form" method="post" action={pagePath}>
          <label className="site-field">
            <span>{t("site.issueLink.message")}</span>
            <textarea
              name={ISSUE_LINK_BODY_FIELD}
              rows={6}
              maxLength={ISSUE_CONVERSATION_LIMITS.body}
              required
            />
            <span className="site-field-hint">
              {t("site.issueLink.messageHint")}
            </span>
          </label>
          <button type="submit">{t("site.issueLink.send")}</button>
        </form>
      ) : (
        <p>{t("site.issueLink.closedNotice")}</p>
      )}

      <p className="site-field-hint">{t("site.issueLink.private")}</p>
    </>,
  );
}

/**
 * Every link that opens nothing: never issued, malformed, expired, withdrawn,
 * of an issue closed long ago or of a reporter purged. One document for all of
 * them, deterministic for a given language, so a caller learns nothing from
 * which it was (ADR 0055).
 */
export function renderIssueLinkNotFound(chrome: SiteChrome): string {
  const { t } = chrome;
  return renderDocument(
    chrome,
    t("site.issueLink.title"),
    <>
      <h1 className="site-title">{t("site.issueLink.notFoundTitle")}</h1>
      <p>{t("site.issueLink.notFoundBody")}</p>
    </>,
  );
}

function renderNotice(
  chrome: SiteChrome,
  notice: IssueLinkNotice | null,
): ReactElement | null {
  const { t } = chrome;
  switch (notice) {
    case null:
      return null;
    case "sent":
      return formConfirmation(t("site.issueLink.notice.sent"));
    case "refused":
      return formRefusal(t("site.issueLink.notice.refused"));
    case "identity":
      return formRefusal(t("site.issueLink.notice.identity"));
    case "closed":
      return formRefusal(t("site.issueLink.notice.closed"));
    case "limited":
      return formRefusal(t("site.issueLink.notice.limited"));
  }
}
