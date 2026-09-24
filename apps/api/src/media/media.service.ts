import { once } from "node:events";
import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";
import { pipeline, type Readable } from "node:stream";

import { AuditLogService } from "../audit/audit-log.service";
import {
  CAPABILITIES,
  type Capability,
  type Principal,
} from "../authorization/capabilities";
import { FieldEncryptionService } from "../crypto/field-encryption.service";
import {
  newFileKey,
  openSealedFile,
  SEALED_FILE_CONTENT_TYPE,
  sealFile,
} from "../crypto/stored-file-cipher";
import { PrismaService } from "../database/prisma.service";
import { residencyHeldOn } from "../registers/held-on";
import type { AuditChannel, MediaEncryption } from "../generated/prisma/enums";
import { DomainError } from "../http/domain-error";
import { failureName } from "../logging/failure";
import { generateStorageKey, type StoragePrefix } from "../storage/storage-key";
import { StorageService } from "../storage/storage.service";
import { readDocumentHeader } from "./document-bytes";
import { readImageHeader } from "./image-bytes";

export type MediaVisibility =
  "PUBLIC" | "INTERNAL" | "MEMBER" | "TENANT_OWNERS" | "HOUSEHOLD";

/**
 * The visibilities decided against a residency on the file's own apartment
 * rather than against a group.
 *
 * Listed once so the upload, the serving branch and the invariant that ties the
 * two to `apartmentId` all read the same set.
 */
const APARTMENT_VISIBILITIES: readonly MediaVisibility[] = [
  "TENANT_OWNERS",
  "HOUSEHOLD",
];

/** Whether a visibility is decided against the file's apartment. */
export function isApartmentVisibility(visibility: MediaVisibility): boolean {
  return APARTMENT_VISIBILITIES.includes(visibility);
}

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
  /**
   * What kind of file this upload is for. Images unless stated otherwise.
   *
   * Stated by the caller rather than inferred from the bytes, because the two
   * are not interchangeable and the wrong one is not a near miss: a PDF is not
   * the housing cooperative's mark, and a photograph in the document archive
   * would be a picture of people carrying no declaration about whether it
   * shows any. The default is images because that is what every path but the
   * archive uploads, and because a caller that says nothing should get the
   * narrower answer.
   */
  accept?: "image" | "document";
  visibility: MediaVisibility;
  /**
   * A capability the file names. Narrows an INTERNAL file to holders of it;
   * widens a MEMBER one to them, beside the members themselves.
   */
  requiredCapability?: Capability;
  /**
   * Whether the image shows identifiable persons. Required for an image; not
   * carried by anything else, and recorded as null there.
   */
  showsIdentifiablePersons?: boolean;
  /**
   * The apartment whose household may read the file.
   *
   * Required exactly when the visibility is one decided against an apartment,
   * and refused on any other, which is the CHECK on the column said in
   * TypeScript: a file marked for a household without an apartment is one
   * nobody can be decided about, and an apartment on a MEMBER file would be an
   * access rule that never runs. Either mistake is a programming error rather
   * than a caller's, so it throws before a byte is stored.
   */
  apartmentId?: string | null;
  uploadedByPersonId?: string | null;
  /**
   * Whether the name the file arrived under goes into the MEDIA_UPLOADED entry.
   *
   * True everywhere but the apartment binder. The audit log is append-only and
   * exempt from every purge, and a household's file name is its own words about
   * its own home - the rule the initial share capital's entry states, that the
   * log names which figure moved and never what it moved to. The name is still
   * stored on the row and served in the disposition; only the log does not get
   * it.
   */
  recordFileName?: boolean;
  /**
   * Which way the upload reached the instance.
   *
   * Named by the caller because this is a shared entry point: a board member
   * uploading a picture and the mail collector storing an attachment both land
   * here, and only the caller knows which it is. A missing person is not the
   * test - the collector has none, and neither does a file a resident uploads
   * anonymously through a form.
   */
  channel: AuditChannel;
  /** Groups the object in storage. Not part of the file's identity. */
  prefix?: StoragePrefix;
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
  /** The file's keyed checksum, hex encoded, used as the entity tag. */
  checksum: string;
  visibility: MediaVisibility;
}

/** The path a stored file is served from. Relative: same origin, always. */
export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/** A file sealed for storage, and what its row carries to open it again. */
export interface SealedForStorage {
  /** The object to store: ciphertext, stored as SEALED_FILE_CONTENT_TYPE. */
  body: Buffer;
  /** The file's own key, encrypted under the instance's key. */
  dataKeyCipher: string;
  /** The keyed checksum of the file as uploaded. */
  checksum: string;
}

/**
 * Seals a file under a new key of its own, and wraps that key under the
 * instance's (ADR 0015).
 *
 * Both the upload and the job that encrypts the files stored before files were
 * encrypted go through here, so there is one way a file comes to be held. All
 * of it happens before anything is stored, so a failure stores nothing.
 */
export async function sealForStorage(
  encryption: FieldEncryptionService,
  bytes: Buffer,
): Promise<SealedForStorage> {
  const key = newFileKey();
  const body = sealFile(bytes, key);
  const { cipher } = await encryption.encrypt(
    "mediaFile.dataKey",
    key.toString("hex"),
  );
  const checksum = await encryption.storedFileChecksum(bytes);
  return { body, dataKeyCipher: cipher, checksum };
}

/** The key a row's wrapped key opens to. Throws when it opens to none. */
export async function unwrapFileKey(
  encryption: FieldEncryptionService,
  dataKeyCipher: string,
): Promise<Buffer> {
  const hex = await encryption.decrypt("mediaFile.dataKey", dataKeyCipher);
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("A wrapped file key did not open to a key.");
  }
  return Buffer.from(hex, "hex");
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
 * against that rule. A document carries no such declaration and records none.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditLogService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /**
   * Stores a file and records what it is.
   *
   * The bytes are written before the row, and the object is removed again if
   * the row cannot be written. The other order would leave a row pointing at
   * nothing, which the serving path cannot tell apart from a deleted file; this
   * order can only ever leave an unreferenced object, which costs disk and
   * nothing else - and which, being sealed under a key that only the unwritten
   * row would have held, opens for nobody.
   *
   * The object is the file sealed under a key of its own, and is named without
   * an extension: storage holds ciphertext, and a `.pdf` on it would both
   * misdescribe it and tell the storage's own logs what kind of file it is.
   */
  async upload(input: UploadInput): Promise<MediaFileView> {
    if (input.bytes.length === 0) {
      throw new MediaError("The uploaded file is empty.", "empty-file");
    }

    const accept = input.accept ?? "image";
    const identified = identify(input.bytes, accept);
    if (identified === null) {
      throw new MediaError(
        accept === "image"
          ? "The uploaded file is not a PNG, JPEG, WebP or GIF image."
          : "The uploaded file is not a PDF document.",
        "unsupported-type",
      );
    }
    if (identified.isImage && input.showsIdentifiablePersons === undefined) {
      throw new MediaError(
        "An image upload has to declare whether it shows identifiable persons.",
        "declaration-required",
      );
    }

    /*
     * Before anything is stored, because neither half of this is something a
     * request can cause: the caller decides both the visibility and the
     * apartment, and the two disagreeing is a mistake in the calling code. The
     * column carries the same rule as a CHECK, so without this the failure
     * would come from the database after the bytes were written and would read
     * as a storage fault.
     */
    const apartmentId = input.apartmentId ?? null;
    if (isApartmentVisibility(input.visibility) !== (apartmentId !== null)) {
      throw new Error(
        `A file held ${input.visibility} names an apartment, and no other file does.`,
      );
    }

    const sealed = await sealForStorage(this.encryption, input.bytes);
    const storageKey = generateStorageKey(
      input.prefix ?? "media",
      SEALED_FILE_CONTENT_TYPE,
    );

    await this.storage.put(storageKey, sealed.body, SEALED_FILE_CONTENT_TYPE);

    let file;
    try {
      file = await this.prisma.mediaFile.create({
        data: {
          storageKey,
          encryption: "SECRETSTREAM_64K",
          dataKeyCipher: sealed.dataKeyCipher,
          contentType: identified.contentType,
          byteSize: input.bytes.length,
          checksum: sealed.checksum,
          fileName: safeFileName(input.fileName),
          width: identified.width,
          height: identified.height,
          // Null for anything that is not an image, whatever the caller
          // passed: the column records a declaration about a picture, and a
          // PDF has nobody's face in it to declare.
          showsIdentifiablePersons: identified.isImage
            ? (input.showsIdentifiablePersons ?? null)
            : null,
          visibility: input.visibility,
          requiredCapability: input.requiredCapability ?? null,
          apartmentId,
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
      channel: input.channel,
      actorPersonId: input.uploadedByPersonId ?? null,
      targetKind: "media",
      targetId: file.id,
      // The name is the uploader's own text and the type is the identified
      // one, so the log says what was accepted rather than what was claimed.
      // The name is left out where the caller asked for that, which the
      // apartment binder does and nothing else does.
      context: {
        ...((input.recordFileName ?? true) ? { fileName: file.fileName } : {}),
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
   *
   * A file that may be read is decrypted as it streams, and returned only once
   * its first chunk has verified, so a file whose stored bytes were changed is
   * that same 404 rather than a 200 that breaks off.
   */
  async open(id: string, viewer: Principal | null): Promise<ServedFile> {
    const file = await this.prisma.mediaFile.findUnique({ where: { id } });
    if (file === null) {
      throw new MediaError("No such file.", "not-found");
    }

    const visibility = file.visibility;
    const required = file.requiredCapability;
    const named =
      viewer !== null && required !== null && holds(viewer, required);

    if (visibility === "PUBLIC") {
      // Anyone, deliberately: a mail client rendering the association's logo
      // carries no session, and the public website's visitors have no account.
    } else if (visibility === "MEMBER") {
      /*
       * Membership is asked of the principal rather than looked for among the
       * capabilities, because it is not one: it is an active residency with
       * role MEMBER, derived per request like every other role. The capability
       * the file names widens this rather than narrowing it - it is how the
       * board and an administrator reach the members' shelf without holding a
       * residency of their own.
       */
      if (viewer === null || !(viewer.isMember || named)) {
        throw new MediaError("No such file.", "not-found");
      }
      /*
       * Deliberately not written to the audit log, though the file is narrowed.
       * The rule is not "narrowed is logged" but "the accesses that have to be
       * accountable are logged, and nothing may bury them": the board's own
       * papers are few and opened rarely, while members read the bylaws, the
       * annual report and every set of minutes as a matter of course. A row per
       * serve would put that traffic in an append-only table the purge cannot
       * reach - and it would be a permanent record of which member read which
       * document when, which is surveillance of ordinary membership rather than
       * the accountability the log exists for.
       */
    } else if (visibility === "TENANT_OWNERS" || visibility === "HOUSEHOLD") {
      /*
       * The file's own apartment, and a residency on it held today.
       *
       * Asked of the database rather than of the principal: the principal
       * carries roles and capabilities and no apartment, and the question here
       * is about one apartment rather than about whether the viewer lives
       * anywhere. `residencyHeldOn` is the platform's rule for a period on a
       * day (ADR 0014), which counts a residency from its move-in day - so a
       * buyer the board recorded before tillträde reads nothing while the
       * seller still lives there, and the seller reads it until the day the
       * move-out date names.
       *
       * The household is asked first, so a board member reading the binder of
       * the apartment they live in is served as a resident and is not written
       * to the log as having read it as the board.
       */
      if (viewer === null || file.apartmentId === null) {
        throw new MediaError("No such file.", "not-found");
      }

      const held = await this.prisma.residency.count({
        where: {
          personId: viewer.personId,
          apartmentId: file.apartmentId,
          ...(visibility === "TENANT_OWNERS" ? { role: "MEMBER" } : {}),
          ...residencyHeldOn(localDayOf(new Date())),
        },
      });

      if (held === 0) {
        if (!named) {
          throw new MediaError("No such file.", "not-found");
        }
        /*
         * Every serve of a household's papers to somebody reading them by
         * capability, written before the bytes leave. Unlike the members'
         * shelf, this is not traffic that would bury anything: a binder is
         * consulted rather than followed, and who read one home's papers and
         * when is exactly the accountability the log exists for.
         */
        await this.audit.record({
          action: "MEDIA_ACCESSED",
          channel: "WEB",
          actorPersonId: viewer.personId,
          targetKind: "media",
          targetId: file.id,
          context: { requiredCapability: required },
        });
      }
    } else if (visibility === "INTERNAL") {
      if (viewer === null || (required !== null && !named)) {
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
          channel: "WEB",
          actorPersonId: viewer.personId,
          targetKind: "media",
          targetId: file.id,
          context: { requiredCapability: required },
        });
      }
    } else {
      throw new MediaError("No such file.", "not-found");
    }

    const stream = await this.openSealed(file);

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
   * The file's bytes as uploaded, verified chunk by chunk as they stream.
   *
   * Every refusal here is the same not-found as a missing file, logged by the
   * file's id and never with its key or a byte of it: there is nothing to serve
   * and no retry that would help. On an instance restored with the wrong key
   * every file answers this way.
   */
  private async openSealed(file: StoredFileRecord): Promise<Readable> {
    // An allowlist with a refusing default, like the visibility: a file held
    // any other way is never served as it lies, and no path serves one that is
    // not encrypted.
    if (file.encryption !== "SECRETSTREAM_64K" || file.dataKeyCipher === null) {
      this.logger.error(
        `The file ${file.id} is not encrypted at rest and is not served.`,
      );
      throw new MediaError("No such file.", "not-found");
    }

    let key: Buffer;
    try {
      key = await unwrapFileKey(this.encryption, file.dataKeyCipher);
    } catch {
      this.logger.error(
        `The key of the file ${file.id} does not open under the instance's key.`,
      );
      throw new MediaError("No such file.", "not-found");
    }

    const stored = await this.storage.open(file.storageKey);
    if (stored === null) {
      // The row survived its bytes.
      this.logger.error(
        `The file at ${file.storageKey} is recorded but not in storage.`,
      );
      throw new MediaError("No such file.", "not-found");
    }

    /*
     * pipeline rather than pipe, so a failure on either side destroys both: a
     * chunk that does not verify closes the stored object, and a storage error
     * ends the decryption. A failure after the first chunk ends the reply short
     * of its content-length, which a client reads as a failed transfer.
     */
    let started = false;
    const opened = openSealedFile(key, file.byteSize);
    pipeline(stored, opened, (error) => {
      if (!started || error === null || error === undefined) {
        return;
      }
      // Closed by the reader: a revalidation, or a client that went away.
      if (
        (error as NodeJS.ErrnoException).code === "ERR_STREAM_PREMATURE_CLOSE"
      ) {
        return;
      }
      this.logger.error(
        `The file ${file.id} stopped partway through: ${failureName(error)}`,
      );
    });

    try {
      await once(opened, "readable");
    } catch (error) {
      // The class and its code, such as SealedFileError (unverified-chunk),
      // never the message: a storage error composes one from what it was
      // handling (ADR 0007).
      this.logger.error(
        `The file ${file.id} failed verification: ${failureName(error)}`,
      );
      throw new MediaError("No such file.", "not-found");
    }
    started = true;
    return opened;
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
   *
   * `recordFileName` is the upload's switch at the other end, and defaults the
   * same way: every caller keeps the name in the entry unless it opts out. The
   * apartment binder opts out, because taking an entry out is also how a board
   * answers an art. 17 request about one - and a name left in the log would put
   * the erasure's own subject in an append-only table no purge reaches.
   */
  async remove(
    id: string,
    actorPersonId: string | null | undefined,
    channel: AuditChannel,
    options: { recordFileName?: boolean } = {},
  ): Promise<void> {
    const file = await this.prisma.mediaFile.findUnique({ where: { id } });
    if (file === null) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.mediaFile.delete({ where: { id } });
      await this.audit.record(
        {
          action: "MEDIA_DELETED",
          channel,
          actorPersonId: actorPersonId ?? null,
          targetKind: "media",
          targetId: id,
          context:
            (options.recordFileName ?? true) ? { fileName: file.fileName } : {},
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

    // The unencrypted object the job at start replaced, if its removal has not
    // succeeded yet. The row was its only record, so it goes now or never.
    if (file.unencryptedStorageKey !== null) {
      const unencrypted = file.unencryptedStorageKey;
      await this.storage.remove(unencrypted).catch((cause: unknown) => {
        this.logger.error(
          `Removed the record of ${file.id} but not its unencrypted object at ${unencrypted}: ${failureName(cause)}`,
        );
      });
    }
  }
}

/**
 * What the bytes are, as the row records it.
 *
 * An image and a document are identified by different evidence - a coherent
 * header carrying dimensions, or a signature with a matching end-of-file
 * marker - so the two readers stay apart, and only the one the caller asked
 * for is run. This is where either answer is put into the shape the row needs.
 */
interface IdentifiedFile {
  contentType: string;
  /** Read out of an image header. Null for a document, which has no canvas. */
  width: number | null;
  height: number | null;
  isImage: boolean;
}

function identify(
  bytes: Buffer,
  accept: "image" | "document",
): IdentifiedFile | null {
  if (accept === "image") {
    const image = readImageHeader(bytes);
    return image === null
      ? null
      : {
          contentType: image.contentType,
          width: image.width,
          height: image.height,
          isImage: true,
        };
  }

  const document = readDocumentHeader(bytes);
  return document === null
    ? null
    : {
        contentType: document.contentType,
        width: null,
        height: null,
        isImage: false,
      };
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
 *
 * Exported because a caller that refuses a name on what it says has to ask
 * about this value and not about the one that arrived. Removing a character
 * can join what it separated: "1981:1218-9876.pdf" carries no personal identity
 * number until the colon goes, and then it carries one. Whoever checks a name
 * therefore checks what will be written, which is what this returns.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    // The Unicode "other" category: control, format, surrogate and unassigned.
    .replace(/\p{C}/gu, "")
    .replace(/["\\/:*?<>|]/g, "")
    .trim()
    .slice(0, 200);

  return cleaned === "" ? "upload" : cleaned;
}

/** What opening a file's bytes reads from its row. */
interface StoredFileRecord {
  id: string;
  storageKey: string;
  encryption: MediaEncryption;
  dataKeyCipher: string | null;
  byteSize: number;
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
