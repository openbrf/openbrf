import type { ReactElement } from "react";
import type { AuthorView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { ASSOCIATION_TIME_ZONE } from "../bookings/booking-calendar";
import type { TranslationKey } from "../i18n/translation-key";
import { NotRecorded } from "../ui/NotRecorded";

/**
 * When something was written, on the association's own clock.
 *
 * The day as well as the time, because the feed is read days apart and a bare
 * time of day would put last Tuesday's post and this morning's beside each
 * other with nothing to tell them apart.
 *
 * On the association's clock rather than the reader's browser, and rather than
 * sliced out of the ISO string. Slicing reads the UTC day, which is the wrong
 * day for anything written after midnight in Stockholm summer time - a post
 * written at 01:30 on the 5th would be dated the 4th on its own author's screen.
 */
export function writtenAt(instant: string, locale: string): string {
  const value = new Date(instant);
  return Number.isNaN(value.getTime())
    ? instant
    : new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: ASSOCIATION_TIME_ZONE,
      }).format(value);
}

/**
 * Who somebody is, as one string: for the name a screen reader announces on a
 * control, and for the avatar's letters.
 *
 * A sighted reader sees a sentence where an author cannot be named, and a
 * control announced as "report the post from - " would be announcing
 * punctuation. So the sentence the dash stands for is used instead.
 */
export function authorLabel(
  of: AuthorView,
  t: (key: TranslationKey) => string,
): string {
  if (of.kind === "person") {
    return of.name;
  }
  return of.kind === "protected"
    ? t("feed.authorProtected")
    : t("feed.authorUnknown");
}

/**
 * Who a post or a comment is from, as the reader is told it.
 *
 * Written as Styrelsen, it is from the board - and, when its writer chose to be
 * named, "Styrelsen via" them. Otherwise from its writer.
 *
 * A person with protected personal data is named to nobody here, every reader
 * included: the board holds `protectedData:reveal` with its seats, but that
 * capability is what lets somebody perform an act of revealing and be recorded
 * doing it, and a name appearing in a feed nothing audits is not that act. A
 * reference that no longer resolves says so rather than showing an empty name -
 * a post is erased on its own clock and a person can be purged out from under
 * one.
 */
export function Byline({
  author,
  byBoard,
}: {
  author: AuthorView | null;
  byBoard: boolean;
}): ReactElement {
  const { t } = useTranslation();

  if (byBoard || author === null) {
    return (
      <span>
        {t("feed.authorBoard")}
        {author === null ? null : (
          <>
            {" "}
            <span className="font-normal text-ink-muted">
              {t("feed.via")}
            </span>{" "}
            <PersonName of={author} />
          </>
        )}
      </span>
    );
  }
  return <PersonName of={author} />;
}

function PersonName({ of }: { of: AuthorView }): ReactElement {
  const { t } = useTranslation();

  if (of.kind === "person") {
    return <span>{of.name}</span>;
  }
  return (
    <NotRecorded
      meaning={
        of.kind === "protected"
          ? t("feed.authorProtected")
          : t("feed.authorUnknown")
      }
    />
  );
}

/**
 * The author's mark beside a post: their initials on a square plate.
 *
 * There are no portraits in the register and there will not be any: a
 * photograph of a resident in front of the whole house is a publication, which
 * wants a consent this product does not ask for. Initials say whose post it is
 * at a glance, which is all a mark here is for.
 *
 * Styrelsen's plate is outlined in brass, because a post written as the board
 * speaks from a position of trust and brass is that colour's one meaning
 * (DESIGN.md). Nobody else's is. A person who cannot be named has no letters
 * either, and the plate says nothing rather than something false.
 *
 * Decorative: the name beside it is what is read out, so the plate is hidden
 * from a screen reader rather than announced twice.
 */
export function Avatar({
  author,
  byBoard,
  size = "post",
}: {
  author: AuthorView | null;
  byBoard: boolean;
  size?: "post" | "comment";
}): ReactElement {
  const { t } = useTranslation();
  const board = byBoard || author === null;
  const letters = board
    ? initials(t("feed.authorBoard"))
    : author.kind === "person"
      ? initials(author.name)
      : "";
  const box = size === "post" ? "size-10 text-small" : "size-8 text-chip";

  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-control border font-semibold uppercase ${box} ${
        board
          ? "border-trust text-trust"
          : "border-line-strong bg-sunken text-ink"
      }`}
    >
      {letters}
    </span>
  );
}

/** The first letter of the first and the last word of a name. */
function initials(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((word) => word !== "");
  const first = words.at(0)?.at(0) ?? "";
  const last = words.length > 1 ? (words.at(-1)?.at(0) ?? "") : "";
  return `${first}${last}`;
}
