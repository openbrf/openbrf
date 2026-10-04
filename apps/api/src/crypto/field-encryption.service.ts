import { Inject, Injectable } from "@nestjs/common";
import {
  BlindIndex,
  CipherSweet,
  EncryptedField,
  StringProvider,
} from "ciphersweet-js";

import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { EncryptionKeyProvider } from "./encryption-key.provider";
import {
  normalizeEmail,
  normalizePersonalIdentityNumber,
  normalizePhone,
} from "./personal-data";

/**
 * Logical identity of an encrypted field.
 *
 * CipherSweet derives a distinct key per table and field, so this identity is
 * part of the ciphertext's provenance: a value encrypted as "person.email"
 * cannot be decrypted as "signupRequest.email", and their blind indexes are
 * not comparable. To check a signup request's address against existing
 * persons, compute a "person.email" index from the plaintext rather than
 * comparing the two stored indexes.
 */
export type EncryptedFieldId =
  | "person.email"
  | "person.phone"
  | "person.personalIdentityNumber"
  | "signupRequest.email"
  | "contactSubmission.email"
  | "issue.reporterName"
  | "issue.reporterEmail"
  | "association.smtpPassword"
  | "association.smsGatewayToken"
  | "association.boardMailboxPop3Password"
  | "boardMailboxThread.correspondentName"
  | "boardMailboxThread.correspondentEmail"
  | "importSession.rows"
  | "importSession.preview"
  | "mediaFile.dataKey";

/** Normalizes for indexing, or returns null when the value cannot be indexed. */
type Normalizer = (value: string) => string | null;

const emptyToNull = (value: string): string | null =>
  value === "" ? null : value;

interface FieldSpec {
  table: string;
  field: string;
  /**
   * Whether the field carries a blind index. Fields that are only ever read
   * back by primary key, such as the SMTP password, do not need one, and
   * indexing a secret is pure downside.
   */
  indexed: boolean;
  /**
   * false selects the Argon2id hash, which measured 43.8 ms per operation
   * against 0.07 ms for the HMAC variant (ADR 0002). Reserved for values whose
   * domain is small enough to sweep offline if the database leaks.
   */
  fastHash: boolean;
  normalize: Normalizer;
}

const INDEX_NAME = "idx";
/** Truncation of the blind index, in bits. Shorter means more collisions. */
const INDEX_BITS = 32;

const FIELD_SPECS: Record<EncryptedFieldId, FieldSpec> = {
  "person.email": {
    table: "person",
    field: "email",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizeEmail(value)),
  },
  "person.phone": {
    table: "person",
    field: "phone",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizePhone(value)),
  },
  "person.personalIdentityNumber": {
    table: "person",
    field: "personalIdentityNumber",
    indexed: true,
    // A personal identity number has almost no entropy once the birth date is
    // known, so the index must be expensive to compute.
    fastHash: false,
    normalize: (value) => normalizePersonalIdentityNumber(value),
  },
  "signupRequest.email": {
    table: "signup_request",
    field: "email",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizeEmail(value)),
  },
  /*
   * The address somebody left on the website's contact form.
   *
   * The same argument as a sign-up request's: it is not register content, it
   * is how the board answers a message, and it is held encrypted for exactly
   * that. Indexed so a second message from one address is recognisable as
   * theirs - a board reading its inbox has to be able to see that it is one
   * conversation rather than two strangers.
   */
  "contactSubmission.email": {
    table: "contact_submission",
    field: "email",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizeEmail(value)),
  },
  /*
   * The contact details on an issue reported without an account.
   *
   * Not register content: a passer-by who reports a broken door has told the
   * association who they are for one service purpose, so the value is held
   * encrypted and read back only by whoever handles issues. The name carries no
   * index because nothing searches by it; the address carries one so a second
   * report from the same person can be recognised as theirs.
   */
  "issue.reporterName": {
    table: "issue",
    field: "reporterName",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  "issue.reporterEmail": {
    table: "issue",
    field: "reporterEmail",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizeEmail(value)),
  },
  "association.smtpPassword": {
    table: "association",
    field: "smtpPassword",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  // The credential the SMS gateway is presented with. The SMTP password's
  // argument, unchanged: read back by primary key alone, so no index.
  "association.smsGatewayToken": {
    table: "association",
    field: "smsGatewayToken",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  // The password for the mailbox the board's address is collected from. The
  // SMTP password's argument, unchanged: read back by primary key alone, so no
  // index.
  "association.boardMailboxPop3Password": {
    table: "association",
    field: "boardMailboxPop3Password",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  /*
   * Who wrote to the board's shared mailbox, as the envelope said.
   *
   * Not register content and never treated as one: mail is untrusted input from
   * outside the association, so this is an assertion by whoever sent it rather
   * than an identity. It is held encrypted because it is how the board answers,
   * and for nothing else. The display name carries no index, because nothing
   * searches by a string the sender chose.
   *
   * The address carries one for two reasons, and neither of them is
   * attribution. A board reading its inbox has to see that two letters are one
   * conversation rather than two strangers - the contact form's own argument -
   * and the association has to be able to answer, starting from a person's own
   * record, what it holds about them and which of it a legal hold preserves.
   * Reading the index the other way, from a thread to a name on a screen, is
   * exactly what this module does not do.
   */
  "boardMailboxThread.correspondentName": {
    table: "board_mailbox_thread",
    field: "correspondentName",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  "boardMailboxThread.correspondentEmail": {
    table: "board_mailbox_thread",
    field: "correspondentEmail",
    indexed: true,
    fastHash: true,
    normalize: (value) => emptyToNull(normalizeEmail(value)),
  },
  // An uploaded member list, held between the mapping and apply steps of an
  // import. Not indexed: nothing searches an upload, and the value is a whole
  // file rather than one person's field.
  "importSession.rows": {
    table: "import_session",
    field: "rows",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  // The preview of an upload, held from the job that planned it until the
  // import is claimed. It names every person in the file and the register
  // persons they would match, so it is held like the rows it was planned from.
  "importSession.preview": {
    table: "import_session",
    field: "preview",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
  /*
   * A stored file's own key, hex encoded (ADR 0015). The file is encrypted
   * under it and it is encrypted under the instance's key, so rotating the
   * instance's key re-encrypts this column and rewrites no object. Read back by
   * primary key alone, so no index: indexing a key is pure downside.
   */
  "mediaFile.dataKey": {
    table: "media_file",
    field: "dataKey",
    indexed: false,
    fastHash: true,
    normalize: () => null,
  },
};

/**
 * A stored file's checksum: CipherSweet's blind index "checksum" on the field
 * media_file.checksum, computed over the file's bytes.
 *
 * A blind index is a keyed hash under a key CipherSweet derives from the
 * instance's own, which is what the checksum has to be: stable for one file,
 * comparable by the instance, and unconfirmable by anybody holding the
 * database alone. At 256 bits rather than INDEX_BITS, because the value stands
 * for the bytes and is not a bucket to search.
 */
const CHECKSUM_TABLE = "media_file";
const CHECKSUM_FIELD = "checksum";
const CHECKSUM_BITS = 256;

/**
 * Associated data that marks a ciphertext as holding the value's UTF-8 bytes.
 *
 * Ciphertext written before the value was UTF-8 holds latin1 bytes, and the
 * two overlap: the latin1 bytes of "Ã¶" are also the UTF-8 bytes of "ö". Looking at the bytes cannot tell them apart, so the format is
 * recorded where it is authenticated. A ciphertext made with this associated
 * data opens only with it, and an older one opens only without it.
 */
const UTF_8_FORMAT = "openbrf:utf-8";

export interface EncryptedValue {
  /** Ciphertext of the value as entered, so the original spelling survives. */
  cipher: string;
  /** Blind index of the normalized value, or null when it cannot be indexed. */
  index: string | null;
}

/**
 * Field-level encryption with searchable blind indexes (ADR 0002).
 *
 * This service is the only place in the codebase that touches
 * `ciphersweet-js`. The dependency is effectively unmaintained, so keeping the
 * surface this narrow is what makes replacing it a contained change.
 *
 * The ciphertext always holds the value **as entered** while the blind index
 * always holds the **normalized** value. That split is deliberate: the
 * register should print the phone number the way the resident wrote it, and
 * still find it when someone searches a different spelling.
 */
@Injectable()
export class FieldEncryptionService {
  private readonly engine: CipherSweet;
  private readonly fields = new Map<EncryptedFieldId, EncryptedField>();
  private checksum: EncryptedField | undefined;

  constructor(@Inject(ENV) env: Env) {
    const key = EncryptionKeyProvider.resolve(env);
    this.engine = new CipherSweet(new StringProvider(key));
  }

  /**
   * Encrypts a value and computes its blind index.
   *
   * Throws nothing for an unindexable value: the index comes back null so the
   * caller decides whether that is acceptable. Validation of, for example, a
   * malformed personal identity number belongs at the form and import layer,
   * which can report it against the row that caused it.
   */
  async encrypt(
    id: EncryptedFieldId,
    plaintext: string,
  ): Promise<EncryptedValue> {
    const spec = FIELD_SPECS[id];
    const field = this.fieldFor(id);

    // The library turns a string into bytes as latin1, one byte per UTF-16
    // code unit, which keeps "Å" as the single byte C5 and cuts anything above
    // U+00FF down to its low byte. Handing it the UTF-8 bytes is what lets
    // decrypt give back the value as entered, and UTF_8_FORMAT is what tells
    // decrypt that it was done. The published types take a string; the library
    // takes the Buffer as it is (Util.toBuffer).
    const cipher = await field.encryptValue(
      Buffer.from(plaintext, "utf8") as unknown as string,
      UTF_8_FORMAT,
    );
    const index = spec.indexed ? await this.computeIndex(id, plaintext) : null;

    return { cipher, index };
  }

  /** Decrypts a value back to the string that was originally entered. */
  async decrypt(id: EncryptedFieldId, cipher: string): Promise<string> {
    // decryptValue resolves to a Buffer, not a string. Comparing its result
    // directly against a string silently fails, which is why this conversion
    // lives in one place.
    const field = this.fieldFor(id);
    try {
      const utf8 = await field.decryptValue(cipher, UTF_8_FORMAT);
      // ignoreBOM keeps a leading U+FEFF that was part of the value.
      return new TextDecoder("utf-8", { ignoreBOM: true }).decode(utf8);
    } catch {
      // Not made with UTF_8_FORMAT, so it is older: the library's own latin1
      // conversion of the string. That reads back as entered as long as the
      // value held nothing above U+00FF. A ciphertext that is damaged or
      // belongs to another field fails here as well, and says so.
      const legacy = await field.decryptValue(cipher);
      return legacy.toString("latin1");
    }
  }

  /**
   * The checksum a stored file's row carries, as 64 hex characters.
   *
   * The same bytes give the same checksum under the same instance key, so it
   * serves as the file's entity tag and survives the file being encrypted
   * again under a key of its own. Without the instance's key it cannot be
   * computed, so a database on its own cannot confirm that a document somebody
   * already holds is stored here.
   */
  async storedFileChecksum(bytes: Buffer): Promise<string> {
    // The published types take a string; the library takes the Buffer as it
    // is (Util.toBuffer), and a file is bytes rather than text.
    const calculated = await this.checksumField().getBlindIndex(
      bytes as unknown as string,
      CHECKSUM_FIELD,
    );
    return typeof calculated === "string" ? calculated : calculated.value;
  }

  /**
   * Computes the blind index for a lookup. Search paths must go through this
   * rather than normalizing by hand, or a query will miss rows that are
   * present.
   */
  async computeIndex(
    id: EncryptedFieldId,
    plaintext: string,
  ): Promise<string | null> {
    const spec = FIELD_SPECS[id];
    if (!spec.indexed) {
      return null;
    }

    const normalized = spec.normalize(plaintext);
    if (normalized === null) {
      return null;
    }

    // Still the string, and so still latin1 inside the library, unlike the
    // ciphertext. An index is only compared, never read back, and every index
    // already stored was computed this way: passing UTF-8 bytes would move
    // every non-ASCII address to a new index and hide it from search. The cost
    // is that characters above U+00FF share an index with their low byte,
    // which a 32-bit index already allows for.
    const calculated = await this.fieldFor(id).getBlindIndex(
      normalized,
      INDEX_NAME,
    );
    // With typed indexes disabled the library returns the bare string, but the
    // published types describe the typed shape. Accept both.
    return typeof calculated === "string" ? calculated : calculated.value;
  }

  private checksumField(): EncryptedField {
    this.checksum ??= new EncryptedField(
      this.engine,
      CHECKSUM_TABLE,
      CHECKSUM_FIELD,
    ).addBlindIndex(new BlindIndex(CHECKSUM_FIELD, [], CHECKSUM_BITS, true));
    return this.checksum;
  }

  private fieldFor(id: EncryptedFieldId): EncryptedField {
    const existing = this.fields.get(id);
    if (existing !== undefined) {
      return existing;
    }

    const spec = FIELD_SPECS[id];
    let field = new EncryptedField(this.engine, spec.table, spec.field);
    if (spec.indexed) {
      field = field.addBlindIndex(
        new BlindIndex(INDEX_NAME, [], INDEX_BITS, spec.fastHash),
      );
    }

    this.fields.set(id, field);
    return field;
  }
}
