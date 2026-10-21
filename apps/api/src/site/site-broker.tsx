import type { ReactElement } from "react";

import {
  associationFactGroups,
  type BrokerPageInput,
  hasRecordedFacts,
  renderFactGroups,
} from "./site-facts";
import { formConfirmation, formHoneypot, formRefusal } from "./site-forms";
import {
  formatNewsDate,
  isoDate,
  renderDocument,
  type SiteChrome,
} from "./site-html";
import { BROKER_PATH } from "./site-paths";

/**
 * The broker information page (maklarinfo), as HTML.
 *
 * A generated page rather than one the board writes: the association records
 * the facts once on its own screen, and this file turns them into the page a
 * broker or a prospective buyer reads. Pure in the same way site-html.tsx is -
 * it is handed everything it needs and reads nothing.
 *
 * What it renders is board-entered facts, the association's own name and
 * organisation number, and the number of apartments. That list is exhaustive
 * and it is the whole safety argument for this page. A broker asks questions
 * the statutory registers could answer - who owns which apartment, what the
 * share capital is, what a lien note says - and none of them are answered here
 * or can be: this module imports nothing from the registers, the address book
 * or the encryption layer, and neither does anything it calls. The paid
 * transactional broker extract (maklarbild) is a different product and is out
 * of core precisely because it needs what this page may not have.
 *
 * The apartment count is the one number not typed by a board member, and it is
 * counted rather than listed: how many apartments a housing cooperative has is
 * a fact about the association, printed in its annual report, while anything
 * per-apartment is register content. The count is computed at render time by
 * the caller, and the boundary it sits against is named where the query is.
 *
 * The rows themselves are built and rendered by site-facts.tsx. A board that
 * would rather answer these questions on a page of its own arranging puts an
 * association facts block on it and gets the same rows from the same code, so
 * the association has one account of itself and not two that can drift.
 *
 * A fact nobody recorded renders as nothing at all, and the page exists from
 * the moment the feature ships. An association that has recorded nothing gets a
 * page carrying its name and its organisation number, rather than a 404 that
 * turns into a page the first time a board member saves something: an address
 * that starts answering is an address somebody has already linked to and had
 * answered with "no such page", and a broker who checked once would have no
 * reason to check again.
 *
 * Under the title the page says when the board last confirmed its answers - by
 * saving them or by confirming them unchanged. A fee policy is only worth what
 * its date is worth, and a broker reading one with no date has no way to tell
 * last month's answer from one nobody has looked at since the building was
 * relined. Only once there is an answer to date: an association that has
 * recorded nothing gets no sentence about when it confirmed it.
 *
 * Once that date is older than the board's own threshold, or there are facts
 * the board has never confirmed, the page offers the broker a form to ask the
 * board to look at them again. Whether it is
 * older is decided by the caller, through the one rule in facts-currency.ts
 * that the endpoint taking the request asks again, and handed in here as a
 * boolean: this file reads no clock. The form is the website's own kind - a
 * plain post, a 303 back to this page, and a fixed sentence about what
 * happened - and nothing a broker typed is ever shown back to them.
 */

export type { BrokerPageInput };

/**
 * Where the update request form posts. Below the page's Swedish address
 * whichever of the two addresses the page was read at, because the answer is a
 * redirect to one fixed page.
 */
export const BROKER_UPDATE_REQUEST_PATH = `${BROKER_PATH}/uppdatering`;

/** The query parameter the endpoint answers with, and the page reads back. */
export const BROKER_UPDATE_REQUEST_PARAM = "uppdatering";

/**
 * What became of an update request, as the page tells the broker.
 *
 * `sent` covers a request the board will see and one it already had for the
 * same apartment, because telling those apart would tell a stranger that
 * another broker is asking about it. `current` is the board having confirmed
 * the facts since the page was read, so there was nothing left to ask for.
 */
export type BrokerUpdateRequestState =
  "sent" | "refused" | "limited" | "current";

const STATE_VALUES: Readonly<Record<BrokerUpdateRequestState, string>> = {
  sent: "skickad",
  refused: "fel",
  limited: "for-manga",
  current: "aktuell",
};

/** The address the endpoint redirects to for an outcome. */
export function brokerUpdateRequestAnswerPath(
  state: BrokerUpdateRequestState,
): string {
  return `${BROKER_PATH}?${BROKER_UPDATE_REQUEST_PARAM}=${STATE_VALUES[state]}`;
}

/**
 * The outcome a query value names, or nothing.
 *
 * Nothing is trusted beyond the four words: any other value is nobody having
 * sent anything, so the query can choose one fixed sentence and do nothing
 * else.
 */
export function brokerUpdateRequestState(
  value: string | undefined,
): BrokerUpdateRequestState | null {
  for (const [state, word] of Object.entries(STATE_VALUES)) {
    if (word === value) {
      return state as BrokerUpdateRequestState;
    }
  }
  return null;
}

/** Whether the page offers the update request form, and what was just sent. */
export interface BrokerUpdateRequestOffer {
  /** The facts are older than the board's threshold: facts-currency.ts. */
  requestable: boolean;
  /** How many months the board's threshold is, for the sentence above the form. */
  staleAfterMonths: number;
  state: BrokerUpdateRequestState | null;
}

/** Facts that are current, with nothing just sent: the page has no form. */
const NOT_OFFERED: BrokerUpdateRequestOffer = {
  requestable: false,
  staleAfterMonths: 3,
  state: null,
};

/**
 * The broker information page, as a whole document.
 *
 * Rendered in the association's own language rather than the visitor's, which
 * is the one place on the website where those differ. Site content is
 * monolingual (decision 59): a board writes its fee policy in the language the
 * association keeps its books in, and it is stored and served exactly as
 * written. Translating the labels around it would produce a page whose
 * questions are in one language and whose answers are in another, and whose
 * lang attribute would be a lie about half of it.
 */
export function renderBrokerPage(
  chrome: SiteChrome,
  input: BrokerPageInput,
  offer: BrokerUpdateRequestOffer = NOT_OFFERED,
): string {
  const title = chrome.t("site.broker.title");
  const groups = associationFactGroups(chrome, input);
  const { confirmedAt } = input.facts;

  return renderDocument(
    chrome,
    title,
    <>
      <h1 className="site-title">{title}</h1>
      {confirmedAt === null || !hasRecordedFacts(groups)
        ? null
        : renderConfirmed(chrome, new Date(confirmedAt))}
      {renderFactGroups(groups)}
      {renderUpdateRequest(chrome, offer, confirmedAt !== null)}
    </>,
  );
}

/**
 * The date the board last confirmed the facts, as a sentence.
 *
 * The date and not the time, formatted as a published date is: in the
 * association's zone, so a confirmation made just after midnight is dated by
 * the day it was made here.
 */
function renderConfirmed(chrome: SiteChrome, confirmedAt: Date): ReactElement {
  return (
    <p className="site-facts-confirmed">
      {chrome.t("site.broker.confirmed")}{" "}
      <time dateTime={isoDate(confirmedAt)}>
        {formatNewsDate(confirmedAt, chrome.locale)}
      </time>
      .
    </p>
  );
}

/**
 * The update request: a form while the facts are stale, the sentence about
 * what was just sent, or nothing.
 *
 * The sentence after a request is shown whether or not the facts are still
 * stale, because a broker who sent one has to be told it arrived even when the
 * board confirmed the facts a minute later. The "current" sentence is shown
 * only over facts that are current, so a query typed by hand cannot put it
 * over stale ones: the form has gone because the board has confirmed the
 * facts, and the broker is told so rather than left to wonder.
 */
function renderUpdateRequest(
  chrome: SiteChrome,
  offer: BrokerUpdateRequestOffer,
  confirmed: boolean,
): ReactElement | null {
  const { t } = chrome;

  if (offer.state === "sent") {
    return (
      <section className="site-form">
        <h2>{t("site.brokerUpdateRequest.title")}</h2>
        {formConfirmation(t("site.brokerUpdateRequest.sent"))}
      </section>
    );
  }

  if (!offer.requestable) {
    return offer.state === "current" ? (
      <section className="site-form">
        <h2>{t("site.brokerUpdateRequest.title")}</h2>
        {formConfirmation(t("site.brokerUpdateRequest.current"))}
      </section>
    ) : null;
  }

  return (
    <section className="site-form">
      <h2>{t("site.brokerUpdateRequest.title")}</h2>
      {/* Facts never confirmed are stale too (facts-currency.ts), and have
          no confirmation to say the age of. */}
      <p>
        {confirmed
          ? t("site.brokerUpdateRequest.intro", {
              count: offer.staleAfterMonths,
            })
          : t("site.brokerUpdateRequest.introUnconfirmed")}
      </p>
      {offer.state === "refused"
        ? formRefusal(t("site.brokerUpdateRequest.refused"))
        : null}
      {offer.state === "limited"
        ? formRefusal(t("site.brokerUpdateRequest.limited"))
        : null}
      {updateRequestFields(chrome)}
    </section>
  );
}

/**
 * The fields, each bounded here as the endpoint bounds it, so a broker is
 * stopped by the browser before the server refuses what they wrote.
 *
 * Only the address is required, and there is no phone field: what the form
 * asks for is what the data protection note on the broker package lists, and
 * no more. The note is the one free text, and short: the board needs to know
 * how to reach the broker, and a broker's questions are answered by the facts
 * on this page rather than in a message.
 */
function updateRequestFields(chrome: SiteChrome): ReactElement {
  const { t } = chrome;
  return (
    <form method="post" action={BROKER_UPDATE_REQUEST_PATH}>
      <label className="site-field">
        <span>{t("site.brokerUpdateRequest.email")}</span>
        <input
          type="email"
          name="email"
          maxLength={320}
          required
          autoComplete="email"
        />
      </label>

      <label className="site-field">
        <span>{t("site.brokerUpdateRequest.name")}</span>
        <input type="text" name="name" maxLength={100} autoComplete="name" />
      </label>

      <label className="site-field">
        <span>{t("site.brokerUpdateRequest.brokerage")}</span>
        <input
          type="text"
          name="brokerage"
          maxLength={100}
          autoComplete="organization"
        />
      </label>

      <label className="site-field">
        <span>{t("site.brokerUpdateRequest.apartment")}</span>
        <input type="text" name="apartment" maxLength={20} />
      </label>

      <label className="site-field">
        <span>{t("site.brokerUpdateRequest.note")}</span>
        <textarea name="note" rows={3} maxLength={280} />
      </label>

      {/*
       * What GDPR art. 13 asks to be said where the address is collected -
       * who is asking, why, on what ground, and for how long - beside the
       * button rather than only in the privacy notice: a broker giving their
       * address to a housing cooperative they do not know is owed it before
       * they send.
       */}
      <p className="site-field-hint">
        {t("site.brokerUpdateRequest.privacy", {
          association: chrome.associationName,
        })}
        {chrome.privacyNoticePath === null ? null : (
          <>
            {" "}
            <a href={chrome.privacyNoticePath}>
              {t("site.brokerUpdateRequest.privacyNotice")}
            </a>
          </>
        )}
      </p>

      {formHoneypot()}

      <button type="submit">{t("site.brokerUpdateRequest.submit")}</button>
    </form>
  );
}
