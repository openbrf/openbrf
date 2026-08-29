import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { z } from "zod";

import type { RequestWithPrincipal } from "../authorization/authorization.guard";
import { RequireCapability } from "../authorization/require-capability.decorator";
import { isTooLarge, readSingleFile } from "../http/multipart";
import { MediaError } from "../media/media.service";
import { DocumentsService, type DocumentView } from "./documents.service";

/**
 * The archive over HTTP, on two controllers.
 *
 * Split by who may reach them, and split rather than branched inside one class
 * because the rules are different in kind: reading is decided per document
 * from its audience and needs no capability at all, while every write needs
 * documents:manage. Declaring the capability on the writing class means a
 * route added to it later inherits the restriction instead of being open by
 * omission.
 */

/**
 * What the board is offered when it files something.
 *
 * Free text with a cap, not an enum. Associations name their own binders, and
 * the interface suggests the four ordinary names rather than insisting on
 * them.
 */
const documentSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.string().trim().min(1).max(80),
  audience: z.enum(["BOARD", "MEMBER", "PUBLIC"]),
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
 * Reading the archive. A session, and nothing more.
 *
 * No capability, deliberately: what a person may read is decided per document
 * from its audience, and a capability here would be a second rule that could
 * disagree with the one the documents themselves carry. A resident sees the
 * public shelf, a member sees theirs as well, and the board sees all three -
 * all from the same filtered query, so the interface cannot show a document
 * the API would refuse to serve.
 */
@Controller("api/documents")
export class DocumentShelfController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(@Req() request: RequestWithPrincipal): Promise<DocumentView[]> {
    return this.documents.list(requirePrincipal(request));
  }
}

/**
 * Filing, re-filing and removing documents. The board's, per documents:manage.
 *
 * The bytes never come back through here. A document is fetched from the media
 * route, which is the one route in the product that streams a stored file and
 * the one place the visibility on that file is enforced; a second serving path
 * would be a second place to get that decision wrong.
 */
@Controller("api/documents")
@RequireCapability("documents:manage")
export class DocumentArchiveController {
  constructor(private readonly documents: DocumentsService) {}

  /**
   * Files one document.
   *
   * The fields travel in the multipart body ahead of the file, which is the
   * order the parser reads them in: it stops at the file part, so a field
   * written after it is one this handler is not guaranteed to have seen.
   */
  @Post()
  async add(@Req() request: RequestWithPrincipal): Promise<DocumentView> {
    const principal = requirePrincipal(request);

    const file = await readSingleFile(request).catch((cause: unknown) => {
      if (isTooLarge(cause)) {
        throw new MediaError("The file is larger than allowed.", "too-large");
      }
      throw cause;
    });

    if (file === null) {
      throw new MediaError("The request carried no file.", "no-file");
    }

    const fields = documentSchema.parse(file.fields);

    return this.documents.add({
      title: fields.title,
      category: fields.category,
      audience: fields.audience,
      bytes: file.bytes,
      fileName: file.fileName,
      actorPersonId: principal.personId,
    });
  }

  /** Renames a document, re-files it, or changes who it is for. */
  @Put(":id")
  async edit(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<DocumentView> {
    return this.documents.edit(id, documentSchema.parse(body));
  }

  @Delete(":id")
  async remove(
    @Param("id") id: string,
    @Req() request: RequestWithPrincipal,
  ): Promise<void> {
    await this.documents.remove(id, requirePrincipal(request).personId);
  }
}
