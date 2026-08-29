import { HttpStatus, Injectable } from "@nestjs/common";

import type { Capability, Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { DocumentAudience } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import {
  MediaService,
  type MediaVisibility,
  mediaUrl,
} from "../media/media.service";

export class DocumentError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason: "not-found",
  ) {
    super(message);
    this.status = HttpStatus.NOT_FOUND;
  }
}

/** A document as the archive shows it. Never the row: the storage key stays in. */
export interface DocumentView {
  id: string;
  title: string;
  category: string;
  audience: DocumentAudience;
  fileName: string;
  contentType: string;
  byteSize: number;
  /**
   * Where the file is fetched: a path on this instance's own origin, served by
   * the media route, which decides for itself whether the caller may have it.
   */
  url: string;
  /** ISO instant. What the archive sorts and groups by. */
  uploadedAt: string;
}

export interface AddDocumentInput {
  title: string;
  category: string;
  audience: DocumentAudience;
  bytes: Buffer;
  fileName: string;
  actorPersonId: string;
}

export interface EditDocumentInput {
  title: string;
  category: string;
  audience: DocumentAudience;
}

/**
 * How an audience is enforced on the file itself.
 *
 * The audience is what the archive shows; this is what the serving path acts
 * on. They are two records of one decision, which is why nothing outside this
 * file computes it and why every write that sets one sets the other in the
 * same transaction.
 *
 * BOARD narrows the file to holders of documents:manage, which is what makes
 * every serve of a board document land in the audit log: the media service
 * records MEDIA_ACCESSED for exactly the files whose access is narrowed.
 *
 * MEMBER is INTERNAL and unnarrowed, because membership is not a capability -
 * it is a residency role - and the column names capabilities. The list is
 * therefore what decides who learns a member document's address at all, and
 * the file behind it is readable by anyone signed in who already holds that
 * address. PUBLIC is the one audience with no session at all behind it, which
 * is the whole point of it.
 */
function transportFor(audience: DocumentAudience): {
  visibility: MediaVisibility;
  requiredCapability: Capability | null;
} {
  switch (audience) {
    case "PUBLIC":
      return { visibility: "PUBLIC", requiredCapability: null };
    case "MEMBER":
      return { visibility: "INTERNAL", requiredCapability: null };
    case "BOARD":
      return {
        visibility: "INTERNAL",
        requiredCapability: "documents:manage",
      };
  }
}

/**
 * The audiences a viewer reads.
 *
 * Written as a widening list rather than a comparison, because the three
 * audiences are not a rank: they are three groups that happen to nest today,
 * and a fourth that did not nest would silently be granted by a `>=`.
 *
 * A resident who is not a member sees the public shelf only. That is the
 * distinction the glossary draws and the association acts on - not every
 * resident is a member (boende, medlem) - and the member shelf is where the
 * minutes and the annual report live.
 */
export function audiencesFor(
  viewer: Principal | null,
): readonly DocumentAudience[] {
  if (viewer === null) {
    return ["PUBLIC"];
  }
  if (viewer.capabilities.has("documents:manage")) {
    return ["BOARD", "MEMBER", "PUBLIC"];
  }
  if (viewer.isMember) {
    return ["MEMBER", "PUBLIC"];
  }
  return ["PUBLIC"];
}

/**
 * The association's document archive: the bylaws, the minutes, the house rules
 * and the annual report.
 *
 * Two rules live here rather than in the callers.
 *
 * Reading is decided by audience and by nothing else. There is no read
 * capability, because who may read a document is a property of the document
 * rather than of a seat: the board decides, per document, whether it is for
 * the board, for the members or for the street. What the interface offers
 * follows from the same list the API filters by.
 *
 * A document's audience and its file's visibility are written together. The
 * archive answers from the audience and the media route answers from the
 * visibility, so a document demoted from PUBLIC to BOARD whose file stayed
 * public would still be fetchable by anyone holding its address - the demotion
 * would have changed the shelf and not the lock. Both writes therefore share a
 * transaction, and there is no method here that sets one without the other.
 */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  /** Every document this viewer's audience allows, newest first per category. */
  async list(viewer: Principal | null): Promise<DocumentView[]> {
    const documents = await this.prisma.document.findMany({
      where: { audience: { in: [...audiencesFor(viewer)] } },
      orderBy: [{ category: "asc" }, { createdAt: "desc" }],
      include: {
        mediaFile: {
          select: {
            id: true,
            fileName: true,
            contentType: true,
            byteSize: true,
          },
        },
      },
    });

    return documents.map(toView);
  }

  /**
   * Puts a file in the archive.
   *
   * The file is stored before the document row, and removed again if that row
   * cannot be written, for the reason the media service gives about bytes and
   * rows: this order can only ever leave an unreferenced file, while the other
   * would leave a document pointing at nothing.
   */
  async add(input: AddDocumentInput): Promise<DocumentView> {
    const transport = transportFor(input.audience);

    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      accept: "document",
      visibility: transport.visibility,
      requiredCapability: transport.requiredCapability ?? undefined,
      uploadedByPersonId: input.actorPersonId,
      prefix: "documents",
    });

    try {
      const document = await this.prisma.document.create({
        data: {
          title: input.title,
          category: input.category,
          audience: input.audience,
          mediaFileId: file.id,
          uploadedByPersonId: input.actorPersonId,
        },
        include: {
          mediaFile: {
            select: {
              id: true,
              fileName: true,
              contentType: true,
              byteSize: true,
            },
          },
        },
      });
      return toView(document);
    } catch (cause) {
      // The upload is already in the audit log, and so is this removal. That
      // pair is the honest record of what happened.
      await this.media.remove(file.id, input.actorPersonId).catch(() => {
        /* Reported by the media service; the original failure is the one to
           raise. */
      });
      throw cause;
    }
  }

  /**
   * Renames a document, re-files it, or changes who it is for.
   *
   * One transaction covers the document and its file. An audience change that
   * committed without the matching visibility change would leave the archive
   * saying one thing and the serving path enforcing another, and the direction
   * that matters is the demotion: a document taken off the public shelf whose
   * file was still PUBLIC would stay readable at its own address by anyone who
   * had ever seen it.
   */
  async edit(id: string, input: EditDocumentInput): Promise<DocumentView> {
    const transport = transportFor(input.audience);

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.document.findUnique({
        where: { id },
        select: { mediaFileId: true },
      });
      if (existing === null) {
        throw new DocumentError("No such document.", "not-found");
      }

      await tx.mediaFile.update({
        where: { id: existing.mediaFileId },
        data: {
          visibility: transport.visibility,
          requiredCapability: transport.requiredCapability,
        },
      });

      const document = await tx.document.update({
        where: { id },
        data: {
          title: input.title,
          category: input.category,
          audience: input.audience,
        },
        include: {
          mediaFile: {
            select: {
              id: true,
              fileName: true,
              contentType: true,
              byteSize: true,
            },
          },
        },
      });

      return toView(document);
    });
  }

  /**
   * Takes a document out of the archive, bytes and all.
   *
   * The file is what is deleted, and the document row goes with it: the
   * reference carries ON DELETE CASCADE, so there is one delete to get right
   * rather than two to keep in step. It also means the removal is recorded
   * exactly once, by the media service, inside the transaction that performs
   * it.
   */
  async remove(id: string, actorPersonId: string): Promise<void> {
    const document = await this.prisma.document.findUnique({
      where: { id },
      select: { mediaFileId: true },
    });
    if (document === null) {
      throw new DocumentError("No such document.", "not-found");
    }

    await this.media.remove(document.mediaFileId, actorPersonId);
  }
}

interface DocumentRow {
  id: string;
  title: string;
  category: string;
  audience: DocumentAudience;
  createdAt: Date;
  mediaFile: {
    id: string;
    fileName: string;
    contentType: string;
    byteSize: number;
  };
}

function toView(document: DocumentRow): DocumentView {
  return {
    id: document.id,
    title: document.title,
    category: document.category,
    audience: document.audience,
    fileName: document.mediaFile.fileName,
    contentType: document.mediaFile.contentType,
    byteSize: document.mediaFile.byteSize,
    url: mediaUrl(document.mediaFile.id),
    uploadedAt: document.createdAt.toISOString(),
  };
}
