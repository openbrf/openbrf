import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { actingPersonId } from "./acting-person";
import {
  type ApartmentRegisterExtract,
  type ApartmentRegisterLien,
  ApartmentRegisterService,
} from "./apartment-register.service";

const scopeSchema = z.object({
  /** Absent reads every apartment the caller is entitled to. */
  apartmentId: z.string().min(1).optional(),
});

const revealSchema = z.object({
  apartmentId: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
});

/** ISO calendar date. A statutory date of record is never guessed from prose. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const lienSchema = z.object({
  apartmentId: z.string().min(1),
  creditor: z.string().min(1).max(200),
  notedOn: isoDate,
  amount: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "must be a decimal amount")
    .nullish(),
});

const releaseLienSchema = z.object({
  lienId: z.string().min(1),
  releasedOn: isoDate,
});

/**
 * The apartment register (lagenhetsforteckning, BRL 9 kap.), as the board reads
 * it.
 *
 * Confidential, and a different document from the member register: separate
 * controller, separate path, separate capability. A tenant-owner's right to
 * their own entry is served by {@link OwnApartmentRegisterController} below,
 * which grants no access to anyone else's.
 *
 * The extract comes back with identity numbers masked. Producing the full
 * statutory document is a second, explicit request that writes its own audit
 * entry - the same shape as revealing a masked field in the address book, and
 * for the same reason: the board's screen should be safe to share, and seeing a
 * personal identity number should be an act somebody chose to take.
 */
@Controller("api/apartment-register")
@RequireCapability("apartmentRegister:read")
export class ApartmentRegisterController {
  constructor(private readonly register: ApartmentRegisterService) {}

  @Get()
  async extract(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<ApartmentRegisterExtract> {
    const { apartmentId } = scopeSchema.parse(query);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "board",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: false,
    });
  }

  /**
   * The full statutory extract, personal identity numbers included.
   *
   * A POST although it reads: it writes an audit entry, and it carries personal
   * identity numbers that must not sit in a URL, a proxy log or the browser's
   * history.
   */
  @Post("reveal")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "protectedData:reveal")
  async reveal(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterExtract> {
    const { apartmentId } = revealSchema.parse(body);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "board",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: true,
    });
  }

  /**
   * Records a lien note (pantnotering).
   *
   * Writing to a statutory register needs more than the right to read it, so
   * this route requires the address book's write capability as well. Only the
   * board and an admin hold both.
   */
  @Post("liens")
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async addLien(@Body() body: unknown): Promise<ApartmentRegisterLien> {
    return this.register.addLien(lienSchema.parse(body));
  }

  @Post("liens/release")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async releaseLien(@Body() body: unknown): Promise<ApartmentRegisterLien> {
    return this.register.releaseLien(releaseLienSchema.parse(body));
  }
}

/**
 * A tenant-owner's own entry.
 *
 * BRL 9 kap. gives the holder of a tenant-ownership the right to an extract
 * concerning their own apartment, and only that one. The scope comes from the
 * session's own residencies rather than from anything the caller sends, so
 * naming someone else's apartment cannot widen it - it is answered as if the
 * apartment did not exist, because a refusal would confirm that it does.
 *
 * A separate controller rather than a flag on the one above: the board's
 * capability must not be what stands between a resident and the whole register.
 */
@Controller("api/apartment-register/mine")
@RequireCapability("self:manage")
export class OwnApartmentRegisterController {
  constructor(private readonly register: ApartmentRegisterService) {}

  @Get()
  async extract(
    @Req() request: RequestWithPrincipal,
    @Query() query: unknown,
  ): Promise<ApartmentRegisterExtract> {
    const { apartmentId } = scopeSchema.parse(query);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "holder",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: false,
    });
  }

  /**
   * The holder's own full extract.
   *
   * No protectedData:reveal here: the number being disclosed is the caller's
   * own, and requiring a capability the board holds would mean a tenant-owner
   * could never obtain the statutory extract the law entitles them to. It is
   * audited exactly as the board's is.
   */
  @Post("reveal")
  @HttpCode(200)
  async reveal(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterExtract> {
    const { apartmentId } = revealSchema.parse(body);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "holder",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: true,
    });
  }
}
