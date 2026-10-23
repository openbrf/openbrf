/**
 * A plugin's own records (ADR 0033).
 *
 * A small keyed store: JSON values under a collection and a key, belonging to
 * the plugin and to nothing else. It is for what a plugin has of its own to
 * remember and cannot fit into a settings form - a list of screens, each with
 * its own layout and rotation - and never for people. The data subject access
 * report, purging, erasure and restriction all read the core's own tables, and
 * a plugin's JSON is opaque to every one of them, so a name, an email address
 * or anything copied out of the register kept here would be data the
 * association holds and cannot report, purge or restrict. The host cannot tell
 * a name from a label, so the rule is declared rather than enforced, with one
 * exception: a personal identity number is refused on every write.
 *
 * The errors below are thrown by the host's copy of this package. A plugin
 * imports the SDK for its types only, so it tells them apart by `name` rather
 * than with `instanceof`.
 */

/** A value JSON can carry. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/**
 * A collection: lowercase letters, digits and single hyphens, at most 32
 * characters, starting and ending with a letter or a digit.
 */
export const PLUGIN_RECORD_COLLECTION_PATTERN =
  /^(?=.{1,32}$)[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A key: 1 to 128 letters, digits, `.`, `_`, `:` or `-`. */
export const PLUGIN_RECORD_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** What one plugin may hold, and the most one call reads. */
export const PLUGIN_RECORD_LIMITS = {
  /** Bytes of one value, serialised as JSON in UTF-8. */
  valueBytes: 64 * 1024,
  /** Records per plugin, across every collection. */
  records: 10_000,
  /** Bytes per plugin, across every collection, counted as for one value. */
  totalBytes: 16 * 1024 * 1024,
  /** Records one `list` returns, and its default. */
  listLimit: 200,
  /**
   * Writes of one plugin the host holds at once, the one under way and those
   * waiting for their turn. A write sent past it is refused, not held.
   */
  queuedWrites: 100,
} as const;

export interface PluginRecord<Value extends JsonValue = JsonValue> {
  readonly collection: string;
  readonly key: string;
  readonly value: Value;
  /**
   * A counter, 1 when the record is written first and one more on every write
   * after that. Not `updatedAt`, because two writes inside one millisecond
   * carry the same time.
   */
  readonly revision: number;
  /** When the record was last written, as an ISO 8601 instant. */
  readonly updatedAt: string;
}

/**
 * The plugin's own records. Needs no permission, and refuses while the plugin
 * is switched off, as every host service does.
 *
 * A collection or a key outside its pattern is refused with a RangeError, and a
 * value JSON cannot carry exactly - `undefined`, a function, `NaN`, a `Date`, a
 * class instance, a lone surrogate or a NUL character - with a TypeError.
 */
export interface PluginRecords {
  get<Value extends JsonValue>(
    collection: string,
    key: string,
  ): Promise<PluginRecord<Value> | null>;

  /**
   * In key order, from after `after` when it is given. At most 200 per call,
   * which is also the default.
   */
  list<Value extends JsonValue>(
    collection: string,
    options?: { after?: string; limit?: number },
  ): Promise<readonly PluginRecord<Value>[]>;

  /**
   * Writes a value. With `expectedRevision`, only over that revision, and
   * `null` means only where there is no record yet; otherwise it throws
   * PluginRecordConflictError.
   *
   * A value carrying a personal identity number, in a string, a property name
   * or a number, is refused with PluginRecordIdentityNumberError. A value
   * over 64 KiB, and a write that would take the plugin past 10 000 records
   * or 16 MiB, is refused with PluginRecordLimitError, and so is any write,
   * an overwrite too, sent while 100 of the plugin's writes are already held,
   * the one under way and those waiting.
   */
  put<Value extends JsonValue>(
    collection: string,
    key: string,
    value: Value,
    options?: { expectedRevision?: number | null },
  ): Promise<PluginRecord<Value>>;

  /**
   * True when there was a record to delete. With `expectedRevision`, only that
   * revision is deleted, and another one throws PluginRecordConflictError; no
   * record at all is still `false`.
   */
  delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number },
  ): Promise<boolean>;
}

/** A write's `expectedRevision` did not match the record it found. */
export class PluginRecordConflictError extends Error {
  constructor(
    readonly pluginId: string,
    /** The revision the store holds, or null when it holds no record. */
    readonly actualRevision: number | null,
  ) {
    super(
      `Plugin "${pluginId}" wrote a record over a revision it no longer has.`,
    );
    this.name = "PluginRecordConflictError";
  }
}

export type PluginRecordLimit =
  "valueBytes" | "records" | "totalBytes" | "queuedWrites";

/**
 * A write, or a delete queued behind the writes, was past one of
 * {@link PLUGIN_RECORD_LIMITS}, and nothing was changed.
 */
export class PluginRecordLimitError extends Error {
  constructor(
    readonly pluginId: string,
    readonly limit: PluginRecordLimit,
  ) {
    super(
      `Plugin "${pluginId}" was refused a record operation past its ${limit} ` +
        `limit of ${String(PLUGIN_RECORD_LIMITS[limit])}.`,
    );
    this.name = "PluginRecordLimitError";
  }
}

/**
 * A write carried a personal identity number.
 *
 * Neither the collection, the key nor the number is in the message: the error
 * reaches the log, and the number is what the refusal is keeping out of it.
 */
export class PluginRecordIdentityNumberError extends Error {
  constructor(readonly pluginId: string) {
    super(
      `Plugin "${pluginId}" wrote a record carrying a personal identity ` +
        "number, which a plugin's records may not hold.",
    );
    this.name = "PluginRecordIdentityNumberError";
  }
}
