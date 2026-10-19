import { Injectable, Logger } from "@nestjs/common";
import {
  type CreatedGroupView,
  type GroupCandidateView,
  type GroupMemberView,
  localDayOf,
} from "@openbrf/shared";

import { AuditLogService } from "../audit/audit-log.service";
import type { Prisma } from "../generated/prisma/client";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import { residencyHeldOn } from "../registers/held-on";
import {
  audienceFor,
  type AudienceRow,
  type FeedDbClient,
  groupsFor,
  isGroupMember,
  isWrittenIntoGroup,
  livesHere,
} from "./feed-audience";
import { readAuthors } from "./feed-author";
import { lockAudience, lockFeedPerson } from "./feed-lock";
import { FeedError, refusePersonalIdentityNumbers } from "./feed.error";

/**
 * The longest name a group may carry.
 *
 * A name is how the people in a group tell it from the next one, so it is a line
 * rather than a description: "Trädgårdsgruppen", "Uppgång C", "Städdagen i
 * april". Bounded because every free-text field here is, and generously enough
 * that nobody has to abbreviate a stairwell.
 */
export const GROUP_NAME_MAX_LENGTH = 80;

/**
 * How many groups one person may be in.
 *
 * A bound rather than a product rule, and it exists because nothing else bounds
 * the list: the groups endpoint answers every group somebody is in, with a count
 * and a newest instant read for each, so an account written into a thousand
 * groups would turn one screen into a thousand queries. Twenty is far past what a
 * house generates - a garden group, a stairwell, two work parties - and a long
 * way below what makes the list expensive.
 *
 * It bites on being put into a group rather than on reading one, so somebody who
 * is already over it can still read and leave what they are in.
 */
export const GROUPS_PER_PERSON = 20;

/**
 * How many people may be in one group.
 *
 * The same reasoning from the other end: a group is read with its member list,
 * and a list nothing bounds is a payload nothing bounds. Two hundred is more
 * than the residents of a building this product is written for, so the rule a
 * member meets is the register's rather than this one.
 */
export const MEMBERS_PER_GROUP = 200;

/**
 * How many candidates one read of the picker answers with.
 *
 * A picker and not a register: somebody looking for a neighbour types a few
 * letters, and a list longer than this is a list to search rather than to read.
 */
const CANDIDATES_PER_READ = 25;

/**
 * Who the picker may offer, and who a person may be added by name: somebody
 * who lives here on the day and has not protected their personal data. The
 * list and the check on an add ask it, so the two cannot disagree about who
 * is offered.
 */
function offerable(held: Prisma.ResidencyWhereInput): Prisma.PersonWhereInput {
  return { protectedPersonalData: false, residencies: { some: held } };
}

/**
 * What somebody typed into the picker's search, as a condition on a name.
 *
 * One clause per word, and every word has to match the first name or the last:
 * "anna lind" finds Anna Lindqvist, and so does "lind anna". That is the rule the
 * resident directory searches by, and the one somebody expects from a name field.
 * Matching the whole string against one column instead would find a neighbour by
 * either half of their name and never by the name itself - which is what anybody
 * looking for them is most likely to type.
 *
 * The caller has already trimmed the search and refused an empty one, so there is
 * always at least one word.
 */
function nameSearchWhere(search: string): Prisma.PersonWhereInput[] {
  return search
    .split(/\s+/)
    .filter((word) => word !== "")
    .map((word) => ({
      OR: [
        { firstName: { contains: word, mode: "insensitive" } },
        { lastName: { contains: word, mode: "insensitive" } },
      ],
    }));
}

/**
 * Groups: making one, who is in it, and how somebody stops being in it.
 *
 * ## Whoever wants a group makes one
 *
 * Not the board. A group is a work party, a stairwell, a garden committee - the
 * things a house organises for itself - and a group the association had to
 * appoint would be a group nobody made. So the condition is living here, and
 * nothing else: no capability decides it beyond the one that opens the
 * endpoints, and no board member approves it.
 *
 * ## Nobody administers it either
 *
 * Every member of a group may put somebody into it, and each may take
 * themselves out of it. Nobody can take anybody else out - a private group in
 * which one member could throw out another would be a tribunal, and the person
 * who happened to press the button first would be its judge. What ends a place
 * in a group against somebody's will is moving out, which the register decides
 * and this service only reads.
 *
 * The person who made the group is recorded on it, and that record grants
 * nothing. It is there because the board reads it when a post is reported out
 * of a group it cannot otherwise see.
 *
 * ## The board is not in it
 *
 * There is no endpoint here that lists groups, and none that lets anybody read
 * one they are not in. A group is invisible from outside: asked for by
 * identifier it is refused exactly as a group that does not exist. The single
 * way the board reaches a group at all is a report from somebody inside it, and
 * that is `post-report.service.ts`.
 *
 * ## What is audited
 *
 * The three acts that change who can read the group, and nothing else. Making
 * one, putting somebody in, and somebody going out. A post written to the
 * group is not audited, for the reason `feed.service.ts` gives.
 */
@Injectable()
export class GroupService {
  private readonly logger = new Logger(GroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Makes a group, with its maker as its first member.
   *
   * One member and not a list of them. Putting people in is its own act with its
   * own entry, and a create that took a list would write one entry covering
   * several people's admission to a private group - which is the one thing the
   * audit log here is for.
   */
  async create(creator: Principal, name: string): Promise<CreatedGroupView> {
    const now = new Date();
    await this.requireLivesHere(creator.personId, now);
    await refuseTooManyGroups(this.prisma, creator.personId);
    // Shown to everybody put into the group, and to the board beside a report.
    refusePersonalIdentityNumbers(name, "name");

    const group = await this.prisma.$transaction(async (tx) => {
      // Counted again under the person's own lock, so parallel creates cannot
      // all pass the count above.
      await lockFeedPerson(tx, creator.personId);
      await refuseTooManyGroups(tx, creator.personId);

      const created = await tx.audience.create({
        data: {
          kind: "GROUP",
          name,
          createdByPersonId: creator.personId,
          members: {
            create: {
              personId: creator.personId,
              // Themselves: nobody else put them in the group they made.
              addedByPersonId: creator.personId,
            },
          },
        },
        select: { id: true, name: true },
      });

      await this.audit.record(
        {
          action: "CHAT_GROUP_CREATED",
          channel: "WEB",
          /*
           * Both, because this is their own act and their own data: making a
           * group puts them in it, and their access report has to be able to say
           * which private groups they are in.
           */
          actorPersonId: creator.personId,
          targetPersonId: creator.personId,
          targetKind: "chat",
          targetId: created.id,
          // Never the name. It is free text somebody typed, and the log is
          // append-only and outside every purge, so a name copied in here would
          // outlive the group the purge erased.
          context: { chatKind: "GROUP", nameLength: name.length },
        },
        tx,
      );

      return created;
    });

    this.logger.log(`A group ${group.id} was created`);

    return { audienceId: group.id, name: group.name ?? name };
  }

  /**
   * Puts somebody into a group.
   *
   * Idempotent: putting in somebody who is already there writes nothing and
   * records nothing, and answers exactly as the press that put them in did. A
   * second press is not a second act, and an audit log that said it was would be
   * saying somebody was admitted to a group twice.
   *
   * The cap counts the people who live here today, as {@link members} lists
   * them: a membership row outlives the residency, and somebody who has moved
   * out is not in the group, so they do not take a place. Somebody who moves
   * back in keeps their row and is in the group again, even when that puts it
   * over the cap - nobody is turned out for it. The cap only stops new people
   * from being put in until the residents are below it.
   */
  async addMember(
    actor: Principal,
    audienceId: string,
    personId: string,
  ): Promise<GroupMemberView[]> {
    const now = new Date();
    const group = await this.requireGroupMembership(audienceId, actor, now);

    /*
     * Somebody already in the group is answered first, with the list that
     * already shows them. Asked after the candidate check below, a person who
     * had since become protected would get its refusal on a second press where
     * everybody else gets the list, and that difference is the one the check is
     * there to hide. Somebody who has moved out is not in the group and not in
     * the list, so they go on to the check and its one refusal.
     */
    if (await isGroupMember(this.prisma, group.id, personId, now)) {
      return this.members(group.id, now);
    }

    /*
     * The person being put in has to be one the group would offer: somebody
     * who lives here and whose personal data is not protected. Every other
     * identifier gets the one refusal, whether it names nobody, somebody who
     * has moved out or somebody protected, because an identifier outside the
     * candidates is one the caller went looking for, and a different answer
     * for each would tell them whether a protected person lives here.
     */
    if (!(await this.isCandidate(personId, now))) {
      throw new FeedError(
        "Only somebody who lives here can be put into a group.",
        "not-a-resident",
      );
    }

    // A cheap early refusal, and not the decision: another press may have put
    // them into this group since the read above, so that group does not count
    // against them here. The count under the locks is the one that decides.
    await refuseTooManyGroups(this.prisma, personId, group.id);

    const added = await this.prisma.$transaction(async (tx) => {
      // The person's own lock first, as everywhere both are taken, so the groups
      // they are in cannot change until this transaction ends.
      await lockFeedPerson(tx, personId);

      /*
       * The group's own lock, and the capacity counted under it. Two people put
       * into a full group at the same moment would otherwise both read a count
       * below the cap and both be let in: the bound is over a set of rows and
       * no row carries it, which is the case `feed-lock.ts` exists for.
       *
       * Membership is read again under it as well, so two presses on one name
       * settle as one - the pair is the row's identifier, and the second insert
       * would otherwise meet the primary key rather than the idempotent answer
       * the method promises.
       */
      await lockAudience(tx, group.id);

      if (await isWrittenIntoGroup(tx, group.id, personId)) {
        return false;
      }

      // Counted only once they are known not to be in this group: the press that
      // put them in may have made it their last place, and this one is still
      // the idempotent answer rather than a refusal.
      await refuseTooManyGroups(tx, personId);

      if ((await residentsIn(tx, group.id, now)) >= MEMBERS_PER_GROUP) {
        throw new FeedError(
          "This group already holds as many people as a group may hold.",
          "group-full",
        );
      }

      await tx.groupMember.create({
        data: {
          audienceId: group.id,
          personId,
          addedByPersonId: actor.personId,
        },
      });

      await this.audit.record(
        {
          action: "CHAT_GROUP_MEMBER_ADDED",
          channel: "WEB",
          actorPersonId: actor.personId,
          // The subject is whoever was put in. Being able to read a private group
          // is something done to them, and their access report says so.
          targetPersonId: personId,
          targetKind: "chat",
          targetId: group.id,
          context: { chatKind: "GROUP" },
        },
        tx,
      );

      return true;
    });

    if (added) {
      this.logger.log(`A person was put into group ${group.id}`);
    }

    return this.members(group.id, now);
  }

  /**
   * Takes somebody out of a group, which is only ever themselves.
   *
   * The membership row goes rather than gaining a date. What they wrote stays in
   * the group, attributed exactly as before and on the clock it was always on -
   * so there is nothing for a dated row to preserve, and a list of people who
   * used to be in a private group is personal data the group has no reason to
   * hold.
   */
  async leave(actor: Principal, audienceId: string): Promise<void> {
    const now = new Date();
    const group = await this.requireGroupMembership(audienceId, actor, now);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.groupMember.deleteMany({
        where: { audienceId: group.id, personId: actor.personId },
      });
      if (count === 0) {
        // Somebody pressed twice. Nothing written, nothing recorded, and the
        // same answer as the press that took them out.
        return;
      }

      await this.audit.record(
        {
          action: "CHAT_GROUP_MEMBER_REMOVED",
          channel: "WEB",
          actorPersonId: actor.personId,
          targetPersonId: actor.personId,
          targetKind: "chat",
          targetId: group.id,
          context: { chatKind: "GROUP" },
        },
        tx,
      );
    });

    this.logger.log(`A person left group ${group.id}`);
  }

  /** Who is in a group, for somebody who is in it. */
  async membersFor(
    audienceId: string,
    reader: Principal,
  ): Promise<GroupMemberView[]> {
    const now = new Date();
    const group = await this.requireGroupMembership(audienceId, reader, now);
    return this.members(group.id, now);
  }

  /**
   * Who this group could still be offered, for somebody who is in it.
   *
   * The resident directory's own rule, restated here rather than reached for
   * through that module: people who live here, and never somebody with protected
   * personal data. That is a real limit and it is the right one - a group made by
   * a neighbour is not a place to put somebody whose whereabouts are protected,
   * and if they want to be in one they can be put there by asking, or make one
   * themselves.
   *
   * Bounded and searched rather than listed whole, because the building is the
   * size of a register and a picker is not a register screen. The search is the
   * resident directory's as well: every word typed has to match a part of the
   * name, so a neighbour is found by their whole name as readily as by either
   * half of it.
   */
  async candidates(
    audienceId: string,
    reader: Principal,
    search: string | null,
  ): Promise<GroupCandidateView[]> {
    const now = new Date();
    const group = await this.requireGroupMembership(audienceId, reader, now);

    const already = await this.prisma.groupMember.findMany({
      where: { audienceId: group.id },
      select: { personId: true },
    });

    const held = residencyHeldOn(localDayOf(now));
    const people = await this.prisma.person.findMany({
      where: {
        id: { notIn: already.map((member) => member.personId) },
        ...offerable(held),
        ...(search === null ? {} : { AND: nameSearchWhere(search) }),
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: CANDIDATES_PER_READ,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        residencies: {
          where: held,
          orderBy: [{ movedInOn: "asc" }],
          take: 1,
          select: { apartment: { select: { number: true } } },
        },
      },
    });

    return people.map((person) => ({
      personId: person.id,
      name: `${person.firstName} ${person.lastName}`.trim(),
      apartment: person.residencies[0]?.apartment.number ?? null,
    }));
  }

  /** The group, if this person is in it and it is a group. */
  private async requireGroupMembership(
    audienceId: string,
    actor: Principal,
    now: Date,
  ): Promise<AudienceRow> {
    const audience = await audienceFor(
      this.prisma,
      audienceId,
      actor.personId,
      now,
    );
    /*
     * Alla and Styrelsen are refused here as a group that does not exist,
     * although the caller may well be in them. Nobody is put into either or
     * taken out of it - a residency or an election is - so the acts this
     * service performs have no meaning there, and one refusal is what keeps
     * every answer about a group identical.
     */
    if (audience === null || audience.kind !== "GROUP") {
      throw new FeedError("There is no such group.", "audience-not-found");
    }
    return audience;
  }

  /**
   * Who is in a group, once the caller has been shown to be in it.
   *
   * The people who live here. A membership ends the day its residency does,
   * so somebody who has moved out is no longer in the group and is not listed
   * as though they were.
   */
  private async members(
    audienceId: string,
    now: Date,
  ): Promise<GroupMemberView[]> {
    const group = await this.prisma.audience.findUnique({
      where: { id: audienceId },
      select: {
        createdByPersonId: true,
        members: {
          orderBy: [{ joinedAt: "asc" }],
          select: { personId: true, joinedAt: true },
        },
      },
    });
    if (group === null) {
      throw new FeedError("There is no such group.", "audience-not-found");
    }

    // Only the people who live here today, attributed on the feed's one rule.
    const residents = new Set(
      (
        await this.prisma.person.findMany({
          where: {
            id: { in: group.members.map((member) => member.personId) },
            residencies: { some: residencyHeldOn(localDayOf(now)) },
          },
          select: { id: true },
        })
      ).map((person) => person.id),
    );
    const members = group.members.filter((member) =>
      residents.has(member.personId),
    );
    const attribute = await readAuthors(
      this.prisma,
      members.map((member) => member.personId),
    );

    return members.map((member) => ({
      person: attribute(member.personId),
      joinedAt: member.joinedAt.toISOString(),
      createdTheGroup: member.personId === group.createdByPersonId,
    }));
  }

  /**
   * Whether this person is one {@link candidates} would offer, the
   * membership of the group aside.
   */
  private async isCandidate(personId: string, now: Date): Promise<boolean> {
    const person = await this.prisma.person.findFirst({
      where: {
        id: personId,
        ...offerable(residencyHeldOn(localDayOf(now))),
      },
      select: { id: true },
    });
    return person !== null;
  }

  /** Refuses somebody who does not live here. */
  private async requireLivesHere(personId: string, now: Date): Promise<void> {
    if (!(await livesHere(this.prisma, personId, now))) {
      throw new FeedError(
        "A group is for the people who live here.",
        "not-a-resident",
      );
    }
  }
}

/**
 * How many of the people written down in a group live here today.
 *
 * Two queries, because `GroupMember` has no relation to the person to
 * filter the residency through. The rows are the group's own, so what the second
 * query is asked about is bounded by the cap plus whoever has moved out since.
 */
async function residentsIn(
  db: FeedDbClient,
  audienceId: string,
  now: Date,
): Promise<number> {
  const rows = await db.groupMember.findMany({
    where: { audienceId },
    select: { personId: true },
  });
  return db.person.count({
    where: {
      id: { in: rows.map((row) => row.personId) },
      residencies: { some: residencyHeldOn(localDayOf(now)) },
    },
  });
}

/**
 * Refuses a person already in as many groups as one account may hold.
 *
 * `joining` is the group they are being put into. Once they are in it there is
 * nothing to refuse, so a person found there is let through to the idempotent
 * answer, whatever the count.
 */
async function refuseTooManyGroups(
  db: FeedDbClient,
  personId: string,
  joining?: string,
): Promise<void> {
  const held = await groupsFor(db, personId, new Date());
  if (joining !== undefined && held.some((group) => group.id === joining)) {
    return;
  }
  if (held.length >= GROUPS_PER_PERSON) {
    throw new FeedError(
      "This account is already in as many groups as one account may be in.",
      "too-many-groups",
    );
  }
}
