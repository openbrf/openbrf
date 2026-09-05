import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { MeetingPerson } from "./use-meeting-people";

/**
 * The chip that marks a person whose personal data is protected.
 *
 * Room-side tokens rather than the register board's, because these panels are
 * cards in the room and the board's on-dark variants would not hold their
 * contrast here. The word is the signal and the colour repeats it, which is the
 * same rule the register's own sign follows: a board member who cannot tell the
 * hues apart reads the label.
 */
const PROTECTED_CHIP =
  "inline-flex items-center rounded-control border border-warn px-1.5 text-chip uppercase text-ink";

/**
 * A person, named from the address book.
 *
 * Every identifier the meetings API answers with is rendered through this, so
 * there is one answer to what a name looks like beside a vote, on the list of
 * those present and on an authority - and one answer to what happens when the
 * register does not hold the person.
 *
 * That case is rendered as a statement rather than as a blank. A service-tier
 * row can name somebody the register no longer holds, and a meeting held about a
 * day in the past can name somebody who has since moved; a board member reading
 * an empty space cannot tell either of those from a screen that failed to load.
 *
 * The apartment travels with the name because a board reading a voting register
 * out loud is reading it against the apartments: two households share a surname
 * often enough that the number is what tells them apart. It is what the address
 * book already shows this seat, and it is the only thing besides the name that
 * is rendered here - no contact detail is read for this screen at all.
 */
export function MeetingPersonName({
  person,
  personId,
}: {
  /** The person the address book holds, or null where it holds none. */
  person: MeetingPerson | null;
  /** The identifier the meetings API answered with. */
  personId: string;
}): ReactElement {
  const { t } = useTranslation();

  if (person === null) {
    return (
      <span className="text-ink-muted">
        {t("meetings.person.unknown")}{" "}
        <span className="font-data text-data">{personId}</span>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span>{person.name}</span>
      {person.apartmentNumbers.length === 0 ? null : (
        <span className="font-data text-data text-ink-muted">
          {person.apartmentNumbers.join(", ")}
        </span>
      )}
      {person.protectedPersonalData ? (
        <span className={PROTECTED_CHIP}>{t("register.sign.protected")}</span>
      ) : null}
    </span>
  );
}
