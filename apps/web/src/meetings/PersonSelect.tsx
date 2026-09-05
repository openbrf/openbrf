import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { FIELD, LABEL } from "../ui/controls";
import type { MeetingPeople } from "./use-meeting-people";

export interface PersonSelectProps {
  label: string;
  people: MeetingPeople;
  /** The chosen identifier, or "" while none is chosen. */
  value: string;
  onChange: (personId: string) => void;
  disabled?: boolean;
}

/**
 * Choosing one person out of the address book.
 *
 * ## Everybody, and the server decides
 *
 * The list is every person the address book holds and is deliberately not
 * narrowed to those the screen believes are members. Who may be checked in, in
 * which capacity, and who may hold an authority are questions about the member
 * register as of the meeting day, and the server answers them - a screen that
 * offered only the people it had worked out were members today would be a second
 * opinion on the statute, formed from the wrong day, and it would hide somebody
 * the server would have accepted.
 *
 * The refusals are written for exactly this. `not-a-member-on-the-meeting-day`
 * and `proxy-holder-not-a-member` name the rule rather than saying no, which is
 * what lets the picker stay open and the answer stay correct.
 *
 * ## Why a select rather than a search box
 *
 * A housing cooperative is tens of households, and the whole book is already on
 * the screen: a control the board can open, read down and pick from is what
 * somebody at a door does, and it needs no request between the reader and the
 * name. A search box would put one there, and would hide from a board member the
 * fact that a name they expected is not in the register at all - which is
 * precisely what they need to find out before the meeting starts.
 *
 * The apartment travels in the option's own text because two households share a
 * surname often enough that the number is what tells them apart.
 */
export function PersonSelect({
  label,
  people,
  value,
  onChange,
  disabled = false,
}: PersonSelectProps): ReactElement {
  const { t } = useTranslation();

  return (
    <label className={`${LABEL} min-w-64 flex-1`}>
      {label}
      <select
        className={FIELD}
        value={value}
        disabled={disabled || !people.ready}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        <option value="">
          {people.ready
            ? t("meetings.people.choose")
            : t("meetings.people.loading")}
        </option>
        {people.everyone.map((person) => (
          <option key={person.personId} value={person.personId}>
            {person.apartmentNumbers.length === 0
              ? person.name
              : `${person.name} (${person.apartmentNumbers.join(", ")})`}
          </option>
        ))}
      </select>
    </label>
  );
}
