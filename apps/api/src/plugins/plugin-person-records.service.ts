import { Inject, Injectable } from "@nestjs/common";
import {
  type JsonObject,
  type JsonValue,
  PLUGIN_RECORD_LIMITS,
  type PluginNonResidentCaller,
  type PluginPersonRecord,
  type PluginPersonRecordCollection,
  type PluginPersonRecordShown,
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

import { authenticatedFacts } from "../actions/authenticated-request";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import type { PluginBoot } from "./plugin-boot";
import { PLUGIN_BOOT } from "./plugin-loader.service";
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
import {
  residentRouteOf,
  residentRouteOfHostCall,
} from "./resident-route-scope";
import { pluginRouteRequestOf, servesRequest } from "./served-request";

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
 * The subject of a new record is a person this plugin serves at the moment of
 * the write (ADR 0047 as amended by ADR 0053): one `residents()` or
 * `nonResidents()` lists to it, decided by the predicate the guard asks
 * (`PluginAddressBookService.isServed`) with the classes its loaded manifest
 * declares and the install approved. A record already about a person may be
 * rewritten about them after they have moved out or left the class. Anything
 * else is refused with PluginRecordSubjectError, which never says why. On a
 * resident route (ADR 0051) the only new subject is the caller: a record about
 * anybody else is refused alike, without asking whether the plugin serves
 * them, so the refusal tells the plugin nothing about that person. A record names no other
 * person: a key or a value holding another person's id is refused with
 * PluginRecordOtherPersonError (`refuseOtherPersons`).
 *
 * ## A name shown at its subject's own choice
 *
 * In a collection that declares `showsSubject` (ADR 0053), a record carries a
 * flag of its subject's: whether they chose to have their name, and a
 * resident their apartment, shown to the others the plugin serves. Only a
 * write made in the subject's own session sets or withdraws it
 * (`writingSessionPersonOf`, `storedShowSubject`); any other write keeps it or
 * stores it as false. A read resolves `shown` from the register on every call,
 * with the predicate the resident route's guard asks (`withShown`), so the
 * record holds no name and the cutoff is the host's.
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
    @Inject(PLUGIN_BOOT) private readonly boot: Pick<PluginBoot, "plugins">,
  ) {}

  /**
   * The classes of caller this plugin serves as its loaded manifest declares
   * them and the install approved, read on the client the write runs on: the
   * host's, never the plugin's, and the ones the guard reads.
   */
  private async servedClasses(
    pluginId: string,
    client: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PluginNonResidentCaller[]> {
    const declared =
      this.boot.plugins.find((plugin) => plugin.id === pluginId)?.manifest
        .nonResidentCallers ?? [];
    return this.addressBook.servedClasses(pluginId, declared, client);
  }

  /**
   * The record under a key, or null. `nonResidentCallers` is the installed
   * manifest's, for the `shown` of a record whose subject chose to be shown
   * (`withShown`); without it only residents are shown.
   */
  async get(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    key: string,
    now: Date = new Date(),
    nonResidentCallers: readonly PluginNonResidentCaller[] = [],
  ): Promise<PluginPersonRecord | null> {
    const declaration = declaredCollection(pluginId, declared, collection);
    checkKey(pluginId, key);
    return await this.readAsOfOneMoment(declaration, async (client) => {
      const row = await client.pluginRecord.findFirst({
        where: { ...visibleLive(pluginId, now), collection, key },
      });
      if (row?.subjectPersonId == null) {
        return null;
      }
      const withheld = await this.addressBook.withheldFrom(pluginId, client);
      if (withheld.has(row.subjectPersonId)) {
        return null;
      }
      const [record] = await this.withShown(
        pluginId,
        declaration,
        nonResidentCallers,
        [row],
        now,
        client,
      );
      return record ?? null;
    });
  }

  async list(
    pluginId: string,
    declared: readonly PluginPersonRecordCollection[],
    collection: string,
    options: { subject?: string; after?: string; limit?: number } = {},
    now: Date = new Date(),
    nonResidentCallers: readonly PluginNonResidentCaller[] = [],
  ): Promise<PluginPersonRecord[]> {
    const declaration = declaredCollection(pluginId, declared, collection);
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
    return await this.readAsOfOneMoment(declaration, async (client) => {
      const withheld = [
        ...(await this.addressBook.withheldFrom(pluginId, client)),
      ];
      if (subject !== undefined && withheld.includes(subject)) {
        return [];
      }
      const rows = await client.pluginRecord.findMany({
        where: {
          ...visibleLive(pluginId, now),
          collection,
          AND: [
            { subjectPersonId: subject ?? { not: null } },
            // Spelled conditionally rather than as an empty `notIn`, so what
            // the query asks does not depend on how the client renders a list
            // of none.
            ...(withheld.length > 0
              ? [{ subjectPersonId: { notIn: withheld } }]
              : []),
          ],
          ...(after === undefined ? {} : { key: { gt: after } }),
        },
        orderBy: { key: "asc" },
        take: limit,
      });
      return await this.withShown(
        pluginId,
        declaration,
        nonResidentCallers,
        rows,
        now,
        client,
      );
    });
  }

  /**
   * Runs a read of records on one snapshot of the database when the
   * collection can show its subjects, and on the connection when it cannot.
   *
   * What a record shows is read from three places: the record with its
   * `showSubject` and subject, the persons the plugin may not read, and the
   * subject's name with whether the plugin serves them (ADR 0053, "The host
   * reads it from the register in the same query that reads the record"). The
   * record's subject is a plain column with no relation to the person, so the
   * reads cannot be one statement through the client, and read one after the
   * other each on its own, a withdrawal, a reassignment, a deletion or a
   * move-out committed between them would leave the name resolved for a
   * record that no longer says what it was read as. A `REPEATABLE READ`
   * transaction gives every read in it the same snapshot, which an ordinary
   * `READ COMMITTED` one does not, so the answer is the register as of one
   * moment: the record and the name either both before a change or both after
   * it. The transaction only reads, so it is never retried.
   */
  private async readAsOfOneMoment<T>(
    declaration: PluginPersonRecordCollection,
    work: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    return declaration.showsSubject === true
      ? await this.prisma.$transaction(work, {
          isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        })
      : await work(this.prisma);
  }

  /**
   * The records as the plugin reads them, each whose subject chose to be shown
   * carrying `shown` while the plugin serves that subject (ADR 0053, "A name
   * shown at its subject's own choice").
   *
   * Resolved from the register on this read and kept nowhere, so the cutoff is
   * the host's: a subject who moves out, becomes a former resident, leaves the
   * class they were served in, or whose class the install no longer serves, is
   * shown on no read after it. Only in a collection the loaded manifest still
   * declares `showsSubject` for, so a version that drops the declaration shows
   * nobody there. Asked only about the subjects of the records being returned,
   * which the plugin reads already, and only when one of them is flagged, on
   * the client the rows were read on (`readAsOfOneMoment`).
   */
  private async withShown(
    pluginId: string,
    declaration: PluginPersonRecordCollection,
    nonResidentCallers: readonly PluginNonResidentCaller[],
    rows: readonly PersonRecordRow[],
    now: Date,
    client: Prisma.TransactionClient,
  ): Promise<PluginPersonRecord[]> {
    const showing = declaration.showsSubject === true;
    const flagged = showing
      ? rows.flatMap((row) =>
          row.showSubject && row.subjectPersonId !== null
            ? [row.subjectPersonId]
            : [],
        )
      : [];
    const shown =
      flagged.length === 0
        ? new Map<string, PluginPersonRecordShown>()
        : await this.addressBook.shownSubjects(
            pluginId,
            flagged,
            await this.addressBook.servedClasses(
              pluginId,
              nonResidentCallers,
              client,
            ),
            now,
            client,
          );
    return rows.map((row) => {
      const record = toPersonRecord(row, showing);
      const subjectShown =
        record.showSubject === true ? shown.get(record.subject) : undefined;
      // A copy for each record, so a plugin that changes one record's
      // `shown` changes no other record about the same person.
      return subjectShown === undefined
        ? record
        : { ...record, shown: structuredClone(subjectShown) };
    });
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
    // Whose own session the write is made in, read as the call is made and
    // from the host's own state, never from anything the plugin passes.
    const session = writingSessionPersonOf(pluginId);
    const declaration = declaredCollection(pluginId, declared, collection);
    checkKey(pluginId, key);
    checkExpectedRevision(pluginId, expectedRevision, true);
    checkExpectedIdentity(pluginId, expectedIdentity, expectedRevision);
    // Each part read once, for the reason `snapshotValue` copies the value:
    // the plugin keeps the object it passed and may change it while the
    // write waits for its turn.
    const { subject, eraseOn, value, showSubject } = readRecordInput(
      pluginId,
      record,
    );
    checkSubject(pluginId, subject);
    checkShowSubject(pluginId, declaration, showSubject);
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
    // Before the write takes its turn or reads anything, the record's subject
    // included: a write made outside the plugin's resident routes while one
    // of them works waits for its answer here, or is refused (ADR 0051).
    const resident = await residentRouteOfHostCall(
      pluginId,
      "personRecords.put",
    );

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

      // A new record names a person the plugin serves now; a rewrite may
      // keep the person it already names, who may have moved out or left the
      // class since. A record past its erase date is no record to rewrite. On
      // a resident route the person a new record names is the caller, and
      // nobody else is asked about.
      if (existing?.subjectPersonId !== subject) {
        if (
          (resident !== null && resident.personId !== subject) ||
          !(await this.addressBook.isServed(
            pluginId,
            subject,
            await this.servedClasses(pluginId, tx),
            now,
            tx,
          ))
        ) {
          throw new PluginRecordSubjectError(pluginId);
        }
      }

      const data = {
        subjectPersonId: subject,
        eraseOn: dateColumnOf(eraseDay),
        value: copy as Prisma.InputJsonValue,
        size,
        showSubject: storedShowSubject(
          declaration,
          session,
          subject,
          showSubject,
          existing,
        ),
      };
      const showing = declaration.showsSubject === true;
      if (existing === null) {
        await checkTotals(tx, pluginId, null, size, now);
        return toPersonRecord(
          await tx.pluginRecord.create({
            data: { pluginId, collection, key, ...data },
          }),
          showing,
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
          showing,
        );
      }
      return toPersonRecord(
        await tx.pluginRecord.update({
          where: { id: existing.id },
          data: { ...data, revision: { increment: 1 } },
        }),
        showing,
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
   * 0047, as amended by ADR 0053): a person it may name in a new record - one
   * it serves - or one a record of its own that it can read is about. On a
   * resident route (ADR 0051) the person it may name in a new record is the
   * caller alone, and whether it serves anybody else is not asked. Off one, the host's `audit.record` has already held
   * the entry while a resident route of the plugin's works
   * (`residentRouteOfHostCall`).
   */
  async mayName(
    pluginId: string,
    subject: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    checkSubject(pluginId, subject);
    const resident = residentRouteOf(pluginId);
    if (
      (resident === null || resident.personId === subject) &&
      // The approved classes and the person are read in one snapshot, as
      // `caller()` and `nonResidents()` read theirs, so a class withdrawn
      // between the two reads cannot still serve a person who joined it
      // after the withdrawal.
      (await this.prisma.$transaction(
        async (tx) =>
          this.addressBook.isServed(
            pluginId,
            subject,
            await this.servedClasses(pluginId, tx),
            now,
            tx,
          ),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ))
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
    showSubject: boolean;
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
      showSubject: true,
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
      showSubject: row.showSubject,
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

/** The parts of a `put`, each read once, or the TypeError. */
function readRecordInput(
  pluginId: string,
  record: unknown,
): {
  subject: unknown;
  eraseOn: unknown;
  value: unknown;
  showSubject: unknown;
} {
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
    showSubject: Reflect.get(record, "showSubject"),
  };
}

/**
 * Refuses a `showSubject` that is not a boolean, and `true` in a collection
 * that does not declare `showsSubject` (ADR 0053), whoever's session the write
 * is made in: the consent screen named no such choice for it. Left out, or
 * false, it is accepted anywhere.
 */
function checkShowSubject(
  pluginId: string,
  declaration: PluginPersonRecordCollection,
  showSubject: unknown,
): asserts showSubject is boolean | undefined {
  if (showSubject !== undefined && typeof showSubject !== "boolean") {
    throw new TypeError(
      `Plugin "${pluginId}" wrote a record about a person whose showSubject ` +
        "is not a boolean.",
    );
  }
  if (showSubject === true && declaration.showsSubject !== true) {
    throw new RangeError(
      `Plugin "${pluginId}" set showSubject on a record in a collection whose ` +
        "declaration does not include showsSubject.",
    );
  }
}

/**
 * The person whose own session a write of the plugin's is made in, or null
 * (ADR 0053, "A name shown at its subject's own choice").
 *
 * On a resident route of the plugin's, the caller the guard found, while the
 * request is still being served. On a board route of the plugin's, the person
 * of the signed-in session core authenticated for the request it is serving.
 * Null for everything else: a job, a timer, work left running after the
 * response, a request for anybody else's route, a connected app's token, and a
 * support session, which core never marks as a person's own (ADR 0028) and
 * which every plugin route refuses before this could be asked.
 *
 * Read from the host's own state alone. The plugin passes no request and no
 * person here, so it cannot make a write count as anybody's session.
 */
export function writingSessionPersonOf(pluginId: string): string | null {
  const resident = residentRouteOf(pluginId);
  if (resident !== null) {
    return servesRequest(resident.request) ? resident.personId : null;
  }
  const request = pluginRouteRequestOf(pluginId);
  if (request === null) {
    return null;
  }
  const facts = authenticatedFacts(request);
  return facts !== undefined && facts.token === null ? facts.personId : null;
}

/**
 * The `showSubject` a write stores (ADR 0053): the subject's own tick, and
 * nobody else's.
 *
 * Made in the session of the person the record is about after the write, it
 * is the flag the write sends, and a write that leaves it out withdraws it.
 * Made in anybody else's session, by a job or in a support session, whatever
 * the write sends is ignored: a rewrite that keeps the record's subject keeps
 * the stored flag, and a new record, or a rewrite that gives the record another
 * subject, stores false, because that subject has not chosen. Always false in a
 * collection the loaded manifest does not declare `showsSubject` for, so a
 * version that drops the declaration clears each choice it rewrites. Only
 * those: a record nobody rewrites while the declaration is absent keeps its
 * stored choice, and shows its subject again if a later version declares
 * `showsSubject` once more and the subject is still served.
 */
function storedShowSubject(
  declaration: PluginPersonRecordCollection,
  session: string | null,
  subject: string,
  requested: boolean | undefined,
  existing: { subjectPersonId: string; showSubject: boolean } | null,
): boolean {
  if (declaration.showsSubject !== true) {
    return false;
  }
  if (session !== null && session === subject) {
    return requested === true;
  }
  return existing?.subjectPersonId === subject && existing.showSubject;
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

/** What a record's read takes from its row. */
interface PersonRecordRow {
  collection: string;
  key: string;
  subjectPersonId: string | null;
  eraseOn: Date | null;
  value: Prisma.JsonValue;
  revision: number;
  identity: string;
  showSubject: boolean;
  updatedAt: Date;
}

/**
 * A row as the plugin reads it, without `shown`, which only a read resolves
 * (`withShown`). `showing` is whether the loaded manifest declares
 * `showsSubject` for the collection: a flag left from a version that did reads
 * as false.
 */
function toPersonRecord(
  row: PersonRecordRow,
  showing: boolean,
): PluginPersonRecord {
  return {
    collection: row.collection,
    key: row.key,
    subject: row.subjectPersonId ?? "",
    eraseOn: formatDateColumn(row.eraseOn) ?? "",
    value: row.value as JsonObject,
    revision: row.revision,
    identity: row.identity,
    updatedAt: row.updatedAt.toISOString(),
    showSubject: showing && row.showSubject,
  };
}
