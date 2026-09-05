import { useEffect, useState } from "react";

import {
  type BoardRow,
  fetchBoardRegister,
  REGISTER_MAX_PAGE_SIZE,
} from "../register/register-api";

/**
 * A name beside every identifier the meetings API answers with.
 *
 * The meetings module holds no copy of the address book and answers with person
 * identifiers throughout - on the list of those present, on every authority, on
 * each line of the voting register and on the notice's list of members it could
 * not reach. That is deliberate on its side: a second store of who somebody is
 * would be a second thing to keep true, and the address book is already the
 * answer.
 *
 * So the screens read the address book for the names, which is the same data
 * through the same capability rather than a new disclosure: `meetings:manage`
 * and `addressBook:read` are held by the same seat, and the board's own view of
 * the register carries these names already. What travels with a name is what
 * that view already carries - the apartment and whether the person's personal
 * data is protected - and nothing else. No contact detail is read here and none
 * is rendered.
 *
 * ## Everybody, and never a judgement about who may be checked in
 *
 * The book is read whole rather than filtered to members, and the picker offers
 * every person in it. Who may be recorded present, in which capacity, is a
 * question about the member register as of the meeting day, and the server
 * answers it - `not-a-member-on-the-meeting-day` is one of its refusals. A
 * screen that offered only the people it had decided were members would be a
 * second opinion on the statute, formed from residencies as they stand today
 * rather than from the register as it stood on the day that decides the vote,
 * and it would silently hide somebody the server would have accepted.
 *
 * `filter: "all"` is what makes that true. It puts no residency condition on the
 * query at all, so the answer covers people who have moved out and people the
 * board has entered without moving in - both of whom can be the answer to "who
 * is this identifier" on a meeting held about a day in the past.
 *
 * ## Read once, for the whole screen
 *
 * One read per screen rather than one per panel, because six panels name the
 * same people and six copies of this map could disagree after a move. It is not
 * re-read when a meeting changes: an act on a meeting changes the meeting and
 * never the address book, so a re-read after every check-in would be a request
 * that could not return anything different.
 */
export interface MeetingPerson {
  personId: string;
  name: string;
  /**
   * The apartments the address book lists them at, sorted, as their numbers.
   *
   * Plural, because a person appears once per residency: somebody holding two
   * tenant-ownerships has two rows, and one vote. Empty for a person with no
   * residency at all, which is what an external board member looks like.
   */
  apartmentNumbers: readonly string[];
  /** Whether their personal data is protected (skyddade personuppgifter). */
  protectedPersonalData: boolean;
}

export interface MeetingPeople {
  /** True once a read has settled, whichever way it went. */
  ready: boolean;
  /** True where the address book could not be read at all. */
  failed: boolean;
  /** Everybody the address book holds, by name. */
  everyone: readonly MeetingPerson[];
  /**
   * The person behind one identifier, or null where the register does not hold
   * them.
   *
   * Null is a real answer rather than a failure, and the screens render it as
   * one: a service-tier row can name a person the register no longer holds, and
   * an identifier printed where a name should be is more honest than a blank.
   */
  find: (personId: string) => MeetingPerson | null;
}

const NONE = new Map<string, MeetingPerson>();

/**
 * How many pages one read will fetch before it stops.
 *
 * A bound rather than a limit anybody has: at a hundred rows a page this is ten
 * thousand people, which is two orders of magnitude past the largest housing
 * cooperative in Sweden. It is here so a paging bug on either side of the wire
 * cannot turn one screen into an unbounded number of requests.
 */
const MAX_PAGES = 100;

/** Reads the address book once, and answers for the identifiers on a meeting. */
export function useMeetingPeople(): MeetingPeople {
  const [people, setPeople] =
    useState<ReadonlyMap<string, MeetingPerson>>(NONE);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    const load = async (): Promise<void> => {
      const collected = new Map<string, MeetingPerson>();
      try {
        let seen = 0;
        for (let page = 1; page <= MAX_PAGES; page += 1) {
          const answer = await fetchBoardRegister(
            { filter: "all", page, pageSize: REGISTER_MAX_PAGE_SIZE },
            controller.signal,
          );
          for (const row of answer.rows) {
            absorb(collected, row);
          }
          seen += answer.rows.length;
          /*
           * Rows seen against the server's own total, rather than a short page
           * being read as the end of the book. A page can be short of the size
           * asked for while more remain: the endpoint draws its rows from
           * residencies and from persons without one, and takes what is left of
           * a page from the second source.
           *
           * Rows and not entries. A person holding two tenant-ownerships is two
           * rows of that total and one entry in the map, so counting entries
           * would leave a total that can never be reached.
           *
           * An empty page stops as well, whatever the total says. Nothing else
           * would end the loop if the two ever disagreed, and a screen asking
           * for a hundred pages is worse than a screen missing a name.
           */
          if (answer.rows.length === 0 || seen >= answer.total) {
            break;
          }
        }
      } catch {
        /*
         * Including the abort, which is the same outcome for this hook: the
         * screen is gone or a newer read owns the state, and the guard below
         * drops the answer either way.
         */
        if (active) {
          setFailed(true);
          setReady(true);
        }
        return;
      }

      if (active) {
        setPeople(collected);
        setFailed(false);
        setReady(true);
      }
    };

    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, []);

  return {
    ready,
    failed,
    everyone: [...people.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "sv"),
    ),
    find: (personId) => people.get(personId) ?? null,
  };
}

/**
 * Folds one register row into the map, merging a person who appears twice.
 *
 * A person holding two tenant-ownerships has two rows and is one person with one
 * vote, so the apartments accumulate and the name does not: both rows carry the
 * same name, and picking either is picking the same one.
 */
function absorb(collected: Map<string, MeetingPerson>, row: BoardRow): void {
  const held = collected.get(row.personId);
  const numbers = new Set(held?.apartmentNumbers ?? []);
  if (row.apartment !== null) {
    numbers.add(row.apartment.number);
  }

  collected.set(row.personId, {
    personId: row.personId,
    name: row.name,
    apartmentNumbers: [...numbers].sort((left, right) =>
      left.localeCompare(right, "sv", { numeric: true }),
    ),
    protectedPersonalData: row.protectedPersonalData,
  });
}
