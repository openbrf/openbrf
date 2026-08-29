import {
  request as playwrightRequest,
  type APIRequestContext,
} from "@playwright/test";

import * as api from "./api";
import { linkFrom, waitForMessage } from "./mailpit";
import { stack } from "./stack";

/**
 * The instance every spec after the first one expects to find.
 *
 * The first-boot spec creates this through the wizard, screen by screen, which
 * is what criterion 1 is about. Every other spec needs the same instance to
 * exist but is not about how it was made, so it calls the functions here, which
 * do the same thing over HTTP and do nothing when the work is already done.
 *
 * Idempotent against the database rather than against process state: Playwright
 * may run spec files in different worker processes, so "have I already done
 * this" has to be a question about the instance, not about this module.
 */

export const HOUSING_COOPERATIVE = {
  name: "Brf Eksemplet",
  organizationNumber: "769600-0000",
} as const;

export const ADMINISTRATOR = {
  firstName: "Holger",
  lastName: "Ekstrom",
  email: "holger@eksemplet.test",
  password: "spisbrod-vindsvag-2026",
} as const;

/**
 * Two addresses with 28 and 14 apartments, per exit criterion 1. Apartment
 * numbers follow the Lantmateriet convention the generator produces:
 * 1000 + floor * 100 + index.
 */
export const ADDRESSES = [
  {
    street: "Storgatan",
    number: "12",
    postalCode: "11122",
    city: "Stockholm",
    floors: 7,
    perFloor: 4,
  },
  {
    street: "Storgatan",
    number: "14",
    postalCode: "11122",
    city: "Stockholm",
    floors: 7,
    perFloor: 2,
  },
] as const;

export function apartmentRows(
  address: (typeof ADDRESSES)[number],
): { number: string; floor: number }[] {
  const rows: { number: string; floor: number }[] = [];
  for (let floor = 0; floor < address.floors; floor += 1) {
    for (let index = 1; index <= address.perFloor; index += 1) {
      rows.push({
        number: String(1000 + floor * 100 + index),
        floor,
      });
    }
  }
  return rows;
}

/** Signs the shared administrator in on a request context. */
export async function signInAsAdministrator(
  request: APIRequestContext,
): Promise<void> {
  await api.signIn(request, stack.baseUrl, {
    email: ADMINISTRATOR.email,
    password: ADMINISTRATOR.password,
  });
}

/**
 * Creates the housing cooperative, its addresses, its apartments and its email
 * settings, and marks setup complete. Returns a signed-in admin context.
 */
export async function ensureInstance(
  request: APIRequestContext,
): Promise<void> {
  const state = await api.setupState(request, stack.baseUrl);
  if (state.setupRequired) {
    await api.createFirstAdministrator(request, stack.baseUrl, {
      firstName: ADMINISTRATOR.firstName,
      lastName: ADMINISTRATOR.lastName,
      email: ADMINISTRATOR.email,
      password: ADMINISTRATOR.password,
    });
  }

  await signInAsAdministrator(request);

  await api.saveHousingCooperative(request, stack.baseUrl, {
    name: HOUSING_COOPERATIVE.name,
    organizationNumber: HOUSING_COOPERATIVE.organizationNumber,
    defaultLocale: "sv",
  });

  const existing = await api.listAddresses(request, stack.baseUrl);
  for (const address of ADDRESSES) {
    const already = existing.find(
      (candidate) =>
        candidate.street === address.street &&
        candidate.number === address.number,
    );
    const created =
      already ??
      (await api.createAddress(request, stack.baseUrl, {
        street: address.street,
        number: address.number,
        postalCode: address.postalCode,
        city: address.city,
      }));
    // Adding apartments is idempotent server-side: a number that already exists
    // is reported as skipped rather than duplicated.
    await api.addApartments(
      request,
      stack.baseUrl,
      created.id,
      apartmentRows(address),
    );
  }

  await api.saveSmtp(request, stack.baseUrl, {
    host: stack.smtpHost,
    port: stack.smtpPort,
    // Mailpit's 1025 is cleartext. Asking for implicit TLS there hangs the
    // send rather than failing it.
    secure: false,
    user: null,
    fromAddress: "noreply@eksemplet.test",
  });

  await api.completeSetup(request, stack.baseUrl);
}

export type RegisterPerson = {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly addressNumber: string;
  readonly apartmentNumber: string;
  readonly role: "MEMBER" | "RESIDENT";
  readonly protectedPersonalData?: boolean;
};

/**
 * The people the address book spec reads.
 *
 * They are created through the sign-up approval path because that is the only
 * endpoint in the application today that writes a residency: a person created
 * straight into the register has no apartment, and the board is grouped by
 * floor. Move-in is the flow that will own this once it exists (stage S7).
 */
export const REGISTER_PEOPLE: readonly RegisterPerson[] = [
  {
    firstName: "Astrid",
    lastName: "Lindqvist",
    email: "astrid@eksemplet.test",
    addressNumber: "12",
    apartmentNumber: "1001",
    role: "MEMBER",
  },
  {
    firstName: "Nils",
    lastName: "Lindqvist",
    email: "nils@eksemplet.test",
    addressNumber: "12",
    apartmentNumber: "1001",
    role: "RESIDENT",
  },
  {
    firstName: "Ingrid",
    lastName: "Persson",
    email: "ingrid@eksemplet.test",
    addressNumber: "12",
    apartmentNumber: "1102",
    role: "MEMBER",
    protectedPersonalData: true,
  },
  {
    firstName: "Karl",
    lastName: "Berg",
    email: "karl@eksemplet.test",
    addressNumber: "14",
    apartmentNumber: "1001",
    role: "MEMBER",
  },
];

/**
 * Puts the four people above into the register, on their apartments.
 *
 * Returns their person ids, keyed by full name.
 *
 * Idempotent against a finished record rather than against a person's mere
 * existence. Putting somebody in the register takes two writes - the sign-up
 * request creates the person, the approval records the residency - and a run
 * that failed between them leaves a person with no apartment. Asking only
 * "does this name exist" would return early on that from then on, and what
 * fails is an assertion several tests later, timing out on a board the person
 * is missing from with nothing saying why. So the residency the fixture
 * promises is what settles it - this apartment, with a move-in date, rather
 * than any apartment at all - and anything short of that is put through the
 * creation path again, where approval matches them by email and records the
 * residency they were left without.
 */
export async function ensureRegisterFixture(
  request: APIRequestContext,
): Promise<ReadonlyMap<string, string>> {
  await ensureInstance(request);

  const addresses = await api.listAddresses(request, stack.baseUrl);
  const apartmentsByAddress = new Map<string, readonly api.ApartmentView[]>();
  for (const address of addresses) {
    apartmentsByAddress.set(
      address.number,
      await api.listApartments(request, stack.baseUrl, address.id),
    );
  }

  // Sign-up requests are only accepted while the toggle is on. It is restored
  // by the spec that owns it; here it is simply switched on for the fixture.
  await api.setSelfSignup(request, stack.baseUrl, true);

  const ids = new Map<string, string>();
  for (const person of REGISTER_PEOPLE) {
    const fullName = `${person.firstName} ${person.lastName}`;
    const existing = await api.findPersonByName(
      request,
      stack.baseUrl,
      fullName,
    );
    const address = addresses.find(
      (candidate) => candidate.number === person.addressNumber,
    );
    if (address === undefined) {
      throw new Error(`no address ${person.addressNumber} in the register`);
    }
    const apartment = apartmentsByAddress
      .get(person.addressNumber)
      ?.find((candidate) => candidate.number === person.apartmentNumber);
    if (apartment === undefined) {
      throw new Error(
        `no apartment ${person.apartmentNumber} on ${address.street} ${address.number}`,
      );
    }

    /*
     * The residency this fixture promises, not merely some residency. A stack
     * that has been reused can hold the person at another apartment, because a
     * move spec put them there, or with no move-in date; either state satisfies
     * "has an apartment" and would be accepted as finished, and what fails is
     * an assertion several tests later about a board the person is missing
     * from. Anything else goes through the creation path again, where approval
     * matches by email and records the residency they were left without.
     */
    if (
      existing?.apartment?.id === apartment.id &&
      existing.movedInOn !== null
    ) {
      ids.set(fullName, existing.personId);
      continue;
    }

    const submitted = await api.submitSignupRequest(request, stack.baseUrl, {
      firstName: person.firstName,
      lastName: person.lastName,
      email: person.email,
      claimedAddress: `${address.street} ${address.number}`,
      claimedApartmentNumber: person.apartmentNumber,
    });
    if (submitted.id === undefined) {
      throw new Error(
        `sign-up request for ${fullName} answered ${String(submitted.status)}`,
      );
    }

    const personId = await api.approveSignupRequest(
      request,
      stack.baseUrl,
      submitted.id,
      { apartmentId: apartment.id, role: person.role },
    );
    ids.set(fullName, personId);

    if (person.protectedPersonalData === true) {
      await api.setProtectedPersonalData(
        request,
        stack.baseUrl,
        personId,
        true,
      );
    }
  }

  return ids;
}

/** The activation token out of an invitation email. */
export function activationTokenFrom(messageText: string): string {
  const url = new URL(linkFrom(messageText, "/activate"));
  const token = url.searchParams.get("token");
  if (token === null) {
    throw new Error(`no token on the activation link ${url.toString()}`);
  }
  return token;
}

/**
 * Makes sure a person can sign in, inviting them if they cannot yet.
 *
 * Signing in first is what makes this idempotent: a spec that runs after the
 * one which activated an account must not send a second invitation, and the
 * only way to know an account exists is to use it.
 *
 * It does that in a context of its own, thrown away afterwards, so the session
 * it creates never lands on the browser the spec is about to drive. A page that
 * arrived at the sign-in screen already signed in is redirected away from it.
 *
 * `board` must be a context signed in as someone who may send invitations.
 */
export async function ensureAccountFor(
  board: APIRequestContext,
  person: {
    personId: string;
    email: string;
    password: string;
    clientAddress: string;
  },
): Promise<void> {
  const visitor = await playwrightRequest.newContext({
    baseURL: stack.baseUrl,
    extraHTTPHeaders: { "x-forwarded-for": person.clientAddress },
  });
  try {
    const attempt = await visitor.post(
      `${stack.baseUrl}/api/auth/sign-in/email`,
      { data: { email: person.email, password: person.password } },
    );
    if (attempt.ok()) {
      return;
    }

    await api.sendInvitation(board, stack.baseUrl, person.personId);
    const { text } = await waitForMessage(person.email);
    await api.acceptInvitation(visitor, stack.baseUrl, {
      token: activationTokenFrom(text),
      password: person.password,
    });
  } finally {
    await visitor.dispose();
  }
}
