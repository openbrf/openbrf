import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { localDayOf } from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import { ENV } from "../config/config.module";
import type { Env } from "../config/env";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import { JobQueueService } from "../jobs/job-queue.service";
import { failureName } from "../logging/failure";
import { MediaService, type RemovableFile } from "../media/media.service";
import { residencyHeldOn } from "../registers/held-on";
import { lockResidencyTransitions } from "../registers/residency-lock";
import {
  feedErasedOnRequest,
  feedTracesErasedOnRequest,
  remainingRunBound,
} from "../retention/erasure-domains";
import { lockErasureEligibility } from "../retention/erasure-lock";
import { lockLegalHold } from "../retention/legal-hold-lock";
import {
  erasureRequestedPersonIds,
  isErasureInForce,
  isPersonWithheld,
  withheldPersonIds,
} from "../retention/withheld-persons";
import { livesHere } from "./feed-audience";
import { UNATTACHED_IMAGE_HOURS } from "./feed-image";
import { lockAudience } from "./feed-lock";
import { FEED_RETENTION_DAYS, feedPurgeCutoff } from "./feed-retention";

/** Queue the nightly feed purge runs on. */
export const FEED_PURGE_QUEUE = "feed-purge";

/**
 * The queues of the two purges this one replaced: the chat's and the news
 * comments'. Their schedules are stored in the job schema and outlive the code
 * that registered them, so they are taken out when this one is put in, rather
 * than left to wake every night into a queue nobody works.
 */
const RETIRED_QUEUES = ["chat-purge", "news-comment-purge"] as const;

/**
 * When it runs.
 *
 * 03:47, before the service-data purge. On a granted erasure request this job
 * erases everything the person wrote however recent, and it finds the request
 * only while the request is open: the service-data purge is the job that marks
 * it executed and closes it. Running after that job, this one would no longer
 * select the person, and their posts would wait out their own year while the
 * request said it had been carried out. `retention/erasure-request-order.spec.ts`
 * fails for any job that reads a granted request and is scheduled at or after
 * the job closing it.
 *
 * A minute of its own, because jobs waking together on one small connection pool
 * is a contention nobody gains anything from.
 */
const PURGE_CRON = "47 3 * * *";

/**
 * The most people one run erases the posts and comments of on the retention
 * window.
 *
 * A night's worth of expiries is a handful of rows for a handful of people, so
 * this is never reached in ordinary running. It exists for the first run on an
 * instance that has been writing for years, or the day the retention window is
 * shortened: without a bound that run would erase every post ever written in
 * one transaction-per-person loop. Nothing is lost by
 * stopping - eligibility is computed from the data rather than marked on it, so
 * the next night's run finds the rest.
 *
 * The people a granted erasure request names are taken before it and cannot be
 * cut by it, because that argument does not hold for them:
 * `retention/erasure-domains.ts` has the whole of why.
 */
const MAX_PERSONS_PER_RUN = 500;

/**
 * The most uploads on no post one run removes. A night's worth is the few
 * pictures somebody chose and then did not post; the bound is for a run that
 * finds a backlog, and the next night takes the rest, oldest first.
 */
const MAX_UNATTACHED_IMAGES_PER_RUN = 500;

export interface FeedPurgeRunSummary {
  /** People the eligibility scan found something erasable for. */
  considered: number;
  /** People whose posts or comments were erased. */
  purged: number;
  /** Posts deleted across all of them. */
  postsDeleted: number;
  /** Comments deleted across all of them: each one its own writer's. */
  commentsDeleted: number;
  /**
   * Erased posts deleted because the last comment under them had gone. The
   * erasure was counted when it happened; this is the row it left.
   */
  erasedPostsDeleted: number;
  /**
   * People whose purge threw. The run carries on past them: one row the
   * database refuses must not stop every later person for good.
   */
  failed: number;
  /** Empty groups erased, with the membership lists that were all they held. */
  groupsDeleted: number;
  /** Places in groups taken from people who no longer live here. */
  formerResidentsRemoved: number;
  /**
   * Uploads for a post that never went on one, removed once no write would
   * still take them - and any file a person's purge erased the post of and then
   * failed to remove, which is the same kind of file by then.
   */
  unattachedImagesRemoved: number;
}

/**
 * The feed purge (gallring av inlägg och kommentarer).
 *
 * A resident's post and a comment are service-tier personal data - which person
 * wrote which words to which neighbours - and the purpose they are held for is
 * the conversation. So each is erased on a date derived from when it was written,
 * a year later, and not on the residency purge's clock: somebody who still lives
 * here has no more use for last spring's exchange about the roof than somebody
 * who has left, and the residency purge would never reach it at all while they
 * stayed. The arithmetic and the reasoning are in `feed-retention.ts`.
 *
 * One purge where there were two, the chat's and the news comments', because
 * there is now one table of posts and one of comments.
 *
 * ## What it erases
 *
 * The row, whole. There is nothing on it to blank down to: strip the person and
 * what is left is an unattributed line in a conversation, which is of no use to
 * anybody and is still a record somebody has to keep.
 *
 * A post goes with what hangs on its text: its likes, its read records, its
 * reports, its history and its images. A like or a read record of words that
 * are gone is a fact about nothing, and a picture is part of what was said. An
 * image's file is removed from storage after the transaction that erased its
 * post commits, because storage is not something a transaction can roll back.
 *
 * Its comments do not go with it. Each is its own writer's data, written on a
 * date of its own, and it is erased on that date and on its writer's request,
 * and kept under its writer's hold or restriction - decisions about the writer
 * that only the writer's own transaction takes, under the writer's own locks.
 * So a post with a comment under it is erased rather than deleted: the row
 * stays, with nothing of its author's on it, as the place the comments still
 * answer (`Post.erasedAt`), and it goes in {@link purgeErasedPosts} once the
 * last of them has. A post nobody answered is deleted whole.
 *
 * A post written as Styrelsen is never touched: it is a news item, and goes when
 * the news item does. Alla, Styrelsen and a group with posts in it are never
 * touched either, and neither is a read marker: an audience with every post
 * erased is an empty audience, and a marker names an instant and no post.
 *
 * ## A granted erasure request
 *
 * Takes everything the person wrote however recent, and with it what else the
 * feed holds of theirs: their places in groups, their read markers, the posts
 * they opened, what they liked and the reports they made, with the note on each.
 * `retention/erasure-domains.ts` counts all of it, so the request is not closed
 * while any of it stands.
 *
 * ## Somebody who has moved out
 *
 * Loses their place in every group on the next run. A place in a group rests
 * on a residency held today (`feed-audience.ts`), so a former resident can
 * neither read the group nor leave it, and the row would keep them on its
 * member list and bring them back into the group unannounced if they moved in
 * again. Each removal is recorded as the act ADR 0012 makes it, with no actor.
 *
 * ## Legal hold
 *
 * A hold standing against the person who wrote something stops it, the way it
 * stops the residency purge. The ground under GDPR art. 17.3 is about the
 * person's data rather than about one table, so a dispute that keeps somebody's
 * contact details keeps what they wrote in the group the dispute may be about -
 * a comment under somebody else's post included, which is why a post's expiry
 * erases the post and never the comments under it.
 *
 * The hold is checked twice: once in the scan, and again inside the transaction
 * that deletes. The second one is the one that counts, because a hold placed
 * while the run was in flight has to win, and the board member who clicked that
 * button is entitled to assume it did. That second check is taken under the
 * advisory lock in `retention/legal-hold-lock.ts`, which is what makes it a
 * decision rather than a race.
 *
 * The scan's check is not a duplicate of it. Held people are excluded by the
 * query rather than dropped from its answer, so they cannot spend a run's bound
 * without anything being erased - see {@link FeedPurgeService.eligible}.
 *
 * A picture is held the same way, by its uploader: the sweep of uploads that
 * went on no post, and the removal of an erased post's files after the erasure
 * has committed, both ask again under the uploader's key on the transaction
 * that deletes the file's row.
 *
 * ## How it runs
 *
 * One person per transaction, like the residency purge and for the same
 * reasons. A crash halfway through leaves what it finished finished and the rest
 * for tomorrow, because eligibility is computed from `createdAt` and the window
 * rather than from a flag somebody has to keep in step; and a person with
 * nothing left to erase is not selected, so nobody collects an entry a night for
 * ever in a table that cannot be tidied.
 *
 * The entry is SERVICE_DATA_PURGED with a targetKind of "post", rather than an
 * action of its own. It is the same act the log already has a word for -
 * service-tier data past its retention date was erased - and one entry per person
 * is what lets a later access report say which of that person's data went and
 * when. The counts say how much; the posts themselves are gone, which is the
 * point.
 */
@Injectable()
export class FeedPurgeService implements OnModuleInit {
  private readonly logger = new Logger(FeedPurgeService.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly jobs: JobQueueService,
    private readonly media: MediaService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (this.env.NODE_ENV === "test") {
      // Integration tests drive the purge with a clock of their own, so a
      // worker must not race them with the real one.
      return;
    }
    await this.startPurgeWorker();
  }

  /** Registers the purge. Public so an integration test can drive the job. */
  async startPurgeWorker(): Promise<void> {
    for (const retired of RETIRED_QUEUES) {
      await this.jobs.instance.unschedule(retired);
    }
    await this.jobs.work(FEED_PURGE_QUEUE, async () => {
      await this.run();
    });
    await this.jobs.schedule(FEED_PURGE_QUEUE, PURGE_CRON, {});
  }

  /**
   * Erases every post and comment past its purge date, person by person.
   *
   * @param now The moment to judge eligibility at. Passed in so the integration
   *   suite can drive the clock forward instead of waiting a year.
   * @param retentionDays How long a post or a comment is kept.
   */
  async run(
    now: Date = new Date(),
    retentionDays: number = FEED_RETENTION_DAYS,
  ): Promise<FeedPurgeRunSummary> {
    const personIds = await this.eligible(now, retentionDays);

    let purged = 0;
    let postsDeleted = 0;
    let commentsDeleted = 0;
    let failed = 0;
    for (const personId of personIds) {
      try {
        const deleted = await this.purgePerson(personId, now, retentionDays);
        if (deleted.posts + deleted.comments > 0) {
          purged += 1;
          postsDeleted += deleted.posts;
          commentsDeleted += deleted.comments;
        }
      } catch (error) {
        // The class of the failure and the person id, and nothing the failure
        // was holding: an exception message here can be quoting a row. The id
        // stays because it is the only handle on an erasure that did not
        // happen, and a failed transaction wrote no audit entry to carry it -
        // ADR 0007.
        failed += 1;
        this.logger.error(
          `Feed purge failed for person ${personId}: ${failureName(error)}`,
        );
      }
    }

    if (postsDeleted + commentsDeleted > 0 || failed > 0) {
      this.logger.log(
        `Purged ${String(postsDeleted)} posts and ${String(
          commentsDeleted,
        )} comments for ${String(purged)} of ${String(
          personIds.length,
        )} eligible persons`,
      );
    }
    if (personIds.length >= MAX_PERSONS_PER_RUN) {
      this.logger.log(
        `Feed purge reached its per-run bound of ${String(
          MAX_PERSONS_PER_RUN,
        )} people. Everybody a granted erasure request names was taken ` +
          "first and the retention window took what was left of the bound, " +
          "so what waits for a later run is people on the window alone.",
      );
    }

    const formerResidentsRemoved = await this.removeFormerResidents(now);
    // Before the groups: a group whose last post was an erased one is empty
    // once that row has gone.
    const erasedPostsDeleted = await this.purgeErasedPosts();
    const groupsDeleted = await this.purgeEmptyGroups(now, retentionDays);
    const unattachedImagesRemoved = await this.purgeUnattachedImages(now);

    return {
      considered: personIds.length,
      purged,
      postsDeleted,
      commentsDeleted,
      erasedPostsDeleted,
      failed,
      groupsDeleted,
      formerResidentsRemoved,
      unattachedImagesRemoved,
    };
  }

  /**
   * Takes out of every group the people who no longer live here.
   *
   * Not a person under a hold or a restriction: the row is theirs, and erasing
   * it is what either forbids. The group does not list them all the same,
   * because who is in a group is asked of the register as well as of the row.
   */
  private async removeFormerResidents(now: Date): Promise<number> {
    const residents = await this.prisma.person.findMany({
      where: { residencies: { some: residencyHeldOn(localDayOf(now)) } },
      select: { id: true },
    });
    const withheld = await withheldPersonIds(this.prisma);
    const kept = [...residents.map((person) => person.id), ...withheld];

    /*
     * Page by page, each starting after the last place the one before it read,
     * until a page comes back short. A place the database refuses to delete is
     * still a stale place, so the scan finds it again every night; read as one
     * page of five hundred, five hundred such places sorting first would keep
     * every place after them in its group for as long as they kept failing.
     *
     * The key compared in the query rather than handed over as Prisma's
     * `cursor`: that one looks its row up, and the row is usually a place this
     * run has just deleted.
     */
    let removed = 0;
    let after: { audienceId: string; personId: string } | undefined;
    for (;;) {
      const stale = await this.prisma.groupMember.findMany({
        where: {
          ...(kept.length > 0 ? { personId: { notIn: kept } } : {}),
          ...(after === undefined
            ? {}
            : {
                OR: [
                  { audienceId: { gt: after.audienceId } },
                  {
                    audienceId: after.audienceId,
                    personId: { gt: after.personId },
                  },
                ],
              }),
        },
        orderBy: [{ audienceId: "asc" }, { personId: "asc" }],
        take: MAX_PERSONS_PER_RUN,
        select: { audienceId: true, personId: true },
      });
      removed += await this.removeFormerResidentPlaces(stale, now);
      if (stale.length < MAX_PERSONS_PER_RUN) {
        break;
      }
      after = stale[stale.length - 1];
    }

    if (removed > 0) {
      this.logger.log(`Took ${String(removed)} former residents out of groups`);
    }
    return removed;
  }

  /** One page of {@link removeFormerResidents}: each place in its own transaction. */
  private async removeFormerResidentPlaces(
    stale: readonly { audienceId: string; personId: string }[],
    now: Date,
  ): Promise<number> {
    let removed = 0;
    for (const { audienceId, personId } of stale) {
      try {
        removed += await this.prisma.$transaction(async (tx) => {
          // The group's lock, which a member being put in takes too, and the
          // hold key, so a hold placed since the scan still wins. And the
          // person's residency transition key, which a move-in takes: without
          // it a move-in committing between the residency read below and the
          // delete would cost a current resident their place in the group.
          // Hold, then transition, then group, the order `residency-lock.ts`
          // gives; no writer of a group takes a transition key.
          await lockLegalHold(tx, personId);
          await lockResidencyTransitions(tx, personId);
          await lockAudience(tx, audienceId);
          // Moved back in since the scan, and the place is theirs again.
          if (
            (await isPersonWithheld(tx, personId)) ||
            (await livesHere(tx, personId, now))
          ) {
            return 0;
          }
          const { count } = await tx.groupMember.deleteMany({
            where: { audienceId, personId },
          });
          if (count === 0) {
            return 0;
          }
          await tx.audienceRead.deleteMany({ where: { audienceId, personId } });
          await this.audit.record(
            {
              action: "CHAT_GROUP_MEMBER_REMOVED",
              channel: "SYSTEM",
              // Nobody took them out: their residency ended.
              actorPersonId: null,
              targetPersonId: personId,
              // The audit vocabulary the chat wrote (ADR 0026).
              targetKind: "chat",
              targetId: audienceId,
              context: { chatKind: "GROUP", residencyEnded: true },
            },
            tx,
          );
          return count;
        });
      } catch (error) {
        // The class of the failure and the group, for the reason the empty
        // group sweep gives.
        this.logger.error(
          `Taking a former resident out of group ${audienceId} failed: ${failureName(error)}`,
        );
      }
    }
    return removed;
  }

  /**
   * Deletes the erased posts nothing stands under any more.
   *
   * An erased post is kept for the comments under it, and each of those goes in
   * its own writer's {@link purgePerson}, on its own date. Deleting the post
   * there as well would race a second writer's erasure under the same post -
   * each would see the other's comment still standing - so the row is left to
   * this one statement after the run, which sees every comment that committed.
   *
   * Nothing can be added under the row meanwhile: every path that adds to a
   * post refuses an erased one under a share lock (`refuseErasedPost`), so the
   * condition this deletes on cannot change between the read and the delete.
   *
   * No audit entry. The erasure was recorded when it happened, against the
   * person whose post it was; what goes here is a row with nobody's data on it.
   */
  private async purgeErasedPosts(): Promise<number> {
    try {
      const { count } = await this.prisma.post.deleteMany({
        where: { erasedAt: { not: null }, comments: { none: {} } },
      });
      if (count > 0) {
        this.logger.log(`Deleted ${String(count)} erased posts left empty`);
      }
      return count;
    } catch (error) {
      // The class of the failure, for the reason the empty group sweep gives,
      // and the groups after it still run.
      this.logger.error(
        `Deleting erased posts left empty failed: ${failureName(error)}`,
      );
      return 0;
    }
  }

  /**
   * Removes the uploads for a post that never went on one.
   *
   * The composer uploads each picture as it is chosen, and a writer who closes
   * the dialog instead of posting leaves the file behind on no post. Nobody can
   * read it - the media route serves a post's image only through its post - but
   * it is somebody's picture in storage, and it goes once
   * {@link UNATTACHED_IMAGE_HOURS} have passed.
   *
   * That age is twice the one at which a write stops taking a file
   * (`ATTACHABLE_HOURS`), and the gap is what lets this run without taking a
   * writer's lock: a file old enough to be found here is one no write would
   * attach, so the
   * delete below cannot cascade through an image row a post committed a moment
   * earlier.
   *
   * The same query finds a file whose post a person's purge erased and whose
   * removal then failed: its image row went with the post, so it is on no post,
   * and it is older than the window by the time it is found.
   *
   * Through the media service, one file at a time, like the board mailbox's
   * attachments: the row and its MEDIA_DELETED entry commit together, and the
   * bytes go after. No actor, because a date arrived and nobody pressed
   * anything. A failure is logged by the file's id and left for the next run.
   *
   * Not a file whose uploader is under a legal hold or a restriction of
   * processing. The picture is their data like anything they wrote, and
   * either one forbids erasing it (`retention/withheld-persons.ts`), whether
   * or not it ever went on a post. Excluded by the query, so withheld uploads
   * cannot spend the run's bound the way {@link eligible} explains, and asked
   * again in the transaction that deletes each row - {@link removeImages}.
   */
  private async purgeUnattachedImages(now: Date): Promise<number> {
    const uploadedBefore = new Date(
      now.getTime() - UNATTACHED_IMAGE_HOURS * 60 * 60 * 1000,
    );
    let unattached: { id: string }[];
    try {
      const withheld = await withheldPersonIds(this.prisma);
      unattached = await this.prisma.mediaFile.findMany({
        where: {
          visibility: "POST",
          postImage: null,
          createdAt: { lt: uploadedBefore },
          // Spelled out for the file with no uploader left to name, which a
          // bare `notIn` would leave out: SQL answers NULL NOT IN (...) with
          // neither true nor false.
          ...(withheld.length > 0
            ? {
                OR: [
                  { uploadedByPersonId: null },
                  { uploadedByPersonId: { notIn: withheld } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: "asc" }],
        take: MAX_UNATTACHED_IMAGES_PER_RUN,
        select: { id: true },
      });
    } catch (error) {
      this.logger.error(
        `Finding uploads on no post failed: ${failureName(error)}`,
      );
      return 0;
    }

    const removed = await this.removeImages(
      unattached.map((file) => file.id),
      uploadedBefore,
    );
    if (removed > 0) {
      this.logger.log(
        `Removed ${String(removed)} uploads that went on no post`,
      );
    }
    return removed;
  }

  /**
   * Removes the files of images whose posts have been erased, and answers how
   * many went.
   *
   * After the transaction that erased the posts and never inside it, for the
   * reason the board mailbox's purge gives: `MediaService.remove` opens a
   * transaction of its own and then deletes the bytes, and a removal begun
   * inside a transaction that then aborted would leave a post whose picture is
   * gone. A failure here is logged by the file's id and not raised - the post is
   * already erased, the run has more to do, and the file is on no post now, so
   * {@link purgeUnattachedImages} finds it once it is old enough.
   *
   * Each file is kept if anything has come to protect it since it was
   * selected, decided on the transaction that deletes its row - see
   * {@link keepsImage}. The bytes leave storage only once that transaction has
   * committed, which `MediaService.remove` holds to for every caller.
   *
   * @param uploadedBefore For the sweep of uploads on no post: the age a file
   *   has to be past, asked again where the row is deleted. Null for the files
   *   of posts a person's purge has just erased, which are as new as the posts.
   */
  private async removeImages(
    fileIds: readonly string[],
    uploadedBefore: Date | null = null,
  ): Promise<number> {
    let removed = 0;
    for (const fileId of fileIds) {
      try {
        if (
          await this.media.remove(fileId, null, "SYSTEM", {
            keep: (tx, file) => this.keepsImage(tx, file, uploadedBefore),
          })
        ) {
          removed += 1;
        }
      } catch (error) {
        // The id and the class of the failure. An id is opaque; a file name
        // would be the writer's own words.
        this.logger.error(
          `Feed purge left the image file ${fileId}: ${failureName(error)}`,
        );
      }
    }
    return removed;
  }

  /**
   * Whether a file the purge selected has to stay after all, asked on the
   * transaction that would delete its row.
   *
   * The uploader's legal hold key first, then everything else, so that what
   * this reads settles the question until the commit. A hold placed, or a
   * restriction granted, between the scan and this transaction takes the same
   * key before it writes (`legal-hold-lock.ts`): one that got there first has
   * committed by the time this reads, and one that comes after waits for the
   * file to have gone - which is the order the board member placing it sees,
   * a hold over what was there when it was placed. Either preservation state
   * keeps the file, the rule every purge asks of `isPersonWithheld`.
   *
   * The rest is what the selection assumed, read again: still a post's image,
   * still on no post, and for the sweep still past its age. A write attaching
   * the file is kept clear of the sweep by that age (`UNATTACHED_IMAGE_HOURS`),
   * and asking here costs one indexed read.
   *
   * A file with no uploader left has nobody a hold could stand over, and goes.
   */
  private async keepsImage(
    tx: Prisma.TransactionClient,
    file: RemovableFile,
    uploadedBefore: Date | null,
  ): Promise<boolean> {
    if (file.uploadedByPersonId !== null) {
      await lockLegalHold(tx, file.uploadedByPersonId);
    }
    if (file.visibility !== "POST") {
      return true;
    }
    if (
      uploadedBefore !== null &&
      file.createdAt.getTime() >= uploadedBefore.getTime()
    ) {
      return true;
    }
    const onPost = await tx.postImage.count({ where: { fileId: file.id } });
    if (onPost > 0) {
      return true;
    }
    return (
      file.uploadedByPersonId !== null &&
      (await isPersonWithheld(tx, file.uploadedByPersonId))
    );
  }

  /**
   * Erases a group that holds nothing and has held nothing for a year.
   *
   * The one thing in the feed that has no clock of its own. A post carries its
   * own window and everything hanging on it goes with it, but a membership list
   * does not: it says which neighbours were in a group together, and a group
   * whose last post the purge has already erased would keep saying that forever.
   *
   * So a group with no post left in it, created longer ago than a post is kept,
   * goes - and its members, its read markers and the group itself with it. The
   * two conditions are both needed: the first is a group the purge has already
   * emptied, and the second keeps a group somebody made this morning and has not
   * yet written in.
   *
   * Alla and Styrelsen are never touched. There is exactly one of each and
   * neither holds a membership list - their members are derived - so an empty
   * one is an audience waiting for somebody to write rather than one that is
   * over.
   *
   * No audit entry. The purge writes one entry per person whose posts it erased,
   * which is the record of what was erased; a group that holds nothing is not a
   * person's data being erased, it is the last of it having gone already.
   */
  private async purgeEmptyGroups(
    now: Date,
    retentionDays: number,
  ): Promise<number> {
    const cutoff = feedPurgeCutoff(now, retentionDays);

    const empty = await this.prisma.audience.findMany({
      where: {
        kind: "GROUP",
        createdAt: { lte: cutoff },
        posts: { none: {} },
      },
      take: MAX_PERSONS_PER_RUN,
      select: { id: true },
    });
    if (empty.length === 0) {
      return 0;
    }

    /*
     * Sorted, so two runs of this sweep take the same groups in the same order
     * and wait for each other rather than deadlock. One transaction per group
     * rather than one for all of them: a transaction holding five hundred locks
     * would make every writer in the house wait on a sweep of groups nobody has
     * written in for a year.
     */
    const audienceIds = empty.map((group) => group.id).sort();

    let deleted = 0;
    for (const audienceId of audienceIds) {
      try {
        deleted += await this.prisma.$transaction(async (tx) => {
          /*
           * Before the emptiness is decided, so that deciding it settles the
           * question. A post committing between the scan above and this delete
           * would be erased by the cascade and its author told it was stored -
           * `feed-lock.ts` has the whole of that argument, and
           * `FeedService.write` takes the same key.
           */
          await lockAudience(tx, audienceId);

          /*
           * Every condition again, under the lock and in the delete itself, so
           * that what the scan found is not what is acted on. The group alone:
           * its read markers and its membership rows both cascade with it, so
           * deleting either here would leave the constraint removable without a
           * test noticing. `audienceId` carries the cascade; `personId` stays a
           * plain column so a purge can reach a person's rows unvetoed.
           */
          const { count } = await tx.audience.deleteMany({
            where: {
              id: audienceId,
              kind: "GROUP",
              createdAt: { lte: cutoff },
              posts: { none: {} },
            },
          });
          return count;
        });
      } catch (error) {
        /*
         * One group the database refuses must not stop the rest, exactly as one
         * person's purge does not stop the run: the loop is a list of erasures
         * that are all owed, and a group that fails every night would otherwise
         * keep every group sorting after it for as long as it kept failing -
         * a retention failure that hides itself behind a summary nobody sees.
         *
         * The class of the failure and the group, and nothing the failure was
         * holding: an exception message here can be quoting a row, and this one
         * would be quoting a group's name - ADR 0007.
         */
        this.logger.error(
          `Purging empty group ${audienceId} failed: ${failureName(error)}`,
        );
      }
    }

    if (deleted > 0) {
      this.logger.log(`Purged ${String(deleted)} empty groups`);
    }

    return deleted;
  }

  /**
   * The people who wrote at least one post or comment whose retention has run
   * out.
   *
   * Grouped by the author rather than listing rows, because the unit of work is
   * a person: one transaction, one audit entry, one answer to "what of mine was
   * erased and when".
   *
   * A person under an open legal hold is excluded by the query itself rather
   * than filtered out of its answer, and that ordering is the whole reason for
   * the extra round trip. The per-run bound is applied by the database, so held
   * people removed afterwards would still have spent it: five hundred held
   * people sorting ahead of everybody else would fill every run for as long as
   * their holds stood, and the posts behind them would outlive their retention
   * window with nothing reporting a fault.
   *
   * `authorPersonId` is a plain column and not a relation, so the holds are read
   * first and passed in rather than joined - the same trade the audit log makes,
   * and the reason a purge can reach these tables at all.
   *
   * The people a granted erasure request names are taken first and are not
   * counted against the bound: they are erased on a flag the service-data purge
   * clears the same night, so one pushed off the end of a bounded run is one no
   * later run would select, and the bound's promise that the next run finds the
   * rest is the one promise that does not hold for them.
   */
  async eligible(now: Date, retentionDays: number): Promise<string[]> {
    const cutoff = feedPurgeCutoff(now, retentionDays);
    const withheld = await withheldPersonIds(this.prisma);

    /*
     * Every one of them, whether or not a post of theirs is left: a place in a
     * group, a read marker, a like or a report is theirs too, and bringing the
     * purge forward is what the board granted. Bounded by the list itself,
     * which is as many people as the board has granted erasure to and not yet
     * had carried out, and `purgePerson` writes nothing for one who has nothing
     * here.
     */
    const requested = await erasureRequestedPersonIds(this.prisma, now);
    const bound = remainingRunBound(requested.length, MAX_PERSONS_PER_RUN);
    const excluded = [...withheld, ...requested];
    // Spelled conditionally rather than as an empty `notIn`, so what the query
    // asks does not depend on how the client renders a list of none.
    const notExcluded =
      excluded.length > 0 ? { authorPersonId: { notIn: excluded } } : {};

    if (bound === 0) {
      return requested;
    }
    const [posts, comments] = await Promise.all([
      this.prisma.post.groupBy({
        by: ["authorPersonId"],
        where: {
          // A resident's post, which always names its author: a database
          // constraint holds that. Not an erased one, which names nobody and
          // goes when the comments under it have.
          byBoard: false,
          erasedAt: null,
          createdAt: { lte: cutoff },
          ...notExcluded,
        },
        orderBy: [{ authorPersonId: "asc" }],
        take: bound,
      }),
      this.prisma.postComment.groupBy({
        by: ["authorPersonId"],
        where: { createdAt: { lte: cutoff }, ...notExcluded },
        orderBy: [{ authorPersonId: "asc" }],
        take: bound,
      }),
    ]);

    /*
     * Each half bounded on its own and then the union cut to the bound again, in
     * the same order, so the first people by identifier are taken whichever
     * table their expiry is in.
     */
    const expired = [
      ...new Set(
        [...posts, ...comments].flatMap((group) =>
          group.authorPersonId === null ? [] : [group.authorPersonId],
        ),
      ),
    ]
      .sort()
      .slice(0, bound);

    return [...requested, ...expired];
  }

  /**
   * Erases one person's expired posts and comments, and answers how many went.
   *
   * The deletion and the entry that records it are one transaction. An audit log
   * claiming a purge that rolled back would be worse than no log: the entry is
   * the only evidence that data which no longer exists ever did, and it is
   * written into a table nobody can correct.
   */
  async purgePerson(
    personId: string,
    now: Date = new Date(),
    retentionDays: number = FEED_RETENTION_DAYS,
  ): Promise<{ posts: number; comments: number }> {
    const cutoff = feedPurgeCutoff(now, retentionDays);
    const nothing = { posts: 0, comments: 0, imageFileIds: [] as string[] };

    const outcome = await this.prisma.$transaction(async (tx) => {
      /*
       * Before the hold is read, so that reading it settles the question.
       * Everything below runs at READ COMMITTED, where a placement committing
       * between the read and the delete would leave this transaction erasing the
       * rows the hold was placed to preserve - and the board member would have
       * been told the person was held. `LegalHoldService.place` takes the same
       * key, which is what makes the two orderable at all.
       */
      await lockLegalHold(tx, personId);
      // And what decides whether a granted erasure may run, for the reason
      // `erasure-lock.ts` gives.
      await lockErasureEligibility(tx, personId);

      const held = await tx.legalHold.findFirst({
        where: { personId, releasedAt: null },
        select: { id: true },
      });
      const person = await tx.person.findUnique({
        where: { id: personId },
        select: { processingRestrictedAt: true },
      });
      if (held !== null || person?.processingRestrictedAt != null) {
        /*
         * Re-checked here rather than trusted from the scan. A hold placed, or a
         * restriction recorded, between the scan and this transaction has to
         * win: whoever asked for it is entitled to assume it took effect, and
         * this is the moment where that is either true or a promise nobody kept.
         * A restriction refuses for the reason art. 18(2) gives - the
         * association may store the data, which makes erasing it the one act
         * the person asked it not to perform.
         */
        return nothing;
      }

      /*
       * A granted erasure request moves this job's cutoff to now, which is the
       * whole of what bringing the purge forward means: the same rows, on the
       * same rule, without waiting out a window the person asked to be freed
       * from. The request is not closed here - the service-data purge runs after
       * this job and closes it, which is why this job still sees it open and a
       * granted erasure reaches the feed on the same night.
       *
       * Only a request nothing refuses. A board seat, a system role or a
       * residency still running would make the closing job refuse the
       * erasure, so this job does not start it either: the person stays on the
       * window, and the request is left open as blocked, with nothing erased.
       */
      const onRequest = await isErasureInForce(tx, personId, now);
      const written = onRequest
        ? feedErasedOnRequest(personId, now)
        : {
            posts: {
              authorPersonId: personId,
              byBoard: false,
              createdAt: { lte: cutoff },
            },
            comments: { authorPersonId: personId, createdAt: { lte: cutoff } },
          };

      /*
       * This person's own comments first, under anybody's post, their own
       * included: a post of theirs whose only answers were their own then goes
       * whole below rather than standing erased for them.
       */
      const { count: commentCount } = await tx.postComment.deleteMany({
        where: written.comments,
      });
      const posts = await tx.post.findMany({
        where: written.posts,
        select: { id: true },
      });
      const {
        erased: postCount,
        kept: commentsUnderPosts,
        imageFileIds,
      } = await this.erasePosts(
        tx,
        posts.map((post) => post.id),
        now,
      );

      // The rest of what the feed holds of theirs, on a request only: on the
      // window a place, a marker, a like and a report go with the group or the
      // post.
      const traces = onRequest
        ? await this.eraseTraces(tx, personId)
        : {
            memberships: 0,
            readMarkers: 0,
            postReads: 0,
            likes: 0,
            reports: 0,
          };

      const erased =
        postCount +
        commentCount +
        traces.memberships +
        traces.readMarkers +
        traces.postReads +
        traces.likes +
        traces.reports;
      if (erased === 0) {
        // The scan filters these out, so reaching here means the last of them
        // went while this ran. An entry for an erasure that erased nothing would
        // be a false record in a table that cannot be corrected.
        return nothing;
      }

      await this.audit.record(
        {
          action: "SERVICE_DATA_PURGED",
          channel: "SYSTEM",
          // No actor: nobody clicked this. The job ran because a date arrived,
          // which is what the retention window promised would happen.
          actorPersonId: null,
          targetPersonId: personId,
          targetKind: "post",
          /*
           * How many, and the window they fell out of. Not which audience, and
           * not a word of what any of them said - the retention rule on
           * AuditLogService. This entry names the person and outlives the rows
           * it describes by design, and the log is exempt from every purge, so
           * text copied in here would be a permanent record of what the house
           * said, inside the entry that says it was erased.
           *
           * The comments other people wrote under this person's posts are
           * counted and not erased: each is its writer's, on its writer's own
           * clock and under its writer's own hold, and the post stands erased
           * above them until the last has gone.
           */
          context: {
            posts: postCount,
            comments: commentCount,
            commentsKeptUnderErasedPosts: commentsUnderPosts,
            images: imageFileIds.length,
            retentionDaysAfterWriting: retentionDays,
            ...(onRequest
              ? {
                  groupMemberships: traces.memberships,
                  readMarkers: traces.readMarkers,
                  postReads: traces.postReads,
                  likes: traces.likes,
                  reports: traces.reports,
                }
              : {}),
          },
        },
        tx,
      );

      return { posts: postCount, comments: commentCount, imageFileIds };
    });

    // After the commit: the posts are erased, and only now may their pictures
    // leave storage.
    await this.removeImages(outcome.imageFileIds);
    return { posts: outcome.posts, comments: outcome.comments };
  }

  /**
   * Erases one person's posts, and answers how many and how many comments by
   * others stand under them.
   *
   * What the author wrote goes, and nothing anybody else wrote does. A post
   * nobody answered is deleted whole, with its likes, read records, reports
   * and history. A post with a comment under it is erased instead: the row
   * stays with no text, no author and nothing that went with them
   * (`Post.erasedAt`), because each comment is its writer's own data, on its own
   * clock (`feed-retention.ts`), and erasing it is a decision about its writer -
   * their legal hold, their restriction, their erasure request - that only
   * their own run of {@link purgePerson} takes, under their own locks. A reply
   * written yesterday under a post from last year is a year from going, and a
   * held neighbour's reply stays as long as the hold does. The row goes in
   * {@link purgeErasedPosts} once nothing stands under it.
   *
   * The update comes first and decides the rest. It locks each post's row, and
   * every path that adds to a post - a comment, a like, a read record, a
   * report - reads the row under a share lock first (`refuseErasedPost`): one
   * that got there before waits out by committing, so what it added is visible
   * to the statements below, and one that arrives after waits for this
   * transaction and then finds the post erased. So the delete of the posts
   * nobody answered cannot meet a comment it did not see, and nothing is added
   * to a post after what hung on it went.
   */
  private async erasePosts(
    tx: Prisma.TransactionClient,
    postIds: readonly string[],
    now: Date,
  ): Promise<{ erased: number; kept: number; imageFileIds: string[] }> {
    if (postIds.length === 0) {
      return { erased: 0, kept: 0, imageFileIds: [] };
    }
    const ids = { in: [...postIds] };

    /*
     * The pictures, read before anything goes so their files can be removed
     * once this commits. The rows go below with the rest of what hung on the
     * text; a post deleted whole would take them by cascade, and one erased
     * keeps its row and must not keep these.
     */
    const images = await tx.postImage.findMany({
      where: { postId: ids },
      select: { fileId: true },
    });

    const { count: erased } = await tx.post.updateMany({
      where: { id: ids },
      data: {
        erasedAt: now,
        authorPersonId: null,
        body: null,
        editedAt: null,
        // The strike was about the text and names the board member who made
        // it, and a pin and an issue link point at the text too.
        struckAt: null,
        struckByPersonId: null,
        pinnedAt: null,
        important: false,
        issueId: null,
      },
    });
    await tx.postRevision.deleteMany({ where: { postId: ids } });
    await tx.postLike.deleteMany({ where: { postId: ids } });
    await tx.postRead.deleteMany({ where: { postId: ids } });
    await tx.postReport.deleteMany({ where: { postId: ids } });
    await tx.postImage.deleteMany({ where: { postId: ids } });
    await tx.post.deleteMany({
      where: { id: ids, comments: { none: {} } },
    });
    const kept = await tx.postComment.count({ where: { postId: ids } });

    return { erased, kept, imageFileIds: images.map((image) => image.fileId) };
  }

  /**
   * Erases a person's places in groups, read markers, read records, likes and
   * reports.
   */
  private async eraseTraces(
    tx: Prisma.TransactionClient,
    personId: string,
  ): Promise<{
    memberships: number;
    readMarkers: number;
    postReads: number;
    likes: number;
    reports: number;
  }> {
    const traces = feedTracesErasedOnRequest(personId);
    const memberships = await tx.groupMember.deleteMany({
      where: traces.memberships,
    });
    const readMarkers = await tx.audienceRead.deleteMany({
      where: traces.readMarkers,
    });
    const postReads = await tx.postRead.deleteMany({
      where: traces.postReads,
    });
    const postLikes = await tx.postLike.deleteMany({
      where: traces.postLikes,
    });
    const commentLikes = await tx.postCommentLike.deleteMany({
      where: traces.commentLikes,
    });
    const reports = await tx.postReport.deleteMany({
      where: traces.reports,
    });
    return {
      memberships: memberships.count,
      readMarkers: readMarkers.count,
      postReads: postReads.count,
      likes: postLikes.count + commentLikes.count,
      reports: reports.count,
    };
  }
}
