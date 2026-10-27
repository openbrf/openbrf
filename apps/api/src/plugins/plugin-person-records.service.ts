import { Injectable } from "@nestjs/common";
import {
  type JsonObject,
  type JsonValue,
  PLUGIN_RECORD_LIMITS,
  type PluginPersonRecord,
  type PluginPersonRecordCollection,
  PluginRecordConflictError,
  PluginRecordOtherPersonError,
  PluginRecordRetentionError,
  PluginRecordSubjectError,
} from "@openbrf/plugin-sdk";
import {
  addLocalDays,
  compareLocalDays,
  dateColumnOf,
  formatDateColumn,
  localDayOf,
  parseLocalDay,
} from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import { PluginAddressBookService } from "./plugin-address-book.service";
import {
  checkCollection,
  checkExpectedRevision,
  checkKey,
  checkRevision,
  checkTotals,
  clearDue,
  isDue,
  liveKey,
  lockPlugin,
  PluginRecordsService,
  refuseIdentityNumbers,
  setAside,
  snapshotValue,
  visibleLive,
} from "./plugin-records.service";
import { residentRouteOfHostCall } from "./resident-route-scope";

/**
 * A plugin's records about a person (ADR 0047), behind `host.personRecords`.
 *
 * The same table and the same write queue as `host.records`, under the same
 * limits, which the two stores share. What is added is held here, and taken
 * from the host object rather than the plugin: the plugin's id, and the
 * collections its manifest declares, each with its bound.
 *
 * ## Which person a record may name
 *
 * The subject of a new record is a person `residents()` lists to this plugin at
 * the moment of the write; a record already about a person may be rewritten
 * about them after they have moved out. Anything else is refused with
 * PluginRecordSubjectError, which never says why. On a resident route (ADR
 * 0051) the only new subject is the caller: a record about anybody else is
 * refused alike, without asking whether the address book lists them, so the
 * refusal tells the plugin nothing about that person. A record names no other
 * person: a key or a value holding another person's id is refused with
 * PluginRecordOtherPersonError (`refuseOtherPersons`).
 *
 * ## Which records a plugin reads
 *
 * A record is absent from every read when its subject is a person the address
 * book leaves out of this plugin's reads - protected, restricted, or objecting
 * to its processing (`PluginAddressBookService.withheldFrom`). Its key is still
 * taken, so a write onto it is refused as a conflict that reports no revision:
 * the plugin learns the key is held and nothing about by whom.
 *
 * A record is also absent, and its key free, from the start of its erase date,
 * whether the purge has deleted it yet or a hold or a restriction has kept it
 * past that date (`visibleLive`). A plugin cannot tell a hold by a record that
 * outlived its date. An erase date of today or earlier is refused, so a write
 * never makes a record the plugin cannot see. Today, here and for which person
 * a record may name, is the day on which the write holds its locks rather than
 * the day it was sent, so a write that waited past midnight is judged on the
 * new day.
 *
 * ## What a hold or a restriction keeps
 *
 * A `delete`, and a `put` over a record, whose person is under a legal hold or
 * a restriction at the moment of the write sets the replaced row aside rather
 * than overwriting or deleting it, in one transaction. A put then writes a new
 * live row under the key with the replaced revision plus one, so the plugin
 * sees an ordinary overwrite, and the limits see one too: rows set aside do not
 * count against them, so a store at its limit refuses the same writes whether
 * or not a hold stands. A row set aside is never written again, is absent
 * from the plugin's reads, stays on the access report and goes with the purge
 * once the hold has ended and its erase date has passed. Of a key's versions
 * about one person on one day, only the one the day's first write replaced is
 * set aside, and later writes that day act in place (`keepsReplaced`), so what
 * a hold keeps grows by at most a row a day for each key and person. A live
 * record the
 * hold keeps past its erase date is absent in the same way, and a put onto
 * its key sets it aside and writes a new record. The hold is read
 * under the person's legal hold key, as every purge reads it, so a hold placed
 * while the write was waiting wins.
 *
 * ## Which record a write is over
 *
 * A record's revision starts again from 1 when its key is written anew, after
 * a delete or once the host has erased the record, so a write over a revision
 * read before an erasure could land on a record written since that has been
 * written as often. Each record also carries an identity, drawn when the key's
 * record is first written and kept on every write over it, the new live row of
 * a held write included, and a write may name it as `expectedIdentity`
 * (`checkIdentity`). It is random rather than the record's creation time, which
 * two records can share to the millisecond, and it goes with the record, so
 * nothing about an erased record stays behind to tell the next one apart.
 *
 * Not exported from PluginsModule, for the reason `PluginRecordsService`
 * gives.
 */
@Injectable()
export class PluginPersonRecordsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly records: PluginRecordsService,
    private readonly addressBook: PluginAddressBookService,
  ) {}

  async get(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    key: string,
    now: Date = new Date(),
  ): Promise<PluginPersonRecord | null> {
    declaredCollection(pluginId, declared, collection);
    checkKey(pluginId, key);
    const row = await this.prisma.pluginRecord.findFirst({
      where: { ...visibleLive(pluginId, now), collection, key },
    });
    if (row?.subjectPersonId == null) {
      return null;
    }
    const withheld = await this.addressBook.withheldFrom(pluginId);
    return withheld.has(row.subjectPersonId) ? null : toPersonRecord(row);
  }

  async list(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    options: { subject?: string; after?: string; limit?: number } = {},
    now: Date = new Date(),
  ): Promise<PluginPersonRecord[]> {
    declaredCollection(pluginId, declared, collection);
    const { subject, after, limit = PLUGIN_RECORD_LIMITS.listLimit } = options;
    if (subject !== undefined) {
      checkSubject(pluginId, subject);
    }
    if (after !== undefined) {
      checkKey(pluginId, after);
    }
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > PLUGIN_RECORD_LIMITS.listLimit
    ) {
      throw new RangeError(
        `Plugin "${pluginId}" listed its records with a limit outside 1-` +
          `${String(PLUGIN_RECORD_LIMITS.listLimit)}.`,
      );
    }
    const withheld = [...(await this.addressBook.withheldFrom(pluginId))];
    if (subject !== undefined && withheld.includes(subject)) {
      return [];
    }
    const rows = await this.prisma.pluginRecord.findMany({
      where: {
        ...visibleLive(pluginId, now),
        collection,
        AND: [
          { subjectPersonId: subject ?? { not: null } },
          // Spelled conditionally rather than as an empty `notIn`, so what the
          // query asks does not depend on how the client renders a list of
          // none.
          ...(withheld.length > 0
            ? [{ subjectPersonId: { notIn: withheld } }]
            : []),
        ],
        ...(after === undefined ? {} : { key: { gt: after } }),
      },
      orderBy: { key: "asc" },
      take: limit,
    });
    return rows.map(toPersonRecord);
  }

  async put(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    key: string,
    record: unknown,
    expectedRevision?: number | null,
    expectedIdentity?: string,
    clock: () => Date = () => new Date(),
  ): Promise<PluginPersonRecord> {
    const declaration = declaredCollection(pluginId, declared, collection);
    checkKey(pluginId, key);
    checkExpectedRevision(pluginId, expectedRevision, true);
    checkExpectedIdentity(pluginId, expectedIdentity, expectedRevision);
    // Each part read once, for the reason `snapshotValue` copies the value:
    // the plugin keeps the object it passed and may change it while the
    // write waits for its turn.
    const { subject, eraseOn, value } = readRecordInput(pluginId, record);
    checkSubject(pluginId, subject);
    // Checked here so a date that is wrong whenever the write runs is refused
    // without a turn in the queue, and again once the write has its locks.
    checkEraseOn(pluginId, declaration, eraseOn, clock());
    const { value: copy, size } = snapshotValue(pluginId, value);
    if (typeof copy !== "object" || copy === null || Array.isArray(copy)) {
      throw new TypeError(
        `Plugin "${pluginId}" wrote a record about a person whose value is ` +
          "not a JSON object.",
      );
    }
    refuseIdentityNumbers(pluginId, collection, key, copy);

    return await this.records.inTurn(pluginId, async (tx) => {
      await lockPlugin(tx, pluginId);
      await refuseOtherPersons(tx, pluginId, subject, key, copy);
      /*
       * The legal hold key of every person the write is about - the one the
       * key's record names now and the one it is to name - taken before
       * either is read and in id order, as a removal takes them. The first
       * settles whether a hold keeps the old version; the second whether the
       * new subject may be named at all, which a restriction or an objection
       * granted at the same moment changes, and both are granted under that
       * key. Taking it again below is a no-op: the lock is the transaction's.
       */
      const current = await tx.pluginRecord.findFirst({
        where: liveKey(pluginId, collection, key),
        select: { subjectPersonId: true },
      });
      for (const person of [
        ...new Set([current?.subjectPersonId ?? subject, subject]),
      ].sort()) {
        await lockLegalHold(tx, person);
      }
      // The moment of the write is when it holds its locks, not when it was
      // sent: a write that waited past midnight is judged on the new day, for
      // the erase date, the address book, the records due and the limits.
      const now = clock();
      const eraseDay = checkEraseOn(pluginId, declaration, eraseOn, now);
      const existing = await this.liveRow(tx, pluginId, collection, key, now, {
        clearDue: true,
      });
      checkRevision(pluginId, existing, expectedRevision);
      checkIdentity(pluginId, existing, expectedIdentity);

      // A new record names a person the plugin may name now; a rewrite may
      // keep the person it already names, who may have moved out since. A
      // record past its erase date is no record to rewrite. On a resident
      // route the person a new record names is the caller, and naming a new
      // person anywhere else fails the answer of a resident route of the
      // plugin's that has yet to answer.
      if (existing?.subjectPersonId !== subject) {
        const resident = residentRouteOfHostCall(pluginId);
        if (
          (resident !== null && resident.personId !== subject) ||
          !(await this.addressBook.isListed(pluginId, subject, now, tx))
        ) {
          throw new PluginRecordSubjectError(pluginId);
        }
      }

      const data = {
        subjectPersonId: subject,
        eraseOn: dateColumnOf(eraseDay),
        value: copy as Prisma.InputJsonValue,
        size,
      };
      if (existing === null) {
        await checkTotals(tx, pluginId, null, size, now);
        return toPersonRecord(
          await tx.pluginRecord.create({
            data: { pluginId, collection, key, ...data },
          }),
        );
      }
      // Checked as an overwrite whether or not the old row is set aside: the
      // key keeps one live row, and only live rows count, so the limits answer
      // a held person's record as anyone's.
      await checkTotals(tx, pluginId, existing, size, now);
      if (await keepsReplaced(tx, pluginId, collection, key, existing, now)) {
        await setAside(tx, existing.id, now);
        return toPersonRecord(
          await tx.pluginRecord.create({
            data: {
              pluginId,
              collection,
              key,
              ...data,
              revision: existing.revision + 1,
              identity: existing.identity,
              createdAt: existing.createdAt,
            },
          }),
        );
      }
      return toPersonRecord(
        await tx.pluginRecord.update({
          where: { id: existing.id },
          data: { ...data, revision: { increment: 1 } },
        }),
      );
    });
  }

  async delete(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    key: string,
    expectedRevision?: number,
    expectedIdentity?: string,
    clock: () => Date = () => new Date(),
  ): Promise<boolean> {
    declaredCollection(pluginId, declared, collection);
    checkKey(pluginId, key);
    checkExpectedRevision(pluginId, expectedRevision, false);
    checkExpectedIdentity(pluginId, expectedIdentity, expectedRevision);

    return await this.records.inTurn(pluginId, async (tx) => {
      await lockPlugin(tx, pluginId);
      // The person's legal hold key before the clock is read, as a put takes
      // it, so a delete that waited past midnight judges the new day.
      const current = await tx.pluginRecord.findFirst({
        where: liveKey(pluginId, collection, key),
        select: { subjectPersonId: true },
      });
      if (current?.subjectPersonId != null) {
        await lockLegalHold(tx, current.subjectPersonId);
      }
      const now = clock();
      const existing = await this.liveRow(tx, pluginId, collection, key, now, {
        hiddenIsAbsent: true,
      });
      if (existing === null) {
        return false;
      }
      checkRevision(pluginId, existing, expectedRevision);
      checkIdentity(pluginId, existing, expectedIdentity);
      if (await keepsReplaced(tx, pluginId, collection, key, existing, now)) {
        await setAside(tx, existing.id, now);
      } else {
        await tx.pluginRecord.delete({ where: { id: existing.id } });
      }
      return true;
    });
  }

  /**
   * Whether a plugin may name this person as an audit entry's subject (ADR
   * 0047): a person it may name in a new record, or one a record of its own
   * that it can read is about. On a resident route (ADR 0051) the person it
   * may name in a new record is the caller alone, and whether anybody else is
   * listed is not asked.
   */
  async mayName(
    pluginId: string,
    subject: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    checkSubject(pluginId, subject);
    const resident = residentRouteOfHostCall(pluginId);
    if (
      (resident === null || resident.personId === subject) &&
      (await this.addressBook.isListed(pluginId, subject, now))
    ) {
      return true;
    }
    return this.holdsReadableRecordAbout(pluginId, subject, now);
  }

  /**
   * Whether the plugin holds a live record about this person that it can
   * read: one whose subject the address book does not leave out of its reads.
   *
   * What it already knows about the person, so an answer that turns on it
   * tells the plugin nothing new. Asked whatever the id is, an id that is no
   * person's included, which is answered no.
   */
  async holdsReadableRecordAbout(
    pluginId: string,
    subject: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const withheld = await this.addressBook.withheldFrom(pluginId);
    if (withheld.has(subject)) {
      return false;
    }
    const record = await this.prisma.pluginRecord.findFirst({
      where: { ...visibleLive(pluginId, now), subjectPersonId: subject },
      select: { id: true },
    });
    return record !== null;
  }

  /**
   * The live row under a key, as a write meets it, with whether a hold or a
   * restriction keeps it.
   *
   * A row the plugin cannot read - one of `host.records` in a collection since
   * declared here, or one about a person the address book leaves out - is a key
   * taken: a put onto it is refused as a conflict reporting no revision, and a
   * delete finds nothing (`hiddenIsAbsent`). The person's legal hold key is
   * taken before the hold is read, and the row read again under it, so a
   * purge or a hold that committed while this waited is the one it sees.
   *
   * A record whose erase date has come is no record, whoever it is about and
   * whether or not a hold keeps it (`visibleLive`): the answer is null, as
   * once the purge has deleted it, and a put clears it out of the key first
   * (`clearDue`) to write the key anew.
   */
  private async liveRow(
    tx: Prisma.TransactionClient,
    pluginId: string,
    collection: string,
    key: string,
    now: Date,
    options: { hiddenIsAbsent?: boolean; clearDue?: boolean } = {},
  ): Promise<{
    id: string;
    subjectPersonId: string;
    revision: number;
    identity: string;
    size: number;
    createdAt: Date;
    held: boolean;
  } | null> {
    const select = {
      id: true,
      subjectPersonId: true,
      revision: true,
      identity: true,
      size: true,
      createdAt: true,
      eraseOn: true,
    } as const;
    const first = await tx.pluginRecord.findFirst({
      where: liveKey(pluginId, collection, key),
      select,
    });
    if (first === null) {
      return null;
    }
    const taken = (): null => {
      if (options.hiddenIsAbsent === true) {
        return null;
      }
      throw new PluginRecordConflictError(pluginId, null);
    };
    if (first.subjectPersonId === null) {
      return taken();
    }
    await lockLegalHold(tx, first.subjectPersonId);
    const row = await tx.pluginRecord.findFirst({
      where: { id: first.id, setAsideAt: null },
      select,
    });
    if (row === null) {
      // Erased by the purge while this waited for the person's key.
      return null;
    }
    const subject = first.subjectPersonId;
    // Before the address book is asked: a due record about a person it
    // leaves out is as absent as anyone's, not a key taken.
    if (isDue(row.eraseOn, now)) {
      if (options.clearDue === true) {
        await clearDue(tx, { id: row.id, subjectPersonId: subject }, now);
      }
      return null;
    }
    if ((await this.addressBook.withheldFrom(pluginId, tx)).has(subject)) {
      return taken();
    }
    return {
      id: row.id,
      revision: row.revision,
      identity: row.identity,
      size: row.size,
      createdAt: row.createdAt,
      subjectPersonId: subject,
      held: await isPersonWithheld(tx, subject),
    };
  }
}

/**
 * What removing a plugin does with its records (ADR 0047), in the transaction
 * that deletes its installed row and before the row goes.
 *
 * Every record of `host.records` is deleted. Every live record about a person
 * under no legal hold or restriction is deleted, and every one whose person is
 * under one is set aside, as the plugin's own `delete` would set it aside. Rows
 * already set aside stay as they are. What stays names the plugin by its id
 * alone, and the purge, erasure and the closing job reach it like any other
 * record.
 *
 * The caller holds the installed row's lock, so no write of the plugin lands
 * in between. Each person's legal hold key is taken before the holds are read,
 * in id order, so a hold placed during the removal either lands first and keeps
 * the person's records or waits for the removal to commit.
 */
export async function removePluginRecords(
  tx: Prisma.TransactionClient,
  pluginId: string,
  now: Date = new Date(),
): Promise<{ deleted: number; setAside: number }> {
  const own = await tx.pluginRecord.deleteMany({
    where: { pluginId, subjectPersonId: null },
  });
  const subjects = (
    await tx.pluginRecord.findMany({
      where: { pluginId, setAsideAt: null, subjectPersonId: { not: null } },
      distinct: ["subjectPersonId"],
      select: { subjectPersonId: true },
      orderBy: { subjectPersonId: "asc" },
    })
  ).flatMap((row) =>
    row.subjectPersonId === null ? [] : [row.subjectPersonId],
  );
  for (const subject of subjects) {
    await lockLegalHold(tx, subject);
  }
  const withheld = new Set(await withheldPersonIds(tx));
  const kept = subjects.filter((subject) => withheld.has(subject));
  // In SQL, for the reason `setAside` gives: the client would stamp every
  // kept row as changed at the moment of the removal.
  const setAsideRows =
    kept.length === 0
      ? 0
      : await tx.$executeRaw`UPDATE plugin_record SET "setAsideAt" = ${now}
          WHERE "pluginId" = ${pluginId} AND "setAsideAt" IS NULL
            AND "subjectPersonId" IN (${Prisma.join(kept)})`;
  const about = await tx.pluginRecord.deleteMany({
    where: { pluginId, setAsideAt: null, subjectPersonId: { not: null } },
  });
  return { deleted: own.count + about.count, setAside: setAsideRows };
}

/**
 * Whether a write over a live row under a hold keeps the row it replaces, set
 * aside, rather than overwriting or deleting it in place.
 *
 * Of the versions a key holds about one person on one day of the
 * association's calendar, the hold keeps the one the day's first write
 * replaced: the record as it stood when the day began, or when the record was
 * first written that day. A later write the same day replaces in place what an
 * earlier one wrote, so a plugin that rewrites a held person's record on every
 * request keeps one row a day for it, not one a request. Nothing about the
 * write the plugin sees changes: the revision, the limits and the answer are
 * those of any overwrite or delete.
 *
 * The caller holds the person's legal hold key and the plugin's lock, so no
 * other write sets a row of this key aside in between.
 */
async function keepsReplaced(
  tx: Prisma.TransactionClient,
  pluginId: string,
  collection: string,
  key: string,
  existing: { subjectPersonId: string; held: boolean },
  now: Date,
): Promise<boolean> {
  if (!existing.held) {
    return false;
  }
  const last = await tx.pluginRecord.findFirst({
    where: {
      pluginId,
      collection,
      key,
      subjectPersonId: existing.subjectPersonId,
      setAsideAt: { not: null },
    },
    orderBy: { setAsideAt: "desc" },
    select: { setAsideAt: true },
  });
  return (
    last?.setAsideAt == null ||
    compareLocalDays(localDayOf(last.setAsideAt), localDayOf(now)) !== 0
  );
}

/**
 * Refuses a record whose key or value names a person other than its subject
 * (ADR 0047): the access report prints the record to its subject, and
 * another person's id would be printed with it.
 *
 * Every person the register holds counts, whatever their residency or
 * status, so the refusal says only that a string is somebody's id. Read in
 * the write's turn and its transaction, not before: a lookup started outside
 * the queue would take a connection for every write a plugin sends at once,
 * and hold its value in memory past the bound `PluginRecordsService` puts on
 * what waits.
 */
async function refuseOtherPersons(
  tx: Prisma.TransactionClient,
  pluginId: string,
  subject: string,
  key: string,
  value: JsonValue,
): Promise<void> {
  const candidates = personIdCandidates(key, value);
  if (candidates.length === 0) {
    return;
  }
  const named = await tx.$queryRaw<unknown[]>`
    SELECT 1 FROM person
    WHERE id = ANY(${candidates}::text[]) AND id <> ${subject}
    LIMIT 1`;
  if (named.length > 0) {
    throw new PluginRecordOtherPersonError(pluginId);
  }
}

/** A person id as the address book hands it out: never a long free text. */
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The strings in a record's key and value that could be a person id as
 * written, for `refuseOtherPersons` to look up.
 *
 * Every run of the characters a person id holds, in the key, in each property
 * name and in each string value, and every run of letters and digits alone
 * within those, since the register makes its ids of letters and digits and a
 * plugin may join one to a word with `-` or `_`. Runs longer than an id can be
 * are left out. An id spelled some other way, encoded or reversed, is not
 * found: this holds an honest plugin to the rule, and catalog review the rest.
 */
export function personIdCandidates(key: string, value: JsonValue): string[] {
  const found = new Set<string>();
  const scan = (text: string): void => {
    for (const pattern of [/[A-Za-z0-9_-]+/g, /[A-Za-z0-9]+/g]) {
      for (const [run] of text.matchAll(pattern)) {
        if (SUBJECT_PATTERN.test(run)) {
          found.add(run);
        }
      }
    }
  };
  const walk = (node: JsonValue): void => {
    if (typeof node === "string") {
      scan(node);
    } else if (Array.isArray(node)) {
      for (const child of node as readonly JsonValue[]) {
        walk(child);
      }
    } else if (node !== null && typeof node === "object") {
      for (const [property, child] of Object.entries(
        node as { readonly [key: string]: JsonValue },
      )) {
        scan(property);
        walk(child);
      }
    }
  };
  scan(key);
  walk(value);
  return [...found];
}

/** The declaration of a collection, or the RangeError that refuses it. */
function declaredCollection(
  pluginId: string,
  declared: readonly PluginPersonRecordCollection[],
  collection: unknown,
): PluginPersonRecordCollection {
  checkCollection(pluginId, collection);
  const declaration = declared.find(
    (candidate) => candidate.collection === collection,
  );
  if (declaration === undefined) {
    throw new RangeError(
      `Plugin "${pluginId}" named a collection its manifest does not declare ` +
        "under personRecords.",
    );
  }
  return declaration;
}

function checkSubject(
  pluginId: string,
  subject: unknown,
): asserts subject is string {
  if (typeof subject !== "string" || !SUBJECT_PATTERN.test(subject)) {
    // Not the value: a plugin may pass anything here, a name included.
    throw new RangeError(
      `Plugin "${pluginId}" named a record's subject by something other ` +
        "than a person id from the address book.",
    );
  }
}

/** A record's identity as the host draws it: a UUID, as the column holds it. */
const IDENTITY_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Refuses an `expectedIdentity` that is not one a read could have handed out,
 * or one beside an `expectedRevision` of null, which asks for no record and so
 * for no identity either: the write could only ever conflict.
 */
function checkExpectedIdentity(
  pluginId: string,
  expectedIdentity: unknown,
  expectedRevision: unknown,
): void {
  if (expectedIdentity === undefined) {
    return;
  }
  if (typeof expectedIdentity !== "string") {
    throw new RangeError(
      `Plugin "${pluginId}" expected a record identity that is not a string.`,
    );
  }
  if (!IDENTITY_PATTERN.test(expectedIdentity)) {
    // Not the value: a plugin may pass anything here.
    throw new RangeError(
      `Plugin "${pluginId}" expected a record identity that no read hands out.`,
    );
  }
  if (expectedRevision === null) {
    throw new RangeError(
      `Plugin "${pluginId}" expected a record identity where it expected no ` +
        "record.",
    );
  }
}

/**
 * The compare-and-set on which record the key holds, beside `checkRevision`
 * on how often it was written: a record written anew under the key after a
 * delete or an erasure starts again from revision 1, so only the identity
 * tells it from the one the plugin read. A conflict reports the revision the
 * store holds, as a revision's does.
 */
function checkIdentity(
  pluginId: string,
  existing: { revision: number; identity: string } | null,
  expectedIdentity: string | undefined,
): void {
  if (expectedIdentity === undefined) {
    return;
  }
  if (existing?.identity !== expectedIdentity) {
    throw new PluginRecordConflictError(pluginId, existing?.revision ?? null);
  }
}

/** The three parts of a `put`, each read once, or the TypeError. */
function readRecordInput(
  pluginId: string,
  record: unknown,
): { subject: unknown; eraseOn: unknown; value: unknown } {
  if (typeof record !== "object" || record === null) {
    throw new TypeError(
      `Plugin "${pluginId}" wrote a record about a person that is not an ` +
        "object with a subject, an eraseOn and a value.",
    );
  }
  return {
    subject: Reflect.get(record, "subject"),
    eraseOn: Reflect.get(record, "eraseOn"),
    value: Reflect.get(record, "value"),
  };
}

/**
 * The erase date as a day, after the day of the write on the association's
 * calendar and within the collection's bound from it, or the error that
 * refuses it.
 *
 * Today and earlier are refused, because such a record would be due as it is
 * written: the plugin could never read it (`visibleLive`), and it would not
 * count against the limits either, so a plugin could write any number of them
 * before the purge came for them.
 */
function checkEraseOn(
  pluginId: string,
  declaration: PluginPersonRecordCollection,
  eraseOn: unknown,
  now: Date,
) {
  const day = typeof eraseOn === "string" ? parseLocalDay(eraseOn) : null;
  if (day === null) {
    throw new RangeError(
      `Plugin "${pluginId}" wrote a record about a person whose eraseOn is ` +
        "not a calendar date, YYYY-MM-DD.",
    );
  }
  const today = localDayOf(now);
  if (compareLocalDays(day, today) <= 0) {
    throw new RangeError(
      `Plugin "${pluginId}" wrote a record about a person whose eraseOn is ` +
        "not after today, so it would be erased as it is written.",
    );
  }
  const latest = addLocalDays(today, declaration.keepAtMostDays);
  if (compareLocalDays(day, latest) > 0) {
    throw new PluginRecordRetentionError(pluginId, declaration.keepAtMostDays);
  }
  return day;
}

function toPersonRecord(row: {
  collection: string;
  key: string;
  subjectPersonId: string | null;
  eraseOn: Date | null;
  value: Prisma.JsonValue;
  revision: number;
  identity: string;
  updatedAt: Date;
}): PluginPersonRecord {
  return {
    collection: row.collection,
    key: row.key,
    subject: row.subjectPersonId ?? "",
    eraseOn: formatDateColumn(row.eraseOn) ?? "",
    value: row.value as JsonObject,
    revision: row.revision,
    identity: row.identity,
    updatedAt: row.updatedAt.toISOString(),
  };
}
