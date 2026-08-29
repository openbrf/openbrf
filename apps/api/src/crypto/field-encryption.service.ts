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
  | "importSession.rows";

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
};

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

    const cipher = await field.encryptValue(plaintext);
    const index = spec.indexed ? await this.computeIndex(id, plaintext) : null;

    return { cipher, index };
  }

  /** Decrypts a value back to the string that was originally entered. */
  async decrypt(id: EncryptedFieldId, cipher: string): Promise<string> {
    // decryptValue resolves to a Buffer, not a string. Comparing its result
    // directly against a string silently fails, which is why this conversion
    // lives in one place.
    const plaintext = await this.fieldFor(id).decryptValue(cipher);
    return plaintext.toString("utf8");
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

    const calculated = await this.fieldFor(id).getBlindIndex(
      normalized,
      INDEX_NAME,
    );
    // With typed indexes disabled the library returns the bare string, but the
    // published types describe the typed shape. Accept both.
    return typeof calculated === "string" ? calculated : calculated.value;
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
