import {
  associationFactGroups,
  type BrokerPageInput,
  renderFactGroups,
} from "./site-facts";
import { renderDocument, type SiteChrome } from "./site-html";

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
 */

export type { BrokerPageInput };

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
): string {
  const title = chrome.t("site.broker.title");

  return renderDocument(
    chrome,
    title,
    <>
      <h1 className="site-title">{title}</h1>
      {renderFactGroups(associationFactGroups(chrome, input))}
    </>,
  );
}
