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

/**
 * A response body as JSON, or nothing at all when it is not JSON.
 *
 * Only for the calls that keep every status, where the body is whatever
 * answered: a proxy's error page, a rate-limit page, or the empty body of a
 * 204. Parsing those unconditionally raises a parse error, and the caller's
 * assertion about the status - which is the thing it was checking - never runs.
 */
export function jsonBodyOrNothing(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
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
    preferredLocale?: "sv" | "en";
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
  // Every status is kept, because a refusal is what two of the callers are
  // about, so the body is read the way a body of any shape has to be read.
  const response = await request.post(`${baseUrl}/api/signup-requests/submit`, {
    data: input,
    failOnStatusCode: false,
  });
  const body = jsonBodyOrNothing(await response.text()) as {
    id?: string;
    reason?: string;
  };
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

/**
 * A transfer of a tenant-ownership, as both move endpoints take it.
 *
 * The agreement reference is required rather than optional: the apartment
 * register extract states one for every transfer, and a transfer row cannot be
 * deleted once it is written.
 */
export type TransferInput = {
  /** ISO calendar date. */
  readonly transferredOn: string;
  readonly price?: string | null;
  readonly agreementReference: string;
};

export type MoveInResult = {
  readonly residencyId: string;
  readonly memberRegisterEntryRecorded: boolean;
  readonly transferId: string | null;
  readonly welcomeEmailSent: boolean;
};

/**
 * Moves a person into an apartment.
 *
 * Here for the specs that need somebody living somewhere before they can be
 * about something else - a register extract has to have an entry to show, and
 * an import row is only ambiguous when two people of that name already share
 * the apartment. The criterion about the move flow itself drives the screen.
 */
export async function moveIn(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    personId: string;
    apartmentId: string;
    role: "MEMBER" | "RESIDENT";
    /** ISO calendar date. */
    movedInOn: string;
    transfer?: TransferInput & { fromPersonId?: string | null };
  },
): Promise<MoveInResult> {
  const response = await request.post(`${baseUrl}/api/moves/move-in`, {
    data: input,
  });
  await expectOk(response, "POST /api/moves/move-in");
  return (await response.json()) as MoveInResult;
}

export type MoveOutResult = {
  readonly residencyId: string;
  readonly movedOutOn: string;
  /** Derived from the retention policy, never stored. */
  readonly purgeOn: string;
  readonly memberRegisterExitRecorded: boolean;
  readonly transferId: string | null;
  readonly boardReminderOn: string;
};

export async function moveOut(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    residencyId: string;
    /** ISO calendar date. */
    movedOutOn: string;
    transfer?: TransferInput & { toPersonId: string };
  },
): Promise<MoveOutResult> {
  const response = await request.post(`${baseUrl}/api/moves/move-out`, {
    data: input,
  });
  await expectOk(response, "POST /api/moves/move-out");
  return (await response.json()) as MoveOutResult;
}

export type IssueTypeRow = {
  readonly id: string;
  readonly name: string;
  readonly audience: "NON_MEMBER" | "MEMBER" | "BOARD";
  readonly active: boolean;
  readonly reportCount: number;
};

export async function listIssueTypes(
  request: APIRequestContext,
  baseUrl: string,
): Promise<readonly IssueTypeRow[]> {
  const response = await request.get(`${baseUrl}/api/issue-types`);
  await expectOk(response, "GET /api/issue-types");
  return (await response.json()) as readonly IssueTypeRow[];
}

/**
 * Adds an issue type.
 *
 * Here rather than driven through the settings screen because the specs that
 * need one are about reporting and triage: a type has to exist before a
 * resident has anything to report under, and the screen that creates it has its
 * own coverage.
 */
export async function createIssueType(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    name: string;
    audience: "NON_MEMBER" | "MEMBER" | "BOARD";
    sortOrder?: number;
  },
): Promise<IssueTypeRow> {
  const response = await request.post(`${baseUrl}/api/issue-types`, {
    data: input,
  });
  await expectOk(response, "POST /api/issue-types");
  return (await response.json()) as IssueTypeRow;
}

/** Whether the association's website carries an issue report form. */
export async function setPublicIssueReporting(
  request: APIRequestContext,
  baseUrl: string,
  publicFormEnabled: boolean,
): Promise<void> {
  const response = await request.put(
    `${baseUrl}/api/settings/issue-reporting`,
    {
      data: { publicFormEnabled },
    },
  );
  await expectOk(response, "PUT /api/settings/issue-reporting");
}

export type QueuedIssueRow = {
  readonly id: string;
  readonly status: "NEW" | "IN_PROGRESS" | "DONE";
  readonly typeName: string;
  readonly description: string;
  readonly photos: readonly { readonly url: string }[];
  readonly reporter: { readonly kind: string; readonly name?: string };
};

export async function listIssueQueue(
  request: APIRequestContext,
  baseUrl: string,
): Promise<readonly QueuedIssueRow[]> {
  const response = await request.get(`${baseUrl}/api/issue-queue`);
  await expectOk(response, "GET /api/issue-queue");
  return (await response.json()) as readonly QueuedIssueRow[];
}

/**
 * One row of the board's address book.
 *
 * Narrowed to what a fixture reads back: who the person is, and enough of what
 * was written about them to tell a finished record from a half-finished one.
 * The endpoint sends more - signs, contact state, the purge date - and a
 * fixture has no business asserting on any of it.
 */
export type AddressBookRow = {
  readonly personId: string;
  readonly name: string;
  /** Null for a person with no residency: an external board member or admin. */
  readonly apartment: {
    readonly id: string;
    readonly addressId: string;
    readonly number: string;
  } | null;
  readonly movedInOn: string | null;
  readonly movedOutOn: string | null;
};

/**
 * The person the address book lists under exactly this name, as a whole row.
 *
 * The only way the suite has of finding somebody it did not just create: a
 * person id appears in no email and on no screen, and the address book is the
 * one surface that searches. Nobody matching is answered with `undefined`
 * rather than an error, because every caller asks in order to decide whether to
 * create the person - which is what makes a fixture idempotent against the
 * database rather than against the process that built it.
 *
 * The search narrows and the name decides: the endpoint matches names
 * incrementally, so it answers "Bo Ek" with everyone whose name begins that
 * way, and only an exact match is the person that was asked for.
 *
 * ## Why the row and not only the id
 *
 * An `ensure*` helper does several writes, and only the first of them creates
 * the person: the sign-up approval that follows records the residency, the
 * move-in that follows records the tenant-ownership. A run that failed between
 * them leaves the person behind without any of it, and a helper that asked only
 * "does this person exist" would return early on that wreckage every time
 * afterwards. What fails is then an assertion several tests later, timing out
 * on a screen that is empty for a reason nothing reports.
 *
 * So the rule for every `ensure*` helper in this directory is: return early
 * only on evidence that the whole thing it ensures is there, not on evidence
 * that its first step once ran. This row is that evidence, and it costs no
 * second request - the search already fetched it and threw it away.
 */
export async function findPersonByName(
  request: APIRequestContext,
  baseUrl: string,
  name: string,
): Promise<AddressBookRow | undefined> {
  const response = await request.get(
    `${baseUrl}/api/address-book?search=${encodeURIComponent(name)}&filter=all&page=1`,
  );
  await expectOk(response, "GET /api/address-book");
  const page = (await response.json()) as {
    readonly rows: readonly AddressBookRow[];
  };
  return page.rows.find((row) => row.name === name);
}

/**
 * {@link findPersonByName}, for a caller that needs the id and nothing else.
 *
 * Expressed in terms of the row rather than duplicating the request, so the two
 * cannot answer differently about the same name.
 */
export async function findPersonIdByName(
  request: APIRequestContext,
  baseUrl: string,
  name: string,
): Promise<string | undefined> {
  return (await findPersonByName(request, baseUrl, name))?.personId;
}

/** A block in a page's body, as the write API takes it. */
export type SitePageBlock = Record<string, unknown>;

export type SitePageRow = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly published: boolean;
};

/**
 * Writes a page through the board's own API.
 *
 * Here rather than through the editor screen because the specs that need one
 * are about what the page DOES for a visitor - a form on it, above all - and
 * the screen that writes pages has its own coverage. A page arrives
 * unpublished; publishing is the separate act the audit log records, so it is
 * a separate call here too.
 */
export async function createSitePage(
  request: APIRequestContext,
  baseUrl: string,
  input: {
    slug: string;
    title: string;
    blocks: readonly SitePageBlock[];
    visibility: "PUBLIC" | "MEMBER";
  },
): Promise<SitePageRow> {
  const response = await request.post(`${baseUrl}/api/site/pages`, {
    data: {
      slug: input.slug,
      title: input.title,
      content: { blocks: input.blocks },
      visibility: input.visibility,
    },
  });
  await expectOk(response, "POST /api/site/pages");
  return (await response.json()) as SitePageRow;
}

export async function publishSitePage(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<void> {
  const response = await request.post(
    `${baseUrl}/api/site/pages/${id}/publish`,
    { data: { published: true } },
  );
  await expectOk(response, "POST /api/site/pages/:id/publish");
}

/** Removes a page this suite wrote. Pages are service tier, so this is allowed. */
export async function deleteSitePage(
  request: APIRequestContext,
  baseUrl: string,
  id: string,
): Promise<void> {
  const response = await request.delete(`${baseUrl}/api/site/pages/${id}`);
  await expectOk(response, "DELETE /api/site/pages/:id");
}

export type ContactSubmissionRow = {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
  readonly message: string;
  readonly handled: boolean;
};

/** The board's inbox for the website's contact form. */
export async function listContactSubmissions(
  request: APIRequestContext,
  baseUrl: string,
): Promise<readonly ContactSubmissionRow[]> {
  const response = await request.get(`${baseUrl}/api/contact-submissions`);
  await expectOk(response, "GET /api/contact-submissions");
  return (await response.json()) as readonly ContactSubmissionRow[];
}

/**
 * The facts a broker asks the association about.
 *
 * Every field optional and nullable, because that is what the endpoint takes:
 * an absent field is one the request does not touch, and a null is the board
 * clearing a fact off the public page.
 */
export type AssociationFactsInput = {
  readonly propertyDesignation?: string | null;
  readonly buildYear?: number | null;
  readonly landLeasehold?: boolean | null;
  readonly landLeaseholdNote?: string | null;
  readonly feePolicy?: string | null;
  readonly feeIncludes?: string | null;
  readonly transferFeePolicy?: string | null;
  readonly pledgeFeePolicy?: string | null;
  readonly legalPersonOwners?: boolean | null;
  readonly legalPersonOwnersNote?: string | null;
  readonly parking?: string | null;
  readonly storage?: string | null;
  readonly renovations?: string | null;
};

/**
 * Records the association's facts, as the board.
 *
 * Here rather than driven through the board's own screen because the criterion
 * this serves is about the page a broker reads: the facts have to be recorded
 * before there is anything to read, and the form that records them has its own
 * coverage in the component tests. Driving the screen would also cost a browser
 * sign-in the spec does not otherwise need, and Better Auth's twenty requests a
 * minute are budgeted per test.
 */
export async function saveAssociationFacts(
  request: APIRequestContext,
  baseUrl: string,
  facts: AssociationFactsInput,
): Promise<void> {
  const response = await request.put(`${baseUrl}/api/site/facts`, {
    data: facts,
  });
  await expectOk(response, "PUT /api/site/facts");
}

/** Every fact back to unrecorded, so one spec cannot decide another's page. */
export async function clearAssociationFacts(
  request: APIRequestContext,
  baseUrl: string,
): Promise<void> {
  await saveAssociationFacts(request, baseUrl, {
    propertyDesignation: null,
    buildYear: null,
    landLeasehold: null,
    landLeaseholdNote: null,
    feePolicy: null,
    feeIncludes: null,
    transferFeePolicy: null,
    pledgeFeePolicy: null,
    legalPersonOwners: null,
    legalPersonOwnersNote: null,
    parking: null,
    storage: null,
    renovations: null,
  });
}
