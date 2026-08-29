import type { APIRequestContext } from "@playwright/test";

import * as api from "./api";
import { ADDRESSES } from "./provision";
import { stack } from "./stack";

/**
 * An apartment nobody has ever lived in, for a spec that writes a residency.
 *
 * The counterpart of `src/identity.ts` for places rather than people. A
 * residency, a transfer and a member register entry are all kept for good -
 * nothing in the suite can take one back - so a spec naming a fixed apartment
 * describes a different apartment on its second run against one database: one
 * that is already held, whose first grant has already been recorded and whose
 * holder is somebody else. `OPENBRF_E2E_REUSE_STACK` is the run that happens
 * on.
 *
 * The apartment is added to the register rather than picked out of it. "Free"
 * is not a question the API answers, and a list read a moment ago is not a
 * claim; a number the register does not hold yet cannot have a resident, which
 * is the guarantee these specs need. Adding apartments is what a board does
 * through this same endpoint when it takes another entrance into the register.
 *
 * The numbers sit on a floor above the ones the setup wizard generated, so
 * nothing here can collide with an apartment a spec addresses by number.
 */

/**
 * The first floor above every floor the fixture's addresses have.
 *
 * Read off the fixture rather than written down: floors are generated from 0
 * upwards, so the count is also the first free floor. An address gaining a
 * storey in the fixture moves this with it.
 */
const SPARE_FLOOR = Math.max(...ADDRESSES.map((address) => address.floors));

/** Apartments a landing can carry in the four-digit form: 01 to 99. */
const MAX_PER_FLOOR = 99;

export interface ClaimedApartment {
  readonly id: string;
  /** Four digits, as every register document and every select spells it. */
  readonly number: string;
  /** "Storgatan 12", the way the address reads on screen. */
  readonly addressLabel: string;
}

/**
 * Claims one apartment on the address with this number.
 *
 * The caller must already be signed in as somebody who may write the register
 * (`ensureInstance` leaves the request context that way).
 */
export async function claimApartment(
  request: APIRequestContext,
  addressNumber: string,
): Promise<ClaimedApartment> {
  const addresses = await api.listAddresses(request, stack.baseUrl);
  const address = addresses.find(
    (candidate) => candidate.number === addressNumber,
  );
  if (address === undefined) {
    throw new Error(`no address numbered ${addressNumber} in the register`);
  }

  const numberOn = (index: number): string =>
    String(1000 + SPARE_FLOOR * 100 + index);

  const held = new Set(
    (await api.listApartments(request, stack.baseUrl, address.id)).map(
      (apartment) => apartment.number,
    ),
  );

  let index = 1;
  while (held.has(numberOn(index))) {
    index += 1;
    if (index > MAX_PER_FLOOR) {
      throw new Error(
        `every spare apartment on ${address.street} ${address.number} is taken; start the stack from empty volumes`,
      );
    }
  }

  const number = numberOn(index);
  await api.addApartments(request, stack.baseUrl, address.id, [
    // The floor the number encodes, so the address book files the apartment
    // where its own designation says it is.
    { number, floor: SPARE_FLOOR },
  ]);

  const claimed = (
    await api.listApartments(request, stack.baseUrl, address.id)
  ).find((candidate) => candidate.number === number);
  if (claimed === undefined) {
    throw new Error(
      `apartment ${number} was not added to ${address.street} ${address.number}`,
    );
  }

  return {
    id: claimed.id,
    number: claimed.number,
    addressLabel: `${address.street} ${address.number}`,
  };
}
