import { Controller, Delete, Get, Param, Post, Req } from "@nestjs/common";
import { parseLocalDay } from "@openbrf/shared";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import { ApartmentBinderError } from "./apartment-binder.error";
import {
  ApartmentBinderService,
  BINDER_TITLE_MAX_LENGTH,
  type BinderEntryView,
  type BinderView,
  type BoardBinderSummaryView,
  type BoardBinderView,
} from "./apartment-binder.service";

/**
 * The apartment binder over HTTP, on two controllers.
 *
 * Split by who may reach them, and split rather than branched inside one class
 * for the reason the document archive gives: the board's routes carry a
 * capability declared on the class, so a route added to it later inherits the
 * restriction instead of being open by omission. The household's routes cannot
 * carry the same declaration, because what entitles somebody to their own
 * binder is a residency and not a capability.
 *
 * The bytes never come back through here. A file is fetched from the media
 * route, which is the one route in the product that streams a stored file and
 * the one place the audience on it is enforced; a second serving path would be
 * a second place to get that decision wrong.
 */

/** What is filed, beside the file itself. */
const entrySchema = z.object({
  kind: z.enum([
    "DRAWING",
    "ALTERATION_PERMISSION",
    "WORK_RECORD",
    "INSPECTION",
    "INSTRUCTIONS",
    "OTHER",
  ]),
  audience: z.enum(["TENANT_OWNERS", "HOUSEHOLD"]),
  title: z.string().trim().min(1).max(BINDER_TITLE_MAX_LENGTH),
  /**
   * A calendar date as YYYY-MM-DD, or absent.
   *
   * Parsed here into the association's own day rather than into an instant:
   * the column is a date, and a day somebody wrote on a piece of paper does not
   * become an hour by travelling over HTTP.
   */
  datedOn: z.string().trim().optional(),
});

/**
 * The acting person, or a fault.
 *
 * The global guard attaches a principal to every non-public route or rejects
 * it, so reaching this throw means the guard stopped doing that, and a 500
 * naming the guard is the honest answer.
 */
function requirePrincipal(request: RequestWithPrincipal) {
  const principal = request.principal;
  if (principal === undefined) {
    throw new Error("The authorization guard did not attach a principal.");
  }
  return principal;
}

/**
 * Reads one uploaded PDF and the fields that arrived ahead of it.
 *
 * The fields travel in the multipart body before the file, which is the order
 * the parser reads them in: it stops at the file part, so a field written after
 * it is one this handler is not guaranteed to have seen.
 */
async function readEntry(request: RequestWithPrincipal) {
  const file = await readSingleFile(request).catch((cause: unknown) => {
    if (isTooLarge(cause)) {
      throw new MediaError("The file is larger than allowed.", "too-large");
    }
    throw cause;
  });

  if (file === null) {
    throw new MediaError("The request carried no file.", "no-file");
  }

  const fields = entrySchema.parse(file.fields);
  const datedOn =
    fields.datedOn === undefined || fields.datedOn === ""
      ? null
      : parseLocalDay(fields.datedOn);
  if (
    fields.datedOn !== undefined &&
    fields.datedOn !== "" &&
    datedOn === null
  ) {
    throw new ApartmentBinderError(
      "The date on an entry is a calendar day.",
      "date-required",
    );
  }

  return {
    kind: fields.kind,
    audience: fields.audience,
    title: fields.title,
    datedOn,
    bytes: file.bytes,
    fileName: file.fileName,
  };
}

/**
 * The binder of whoever is reading.
 *
 * `self:manage` rather than nothing, on the rule every non-public route in this
 * codebase follows: a route states what it requires, so its protection can be
 * read off the route rather than inferred from what the guard does with no
 * metadata. Every principal holds it, so the declaration narrows nothing - the
 * service decides which binders there are for this person, from the residencies
 * held today.
 */
@Controller("api/apartment-binder")
@RequireCapability("self:manage")
export class ApartmentBinderShelfController {
  constructor(private readonly binder: ApartmentBinderService) {}

  @Get()
  async mine(@Req() request: RequestWithPrincipal): Promise<BinderView[]> {
    return this.binder.mine(requirePrincipal(request));
  }

  @Post(":apartmentId/documents")
  async file(
    @Param("apartmentId") apartmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BinderEntryView> {
    const principal = requirePrincipal(request);
    const entry = await readEntry(request);

    return this.binder.file({ ...entry, apartmentId, actor: principal });
  }

  @Delete("documents/:id")
  async takeOut(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.binder.takeOut(id, requirePrincipal(request));
  }
}

/**
 * Every apartment's binder, for the board.
 *
 * `apartmentBinder:manage` comes with a board seat and with nothing else - not
 * with the administrator's grant, which carries every other capability in the
 * product. A household's papers are read by people the general meeting elected,
 * and every serve of a file to somebody reading it this way is in the audit log
 * (ADR 0017).
 */
@Controller("api/apartment-binders")
@RequireCapability("apartmentBinder:manage")
export class ApartmentBinderBoardController {
  constructor(private readonly binder: ApartmentBinderService) {}

  @Get()
  async binders(): Promise<BoardBinderSummaryView[]> {
    return this.binder.binders();
  }

  @Get(":apartmentId")
  async one(
    @Param("apartmentId") apartmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BoardBinderView> {
    return this.binder.binder(apartmentId, requirePrincipal(request).personId);
  }

  @Post(":apartmentId/documents")
  async file(
    @Param("apartmentId") apartmentId: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<BinderEntryView> {
    const principal = requirePrincipal(request);
    const entry = await readEntry(request);

    return this.binder.fileAsBoard({ ...entry, apartmentId, actor: principal });
  }

  @Delete("documents/:id")
  async takeOut(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.binder.takeOutAsBoard(id, requirePrincipal(request).personId);
  }
}
