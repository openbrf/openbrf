/**
 * A plugin's records about a person (ADR 0047).
 *
 * The same keyed store as `host.records`, under the same limits, for what a
 * plugin keeps about one resident: who offered a parking space for which days,
 * and who claimed it. Each record names its person and the day the host erases
 * it, and lives only in a collection the manifest declares, so the access
 * report, the purge, erasure, a legal hold and a restriction reach it as they
 * reach the core's own records, without running any of the plugin's code.
 *
 * The errors below are thrown by the host's copy of this package. A plugin
 * imports the SDK for its types only, so it tells them apart by `name` rather
 * than with `instanceof`.
 */

import type { JsonValue } from "./records.ts";

/** A JSON object, which is what a record about a person holds. */
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** The bounds of the `personRecords` declaration. */
export const PLUGIN_PERSON_RECORD_LIMITS = {
  /** Collections one plugin declares. */
  collections: 8,
  /**
   * The longest bound a collection may declare, in days: five years, the bound
   * ADR 0016 puts on a subletting period.
   */
  keepAtMostDays: 1830,
  /** Fields one collection names. */
  fields: 32,
} as const;

/**
 * A field the declaration names: a top-level key of the value, 1 to 64
 * letters, digits, `_` or `-`, starting with a letter.
 */
export const PLUGIN_PERSON_RECORD_FIELD_PATTERN =
  /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** One record about a person, as the plugin reads it back. */
export interface PluginPersonRecord<Value extends JsonObject = JsonObject> {
  readonly collection: string;
  readonly key: string;
  /** The person the record is about, as `host.addressBook` names them. */
  readonly subject: string;
  /**
   * The association's calendar day (ADR 0013), `YYYY-MM-DD`, that the host
   * erases the record on.
   */
  readonly eraseOn: string;
  readonly value: Value;
  /**
   * As for `host.records`: 1 on the first write, one more on each after. A
   * record written anew under the key, after a delete or an erasure, starts
   * again from 1, so a revision alone does not say which record it counts:
   * see `identity`.
   */
  readonly revision: number;
  /**
   * Which record this is, an opaque string to compare and pass back as
   * `expectedIdentity`, never to parse or store as anything else. It stays
   * the same on every write over the record, a hold or a restriction of its
   * person included, and changes only when the key's record is written anew:
   * after a delete, or after the host erased it, on its erase date or on a
   * granted erasure request. No two records under a key share one.
   *
   * Absent on an instance from before records carried one, so check for it
   * before you rely on it (see "Feature detection" in
   * `docs/plugin-contract.md`).
   */
  readonly identity?: string;
  /** When the record was last written, as an ISO 8601 instant. */
  readonly updatedAt: string;
}

/** What a `put` writes: the person, the day it goes, and the value. */
export interface PluginPersonRecordInput<Value extends JsonObject> {
  /** A person id `host.addressBook.residents()` lists to this plugin. */
  subject: string;
  /**
   * `YYYY-MM-DD`, after today and at most the collection's `keepAtMostDays`
   * from it.
   */
  eraseOn: string;
  value: Value;
}

/**
 * The plugin's records about a person (ADR 0047). Needs no permission of its
 * own, but a manifest that declares `personRecords` must ask for
 * `addressBook:read` (or `addressBook:readContact`): whether a write naming a
 * person is accepted is the address book's answer about that person. Refuses
 * while the plugin is switched off, as every host service does.
 *
 * Only a collection the manifest declares under `personRecords` is reachable
 * here, and none of those is reachable through `host.records`. A collection or
 * a key outside its pattern, or a collection the manifest does not declare, is
 * refused with a RangeError, and a value that is not a JSON object, or that
 * JSON cannot carry exactly, with a TypeError.
 *
 * A record whose person the address book leaves out - a person with protected
 * personal data, under a restriction of processing, or whose objection to this
 * plugin's processing stands - is absent from every read. Its key is still
 * taken, so a write onto it is refused as a conflict. A moved-out person's
 * records stay readable, so a plugin that keeps a record about a person learns
 * when that person becomes withheld from it, as against moving out, though not
 * which of the three it is.
 *
 * A record is gone from every read, from the limits and from its key at the
 * start of its `eraseOn`, and the host erases it that night or on a granted
 * erasure request; a plugin learns that one is gone by not finding it. A
 * `delete`, and a `put` over a record, under a legal hold or a restriction of
 * its person goes through as usual, and the host keeps the replaced version
 * where the plugin cannot read it until the hold ends: of a key's versions on
 * one day, the one the day's first write replaced.
 */
export interface PluginPersonRecords {
  get<Value extends JsonObject>(
    collection: string,
    key: string,
  ): Promise<PluginPersonRecord<Value> | null>;

  /**
   * In key order, from after `after` when it is given, and only the records
   * about `subject` when that is given. At most 200 per call, which is also the
   * default.
   */
  list<Value extends JsonObject>(
    collection: string,
    options?: { subject?: string; after?: string; limit?: number },
  ): Promise<readonly PluginPersonRecord<Value>[]>;

  /**
   * Writes a record. With `expectedRevision`, only over that revision, and
   * `null` means only where the key holds no record yet; with
   * `expectedIdentity`, only over the record a read handed out that identity
   * for, whatever its revision. Given both, the write needs both to match.
   * Otherwise it throws PluginRecordConflictError. An `expectedIdentity`
   * beside an `expectedRevision` of `null`, or one that is not a string a read
   * handed out, is refused with a RangeError.
   *
   * A revision alone is matched by a record written anew under the key since
   * it was read, once that record has been written as often: name the
   * identity as well where a record may be deleted or erased under a write in
   * flight.
   *
   * The subject of a new record must be a person `residents()` lists to this
   * plugin at the moment of the write, and a record already about a person may
   * be rewritten about them after they have moved out. Any other subject is
   * refused with PluginRecordSubjectError, which never says why. An `eraseOn`
   * of today or earlier is refused with a RangeError, and one further from
   * today than the collection's `keepAtMostDays` with
   * PluginRecordRetentionError. A personal identity number is refused with
   * PluginRecordIdentityNumberError, another person's id in the key or the
   * value with PluginRecordOtherPersonError, and the limits of `host.records`,
   * which the two stores share, with PluginRecordLimitError.
   */
  put<Value extends JsonObject>(
    collection: string,
    key: string,
    record: PluginPersonRecordInput<Value>,
    options?: { expectedRevision?: number | null; expectedIdentity?: string },
  ): Promise<PluginPersonRecord<Value>>;

  /**
   * True when there was a record to delete. With `expectedRevision`, only that
   * revision is deleted, and with `expectedIdentity` only that record; another
   * one throws PluginRecordConflictError. No record at all is still `false`.
   */
  delete(
    collection: string,
    key: string,
    options?: { expectedRevision?: number; expectedIdentity?: string },
  ): Promise<boolean>;
}

/**
 * A record named a person this plugin may not name.
 *
 * Deliberately silent about why. A person with protected personal data, one
 * under a restriction, one who objected to this plugin's processing, one who
 * no longer lives here and an id that names nobody are refused alike, so the
 * refusal says whether the address book lists the person to this plugin and
 * not which of them they are. The plugin's own records can say more: see
 * `PluginPersonRecords` on records whose person the address book leaves out.
 */
export class PluginRecordSubjectError extends Error {
  constructor(readonly pluginId: string) {
    super(
      `Plugin "${pluginId}" named a person it may not keep a record about.`,
    );
    this.name = "PluginRecordSubjectError";
  }
}

/**
 * A record's key or value named a person other than its subject.
 *
 * A record is about one person, and the access report prints it in full to
 * that person. Another person's id in its key or value would be printed on that
 * report too, though the subject may not be told about the other person, and
 * would outlive the other person's erasure. Relate two people with two records
 * and a key of the plugin's own instead.
 *
 * The host looks for a person id as written: a key, a property name or a
 * string that is the id, or holds it between characters an id cannot contain,
 * as in `offer:<id>`. An id of letters and digits alone, as the register makes
 * them, is found beside `_` and `-` too, as in `holder-<id>`. It refuses every
 * person the register
 * holds alike, whatever their residency or status, so the refusal tells the
 * plugin only that a string it already holds is somebody's id, and never which
 * string.
 */
export class PluginRecordOtherPersonError extends Error {
  constructor(readonly pluginId: string) {
    super(
      `Plugin "${pluginId}" wrote a record about a person that names ` +
        "another person.",
    );
    this.name = "PluginRecordOtherPersonError";
  }
}

/** A record's `eraseOn` was further away than its collection's bound. */
export class PluginRecordRetentionError extends Error {
  constructor(
    readonly pluginId: string,
    /** The collection's `keepAtMostDays`. */
    readonly keepAtMostDays: number,
  ) {
    super(
      `Plugin "${pluginId}" wrote a record to be erased more than ` +
        `${String(keepAtMostDays)} days from today, past its collection's bound.`,
    );
    this.name = "PluginRecordRetentionError";
  }
}

/**
 * The part of one collection's declaration the board consents to: its name, the
 * categories it holds and how long it may keep a record.
 */
export interface PersonRecordsConsentTerms {
  readonly collection: string;
  readonly personalData: readonly string[];
  readonly keepAtMostDays: number;
}

/**
 * The collections of `declared` that reach beyond `consented`: one the consent
 * does not name, one holding a category it did not, or one keeping a record
 * longer. A collection that holds fewer categories or keeps records for less
 * time is within the consent, as a narrowed `personalData` is.
 */
export function personRecordsBeyondConsent(
  declared: readonly PersonRecordsConsentTerms[],
  consented: readonly PersonRecordsConsentTerms[],
): string[] {
  const terms = new Map(consented.map((entry) => [entry.collection, entry]));
  return declared
    .filter((entry) => {
      const agreed = terms.get(entry.collection);
      if (agreed === undefined) {
        return true;
      }
      const categories = new Set(agreed.personalData);
      return (
        entry.keepAtMostDays > agreed.keepAtMostDays ||
        entry.personalData.some((category) => !categories.has(category))
      );
    })
    .map((entry) => entry.collection);
}

/**
 * Whether two declarations agree on what the board consents to, collection by
 * collection, whatever their order.
 */
export function samePersonRecordsTerms(
  left: readonly PersonRecordsConsentTerms[],
  right: readonly PersonRecordsConsentTerms[],
): boolean {
  return (
    left.length === right.length &&
    personRecordsBeyondConsent(left, right).length === 0 &&
    personRecordsBeyondConsent(right, left).length === 0
  );
}
