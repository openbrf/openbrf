import { Injectable, Logger } from "@nestjs/common";

import { AuditLogService } from "../audit/audit-log.service";
import type { Prisma } from "../generated/prisma/client";
import type { Principal } from "../authorization/capabilities";
import { PrismaService } from "../database/prisma.service";
import {
  groupsFor,
  isGroupMember,
  liveResidencyWhere,
  livesHere,
  roomFor,
  type ChatRoom,
} from "./chat-membership";
import { lockChat } from "./chat-lock";
import { ChatError } from "./chat.error";
import { authorViewOf, type ChatAuthorView } from "./chat.service";

/**
 * The longest name a group may carry.
 *
 * A name is how the people in a room tell it from the next one, so it is a line
 * rather than a description: "Trädgårdsgruppen", "Uppgång C", "Städdagen i
 * april". Bounded because every free-text field here is, and generously enough
 * that nobody has to abbreviate a stairwell.
 */
export const GROUP_NAME_MAX_LENGTH = 80;

/**
 * How many groups one person may be in.
 *
 * A bound rather than a product rule, and it exists because nothing else bounds
 * the list: the rooms endpoint answers every group somebody is in, with a count
 * and a newest instant read for each, so an account written into a thousand
 * rooms would turn one screen into a thousand queries. Twenty is far past what a
 * house generates - a garden group, a stairwell, two work parties - and a long
 * way below what makes the list expensive.
 *
 * It bites on being put into a room rather than on reading one, so somebody who
 * is already over it can still read and leave what they are in.
 */
export const GROUPS_PER_PERSON = 20;

/**
 * How many people may be in one group.
 *
 * The same reasoning from the other end: a room is read with its member list,
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

/** One person in a group, as the room's own panel says it. */
export interface ChatGroupMemberView {
  /**
   * Who they are, on exactly the terms a message's author is.
   *
   * A person with protected personal data (skyddade personuppgifter) is not
   * named here either. They can be in a room and write in it; what the panel
   * does not do is print their name to the others, because the room is not the
   * act of revealing that `protectedData:reveal` exists for.
   */
  person: ChatAuthorView;
  /** ISO instant they were put into the room. */
  joinedAt: string;
  /** Whether they made the room. A fact about it, and not an office. */
  createdTheGroup: boolean;
}

/** Somebody who may be put into this room, as the picker offers them. */
export interface ChatGroupCandidateView {
  personId: string;
  name: string;
  /** Their apartment, so two neighbours with one name can be told apart. */
  apartment: string | null;
}

/**
 * Groups: making one, who is in it, and how somebody stops being in it.
 *
 * ## Whoever wants a group makes one
 *
 * Not the board. A group is a work party, a stairwell, a garden committee - the
 * things a house organises for itself - and a room the association had to
 * appoint would be a room nobody made. So the condition is living here, and
 * nothing else: no capability decides it beyond the one that opens the
 * endpoints, and no board member approves it.
 *
 * ## Nobody administers it either
 *
 * Every member of a group may put somebody into it, and each may take
 * themselves out of it. Nobody can take anybody else out - a private room in
 * which one member could throw out another would be a tribunal, and the person
 * who happened to press the button first would be its judge. What ends a place
 * in a room against somebody's will is moving out, which the register decides
 * and this service only reads.
 *
 * The person who made the room is recorded on it, and that record grants
 * nothing. It is there because the board reads it when a message is reported out
 * of a room it cannot otherwise see.
 *
 * ## The board is not in it
 *
 * There is no endpoint here that lists groups, and none that lets anybody read
 * one they are not in. A group is invisible from outside: asked for by
 * identifier it is refused exactly as a room that does not exist. The single
 * way the board reaches a group at all is a report from somebody inside it, and
 * that is `chat-report.service.ts`.
 *
 * ## What is audited
 *
 * The three acts that change who can read the room, and nothing else. Making
 * one, putting somebody in, and somebody going out. A message written in the
 * room is not audited, for the reason `chat.service.ts` gives.
 */
@Injectable()
export class ChatGroupService {
  private readonly logger = new Logger(ChatGroupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Makes a group, with its maker as its first member.
   *
   * One member and not a list of them. Putting people in is its own act with its
   * own entry, and a create that took a list would write one entry covering
   * several people's admission to a private room - which is the one thing the
   * audit log here is for.
   */
  async create(
    creator: Principal,
    name: string,
  ): Promise<{ chatId: string; name: string }> {
    const now = new Date();
    await this.requireLivesHere(creator.personId, now);
    await this.refuseTooManyGroups(creator.personId);

    const chat = await this.prisma.$transaction(async (tx) => {
      const created = await tx.chat.create({
        data: {
          kind: "GROUP",
          name,
          createdByPersonId: creator.personId,
          members: {
            create: {
              personId: creator.personId,
              // Themselves: nobody else put them in the room they made.
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
           * room puts them in it, and their access report has to be able to say
           * which private rooms they are in.
           */
          actorPersonId: creator.personId,
          targetPersonId: creator.personId,
          targetKind: "chat",
          targetId: created.id,
          // Never the name. It is free text somebody typed, and the log is
          // append-only and outside every purge, so a name copied in here would
          // outlive the room the purge erased.
          context: { chatKind: "GROUP", nameLength: name.length },
        },
        tx,
      );

      return created;
    });

    this.logger.log(`A group chat ${chat.id} was created`);

    return { chatId: chat.id, name: chat.name ?? name };
  }

  /**
   * Puts somebody into a group.
   *
   * Idempotent: putting in somebody who is already there writes nothing and
   * records nothing, and answers exactly as the press that put them in did. A
   * second press is not a second act, and an audit log that said it was would be
   * saying somebody was admitted to a room twice.
   */
  async addMember(
    actor: Principal,
    chatId: string,
    personId: string,
  ): Promise<ChatGroupMemberView[]> {
    const now = new Date();
    const group = await this.requireGroupMembership(chatId, actor, now);

    /*
     * The person being put in has to live here, and the refusal says so rather
     * than answering "there is no such person": every candidate the room is
     * offered comes from the resident directory, so a name that is not in it is
     * somebody the caller went looking for.
     */
    if (!(await livesHere(this.prisma, personId, now))) {
      throw new ChatError(
        "Only somebody who lives here can be put into a group.",
        "not-a-resident",
      );
    }

    if (await isGroupMember(this.prisma, group.id, personId, now)) {
      return this.members(group.id);
    }

    await this.refuseTooManyGroups(personId);

    const added = await this.prisma.$transaction(async (tx) => {
      /*
       * The room's own lock, and the capacity counted under it. Two people put
       * into a full room at the same moment would otherwise both read a count
       * below the cap and both be let in: the bound is over a set of rows and
       * no row carries it, which is the case `chat-lock.ts` exists for.
       *
       * Membership is read again under it as well, so two presses on one name
       * settle as one - the pair is the row's identifier, and the second insert
       * would otherwise meet the primary key rather than the idempotent answer
       * the method promises.
       */
      await lockChat(tx, group.id);

      const members = await tx.chatGroupMember.count({
        where: { chatId: group.id },
      });
      if (members >= MEMBERS_PER_GROUP) {
        throw new ChatError(
          "This group already holds as many people as a group may hold.",
          "group-full",
        );
      }

      const standing = await tx.chatGroupMember.findUnique({
        where: { chatId_personId: { chatId: group.id, personId } },
        select: { chatId: true },
      });
      if (standing !== null) {
        return false;
      }

      await tx.chatGroupMember.create({
        data: {
          chatId: group.id,
          personId,
          addedByPersonId: actor.personId,
        },
      });

      await this.audit.record(
        {
          action: "CHAT_GROUP_MEMBER_ADDED",
          channel: "WEB",
          actorPersonId: actor.personId,
          // The subject is whoever was put in. Being able to read a private room
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
      this.logger.log(`A person was put into group chat ${group.id}`);
    }

    return this.members(group.id);
  }

  /**
   * Takes somebody out of a group, which is only ever themselves.
   *
   * The membership row goes rather than gaining a date. What they wrote stays in
   * the room, attributed exactly as before and on the clock it was always on -
   * so there is nothing for a dated row to preserve, and a list of people who
   * used to be in a private room is personal data the room has no reason to
   * hold.
   */
  async leave(actor: Principal, chatId: string): Promise<void> {
    const now = new Date();
    const group = await this.requireGroupMembership(chatId, actor, now);

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.chatGroupMember.deleteMany({
        where: { chatId: group.id, personId: actor.personId },
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

    this.logger.log(`A person left group chat ${group.id}`);
  }

  /** Who is in a room, for somebody who is in it. */
  async membersFor(
    chatId: string,
    reader: Principal,
  ): Promise<ChatGroupMemberView[]> {
    const group = await this.requireGroupMembership(chatId, reader, new Date());
    return this.members(group.id);
  }

  /**
   * Who this room could still be offered, for somebody who is in it.
   *
   * The resident directory's own rule, restated here rather than reached for
   * through that module: people who live here, and never somebody with protected
   * personal data. That is a real limit and it is the right one - a room made by
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
    chatId: string,
    reader: Principal,
    search: string | null,
  ): Promise<ChatGroupCandidateView[]> {
    const now = new Date();
    const group = await this.requireGroupMembership(chatId, reader, now);

    const already = await this.prisma.chatGroupMember.findMany({
      where: { chatId: group.id },
      select: { personId: true },
    });

    const people = await this.prisma.person.findMany({
      where: {
        id: { notIn: already.map((member) => member.personId) },
        protectedPersonalData: false,
        residencies: { some: liveResidencyWhere(now) },
        ...(search === null ? {} : { AND: nameSearchWhere(search) }),
      },
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: CANDIDATES_PER_READ,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        residencies: {
          where: liveResidencyWhere(now),
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

  /** The room, if this person is in it and it is a group. */
  private async requireGroupMembership(
    chatId: string,
    actor: Principal,
    now: Date,
  ): Promise<ChatRoom> {
    const chat = await roomFor(this.prisma, chatId, actor.personId, now);
    /*
     * The board chat is refused here as a room that does not exist, although the
     * caller may well be in it. Nobody is put into it or taken out of it - an
     * election is - so the acts this service performs have no meaning there, and
     * one refusal is what keeps every answer about a room identical.
     */
    if (chat === null || chat.kind !== "GROUP") {
      throw new ChatError("There is no such chat.", "chat-not-found");
    }
    return chat;
  }

  /** Who is in a room, once the caller has been shown to be in it. */
  private async members(chatId: string): Promise<ChatGroupMemberView[]> {
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        createdByPersonId: true,
        members: {
          orderBy: [{ joinedAt: "asc" }],
          select: { personId: true, joinedAt: true },
        },
      },
    });
    if (chat === null) {
      throw new ChatError("There is no such chat.", "chat-not-found");
    }

    const persons = await this.prisma.person.findMany({
      where: { id: { in: chat.members.map((member) => member.personId) } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        protectedPersonalData: true,
      },
    });
    const byId = new Map(persons.map((person) => [person.id, person]));

    return chat.members.map((member) => ({
      person: authorViewOf(member.personId, byId.get(member.personId)),
      joinedAt: member.joinedAt.toISOString(),
      createdTheGroup: member.personId === chat.createdByPersonId,
    }));
  }

  /** Refuses somebody who does not live here. */
  private async requireLivesHere(personId: string, now: Date): Promise<void> {
    if (!(await livesHere(this.prisma, personId, now))) {
      throw new ChatError(
        "A group is for the people who live here.",
        "not-a-resident",
      );
    }
  }

  /** Refuses a person already in as many rooms as one account may hold. */
  private async refuseTooManyGroups(personId: string): Promise<void> {
    const held = await groupsFor(this.prisma, personId, new Date());
    if (held.length >= GROUPS_PER_PERSON) {
      throw new ChatError(
        "This account is already in as many groups as one account may be in.",
        "too-many-groups",
      );
    }
  }
}
