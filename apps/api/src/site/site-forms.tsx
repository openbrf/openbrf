import type { TFunction } from "i18next";
import type { ReactElement, ReactNode } from "react";

import { HONEYPOT_FIELD } from "../http/honeypot";
import type { ContactFormBlock, IssueReportFormBlock } from "./page-content";

/**
 * The two forms the association's website puts in front of somebody with no
 * account: a message to the board, and a report of something broken.
 *
 * They are plain HTML. A `<form method="post">`, a 303 to the page they were
 * sent from, and a confirmation rendered there - no JavaScript, no cookie, no
 * request to anybody else. That is not nostalgia: the whole website is served
 * under a content policy with no script source at all, so a form that needed
 * one could not run, and a form that needs one cannot be sent by a visitor who
 * has scripting switched off either. What this costs is a page reload per
 * submission. What it buys is a form that works in every browser a housing
 * cooperative's members and neighbours actually use.
 *
 * Pure, like the rest of the renderer: everything these functions know arrives
 * as an argument. Nothing here reads a database, a request or a clock, and
 * every string that came from a person is a React child, so it is escaped by
 * construction - which is what keeps a message somebody typed from becoming
 * markup on the page it is echoed back to. Nothing IS echoed back, and that is
 * the second half of the same argument: a confirmation says a fixed translated
 * sentence and never repeats what was submitted.
 */

/** Which of the two forms a path, a query or a block is about. */
export type SiteFormKind = "contact" | "issue";

/**
 * The last path segment each form posts to, below the page's own address.
 *
 * Fixed and Swedish, for the reason the privacy notice's slug is: the address
 * is part of the association's public website and has to be the same on every
 * instance, whatever language the cooperative was set up in. The page's own
 * slug is what varies, and it is what the form's action starts with, so a
 * submission is always sent to the page it was read on and can be answered by
 * redirecting straight back to it.
 */
export const SITE_FORM_PATH: Readonly<Record<SiteFormKind, string>> = {
  contact: "kontakt",
  issue: "felanmalan",
};

/** Query parameter naming the form a visitor has just sent. */
export const SITE_FORM_SENT_PARAM = "skickat";

/** Query parameter naming the form that could not read what was sent. */
export const SITE_FORM_REFUSED_PARAM = "fel";

/** The form a path segment or a query value names, or nothing. */
export function siteFormKind(value: string | undefined): SiteFormKind | null {
  if (value === SITE_FORM_PATH.contact) {
    return "contact";
  }
  if (value === SITE_FORM_PATH.issue) {
    return "issue";
  }
  return null;
}

/** An issue type as the public form offers it. */
export interface SiteIssueType {
  id: string;
  name: string;
}

/**
 * What a page's forms need to know about the request that reached them.
 *
 * Separate from SiteChrome because every field here is about one page and one
 * visit, while the chrome is about the association. Handing it in rather than
 * reading it keeps this module pure and keeps the decisions - may this page
 * carry a form at all, does the association take public reports - in the
 * service that is allowed to ask.
 */
export interface SiteFormState {
  /** The page's own address. A form on it posts below this and returns to it. */
  pagePath: string;
  /**
   * Whether an anonymous visitor may read this page.
   *
   * A form renders on no other kind. A member-only page's form would be one
   * whose submission the endpoint refuses - it resolves the page as an
   * anonymous visitor, so that a page nobody may read stays indistinguishable
   * from one that was never written - and a form that cannot be sent is worse
   * than no form.
   */
  publiclyReadable: boolean;
  /** The form this visitor has just sent, when they have. */
  sent: SiteFormKind | null;
  /** The form that could not read what they wrote, when that happened. */
  refused: SiteFormKind | null;
  /**
   * The types a public report may be filed under, or null.
   *
   * Null means the association does not take reports from the public: the
   * board's switch is off, and the block then renders as nothing. A page
   * survives the switch being turned - the block stays where the board put it
   * and reappears when reporting is opened again - which is why this is a
   * rendering decision rather than something the page's body records.
   *
   * An empty list is a different thing: reporting is open and nobody has
   * configured a type for the public yet. That renders as nothing too, because
   * a form whose only choice is empty cannot be filled in.
   */
  issueTypes: readonly SiteIssueType[] | null;
}

/** A form block becomes a form, a confirmation, or nothing. */
export function renderSiteForm(
  t: TFunction,
  block: ContactFormBlock | IssueReportFormBlock,
  state: SiteFormState,
  intro: ReactNode,
  key: number,
): ReactElement | null {
  if (!state.publiclyReadable) {
    return null;
  }

  if (block.type === "contactForm") {
    return (
      <section className="site-form" key={key}>
        <h2>{t("site.contactForm.title")}</h2>
        {intro}
        {state.sent === "contact" ? (
          confirmation(t("site.contactForm.sent"))
        ) : (
          <>
            {state.refused === "contact"
              ? refusal(t("site.contactForm.refused"))
              : null}
            {contactFields(t, state)}
          </>
        )}
      </section>
    );
  }

  const types = state.issueTypes;
  if (types === null || types.length === 0) {
    return null;
  }

  return (
    <section className="site-form" key={key}>
      <h2>{t("site.issueForm.title")}</h2>
      {intro}
      {state.sent === "issue" ? (
        confirmation(t("site.issueForm.sent"))
      ) : (
        <>
          {state.refused === "issue"
            ? refusal(t("site.issueForm.refused"))
            : null}
          {issueFields(t, state, types)}
        </>
      )}
    </section>
  );
}

/**
 * What a visitor is told once their message is stored.
 *
 * A fixed sentence, and deliberately not a receipt. It names no identifier,
 * repeats nothing that was submitted and says nothing about what happened
 * afterwards - a message dropped for filling the decoy is answered with this
 * exact paragraph, and so is one the board is already reading.
 */
function confirmation(sentence: string): ReactElement {
  return (
    <p className="site-form-sent" role="status">
      {sentence}
    </p>
  );
}

/**
 * What a visitor is told when the form could not read what they wrote.
 *
 * Also a fixed sentence, and for a plainer reason: the only thing the endpoint
 * can be sure of is that the submission did not hold what the form asks for,
 * and reporting which field would mean carrying what was typed back to the
 * page it came from.
 */
function refusal(sentence: string): ReactElement {
  return (
    <p className="site-form-refused" role="alert">
      {sentence}
    </p>
  );
}

function contactFields(t: TFunction, state: SiteFormState): ReactElement {
  return (
    <form method="post" action={formAction(state, "contact")}>
      <label className="site-field">
        <span>{t("site.contactForm.name")}</span>
        <input type="text" name="name" maxLength={100} autoComplete="name" />
      </label>

      <label className="site-field">
        <span>{t("site.contactForm.email")}</span>
        <input
          type="email"
          name="email"
          maxLength={320}
          required
          autoComplete="email"
        />
      </label>

      <label className="site-field">
        <span>{t("site.contactForm.message")}</span>
        <textarea name="message" rows={6} maxLength={4000} required />
      </label>

      {honeypot()}

      <button type="submit">{t("site.contactForm.submit")}</button>
    </form>
  );
}

function issueFields(
  t: TFunction,
  state: SiteFormState,
  types: readonly SiteIssueType[],
): ReactElement {
  return (
    <form method="post" action={formAction(state, "issue")}>
      <label className="site-field">
        <span>{t("site.issueForm.type")}</span>
        {/*
         * The types the association offers the public, and no others. The list
         * is filtered on the server by the same rule that decides what a
         * submission may name, so a report posted with an identifier that was
         * never on the page is refused rather than filed.
         */}
        {/*
         * No placeholder option and no preselection of our own: a select with
         * no chosen value opens on its first entry in every browser, which is
         * the behaviour a form with no JavaScript should lean on rather than
         * work around.
         */}
        <select name="type" required>
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      </label>

      <label className="site-field">
        <span>{t("site.issueForm.location")}</span>
        <input type="text" name="location" maxLength={200} />
      </label>

      <label className="site-field">
        <span>{t("site.issueForm.description")}</span>
        <textarea name="description" rows={6} maxLength={4000} required />
        {/*
         * The warning the law research asks for, beside the field rather than
         * in a policy elsewhere: a report about a leak or about a neighbour
         * carries health data and somebody else's details without anybody
         * meaning it to. The form warns; it never refuses, because refusing a
         * description that looks like personal data would refuse the reports
         * this form exists for.
         */}
        <span className="site-field-hint">{t("site.issueForm.warning")}</span>
      </label>

      <label className="site-field">
        <span>{t("site.issueForm.name")}</span>
        <input type="text" name="name" maxLength={100} autoComplete="name" />
      </label>

      <label className="site-field">
        <span>{t("site.issueForm.email")}</span>
        <input type="email" name="email" maxLength={320} autoComplete="email" />
      </label>

      {honeypot()}

      <button type="submit">{t("site.issueForm.submit")}</button>
    </form>
  );
}

/**
 * Where a form sends what was written in it.
 *
 * The page's own address plus one fixed segment. A relative action would do the
 * same thing and is one confusion away from doing something else - the page is
 * served at exactly one address, so the address is written out. The policy
 * carries form-action 'self', so a stored page cannot make a form post
 * anywhere but this instance whatever this function returns.
 */
function formAction(state: SiteFormState, kind: SiteFormKind): string {
  return `${state.pagePath}/${SITE_FORM_PATH[kind]}`;
}

/**
 * The decoy, rendered the way `http/honeypot.ts` says every side must render
 * it: out of sight, out of the accessibility tree, out of the tab order.
 *
 * A person using a screen reader must never be offered it. They would fill it
 * in honestly and their message to the board would be dropped without a word to
 * either of them, which is the one way this convention can do harm.
 */
function honeypot(): ReactElement {
  return (
    <div className="site-hidden" aria-hidden="true">
      <input
        type="text"
        name={HONEYPOT_FIELD}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
}
