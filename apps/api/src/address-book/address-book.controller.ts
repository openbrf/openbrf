import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  ADDRESS_BOOK_FILTERS,
  AddressBookService,
  type AddressBookPage,
  type ApartmentDetail,
} from "./address-book.service";
import {
  type AddressBookRow,
  MASKABLE_FIELDS,
  type ResidentDirectoryRow,
} from "./address-book-view";
import {
  type PersonDetail,
  PersonService,
  type RevealedFields,
} from "./person.service";

/** Bounded so a client cannot ask for the whole register in one response. */
const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

const querySchema = z.object({
  addressId: z.string().min(1).optional(),
  filter: z.enum(ADDRESS_BOOK_FILTERS).default("all"),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

const createPersonSchema = z.object({
  firstName: z.string().min(1).max(100),
  lastName: z.string().min(1).max(100),
  postalStreet: z.string().max(200).optional(),
  postalCode: z.string().max(20).optional(),
  postalCity: z.string().max(100).optional(),
  alternativePostalAddress: z.string().max(300).optional(),
  email: z.email().max(320).optional(),
  phone: z.string().max(40).optional(),
  personalIdentityNumber: z.string().max(20).optional(),
  protectedPersonalData: z.boolean().optional(),
  preferredLocale: z.enum(["sv", "en"]).optional(),
});

const protectedFlagSchema = z.object({
  protectedPersonalData: z.boolean(),
  reason: z.string().max(500).optional(),
});

const revealSchema = z.object({
  fields: z.array(z.enum(MASKABLE_FIELDS)).min(1),
  reason: z.string().max(500).optional(),
});

/**
 * The board's address book.
 *
 * Every route on this controller requires `addressBook:read`, which residents
 * and the property manager do not hold. The resident-facing view is a separate
 * controller with a separate capability and a separate response shape, so
 * contact data has no route into it: see {@link ResidentDirectoryController}.
 */
@Controller("api/address-book")
@RequireCapability("addressBook:read")
export class AddressBookController {
  constructor(
    private readonly addressBook: AddressBookService,
    private readonly persons: PersonService,
  ) {}

  @Get()
  async board(
    @Query() query: unknown,
  ): Promise<AddressBookPage<AddressBookRow>> {
    return this.addressBook.boardView(querySchema.parse(query));
  }

  @Get("apartments/:id")
  async apartment(@Param("id") id: string): Promise<ApartmentDetail> {
    return this.addressBook.apartmentDetail(id);
  }

  @Get("persons/:id")
  async person(@Param("id") id: string): Promise<PersonDetail> {
    return this.persons.detail(id);
  }

  @Post("persons")
  @RequireCapability("addressBook:read", "addressBook:write")
  async addPerson(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ personId: string }> {
    return this.persons.create(
      createPersonSchema.parse(body),
      actorOf(request),
    );
  }

  @Patch("persons/:id/protected-personal-data")
  @RequireCapability("addressBook:read", "addressBook:write")
  async setProtectedPersonalData(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ protectedPersonalData: boolean }> {
    const input = protectedFlagSchema.parse(body);
    return this.persons.setProtectedPersonalData({
      personId: id,
      protectedPersonalData: input.protectedPersonalData,
      reason: input.reason,
      actorPersonId: actorOf(request),
    });
  }

  /**
   * Reveals masked fields on one person.
   *
   * A POST rather than a GET although it reads: it writes an audit entry, and it
   * carries personal data in the response that must not sit in a URL, a proxy
   * log or the browser's history.
   */
  @Post("persons/:id/reveal")
  @HttpCode(200)
  @RequireCapability("addressBook:read", "protectedData:reveal")
  async reveal(
    @Req() request: RequestWithPrincipal,
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<RevealedFields> {
    const input = revealSchema.parse(body);
    return this.persons.reveal({
      actorPersonId: actorOf(request),
      personId: id,
      fields: input.fields,
      reason: input.reason,
    });
  }
}

/**
 * The resident-facing address book.
 *
 * The same board, with the contact column absent entirely: residents see names,
 * apartments, roles and dates, and contact data stays with the board (plan 4.4,
 * settled 2026-08-27). Persons with protected personal data are not listed here
 * at all.
 *
 * A separate controller rather than a flag on the one above, because the two
 * return different types and the compiler should be what stops contact data
 * reaching this response.
 */
@Controller("api/resident-directory")
@RequireCapability("residentDirectory:read")
export class ResidentDirectoryController {
  constructor(private readonly addressBook: AddressBookService) {}

  @Get()
  async directory(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<AddressBookPage<ResidentDirectoryRow>> {
    return this.addressBook.residentDirectory(
      querySchema.parse(query),
      actorOf(request),
    );
  }
}

/**
 * The acting person.
 *
 * The global guard rejects the request before a controller runs unless a
 * principal was resolved, so this is a narrowing rather than a fallback: an
 * empty actor id would be a silent hole in the audit log, which is why it throws
 * instead of defaulting.
 */
function actorOf(request: RequestWithPrincipal): string {
  const personId = request.principal?.personId;
  if (personId === undefined) {
    throw new Error(
      "No principal on the request. The authorization guard must run before " +
        "this controller.",
    );
  }
  return personId;
}
