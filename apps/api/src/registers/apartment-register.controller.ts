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
  type ApartmentRegisterTermination,
  type ApartmentRegisterTransfer,
  type ApartmentRegisterTransferReversal,
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
 * Recording that a tenant-ownership has ceased (upphorande).
 *
 * The two grounds are stated as a literal union rather than as the generated
 * enum. A schema that accepted whatever the enum happens to hold would widen
 * silently the day a value is added to it, and a ground the register records is
 * a statement about which section of bostadsrattslagen applies.
 */
const terminationSchema = z.object({
  apartmentId: z.string().min(1),
  kind: z.enum(["GENERAL_MEETING_DECISION", "BUILDING_TRANSFERRED"]),
  tookEffectOn: isoDate,
  // Non-empty after trimming, matching the CHECK on the column. The service
  // trims before it writes, so a value of spaces would otherwise reach the
  // database as an empty string and surface as a driver error.
  reference: z.string().trim().min(1).max(500),
});

/**
 * Which case of Lag (2026:484) 3 kap. 3 § an overgang falls in.
 *
 * A literal union rather than the generated enum, for the reason the termination
 * schema above gives: a schema reading whatever the enum happens to hold widens
 * silently the day a value is added, and this one states which sentence of a
 * statute the association is acting under.
 *
 * The date is optional here and required by the service, because which of the
 * two it is depends on the case: the ordinary one runs its window from the
 * membership decision and the rest run it from the overgang. Stated once, in the
 * service, so the two cannot disagree - and refused rather than dropped, since a
 * date silently discarded is a statutory value the board believes it recorded.
 */
const reportBasisSchema = z.object({
  transferId: z.string().min(1),
  basis: z.enum([
    "MEMBERSHIP_DECISION",
    "ALREADY_MEMBER",
    "OUTSIDE_MEMBERSHIP_REQUIREMENT",
    "TO_THE_ASSOCIATION",
    "LIENHOLDING_JURIDICAL_PERSON",
  ]),
  membershipDecidedOn: isoDate.nullish(),
});

/**
 * Recording that a registered overlatelse has been havd or has gone back to the
 * seller (Lag (2026:484) 3 kap. 3 § tredje stycket).
 *
 * The two grounds are a literal union for the same reason, and the reference is
 * trimmed and non-empty to match the CHECK on the column, as the termination's
 * is: the service trims before it writes, so a value of spaces would otherwise
 * reach the database as an empty string and surface as a driver error.
 */
const transferReversalSchema = z.object({
  transferId: z.string().min(1),
  kind: z.enum(["RESCINDED", "RETURNED_TO_SELLER"]),
  reversedOn: isoDate,
  reference: z.string().trim().min(1).max(500),
});

const propertyDesignationSchema = z.object({
  /** Null clears it, which is how a designation recorded in error is undone. */
  propertyDesignation: z.string().trim().max(200).nullable(),
});

/**
 * On what footing the association's buildings stand on their land, and the two
 * fields Forordning (2026:898) 2 kap. 4 § andra stycket reports on the strength
 * of one of the three answers.
 *
 * Null on the tenure clears it, the way the designation's null does. The two
 * text fields are nullish so a request that is only correcting the tenure need
 * not restate them, and the service clears them where the tenure stops being the
 * one that reports them.
 */
const landTenureSchema = z.object({
  landTenure: z.enum(["OWNERSHIP", "SITE_LEASEHOLD", "OTHER"]).nullable(),
  taxAssessmentUnitNumber: z.string().trim().max(200).nullish(),
  propertyType: z.string().trim().max(200).nullish(),
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
    const { apartmentId, reason } = revealSchema.parse(body);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "board",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: true,
      reason: reason ?? null,
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
  async addLien(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterLien> {
    return this.register.addLien({
      ...lienSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }

  @Post("liens/release")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async releaseLien(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterLien> {
    return this.register.releaseLien({
      ...releaseLienSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Records that a tenant-ownership has ceased (upphorande).
   *
   * Behind the same pair of capabilities as a lien note, and for the reason
   * that route gives: writing to a statutory register needs more than the right
   * to read it. This row is one the database will not let anyone update or
   * delete afterwards.
   *
   * No live role holds `apartmentRegister:read` without `addressBook:write`, so
   * no request can tell the pair apart today. It is declared for the role that
   * reads the register without keeping its content - and asserted in
   * apartment-register.controller.spec.ts, because a request test would go on
   * passing without it.
   */
  @Post("terminations")
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordTermination(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterTermination> {
    return this.register.recordTermination({
      ...terminationSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Records which case of Lag (2026:484) 3 kap. 3 § an overgang falls in, and
   * with it the day the association decided on membership where that case has
   * one.
   *
   * A POST although it sets two fields on an existing row: it is the act of
   * recording a board decision, it is audited, and it is refused if the case is
   * already stated.
   *
   * The route keeps its old path. It is the same act widened - the ordinary case
   * is what it always recorded - and moving it would break a bookmark on a board
   * screen for a rename.
   */
  @Post("membership-decision")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordReportBasis(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterTransfer> {
    return this.register.recordReportBasis({
      ...reportBasisSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Records that a registered overlatelse has been havd or has gone back to the
   * seller.
   *
   * Behind the same pair of capabilities as a termination, and for that route's
   * reason: this writes a row the database will not let anyone update or delete
   * afterwards.
   */
  @Post("transfer-reversals")
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordTransferReversal(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterTransferReversal> {
    return this.register.recordTransferReversal({
      ...transferReversalSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Records the association's authoritative property designation.
   *
   * Here rather than in the settings module because it is register content: the
   * cooperative housing register identifies the property the apartments are in,
   * and the prose the board publishes to a broker is a separate field that no
   * statutory answer may be derived from.
   */
  @Post("property-designation")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordPropertyDesignation(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{ propertyDesignation: string | null }> {
    const { propertyDesignation } = propertyDesignationSchema.parse(body);
    return this.register.recordPropertyDesignation({
      propertyDesignation,
      actorPersonId: actingPersonId(request),
    });
  }

  /**
   * Records on what footing the association's buildings stand on their land,
   * and the two fields that answer makes reportable.
   *
   * Beside the property designation and not in the settings module, for the
   * reason that route gives: Forordning (2026:898) 2 kap. 4 § andra stycket
   * decides on this answer whether the designation is reported at all, so the
   * two are one register question asked in two places.
   */
  @Post("land-tenure")
  @HttpCode(200)
  @RequireCapability("apartmentRegister:read", "addressBook:write")
  async recordLandTenure(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<{
    landTenure: "OWNERSHIP" | "SITE_LEASEHOLD" | "OTHER" | null;
    taxAssessmentUnitNumber: string | null;
    propertyType: string | null;
  }> {
    return this.register.recordLandTenure({
      ...landTenureSchema.parse(body),
      actorPersonId: actingPersonId(request),
    });
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
   * could never obtain the statutory extract the law entitles them to. The
   * service is what keeps that justification true - a holder's copy carries
   * their own number and masks every co-holder's and previous holder's. It is
   * audited exactly as the board's is.
   */
  @Post("reveal")
  @HttpCode(200)
  async reveal(
    @Req() request: RequestWithPrincipal,
    @Body() body: unknown,
  ): Promise<ApartmentRegisterExtract> {
    const { apartmentId, reason } = revealSchema.parse(body);
    return this.register.extract({
      actorPersonId: actingPersonId(request),
      audience: "holder",
      apartmentId: apartmentId ?? null,
      includeIdentityNumbers: true,
      reason: reason ?? null,
    });
  }
}
