import { fetchAddresses, fetchApartments } from "../api/instance";
import {
  fetchBoardRegister,
  REGISTER_MAX_PAGE_SIZE,
  RegisterRequestError,
} from "../register/register-api";

/**
 * Who and what a charge can be put on, as the form offers them.
 *
 * Read from the register rather than typed in. A charge names a person or an
 * apartment by identifier, so a form that took a name as text would either
 * invent a party the register does not hold or ask a board member to copy an
 * identifier - and the module's own rule is that exactly one of the two is
 * named.
 *
 * Both lists come from what the board can already see: the address book for the
 * people, the addresses and their apartments for the flats. Neither read is new
 * access, and neither is gated on the charges capability - a board member who
 * can reach this screen can reach both of those.
 *
 * Everybody the register holds, including people who have moved out. A final
 * charge for the key that was not handed back is put on the household that left,
 * and a list of current residents could not offer them.
 */

export interface ChargeablePerson {
  personId: string;
  name: string;
  /** Where they live, for telling two people of one name apart. */
  apartment: string | null;
  /**
   * The day they moved in, carried only for the case below.
   *
   * Null where the register holds none, which is also the case where two
   * otherwise identical people cannot be told apart at all - the option then
   * reads the same for both, and there is nothing truthful to add.
   */
  movedInOn: string | null;
  /**
   * Whether somebody else renders the same name and the same apartment.
   *
   * A register can hold two people of one name in one flat - a father and a son
   * - and an option that read the same for both would ask a board to choose
   * between two identical rows, which is not a choice. Where that happens the
   * option carries the day each of them moved in, which is what the register
   * holds and what tells them apart; where it does not, the option stays short.
   *
   * Computed over the whole list rather than per row, because being ambiguous is
   * a fact about a pair and not about a person.
   */
  ambiguous: boolean;
}

export interface ChargeableApartment {
  apartmentId: string;
  /** "<street> <number> <apartment number>". */
  label: string;
}

export interface ChargeParties {
  persons: ChargeablePerson[];
  apartments: ChargeableApartment[];
}

/**
 * How many pages of the register one load reads.
 *
 * The endpoint pages at a hundred rows and this form needs the book as a whole,
 * so it reads until the rows run out. Bounded because an unbounded loop against
 * a paging endpoint is a way to hang a screen on a server that keeps answering:
 * two thousand people is far beyond any housing cooperative.
 *
 * Reaching the bound fails the load rather than answering the pages that did
 * arrive. A short list is not a smaller version of this form's job: the people
 * it leaves out cannot be charged at all, and nothing on the screen would say
 * which they were. The failure state the module already has says the parties
 * could not be read and offers the retry, which is true.
 */
const MAX_PAGES = 20;

/**
 * Loads both lists.
 *
 * Throws rather than answering a result, because the screen treats a failure
 * here the way it treats a failed list read: the form cannot be offered without
 * somebody to charge, so there is one failure state and one retry rather than a
 * form that renders with two empty selects.
 */
export async function loadChargeParties(
  signal: AbortSignal,
): Promise<ChargeParties> {
  const [persons, apartments] = await Promise.all([
    loadPersons(signal),
    loadApartments(signal),
  ]);
  return { persons, apartments };
}

async function loadPersons(signal: AbortSignal): Promise<ChargeablePerson[]> {
  const persons: ChargeablePerson[] = [];
  const seen = new Set<string>();

  for (let page = 1; page <= MAX_PAGES; page++) {
    const answer = await fetchBoardRegister(
      { filter: "all", page, pageSize: REGISTER_MAX_PAGE_SIZE },
      signal,
    );

    for (const row of answer.rows) {
      /*
       * A person with two residencies is two rows in the register and one
       * person to charge, so the first row wins and the rest are skipped. The
       * apartment on the option is a hint for telling two people of one name
       * apart rather than part of the charge: a charge on a person names no
       * apartment at all.
       */
      if (seen.has(row.personId)) {
        continue;
      }
      seen.add(row.personId);
      persons.push({
        personId: row.personId,
        name: row.name,
        apartment: apartmentOf(answer.addresses, row.apartment),
        movedInOn: row.movedInOn,
        // Settled below, once the whole list is known.
        ambiguous: false,
      });
    }

    if (persons.length >= answer.total || answer.rows.length === 0) {
      return markAmbiguous(persons).sort((first, second) =>
        first.name.localeCompare(second.name),
      );
    }
  }

  throw new Error(
    `The address book did not fit in ${String(MAX_PAGES)} pages of ${String(
      REGISTER_MAX_PAGE_SIZE,
    )}.`,
  );
}

/**
 * Flags the people an option would otherwise render identically.
 *
 * Exported for its own test: the case it exists for needs two people the
 * register happens to hold the same way, which is awkward to arrange and easy to
 * state directly.
 */
export function markAmbiguous(
  persons: readonly ChargeablePerson[],
): ChargeablePerson[] {
  const shown = new Map<string, number>();
  const shownAs = (person: ChargeablePerson): string =>
    `${person.name}\u0000${person.apartment ?? ""}`;

  for (const person of persons) {
    shown.set(shownAs(person), (shown.get(shownAs(person)) ?? 0) + 1);
  }

  return persons.map((person) => ({
    ...person,
    ambiguous: (shown.get(shownAs(person)) ?? 0) > 1,
  }));
}

/**
 * The flats, one address at a time.
 *
 * The signal is read between the requests rather than carried into them: the
 * shared API client sends no signal, and giving it one is a change to every call
 * in this application rather than to this screen. Stopping at the next boundary
 * is what the waste here is made of - one request per address, in sequence - so
 * an abandoned load stops after the request in flight instead of walking the
 * whole address list a second time.
 */
async function loadApartments(
  signal: AbortSignal,
): Promise<ChargeableApartment[]> {
  signal.throwIfAborted();

  const addresses = await fetchAddresses();
  if (!addresses.ok) {
    throw new RegisterRequestError(
      addresses.failure.status,
      addresses.failure.reason,
    );
  }

  const apartments: ChargeableApartment[] = [];
  for (const address of addresses.value) {
    signal.throwIfAborted();

    const answer = await fetchApartments(address.id);
    if (!answer.ok) {
      throw new RegisterRequestError(
        answer.failure.status,
        answer.failure.reason,
      );
    }
    for (const apartment of answer.value) {
      apartments.push({
        apartmentId: apartment.id,
        label: `${address.street} ${address.number} ${apartment.number}`,
      });
    }
  }

  return apartments.sort((first, second) =>
    first.label.localeCompare(second.label),
  );
}

/** The apartment a register row names, as the board writes it. */
function apartmentOf(
  addresses: readonly { id: string; street: string; number: string }[],
  apartment: { addressId: string; number: string } | null,
): string | null {
  if (apartment === null) {
    return null;
  }
  const address = addresses.find((entry) => entry.id === apartment.addressId);
  return address === undefined
    ? apartment.number
    : `${address.street} ${address.number} ${apartment.number}`;
}
