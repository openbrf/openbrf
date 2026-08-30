import type { TFunction } from "i18next";

/**
 * What a member reads when the board texts them about a news item.
 *
 * A notice and never the article, for the reason the email is a notice: the
 * announcement lives on the association's own website, where taking it down
 * takes it down. A text message is also the least private place the platform
 * writes anything - it arrives unencrypted, on a lock screen, over a network
 * the association does not run - so what it carries is a headline and an
 * address, and nothing that would not have been published anyway.
 *
 * The message is bounded, and the address is what survives the bound. A long
 * headline is cut; the link never is, because a message whose link has lost its
 * last characters is a message that cost the association money and told the
 * member nothing.
 */

/**
 * Characters the whole message is held to.
 *
 * Two GSM-7 segments. The count is characters rather than segments on purpose:
 * how a provider divides a message depends on the alphabet it picks, and a
 * headline with a typographic apostrophe in it can halve the capacity of every
 * segment. A fixed character budget is a bound the board can reason about
 * without knowing any of that, and it errs towards the cheaper message.
 */
export const MAX_SMS_CHARACTERS = 320;

/** The mark left where a headline was cut. */
const ELLIPSIS = "...";

export interface NewsSmsInput {
  /** Bound to the recipient's own locale, like every other message. */
  t: TFunction;
  /** The association's name, so an unknown number identifies itself. */
  association: string;
  /** The news item's own title, as the board wrote it. */
  title: string;
  /** Absolute address of the article on the association's website. */
  articleUrl: string;
}

export function composeNewsSms(input: NewsSmsInput): string {
  const lead = input.t("sms.news.lead", {
    association: input.association,
    title: input.title,
  });

  // What is left for the lead once the address and the line break are paid for.
  const budget = MAX_SMS_CHARACTERS - input.articleUrl.length - 1;

  if (budget <= 0) {
    // An address alone longer than the whole budget. Nothing here can shorten a
    // URL without breaking it, so the message is the address and the bound is
    // the one thing that gives way.
    return input.articleUrl;
  }

  return `${truncate(lead, budget)}\n${input.articleUrl}`;
}

/** The text, or as much of it as fits with a mark where the rest was. */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  if (limit <= ELLIPSIS.length) {
    return text.slice(0, limit);
  }
  return `${text.slice(0, limit - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}
