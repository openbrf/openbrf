import type { APIRequestContext } from "@playwright/test";

/**
 * The API, as the suite uses it.
 *
 * Two kinds of call live here. Some set up state that the interface cannot
 * create yet - a residency, for instance, is only written by the sign-up
 * approval path - so a spec about something else should not pretend to click
 * its way there. The others are the endpoints a criterion is actually about,
 * where no screen exists: an invitation is sent and accepted over HTTP today,
 * and the criterion is about the invitation, not about a form.
 *
 * Where a screen does exist, the specs drive the screen.
 */

async function expectOk(
  response: {
    ok: () => boolean;
    status: () => number;
    text: () => Promise<string>;
  },
  what: string,
): Promise<void> {
  if (!response.ok()) {
    throw new Error(
      `${what} answered ${String(response.status())}: ${await response.text()}`,
    );
  }
}

export type SetupState = { readonly setupRequired: boolean };

export async function setupState(
  request: APIRequestContext,
  baseUrl: string,
): Promise<SetupState> {
  const response = await request.get(`${baseUrl}/api/setup/state`);
  await expectOk(response, "GET /api/setup/state");
  return (await response.json()) as SetupState;
}

export async function createFirstAdministrator(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    password: string;
  },
): Promise<string> {
  const response = await request.post(`${baseUrl}/api/setup/administrator`, {
    data: input,
  });
  await expectOk(response, "POST /api/setup/administrator");
  return ((await response.json()) as { personId: string }).personId;
}

export async function signIn(
  request: APIRequestContext,
  baseUrl: string,
  input: { email: string; password: string },
): Promise<void> {
  const response = await request.post(`${baseUrl}/api/auth/sign-in/email`, {
    data: input,
  });
  await expectOk(response, "POST /api/auth/sign-in/email");

  // A correct password on an account with an authenticator app answers 200 and
  // grants no session. Left unchecked, every later call would fail with 401 and
  // the cause would be three files away.
  const body = (await response.json()) as { twoFactorRedirect?: boolean };
  if (body.twoFactorRedirect === true) {
    throw new Error(
      `${input.email} has an authenticator app enrolled, so a password alone grants no session here`,
    );
  }
}

export async function saveHousingCooperative(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    name: string;
    organizationNumber?: string;
    defaultLocale?: "sv" | "en";
  },
): Promise<void> {
  const response = await request.put(
    `${baseUrl}/api/settings/housing-cooperative`,
    { data: input },
  );
  await expectOk(response, "PUT /api/settings/housing-cooperative");
}

export type AddressView = {
  readonly id: string;
  readonly street: string;
  readonly number: string;
};

export async function listAddresses(
  request: APIRequestContext,
  baseUrl: string,
): Promise<readonly AddressView[]> {
  const response = await request.get(`${baseUrl}/api/addresses`);
  await expectOk(response, "GET /api/addresses");
  return (await response.json()) as readonly AddressView[];
}

export async function createAddress(
  request: APIRequestContext,
  baseUrl: string,
  input: { street: string; number: string; postalCode: string; city: string },
): Promise<AddressView> {
  const response = await request.post(`${baseUrl}/api/addresses`, {
    data: input,
  });
  await expectOk(response, "POST /api/addresses");
  return (await response.json()) as AddressView;
}

export type ApartmentView = {
  readonly id: string;
  readonly number: string;
  readonly floor: number | null;
};

export async function listApartments(
  request: APIRequestContext,
  baseUrl: string,
  addressId: string,
): Promise<readonly ApartmentView[]> {
  const response = await request.get(
    `${baseUrl}/api/addresses/${addressId}/apartments`,
  );
  await expectOk(response, "GET apartments");
  return (await response.json()) as readonly ApartmentView[];
}

export async function addApartments(
  request: APIRequestContext,
  baseUrl: string,
  addressId: string,
  apartments: readonly { number: string; floor: number }[],
): Promise<void> {
  const response = await request.post(
    `${baseUrl}/api/addresses/${addressId}/apartments`,
    { data: { apartments } },
  );
  await expectOk(response, "POST apartments");
}

export async function saveSmtp(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    host: string | null;
    port: number | null;
    secure: boolean;
    user: string | null;
    fromAddress: string | null;
  },
): Promise<void> {
  const response = await request.put(`${baseUrl}/api/settings/smtp`, {
    data: input,
  });
  await expectOk(response, "PUT /api/settings/smtp");
}

export type InstanceSettings = {
  readonly housingCooperative: {
    readonly name: string;
    readonly organizationNumber: string | null;
    readonly defaultLocale: string;
    readonly setupCompletedAt: string | null;
  };
  readonly smtp: {
    readonly host: string | null;
    readonly port: number | null;
    readonly configured: boolean;
  };
  readonly selfSignup: { readonly enabled: boolean };
};

export async function settings(
  request: APIRequestContext,
  baseUrl: string,
): Promise<InstanceSettings> {
  const response = await request.get(`${baseUrl}/api/settings`);
  await expectOk(response, "GET /api/settings");
  return (await response.json()) as InstanceSettings;
}

export async function setSelfSignup(
  request: APIRequestContext,
  baseUrl: string,
  enabled: boolean,
): Promise<void> {
  const response = await request.put(`${baseUrl}/api/settings/self-signup`, {
    data: { enabled },
  });
  await expectOk(response, "PUT /api/settings/self-signup");
}

export async function completeSetup(
  request: APIRequestContext,
  baseUrl: string,
): Promise<void> {
  const response = await request.post(`${baseUrl}/api/setup/complete`);
  await expectOk(response, "POST /api/setup/complete");
}

export async function createPerson(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    firstName: string;
    lastName: string;
    email?: string;
    phone?: string;
    personalIdentityNumber?: string;
    postalStreet?: string;
    postalCode?: string;
    postalCity?: string;
    protectedPersonalData?: boolean;
  },
): Promise<string> {
  const response = await request.post(`${baseUrl}/api/address-book/persons`, {
    data: input,
  });
  await expectOk(response, "POST /api/address-book/persons");
  return ((await response.json()) as { personId: string }).personId;
}

export async function sendInvitation(
  request: APIRequestContext,
  baseUrl: string,
  personId: string,
): Promise<void> {
  const response = await request.post(`${baseUrl}/api/invitations`, {
    data: { personId },
  });
  await expectOk(response, "POST /api/invitations");
}

export async function acceptInvitation(
  request: APIRequestContext,
  baseUrl: string,
  input: { token: string; password: string },
): Promise<void> {
  const response = await request.post(`${baseUrl}/api/invitations/accept`, {
    data: input,
  });
  await expectOk(response, "POST /api/invitations/accept");
}

export async function submitSignupRequest(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    firstName: string;
    lastName: string;
    email: string;
    claimedAddress: string;
    claimedApartmentNumber: string;
  },
): Promise<{ status: number; id?: string; reason?: string }> {
  const response = await request.post(`${baseUrl}/api/signup-requests/submit`, {
    data: input,
    failOnStatusCode: false,
  });
  const body = (await response.json()) as { id?: string; reason?: string };
  return { status: response.status(), ...body };
}

export type PendingSignupRequest = {
  readonly id: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string;
  readonly claimedAddress: string;
  readonly claimedApartmentNumber: string;
};

export async function listSignupRequests(
  request: APIRequestContext,
  baseUrl: string,
): Promise<readonly PendingSignupRequest[]> {
  const response = await request.get(`${baseUrl}/api/signup-requests`);
  await expectOk(response, "GET /api/signup-requests");
  return (await response.json()) as readonly PendingSignupRequest[];
}

export async function approveSignupRequest(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
  input: { apartmentId: string; role: "MEMBER" | "RESIDENT" },
): Promise<string> {
  const response = await request.post(
    `${baseUrl}/api/signup-requests/${id}/approve`,
    { data: input },
  );
  await expectOk(response, "POST approve");
  return ((await response.json()) as { personId: string }).personId;
}

export async function setProtectedPersonalData(
  request: APIRequestContext,
  baseUrl: string,
  personId: string,
  protectedPersonalData: boolean,
): Promise<void> {
  const response = await request.patch(
    `${baseUrl}/api/address-book/persons/${personId}/protected-personal-data`,
    { data: { protectedPersonalData } },
  );
  await expectOk(response, "PATCH protected-personal-data");
}

export type Viewer = {
  readonly personId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly capabilities: readonly string[];
};

export async function viewer(
  request: APIRequestContext,
  baseUrl: string,
): Promise<Viewer> {
  const response = await request.get(`${baseUrl}/api/me`);
  await expectOk(response, "GET /api/me");
  return (await response.json()) as Viewer;
}
