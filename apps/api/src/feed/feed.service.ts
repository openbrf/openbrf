import { Injectable, Logger } from "@nestjs/common";
import type {
  AudienceListView,
  AudienceView,
  FeedFrom,
  FeedPage,
  FeedUpdate,
  LikeView,
  NotReadView,
  PostImageView,
  PostReadView,
  PostView,
  RevisionListView,
} from "@openbrf/shared";

import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import type { Prisma } from "../generated/prisma/client";
import type { AudienceKind } from "../generated/prisma/enums";
import { holdsBoardSeat } from "../mail/board-recipients";
import { MediaService, mediaUrl } from "../media/media.service";
import {
  audienceFor,
  audiencePeopleWhere,
  audiencesFor,
  derivedAudience,
  type FeedDbClient,
  livesHere,
  postFor,
  refuseErasedPost,
  shownAt,
} from "./feed-audience";
import { AUTHOR_COLUMNS, authorViewOf, readAuthors } from "./feed-author";
import { newsText, speaksForBoard } from "./feed-board";
import {
  ATTACHABLE_HOURS,
  MAX_IMAGES_PER_POST,
  UPLOADS_PER_DAY,
} from "./feed-image";
import {
  type FeedCursor,
  feedCursor,
  newerThan,
  olderThan,
} from "./feed-cursor";
import { lockAudience, lockFeedOrder, lockFeedPerson } from "./feed-lock";
import { refuseFullHistory, revisionView } from "./feed-revision";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";
import { isModerated, strikesWithoutReport } from "./post-report-access";

/**
 * The longest post this application stores.
 *
 * The same cap a comment carries, and the same reasoning: bounded but generous,
 * so that one write cannot put a megabyte of text in front of the whole house,
 * and long enough that somebody explaining why the roof quote is too high does
 * not have to send it in instalments.
 *
 * Enforced by the controller's schema as the body arrives, and stated here so
 * the rule and the type that carries it are one decision.
 */
export const POST_MAX_LENGTH = 2000;

/**
 * How many posts one person may write in {@link WRITE_WINDOW_MINUTES}.
 *
 * Counted from the rows themselves rather than from an in-memory bucket: every
 * caller here is signed in, so the budget can belong to the account, and a count
 * taken from the table survives a restart and is the same budget in every
 * process.
 *
 * Sixty in ten minutes, the chat's number, because the board's and the groups'
 * conversations became posts and a conversation runs at that pace. Six a minute
 * sustained is faster than anybody discussing a roof quote types and far below
 * what a script would want: it is here to stop one account writing all
 * afternoon, not to pace a discussion.
 *
 * A bound rather than a throttle: the count is taken again under the writer's
 * own lock (`lockFeedPerson`), so requests in flight together cannot all pass it.
 */
export const POSTS_PER_WRITE_WINDOW = 60;

/** The window {@link POSTS_PER_WRITE_WINDOW} is counted over. */
export const WRITE_WINDOW_MINUTES = 10;

/**
 * How many posts one read of the feed answers with.
 *
 * The read has to be bounded, because nothing else bounds it: the feed has no
 * end and a post holds up to {@link POST_MAX_LENGTH} characters, so an unbounded
 * read would hand somebody opening the screen a year of the house in one
 * payload. The same number bounds the poll, so a screen that was closed for a
 * week catches up a page at a time rather than in one response that times out.
 */
export const POSTS_PER_PAGE = 50;

/**
 * The longest search a reader may type. A search is a few words for a post
 * somebody half remembers, and a longer one is not a search.
 */
export const SEARCH_MAX_LENGTH = 100;

/** What narrows a read of the feed. Each one only ever narrows. */
export interface FeedQuery {
  /** One audience, or null for every audience the reader is in. */
  audienceId: string | null;
  /** Words a post's text or its news item's title has to contain, or null. */
  search: string | null;
  /** Posts written as Styrelsen, or by neighbours as themselves, or null. */
  from: FeedFrom | null;
  /** Only posts the board marked important. */
  important: boolean;
}

/** What somebody writes to an audience. */
export interface WritePostInput {
  audienceId: string;
  body: string;
  /**
   * The images to put on it, in their order: files this person uploaded for a
   * post (`uploadImage`) that are on no post yet. None when left out.
   */
  imageIds?: readonly string[];
}

/** An image somebody is uploading for a post they are writing. */
export interface UploadImageInput {
  bytes: Buffer;
  fileName: string;
}

/** The columns a post is read with to be shown, for one reader. */
function postColumns(readerId: string) {
  return {
    id: true,
    authorPersonId: true,
    byBoard: true,
    namesAuthor: true,
    body: true,
    important: true,
    pinnedAt: true,
    commentsAllowed: true,
    scheduledAt: true,
    createdAt: true,
    editedAt: true,
    struckAt: true,
    erasedAt: true,
    issueId: true,
    issue: { select: { id: true, status: true, reporterPersonId: true } },
    audience: { select: { id: true, kind: true, name: true } },
    news: { select: { id: true, slug: true, title: true, content: true } },
    _count: { select: { likes: true, comments: true, reads: true } },
    // This reader's own like and nobody else's: the screen shows a count.
    likes: { where: { personId: readerId }, select: { personId: true } },
    images: {
      orderBy: [{ sortOrder: "asc" }],
      select: {
        file: { select: { id: true, width: true, height: true } },
      },
    },
  } satisfies Prisma.PostSelect;
}

type PostRow = Prisma.PostGetPayload<{
  select: ReturnType<typeof postColumns>;
}>;

/**
 * The feed (flödet): what is posted to each audience, and who reads it.
 *
 * Five rules live here and nowhere else.
 *
 * **The audience decides; the capability opens the endpoint.** The global guard
 * requires `chat:participate` on every route, and this service then answers
 * which audiences there are for the caller - `feed-audience.ts`, the one check
 * every path asks. The administrator holds every capability, no seat and no
 * residency, so they reach every route here and find no audience.
 *
 * **One refusal for two cases.** A post, or an audience, that does not exist and
 * one this person may not read are the same answer. Distinguishing them would
 * let anybody holding the capability walk the identifier space, and it is what
 * keeps a group and its posts invisible to somebody outside it (ADR 0012). The
 * list, the search and the filters run inside the reader's own audiences and
 * never outside them, and a search never matches text withheld from the reader.
 *
 * **Nothing is ever erased except by the retention clock.** No delete, by the
 * author or by anybody else - what somebody wrote is a record of what was said.
 * One thing can happen to a post afterwards, in a group: the board strikes it
 * through after somebody in the group reported it, which withholds the text from
 * the others and erases nothing. Striking is `post-report.service.ts`; this
 * service only decides who is shown the text afterwards.
 *
 * **A personal identity number is refused.** Every post is scanned on the way in
 * and a hit refuses the write, naming the offset and never the value.
 *
 * **A post write is not audited** (ADR 0010). A post is on its author's access
 * report in full, carrying its audience and its instant, so an entry would
 * restate what the row already says, in a table nothing may ever tidy.
 *
 * ## No optimistic anything
 *
 * A post arrives on a screen because a read brought it, never because the
 * screen put it there. That is what makes the poll the one delivery path rather
 * than a second opinion about one.
 */
@Injectable()
export class FeedService {
  private readonly logger = new Logger(FeedService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  /**
   * Every audience this person is in, with what is new in each.
   *
   * Empty for somebody who neither lives here nor holds a seat, which is the
   * whole answer rather than a refusal. It also carries whether they may make a
   * group, because a screen with nothing on it has to know which of the two
   * empty cases it is showing.
   */
  async audiences(reader: Principal): Promise<AudienceListView> {
    // Taken once, so a single request cannot see two boards and a residency
    // cannot end halfway through one answer.
    const now = new Date();
    const audiences = await audiencesFor(this.prisma, reader.personId, now);

    return {
      audiences: await Promise.all(
        audiences.map((audience) =>
          this.audienceView(audience, reader.personId, now),
        ),
      ),
      mayCreateGroup: await livesHere(this.prisma, reader.personId, now),
      mayPostAsBoard: await speaksForBoard(this.prisma, reader, now),
    };
  }

  /**
   * One page of the feed, newest first, and the pinned posts on the first.
   *
   * ## Which page, when nobody asks for one
   *
   * The newest, and then backwards. Somebody opening the feed wants what was
   * written today, and their own post lands at the top the moment they write it.
   *
   * ## Why a cursor and not a page number
   *
   * The feed is written into while it is being read, and an offset shifts by one
   * for every post somebody adds - so page two by offset would repeat what page
   * one had shown, or step over it, depending on how busy the house was. A
   * cursor names a place rather than a distance from an end.
   */
  async page(
    reader: Principal,
    query: FeedQuery,
    before: FeedCursor | null = null,
  ): Promise<FeedPage> {
    const now = new Date();
    const audienceIds = await this.audienceIdsOf(reader, query, now);
    const scope = await this.scope(reader, query, audienceIds, now);

    /*
     * One more row than the page holds, which is how "there is a page before
     * this one" is answered. A separate count would be a second statement about
     * a second moment, and could say there was more when the extra post had
     * been purged between the two - a page offered and then answered empty.
     */
    const rows = await this.prisma.post.findMany({
      where: {
        AND: [
          scope,
          { pinnedAt: null },
          ...(before === null ? [] : [olderThan(before)]),
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: POSTS_PER_PAGE + 1,
      select: postColumns(reader.personId),
    });
    const page = rows.slice(0, POSTS_PER_PAGE);
    const oldest = page.at(-1);

    /*
     * The pinned posts sit on top of the feed rather than at a place in it, so
     * they are read once, with the first page, and never paged.
     */
    const pinned =
      before === null
        ? await this.prisma.post.findMany({
            where: { AND: [scope, { pinnedAt: { not: null } }] },
            orderBy: [{ pinnedAt: "desc" }, { id: "desc" }],
            take: POSTS_PER_PAGE,
            select: postColumns(reader.personId),
          })
        : [];

    const scheduled =
      before === null && (await this.showsScheduled(reader, query, now))
        ? await this.prisma.post.findMany({
            where: {
              AND: [
                { audienceId: { in: audienceIds } },
                waitingForInstant(now),
              ],
            },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: POSTS_PER_PAGE,
            select: postColumns(reader.personId),
          })
        : [];

    /*
     * Where the poll starts: the newest post on the screen, pinned or not, so
     * the poll delivers exactly what was written after the screen was drawn.
     * Null on a page read from a cursor, whose reader already holds a newer one.
     */
    const newest = [...pinned, ...page.slice(0, 1)].reduce<PostRow | null>(
      (latest, row) =>
        latest === null || compareOrder(row, latest) > 0 ? row : latest,
      null,
    );

    return {
      pinned: await this.toViews(pinned, reader, now),
      scheduled: await this.toViews(scheduled, reader, now),
      posts: await this.toViews(page, reader, now),
      // The oldest post kept rather than the extra row read, so the next page
      // starts exactly where this one stopped.
      earlier:
        oldest !== undefined && rows.length > page.length
          ? feedCursor(oldest)
          : null,
      latest: before === null && newest !== null ? feedCursor(newest) : null,
    };
  }

  /**
   * What has been posted since a cursor, oldest first.
   *
   * The mirror of {@link page}, and the only delivery path there is (ADR 0010).
   * Bounded for the reason the page is, so catching up after a week is several
   * reads and each one is small. Pinned or not, a post written since is
   * delivered: the screen decides where to put it.
   *
   * A feed that has nothing in it has no cursor to poll from, and the screen
   * re-reads its first page until it has one - ADR 0010's empty room.
   */
  async since(
    reader: Principal,
    query: FeedQuery,
    after: FeedCursor,
  ): Promise<FeedUpdate> {
    const now = new Date();
    const scope = await this.scope(
      reader,
      query,
      await this.audienceIdsOf(reader, query, now),
      now,
    );

    const rows = await this.prisma.post.findMany({
      where: { AND: [scope, newerThan(after)] },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: POSTS_PER_PAGE + 1,
      select: postColumns(reader.personId),
    });
    const page = rows.slice(0, POSTS_PER_PAGE);
    const newest = page.at(-1);

    return {
      posts: await this.toViews(page, reader, now),
      // The cursor handed in comes back when nothing arrived, so a screen
      // polling an idle feed keeps its place.
      cursor: newest === undefined ? feedCursor(after) : feedCursor(newest),
      more: rows.length > page.length,
    };
  }

  /**
   * One post, which is what a post's own address opens.
   *
   * Refused exactly as a post that does not exist when it is in an audience the
   * reader is not in - which is what keeps a group's post unreachable by its
   * identifier from outside the group.
   */
  async post(reader: Principal, postId: string): Promise<PostView> {
    const now = new Date();
    await this.requirePost(reader, postId, now);
    return this.viewOf(reader, postId, now);
  }

  /**
   * Writes a post to an audience.
   *
   * The three refusals in order: an audience this person is not in, a person who
   * has written too many, and text carrying a personal identity number. The first
   * is first because it is the cheapest and the least revealing - a caller learns
   * only what they would learn by asking to read the audience.
   *
   * A transaction, and what it is for is the sweep and the order rather than the
   * insert. The nightly purge erases a group that has held nothing for a year,
   * deciding it from a read of the posts, and a post committed between that read
   * and the delete would go with the group through the cascade - so both sides
   * take `lockAudience`, and the loser finds the other's work done. And the post
   * is stamped under `lockFeedOrder`, later than every post already in the feed,
   * so a poll is never handed one stamped behind a post it has already seen.
   */
  async write(reader: Principal, input: WritePostInput): Promise<PostView> {
    const now = new Date();
    const audience = await audienceFor(
      this.prisma,
      input.audienceId,
      reader.personId,
      now,
    );
    if (audience === null) {
      throw new FeedError("There is no such audience.", "audience-not-found");
    }
    const imageIds = input.imageIds ?? [];
    if (imageIds.length > MAX_IMAGES_PER_POST) {
      throw new FeedError(
        "A post carries no more images than the feed allows.",
        "too-many-images",
      );
    }
    await refuseTooManyPosts(this.prisma, reader.personId);
    refusePersonalIdentityNumbers(input.body);

    const row = await this.prisma.$transaction(async (tx) => {
      // Counted again under the writer's own lock, which is what makes the
      // allowance a bound: parallel requests can all pass the count above.
      await lockFeedPerson(tx, reader.personId);
      await refuseTooManyPosts(tx, reader.personId);
      /*
       * Under the same lock, so two posts written at once cannot both take one
       * upload: the second reads the first's image row and is refused. The
       * unique file on `post_image` is the backstop.
       */
      await refuseImagesNotAttachable(tx, reader.personId, imageIds, now);
      await lockAudience(tx, audience.id);

      /*
       * Read again under the lock. Membership was decided before it, and the
       * sweep can have erased the group in between - in which case the insert
       * would fail on the foreign key with a fault rather than an answer. A
       * group that has gone is refused exactly as one that never existed.
       */
      const still = await tx.audience.findUnique({
        where: { id: audience.id },
        select: { id: true },
      });
      if (still === null) {
        throw new FeedError("There is no such audience.", "audience-not-found");
      }

      const created = await tx.post.create({
        data: {
          audienceId: audience.id,
          authorPersonId: reader.personId,
          body: input.body,
          createdAt: await stampAfterNewest(tx),
        },
        select: { id: true },
      });
      if (imageIds.length > 0) {
        await tx.postImage.createMany({
          data: imageIds.map((fileId, sortOrder) => ({
            postId: created.id,
            fileId,
            sortOrder,
          })),
        });
      }
      return created;
    });

    // The audience and nothing that was said in it - ADR 0007 keeps the
    // identifier and the log keeps no prose.
    this.logger.log(`A post was written to audience ${audience.id}`);

    return this.viewOf(reader, row.id, new Date());
  }

  /**
   * Stores an image for a post this person is about to write, and answers with
   * what the post is written with.
   *
   * Uploaded on its own rather than with the post, one file per request, because
   * that is what every upload path here takes: the parser holds a file in memory
   * whole, and the ceiling on that is set for one (`config/env.ts`). The post
   * then names its images by identifier, and only uploads of this person's that
   * are on no post yet can be named.
   *
   * Held POST, so whoever may read the post it ends up on reads it and nobody
   * else does - until then, nobody at all: the composer shows the writer the
   * copy they picked. Declared as showing identifiable persons without asking,
   * which is the safe direction and the issue photograph's reasoning: nobody
   * knows whether a picture of the laundry room caught a neighbour, and a post
   * is never published.
   *
   * Refused to somebody in no audience - the administrator - on the answer every
   * other path here gives them, before a byte is stored. Bounded by
   * {@link UPLOADS_PER_DAY}, counted before the bytes go to storage: an upload
   * cannot be counted under the writer's lock, because the file is stored before
   * any transaction could hold one, so the bound is on what one account can put
   * on the disk rather than an exact count. An upload never used is swept two
   * days later (`FeedPurgeService`).
   */
  async uploadImage(
    reader: Principal,
    input: UploadImageInput,
  ): Promise<PostImageView> {
    const now = new Date();
    const audiences = await audiencesFor(this.prisma, reader.personId, now);
    if (audiences.length === 0) {
      throw new FeedError("There is no such audience.", "audience-not-found");
    }

    const uploaded = await this.prisma.mediaFile.count({
      where: {
        visibility: "POST",
        uploadedByPersonId: reader.personId,
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
    });
    if (uploaded >= UPLOADS_PER_DAY) {
      throw new FeedError(
        "Too many images uploaded in too short a time. Try again tomorrow.",
        "too-many-uploads",
      );
    }

    const file = await this.media.upload({
      bytes: input.bytes,
      fileName: input.fileName,
      visibility: "POST",
      showsIdentifiablePersons: true,
      uploadedByPersonId: reader.personId,
      channel: "WEB",
      // The writer's own words about a picture that goes with the post; the
      // log outlives it and no purge reaches the log.
      recordFileName: false,
    });

    return {
      id: file.id,
      url: file.url,
      width: file.width,
      height: file.height,
    };
  }

  /**
   * Records how far this person has read an audience.
   *
   * Never backwards. Two tabs open on one audience would otherwise un-read each
   * other, and a marker that moved back would announce posts the person had
   * already read. The insert and the comparison are one statement, so two tabs
   * racing each other settle rather than overwrite.
   *
   * Written in SQL because Prisma's upsert has no conditional update - its
   * `update` clause runs whatever the stored row holds, which is exactly the
   * backwards move this refuses.
   *
   * Capped at this server's own clock. The instant arrives from the caller, and a
   * single call carrying one far in the future would set a marker no later call
   * could lower: from then on every post counts as read for that person,
   * including ones written afterwards. A marker can only ever say that somebody
   * has read as far as something that already exists.
   *
   * @param readAt The instant to mark, which is the newest post the screen has
   *   actually shown rather than the moment of the request.
   */
  async markAudienceRead(
    reader: Principal,
    audienceId: string,
    readAt: Date,
  ): Promise<{ readAt: string }> {
    // Taken once, so the cap and the value written cannot come from two moments.
    const now = new Date();
    const audience = await audienceFor(
      this.prisma,
      audienceId,
      reader.personId,
      now,
    );
    if (audience === null) {
      throw new FeedError("There is no such audience.", "audience-not-found");
    }

    const marked = readAt.getTime() > now.getTime() ? now : readAt;

    await this.prisma.$executeRaw`
      INSERT INTO "audience_read" ("audienceId", "personId", "readAt")
      VALUES (${audience.id}, ${reader.personId}, ${marked})
      ON CONFLICT ("audienceId", "personId")
      DO UPDATE SET "readAt" = GREATEST("audience_read"."readAt", EXCLUDED."readAt")
    `;

    const marker = await this.prisma.audienceRead.findUnique({
      where: {
        audienceId_personId: {
          audienceId: audience.id,
          personId: reader.personId,
        },
      },
      select: { readAt: true },
    });

    /*
     * Read back rather than echoed, so a screen whose instant lost the
     * comparison is told the marker that actually stands. The row cannot be
     * absent: the statement above either inserted it or found it.
     */
    return { readAt: (marker?.readAt ?? marked).toISOString() };
  }

  /**
   * Records that this person opened a post, and answers how many have.
   *
   * The read record ADR 0026 states the purpose of: the count every reader sees,
   * and on an important post the board's list of who has not opened it. Written
   * once - opening a post twice is having read it once, so the first instant
   * stands - and never for the post's own author, who wrote it rather than read
   * it.
   *
   * Nor on an erased post, which is not refused - a screen opening one is
   * showing the comments under it - and records nothing: the read records went
   * with the text, and a new one would be a fact about a post that says nothing.
   * The insert reads the post under a share lock in the same statement, so it
   * waits for an erasure in flight and then finds the post erased, for the
   * reason `refuseErasedPost` gives.
   */
  async markPostRead(reader: Principal, postId: string): Promise<PostReadView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);

    if (post.erasedAt === null && post.authorPersonId !== reader.personId) {
      await this.prisma.$executeRaw`
        INSERT INTO "post_read" ("postId", "personId", "readAt")
        SELECT "id", ${reader.personId}, ${now} FROM "post"
        WHERE "id" = ${post.id} AND "erasedAt" IS NULL
        FOR SHARE
        ON CONFLICT ("postId", "personId") DO NOTHING
      `;
    }

    return {
      readBy: await this.prisma.postRead.count({ where: { postId: post.id } }),
    };
  }

  /**
   * Likes a post, or takes the like back.
   *
   * Idempotent both ways: liking twice is liking once, and the pair is the row's
   * identifier. Who liked what is personal data and is on the access report; the
   * screen shows a count.
   *
   * An erased post is refused a like: there is nothing left on it to like. Taking
   * one back is never refused, and finds none there.
   */
  async like(
    reader: Principal,
    postId: string,
    liked: boolean,
  ): Promise<LikeView> {
    const post = await this.requirePost(reader, postId, new Date());

    if (liked) {
      if (post.erasedAt !== null) {
        throw new FeedError("This post has been erased.", "post-erased");
      }
      await this.prisma.$transaction(async (tx) => {
        await refuseErasedPost(tx, post.id);
        await tx.$executeRaw`
          INSERT INTO "post_like" ("postId", "personId", "createdAt")
          VALUES (${post.id}, ${reader.personId}, ${new Date()})
          ON CONFLICT ("postId", "personId") DO NOTHING
        `;
      });
    } else {
      await this.prisma.postLike.deleteMany({
        where: { postId: post.id, personId: reader.personId },
      });
    }

    return {
      liked,
      likes: await this.prisma.postLike.count({ where: { postId: post.id } }),
    };
  }

  /**
   * Edits a post its author wrote as themselves, keeping what it said before.
   *
   * The text that stood goes into the post's history (`PostRevision`) with the
   * instant it was written and the instant it was replaced, and the post then
   * says it was edited. That is how editing keeps the reason "written once and
   * never edited" had (ADR 0026): what somebody wrote stays a record of what was
   * said, because the record is the history rather than the latest text. The
   * author and the board read it; the house reads what stands, and that it was
   * edited.
   *
   * Refused in order: a post this person may not read, exactly as one that does
   * not exist; text carrying a personal identity number; and then, read again
   * under the row's lock, a post that is not theirs to edit - somebody else's,
   * one written as Styrelsen, one the board struck - one the purge has erased,
   * and one whose history is full. The lock is the row's own, so an edit waits
   * for a strike or an erasure in flight and reads what it left, and two edits
   * of one post each keep the text the other replaced.
   *
   * Text that is what the post already says changes nothing and records
   * nothing. Not audited, as a post write is not (ADR 0010): the history is on
   * its author's access report in full.
   */
  async edit(
    reader: Principal,
    postId: string,
    body: string,
  ): Promise<PostView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);
    refusePersonalIdentityNumbers(body);

    await this.prisma.$transaction(async (tx) => {
      const [row] = await tx.$queryRaw<
        {
          authorPersonId: string | null;
          byBoard: boolean;
          body: string | null;
          createdAt: Date;
          editedAt: Date | null;
          struckAt: Date | null;
          erasedAt: Date | null;
        }[]
      >`SELECT "authorPersonId", "byBoard", "body", "createdAt", "editedAt", "struckAt", "erasedAt" FROM "post" WHERE "id" = ${post.id} FOR UPDATE`;
      if (row === undefined) {
        throw new FeedError("There is no such post.", "post-not-found");
      }
      if (row.erasedAt !== null) {
        throw new FeedError("This post has been erased.", "post-erased");
      }
      if (!editable(row, reader.personId) || row.body === null) {
        throw new FeedError(
          "Only its author edits a post, and not one the board struck.",
          "not-editable",
        );
      }
      if (row.body === body) {
        return;
      }
      refuseFullHistory(
        await tx.postRevision.count({ where: { postId: post.id } }),
      );

      const edited = new Date();
      await tx.postRevision.create({
        data: {
          postId: post.id,
          body: row.body,
          writtenAt: row.editedAt ?? row.createdAt,
          replacedAt: edited,
        },
      });
      await tx.post.update({
        where: { id: post.id },
        data: { body, editedAt: edited },
      });
    });

    // The post and nothing that was said in it, as for a write.
    this.logger.log(`Post ${post.id} was edited`);

    return this.viewOf(reader, post.id, new Date());
  }

  /**
   * A post's earlier versions, the most recently replaced first.
   *
   * For its author and the board, and for nobody else (ADR 0026): somebody who
   * may read the post is told the history is not theirs, which tells them
   * nothing the "edited" on the card has not; somebody who may not read the post
   * is refused exactly as for a post that does not exist.
   */
  async history(reader: Principal, postId: string): Promise<RevisionListView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);
    if (post.erasedAt !== null) {
      throw new FeedError("This post has been erased.", "post-erased");
    }
    if (
      post.authorPersonId !== reader.personId &&
      !(await this.moderates(reader, now))
    ) {
      throw new FeedError(
        "The earlier versions of a post are its author's and the board's.",
        "history-withheld",
      );
    }

    const revisions = await this.prisma.postRevision.findMany({
      where: { postId: post.id },
      orderBy: [{ replacedAt: "desc" }, { id: "desc" }],
      select: { body: true, writtenAt: true, replacedAt: true },
    });
    return { revisions: revisions.map(revisionView) };
  }

  /**
   * Who in an important post's audience has not opened it yet: the board's
   * must-read list.
   *
   * One of the two purposes ADR 0026 states for the read records, and the only
   * place their names reach anybody. A notice about the water being shut off can
   * be followed up with the households it has not reached, so the board - and
   * only the board, `chat:moderate` and a seat - is told who; everybody else
   * has the count on the card. Only on a post the board marked important: on an
   * ordinary post the names behind "Läst av" are nobody's business, and asking
   * for them is refused rather than answered empty. Only in an audience the
   * board member may read, which is what `postFor` asks first, so a group's post
   * is refused to a board outside the group exactly as one that does not exist.
   *
   * Who is in the audience is asked of the register today, as every membership
   * is: somebody who moved in yesterday has not read last week's notice either.
   * The post's author wrote it rather than read it, and is not listed.
   */
  async notRead(reader: Principal, postId: string): Promise<NotReadView> {
    const now = new Date();
    const post = await this.requirePost(reader, postId, now);
    if (post.erasedAt !== null) {
      throw new FeedError("This post has been erased.", "post-erased");
    }
    if (!(await this.moderates(reader, now))) {
      throw new FeedError(
        "Only the board sees who has not opened a post.",
        "not-board",
      );
    }
    const row = await this.prisma.post.findUnique({
      where: { id: post.id },
      select: { important: true },
    });
    if (row === null || !row.important) {
      throw new FeedError(
        "Only a post marked important lists who has not opened it.",
        "not-important",
      );
    }

    const readers = await this.prisma.postRead.findMany({
      where: { postId: post.id },
      select: { personId: true },
    });
    const opened = [
      ...readers.map((each) => each.personId),
      ...(post.authorPersonId === null ? [] : [post.authorPersonId]),
    ];
    const people = await this.prisma.person.findMany({
      where: {
        AND: [
          await audiencePeopleWhere(this.prisma, post.audience, now),
          { id: { notIn: opened } },
        ],
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }, { id: "asc" }],
      select: AUTHOR_COLUMNS,
    });

    return { people: people.map((person) => authorViewOf(person.id, person)) };
  }

  /**
   * The audiences a read reaches: every one the reader is in, or the one they
   * asked for when they are in it. Refused as an audience that does not exist
   * otherwise.
   */
  private async audienceIdsOf(
    reader: Principal,
    query: FeedQuery,
    now: Date,
  ): Promise<string[]> {
    if (query.audienceId === null) {
      return (await audiencesFor(this.prisma, reader.personId, now)).map(
        (audience) => audience.id,
      );
    }
    const audience = await audienceFor(
      this.prisma,
      query.audienceId,
      reader.personId,
      now,
    );
    if (audience === null) {
      throw new FeedError("There is no such audience.", "audience-not-found");
    }
    return [audience.id];
  }

  /**
   * Which posts a read reaches: the reader's audiences, narrowed by the query.
   *
   * Every condition is a narrowing of the first one, so nothing a reader asks
   * for can reach a post outside an audience they are in.
   */
  private async scope(
    reader: Principal,
    query: FeedQuery,
    audienceIds: readonly string[],
    now: Date,
  ): Promise<Prisma.PostWhereInput> {
    return {
      AND: [
        { audienceId: { in: [...audienceIds] } },
        shownAt(now),
        ...(query.from === null ? [] : [{ byBoard: query.from === "board" }]),
        ...(query.important ? [{ important: true }] : []),
        ...(query.search === null
          ? []
          : [await this.searchWhere(reader, query.search, now)]),
      ],
    };
  }

  /**
   * Whether a first page carries the board's scheduled posts, in the audiences
   * it reads.
   *
   * Only for somebody who may write as Styrelsen - a scheduled post is the
   * board's until its instant, and in nobody else's feed - and only on a read
   * narrowed by nothing but its audience: a search or a filter asks for posts
   * that are there, and a scheduled one is not there yet.
   */
  private async showsScheduled(
    reader: Principal,
    query: FeedQuery,
    now: Date,
  ): Promise<boolean> {
    if (query.search !== null || query.from !== null || query.important) {
      return false;
    }
    return speaksForBoard(this.prisma, reader, now);
  }

  /**
   * What a search matches: a post's own text, or its news item's title.
   *
   * Never text the reader may not read. A struck post's text is withheld from
   * everybody but its author and the board, and a search that matched it would
   * tell the others the words were there, one guess at a time - so for them a
   * struck post is matched by nothing it said.
   */
  private async searchWhere(
    reader: Principal,
    search: string,
    now: Date,
  ): Promise<Prisma.PostWhereInput> {
    const matches = { contains: search, mode: "insensitive" } as const;
    const ownText = (await this.moderates(reader, now))
      ? { body: matches }
      : {
          body: matches,
          OR: [{ struckAt: null }, { authorPersonId: reader.personId }],
        };
    return { OR: [ownText, { news: { title: matches } }] };
  }

  /** One audience with what is new in it and the instant it was last posted to. */
  private async audienceView(
    audience: { id: string; kind: AudienceView["kind"]; name: string | null },
    personId: string,
    now: Date,
  ): Promise<AudienceView> {
    const marker = await this.prisma.audienceRead.findUnique({
      where: { audienceId_personId: { audienceId: audience.id, personId } },
      select: { readAt: true },
    });
    const shown = { audienceId: audience.id, ...shownAt(now) };
    const newest = await this.prisma.post.findFirst({
      where: shown,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { createdAt: true },
    });
    const unread = await this.prisma.post.count({
      where: {
        AND: [
          shown,
          /*
           * Somebody who has just written a post does not have an unread one.
           * Spelled with the null case, because a board post may name nobody
           * and "not this person" in SQL is never true of a null.
           */
          {
            OR: [
              { authorPersonId: null },
              { authorPersonId: { not: personId } },
            ],
          },
          // Nor one the purge has erased, which has nothing left to read.
          { erasedAt: null },
          ...(marker === null ? [] : [{ createdAt: { gt: marker.readAt } }]),
        ],
      },
    });

    return {
      id: audience.id,
      kind: audience.kind,
      name: audience.name,
      unread,
      lastPostAt: newest?.createdAt.toISOString() ?? null,
      readAt: marker?.readAt.toISOString() ?? null,
    };
  }

  /** The post this person may read, or the one refusal. */
  private async requirePost(
    reader: Principal,
    postId: string,
    now: Date,
  ): Promise<NonNullable<Awaited<ReturnType<typeof postFor>>>> {
    const post = await postFor(this.prisma, postId, reader.personId, now);
    if (post === null) {
      throw new FeedError("There is no such post.", "post-not-found");
    }
    return post;
  }

  /**
   * One post as this reader is shown it, once it is known they may read it.
   *
   * Public for the board's tools, which answer a post written as Styrelsen -
   * one scheduled for later included, which no read would reach yet - with the
   * post as its writer is shown it. Every caller has decided the reader may see
   * it before asking.
   */
  async viewOf(
    reader: Principal,
    postId: string,
    now: Date,
  ): Promise<PostView> {
    const row = await this.prisma.post.findUnique({
      where: { id: postId },
      select: postColumns(reader.personId),
    });
    const [view] = row === null ? [] : await this.toViews([row], reader, now);
    if (view === undefined) {
      throw new FeedError("There is no such post.", "post-not-found");
    }
    return view;
  }

  /**
   * Whether this reader moderates: `chat:moderate` and a board seat, asked of
   * the register as the report queue asks it (ADR 0012). An administrator holds
   * every capability and is not the board.
   */
  private async moderates(reader: Principal, now: Date): Promise<boolean> {
    return (
      reader.capabilities.has("chat:moderate") &&
      holdsBoardSeat(this.prisma, reader.personId, now)
    );
  }

  /** Every view in a page, with the authors resolved in one read. */
  private async toViews(
    rows: readonly PostRow[],
    reader: Principal,
    now: Date,
  ): Promise<PostView[]> {
    const attribute = await readAuthors(
      this.prisma,
      rows.map((row) => (namesItsAuthor(row) ? row.authorPersonId : null)),
    );

    /*
     * Whether the reader holds a board seat, asked of the register at most once
     * per page and only when a row's answer turns on it: whether the board's
     * moderation opens a struck post, its history or its must-read list, and
     * whether the reader may make an issue report from a post they did not
     * write.
     */
    let seat: Promise<boolean> | null = null;
    const holdsSeat = (): Promise<boolean> =>
      (seat ??= holdsBoardSeat(this.prisma, reader.personId, now));

    /*
     * The board's moderation capability opens a struck post's text, and so does
     * having written it. Nothing else does: a strike answers somebody who asked
     * the board to look at what was said about them, or the board's own reading
     * of Alla, and leaving the text in front of the audience afterwards would
     * answer nothing. The same answer opens an edited post's earlier versions
     * and an important post's list of who has not opened it, and strikes a
     * resident's post in Alla through (ADR 0026).
     */
    const moderates =
      reader.capabilities.has("chat:moderate") &&
      rows.some(
        (row) =>
          (row.struckAt !== null && row.authorPersonId !== reader.personId) ||
          (row.erasedAt === null &&
            (row.important ||
              strikeable(row) ||
              (row.editedAt !== null &&
                row.authorPersonId !== reader.personId))),
      ) &&
      (await holdsSeat());

    /*
     * An issue report is made by the post's writer or by the board, and only by
     * somebody who may report issues at all: the issue module's own capability
     * decides whether its form is theirs.
     */
    const reportsIssues =
      reader.capabilities.has("issues:report") &&
      rows.some(
        (row) =>
          row.erasedAt === null &&
          row.issueId === null &&
          row.authorPersonId !== reader.personId,
      )
        ? await holdsSeat()
        : false;

    /*
     * A report's status is shown to whoever may read the report - the person who
     * made it, and whoever handles issues - and to nobody else. A post does not
     * widen who reads an issue: the neighbours see the post, not the queue.
     */
    const handlesIssues = reader.capabilities.has("issues:handle");

    return rows.map((row) => {
      const withheld =
        row.struckAt !== null &&
        !moderates &&
        row.authorPersonId !== reader.personId;
      return {
        id: row.id,
        audience: row.audience,
        author:
          namesItsAuthor(row) && row.authorPersonId !== null
            ? attribute(row.authorPersonId)
            : null,
        byBoard: row.byBoard,
        body: withheld ? null : row.body,
        /*
         * Withheld with the text, because a picture is part of what was said,
         * and none on an erased post, whose images went with its text. The
         * media route asks the same two questions of every request for a file
         * (`feed-image.ts`), so leaving one out here is not what keeps it from
         * a reader - it keeps the card from showing a picture that would not
         * load.
         */
        images:
          withheld || row.erasedAt !== null
            ? []
            : row.images.map(({ file }) => ({
                id: file.id,
                url: mediaUrl(file.id),
                width: file.width,
                height: file.height,
              })),
        news:
          row.news === null
            ? null
            : {
                id: row.news.id,
                slug: row.news.slug,
                title: row.news.title,
                text: newsText(row.news.content),
              },
        important: row.important,
        pinned: row.pinnedAt !== null,
        // An erased post takes no comment, whatever the column said of it.
        commentsAllowed: row.commentsAllowed && row.erasedAt === null,
        scheduledAt: row.scheduledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
        editedAt: row.editedAt?.toISOString() ?? null,
        struckAt: row.struckAt?.toISOString() ?? null,
        erasedAt: row.erasedAt?.toISOString() ?? null,
        likes: row._count.likes,
        liked: row.likes.length > 0,
        comments: row._count.comments,
        readBy: row._count.reads,
        issue:
          row.issue !== null &&
          (handlesIssues || row.issue.reporterPersonId === reader.personId)
            ? { id: row.issue.id, status: row.issue.status }
            : null,
        mayReportIssue:
          row.erasedAt === null &&
          row.issueId === null &&
          reader.capabilities.has("issues:report") &&
          (row.authorPersonId === reader.personId || reportsIssues),
        mayEdit: editable(row, reader.personId),
        mayReadHistory:
          row.editedAt !== null &&
          row.erasedAt === null &&
          (row.authorPersonId === reader.personId || moderates),
        mayListNotRead: row.important && row.erasedAt === null && moderates,
        ...moderation(row, reader.personId, moderates),
      };
    });
  }
}

/**
 * Whether the board strikes this post through without a report: a resident's
 * post in Alla, standing (`post-report-access.ts`). A post written as
 * Styrelsen is a news item, taken down on the news screen.
 */
function strikeable(row: {
  audience: { kind: AudienceKind };
  byBoard: boolean;
  struckAt: Date | null;
  erasedAt: Date | null;
}): boolean {
  return (
    strikesWithoutReport(row.audience.kind) &&
    !row.byBoard &&
    row.struckAt === null &&
    row.erasedAt === null
  );
}

/**
 * Whether this reader may report a post to the board, and whether they may
 * strike it through themselves: never both, because the board in Alla strikes
 * rather than reporting to itself.
 *
 * A report is of a resident's post in Alla or a group that somebody else
 * wrote, and that is neither struck - which has been answered - nor erased,
 * which has nothing left on it to report.
 */
function moderation(
  row: {
    audience: { kind: AudienceKind };
    authorPersonId: string | null;
    byBoard: boolean;
    struckAt: Date | null;
    erasedAt: Date | null;
  },
  readerId: string,
  moderates: boolean,
): { mayReport: boolean; mayStrike: boolean } {
  const mayStrike = moderates && strikeable(row);
  return {
    mayReport:
      !mayStrike &&
      isModerated(row.audience.kind) &&
      !row.byBoard &&
      row.struckAt === null &&
      row.erasedAt === null &&
      row.authorPersonId !== readerId,
    mayStrike,
  };
}

/**
 * Whether this person may edit a post: they wrote it as themselves, and it is
 * neither struck nor erased.
 *
 * Not one written as Styrelsen, whose text is its news item's and is edited as
 * one. Not a struck one: the board withheld what it said from the audience, and
 * an edit would put new words in front of the audience under a strike made
 * about the old ones.
 */
function editable(
  row: {
    authorPersonId: string | null;
    byBoard: boolean;
    struckAt: Date | null;
    erasedAt: Date | null;
  },
  personId: string,
): boolean {
  return (
    !row.byBoard &&
    row.authorPersonId === personId &&
    row.struckAt === null &&
    row.erasedAt === null
  );
}

/**
 * Whether a post says who wrote it: always for a resident's own, and for a
 * board post only when its writer chose "via" their name.
 */
function namesItsAuthor(row: { byBoard: boolean; namesAuthor: boolean }) {
  return !row.byBoard || row.namesAuthor;
}

/** The order of two posts in the feed: by instant, and by identifier on a tie. */
function compareOrder(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
): number {
  const byInstant = a.createdAt.getTime() - b.createdAt.getTime();
  if (byInstant !== 0) {
    return byInstant;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The instant a post is stamped with: now, or a millisecond after the newest
 * post in the feed if the clock has not moved past it.
 *
 * Under `lockFeedOrder`, so the order the instants say is the order the posts
 * were committed in, across every audience - see that lock for why the poll
 * needs it. A scheduled post whose instant has not come is left out of the
 * comparison: its instant is the one it was asked to appear at, and a post
 * written now belongs before it. One whose instant has come is in it like any
 * other, so nothing is stamped behind a post a reader may already hold.
 *
 * Exported for the news module, which puts a news item into the feed when it is
 * published and has to stamp it on the same rule.
 */
export async function stampAfterNewest(
  tx: Prisma.TransactionClient,
): Promise<Date> {
  await lockFeedOrder(tx);
  const now = new Date();
  const newest = await tx.post.findFirst({
    where: { OR: [{ scheduledAt: null }, { createdAt: { lte: now } }] },
    orderBy: [{ createdAt: "desc" }],
    select: { createdAt: true },
  });
  return newest !== null && newest.createdAt.getTime() >= now.getTime()
    ? new Date(newest.createdAt.getTime() + 1)
    : now;
}

/**
 * Puts a news item into the feed as a Styrelsen post to Alla, if it is not
 * already there.
 *
 * Called by the news module in the transaction that publishes an item, and by
 * the news screen's thread before it writes a comment. A board post is a news
 * item (ADR 0026), and the post is how the item appears in the feed and what
 * its comments hang on, so an item has one from the moment it is first
 * published. Publishing again finds the post it already has: an item taken
 * down and put back is back where it was rather than at the top.
 *
 * An item written on the news screen does not name its writer on the post, as
 * nothing ever named a news item's author. One written in the feed has its post
 * already, with the writer's own choice on it.
 *
 * ## A scheduled post takes its place when it is first published
 *
 * A post the board scheduled was written with its instant in the future, and
 * its item is published by a job at that instant - or a moment after, since a
 * queue is not a clock - or earlier, by a board member pressing publish on the
 * news screen. Whichever comes first is when the house hears it, so the first
 * publication stamps the post again at that moment, on the feed's own rule.
 * Late, the instant it was asked for would sit behind a cursor that had moved
 * past it in the meantime, and the poll would never deliver it; early, it would
 * hide a published item from the feed until a time the board no longer meant.
 * Nobody's cursor has passed its new place: nobody could read it before.
 */
export async function putNewsItemInFeed(
  tx: Prisma.TransactionClient,
  news: {
    id: string;
    authorPersonId: string | null;
    /** Whether this is the item's first publication. */
    firstPublication?: boolean;
  },
): Promise<{ postId: string }> {
  const existing = await tx.post.findUnique({
    where: { newsId: news.id },
    select: { id: true, scheduledAt: true },
  });
  if (existing !== null) {
    if (news.firstPublication === true && existing.scheduledAt !== null) {
      await tx.post.update({
        where: { id: existing.id },
        data: { createdAt: await stampAfterNewest(tx) },
      });
    }
    return { postId: existing.id };
  }
  const all = await derivedAudience(tx, "ALL");
  const created = await tx.post.create({
    data: {
      audienceId: all.id,
      authorPersonId: news.authorPersonId,
      byBoard: true,
      namesAuthor: false,
      body: null,
      newsId: news.id,
      createdAt: await stampAfterNewest(tx),
    },
    select: { id: true },
  });
  return { postId: created.id };
}

/**
 * The board's posts still waiting for their instant: scheduled, and not yet in
 * front of anybody.
 *
 * Either the instant has not come, or it has and the job that publishes the
 * news item has not run yet - a queue is not a clock. An item published once
 * and taken down since is not waiting for anything, and is not here.
 */
function waitingForInstant(now: Date): Prisma.PostWhereInput {
  return {
    byBoard: true,
    scheduledAt: { not: null },
    OR: [{ createdAt: { gt: now } }, { news: { publishedAt: null } }],
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Refuses an image a post may not be written with.
 *
 * Each one has to be an upload of this person's for a post (`uploadImage`),
 * on no post yet, and recent enough to be attached: younger than
 * {@link ATTACHABLE_HOURS}. The age is what keeps a write clear of the sweep
 * that removes uploads nobody used, which only reaches files twice as old - so
 * a file this accepts is never one the sweep is removing at the same moment.
 *
 * One refusal for all of it, as vague as the post's own: a file that does not
 * exist, one somebody else uploaded and one already on a post are the same
 * answer, so an identifier cannot be used to learn whether a file is there.
 *
 * Exported for the board's tools, which put images on a post written as
 * Styrelsen on exactly these terms.
 */
export async function refuseImagesNotAttachable(
  db: FeedDbClient,
  personId: string,
  imageIds: readonly string[],
  now: Date,
): Promise<void> {
  if (imageIds.length === 0) {
    return;
  }
  const attachable = await db.mediaFile.count({
    where: {
      id: { in: [...imageIds] },
      visibility: "POST",
      uploadedByPersonId: personId,
      postImage: null,
      createdAt: {
        gte: new Date(now.getTime() - ATTACHABLE_HOURS * 60 * 60 * 1000),
      },
    },
  });
  // Distinct identifiers, which the controller's schema holds, so the count of
  // rows found is the count asked for exactly when every one was found.
  if (attachable !== new Set(imageIds).size || attachable !== imageIds.length) {
    throw new FeedError("There is no such image.", "image-not-found");
  }
}

/** Refuses a person who has written their allowance of posts for the window. */
async function refuseTooManyPosts(
  db: FeedDbClient,
  authorPersonId: string,
): Promise<void> {
  const since = new Date(Date.now() - WRITE_WINDOW_MINUTES * 60 * 1000);
  const written = await db.post.count({
    where: { authorPersonId, byBoard: false, createdAt: { gte: since } },
  });
  if (written >= POSTS_PER_WRITE_WINDOW) {
    throw new FeedError(
      "Too many posts in too short a time. Try again shortly.",
      "too-many-posts",
    );
  }
}
