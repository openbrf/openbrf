import { createHash } from "node:crypto";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import type { Readable } from "node:stream";

import { AuditLogService } from "../audit/audit-log.service";
import {
  CAPABILITIES,
  type Capability,
  type Principal,
} from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { DomainError } from "../http/domain-error";
import { generateStorageKey } from "../storage/storage-key";
import { StorageService } from "../storage/storage.service";
import { readImageHeader } from "./image-bytes";

export type MediaVisibility = "PUBLIC" | "INTERNAL";

export class MediaError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      | "no-file"
      | "empty-file"
      | "too-large"
      | "unsupported-type"
      | "declaration-required"
      | "not-found"
      | "forbidden",
  ) {
    super(message);
    this.status =
      reason === "not-found"
        ? HttpStatus.NOT_FOUND
        : reason === "forbidden"
          ? HttpStatus.FORBIDDEN
          : reason === "too-large"
            ? HttpStatus.PAYLOAD_TOO_LARGE
            : HttpStatus.BAD_REQUEST;
  }
}

export interface UploadInput {
  bytes: Buffer;
  /** The name the file arrived under. Kept, never used to build a key. */
  fileName: string;
  visibility: MediaVisibility;
  /** Narrows an INTERNAL file to holders of one capability. */
  requiredCapability?: Capability;
  /**
   * Whether the image shows identifiable persons. Required for an image, and
   * refused for anything that is not one.
   */
  showsIdentifiablePersons?: boolean;
  uploadedByPersonId?: string | null;
  /** Groups the object in storage. Not part of the file's identity. */
  prefix?: "branding" | "media";
}

export interface MediaFileView {
  id: string;
  contentType: string;
  byteSize: number;
  fileName: string;
  width: number | null;
  height: number | null;
  showsIdentifiablePersons: boolean | null;
  visibility: MediaVisibility;
  /**
   * Where the interface fetches the file: a path on this instance's own
   * origin, always, whichever driver holds the bytes.
   */
  url: string;
}

/** An open file, ready to be piped into a reply. */
export interface ServedFile {
  stream: Readable;
  contentType: string;
  byteSize: number;
  fileName: string;
  /** Hex SHA-256, used as the entity tag. */
  checksum: string;
  visibility: MediaVisibility;
}

/** The path a stored file is served from. Relative: same origin, always. */
export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/**
 * Uploaded files: what they are, who may read them, and where their bytes went.
 *
 * Three rules live here rather than in the callers.
 *
 * A file is identified from its own bytes. The content type a request declares
 * and the extension a file name carries are both written by the client, and the
 * type this service stores is the one it will later serve with - so believing
 * the request would let an upload choose how a browser interprets it.
 *
 * A file is never addressed at the storage backend. Reading one produces a
 * stream, so there is no shape in which a route could hand a browser a link to
 * a bucket. That is not a preference: a redirect to a storage endpoint
 * discloses every visitor's IP address to whoever runs it, which is the reason
 * this platform self-hosts its typefaces too.
 *
 * An image says whether it shows identifiable persons, at the moment it is
 * uploaded. Nothing acts on that here; it is the input the publication
 * guardrails need, because a person may appear on a public page only with a
 * recorded publication consent, and an image nobody declared cannot be checked
 * against that rule.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Stores a file and records what it is.
   *
   * The bytes are written before the row, and the object is removed again if
   * the row cannot be written. The other order would leave a row pointing at
   * nothing, which the serving path cannot tell apart from a deleted file; this
   * order can only ever leave an unreferenced object, which costs disk and
   * nothing else.
   */
  async upload(input: UploadInput): Promise<MediaFileView> {
    if (input.bytes.length === 0) {
      throw new MediaError("The uploaded file is empty.", "empty-file");
    }

    const header = readImageHeader(input.bytes);
    if (header === null) {
      throw new MediaError(
        "The uploaded file is not a PNG, JPEG, WebP or GIF image.",
        "unsupported-type",
      );
    }
    if (input.showsIdentifiablePersons === undefined) {
      throw new MediaError(
        "An image upload has to declare whether it shows identifiable persons.",
        "declaration-required",
      );
    }

    const storageKey = generateStorageKey(
      input.prefix ?? "media",
      header.contentType,
    );
    const checksum = createHash("sha256").update(input.bytes).digest("hex");

    await this.storage.put(storageKey, input.bytes, header.contentType);

    let file;
    try {
      file = await this.prisma.mediaFile.create({
        data: {
          storageKey,
          contentType: header.contentType,
          byteSize: input.bytes.length,
          checksum,
          fileName: safeFileName(input.fileName),
          width: header.width,
          height: header.height,
          showsIdentifiablePersons: input.showsIdentifiablePersons,
          visibility: input.visibility,
          requiredCapability: input.requiredCapability ?? null,
          uploadedByPersonId: input.uploadedByPersonId ?? null,
        },
      });
    } catch (cause) {
      await this.storage.remove(storageKey).catch(() => {
        this.logger.warn(
          `Left an unreferenced object at ${storageKey}: its row could not be written and it could not be removed.`,
        );
      });
      throw cause;
    }

    await this.audit.record({
      action: "MEDIA_UPLOADED",
      actorPersonId: input.uploadedByPersonId ?? null,
      targetKind: "media",
      targetId: file.id,
      // The name is the uploader's own text and the type is the identified
      // one, so the log says what was accepted rather than what was claimed.
      context: {
        fileName: file.fileName,
        contentType: file.contentType,
        byteSize: file.byteSize,
        visibility: file.visibility,
        showsIdentifiablePersons: file.showsIdentifiablePersons,
      },
    });

    return toView(file);
  }

  /**
   * Opens a file for a viewer, or refuses.
   *
   * The visibility decides, and the branch that decides it is written as an
   * allowlist with a refusing default, so a visibility added to the schema and
   * not handled here is refused rather than served to everyone.
   *
   * The refusal for a file that exists but may not be read is the same 404 as
   * for one that does not exist: the ids are unguessable, and answering 403
   * would confirm to an anonymous caller that a particular file is there.
   */
  async open(id: string, viewer: Principal | null): Promise<ServedFile> {
    const file = await this.prisma.mediaFile.findUnique({ where: { id } });
    if (file === null) {
      throw new MediaError("No such file.", "not-found");
    }

    const visibility = file.visibility;
    const required = file.requiredCapability;

    if (visibility === "PUBLIC") {
      // Anyone, deliberately: a mail client rendering the association's logo
      // carries no session, and the public website's visitors have no account.
    } else if (visibility === "INTERNAL") {
      if (viewer === null || (required !== null && !holds(viewer, required))) {
        throw new MediaError("No such file.", "not-found");
      }
      if (required !== null) {
        /*
         * Written before the bytes leave, and only for the files whose access
         * has to be accountable. Logging every serve would put one row in an
         * append-only table per image on a page, and bury the accesses the law
         * actually requires to be recorded.
         */
        await this.audit.record({
          action: "MEDIA_ACCESSED",
          actorPersonId: viewer.personId,
          targetKind: "media",
          targetId: file.id,
          context: { requiredCapability: required },
        });
      }
    } else {
      throw new MediaError("No such file.", "not-found");
    }

    const stream = await this.storage.open(file.storageKey);
    if (stream === null) {
      // The row survived its bytes. Reported as missing rather than as a
      // server fault: there is nothing to serve and no retry that would help.
      this.logger.error(
        `The file at ${file.storageKey} is recorded but not in storage.`,
      );
      throw new MediaError("No such file.", "not-found");
    }

    return {
      stream,
      contentType: file.contentType,
      byteSize: file.byteSize,
      fileName: file.fileName,
      checksum: file.checksum,
      visibility,
    };
  }

  /**
   * Removes a file and its bytes.
   *
   * The row and its audit entry are written in one transaction, because the
   * entry is the evidence that the deletion happened and who asked for it. The
   * log is append-only in the database, so an entry that fails to be written
   * cannot be added afterwards: deleting first and recording second would, on
   * a failed insert, destroy a file with nothing left to show that it ever
   * existed or that anyone authorised its removal.
   *
   * The bytes go after the transaction commits, and in that order for the same
   * reason the upload writes them first: a row without bytes serves a 404,
   * while bytes without a row are unreachable but still stored, and only one of
   * those two is a disclosure risk after somebody asked for a file to be
   * deleted. Storage cannot take part in the transaction, so removing the
   * object before the commit would destroy a file the database still holds.
   */
  async remove(id: string, actorPersonId?: string | null): Promise<void> {
    const file = await this.prisma.mediaFile.findUnique({ where: { id } });
    if (file === null) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mediaFile.delete({ where: { id } });
      await this.audit.record(
        {
          action: "MEDIA_DELETED",
          actorPersonId: actorPersonId ?? null,
          targetKind: "media",
          targetId: id,
          context: { fileName: file.fileName },
        },
        tx,
      );
    });

    await this.storage.remove(file.storageKey).catch((cause: unknown) => {
      this.logger.error(
        `Removed the record of ${file.storageKey} but not the object itself.`,
        cause instanceof Error ? cause.stack : undefined,
      );
    });
  }
}

/**
 * Whether a viewer holds a capability named in the database.
 *
 * The column is free text, so an unknown name has to mean "nobody", not "cast
 * it and hope". A typo that widened access would be silent otherwise.
 */
function holds(viewer: Principal, capabilityName: string): boolean {
  const known = CAPABILITIES.find((name) => name === capabilityName);
  return known !== undefined && viewer.capabilities.has(known);
}

/**
 * The stored file name.
 *
 * This string is echoed in a Content-Disposition header and shown in the
 * interface, so two classes of character have to go. Control characters,
 * because a newline in a header value ends it early and lets the rest be read
 * as a header of our own. And quoting and path punctuation, because the value
 * is quoted and because a name that looks like a path invites somebody later to
 * treat it as one. It never reaches the file system either way: the storage key
 * is generated.
 */
function safeFileName(name: string): string {
  const cleaned = name
    // The Unicode "other" category: control, format, surrogate and unassigned.
    .replace(/\p{C}/gu, "")
    .replace(/["\\/:*?<>|]/g, "")
    .trim()
    .slice(0, 200);

  return cleaned === "" ? "upload" : cleaned;
}

interface MediaFileRow {
  id: string;
  contentType: string;
  byteSize: number;
  fileName: string;
  width: number | null;
  height: number | null;
  showsIdentifiablePersons: boolean | null;
  visibility: MediaVisibility;
}

function toView(file: MediaFileRow): MediaFileView {
  return {
    id: file.id,
    contentType: file.contentType,
    byteSize: file.byteSize,
    fileName: file.fileName,
    width: file.width,
    height: file.height,
    showsIdentifiablePersons: file.showsIdentifiablePersons,
    visibility: file.visibility,
    url: mediaUrl(file.id),
  };
}
