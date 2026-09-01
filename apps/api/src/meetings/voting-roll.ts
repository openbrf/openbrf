import {
  compareLocalDays,
  type LocalDay,
  localDayOfColumn,
} from "../bookings/stockholm-calendar";
import type { ResolvedRegisterEvent } from "../registers/membership-periods";
import { membershipPeriods } from "../registers/membership-periods";
import { isProxyAuthorityCurrent } from "./proxy-authority";

/**
 * The voting roll (rostlangd) of a general meeting: which votes there are, who
 * holds each of them, and which of them are in the room.
 *
 * EFL 6 kap. 27 § has a list drawn up at the meeting of the members, ombud and
 * bitraden present, stating the number of votes the members have where they do
 * not all have the same number. This file is that list's derivation. It is pure,
 * and it is pure for the same reason `membership-periods.ts` is: the archive it
 * reads cannot be repaired by editing, and how it is read has to be exercised
 * exhaustively without a database in the way.
 *
 * ## Derived, and never stored
 *
 * Nothing writes a vote count or an eligibility flag anywhere. The roll is
 * computed when it is asked for, exactly as the booking allowance is counted out
 * of the residencies at write time and for exactly the same reason: a stored
 * count goes stale the moment somebody moves or a transfer completes, and it
 * goes stale silently, because nothing about the stored row looks wrong. A roll
 * asked for twice on one day gives one answer; asked for after a transfer it
 * gives the new one, which is what the statute wants of a list drawn up at the
 * meeting.
 *
 * ## One vote per membership, and where that bites
 *
 * EFL 6 kap. 3 § gives every member one vote, and BRL 9 kap. 14 § 1 permits a
 * bylaws deviation from that only to limit the vote of a member who holds
 * nothing but a garage, a store or another space used primarily for storage.
 * Three consequences, and all three are properties of this file:
 *
 *   **A member who holds two apartments has one vote.** The vote belongs to the
 *   membership and not to the holding. So the roll is built from memberships
 *   first - one line per membership - and the apartments are read afterwards
 *   only to decide which lines merge. `membershipPeriods` already ignores a
 *   second ENTRY while a membership is open, on the same reading, which is why
 *   taking over a second apartment does not appear as a second membership.
 *
 *   **Members who hold one bostadsratt jointly have one vote between them.**
 *   BRL 9 kap. 14 § 1, second sentence, and unconditional: unlike the storage
 *   limitation in the same paragraph it does not depend on the bylaws. So two
 *   joint holders are one line with one vote, not two lines.
 *
 *   **Merging is transitive.** A member who holds one apartment jointly with a
 *   second member and another jointly with a third cannot have one vote with
 *   each of them without having two, which the first rule forbids. So the lines
 *   are connected components over "shares a tenant-ownership", and the line
 *   names every member and every apartment that went into it - because a chain
 *   is rare, because the merge is arguable where it chains, and because EFL
 *   6 kap. 27 § puts the decision at the meeting in any case: the roll is drawn
 *   up by the chair, approved by the meeting, and stands until the meeting
 *   resolves to change it. The platform's job is to propose a defensible roll
 *   and to show its working, not to settle a question the meeting settles.
 *
 * ## Two sources, each for what it is the record of
 *
 * **Whether somebody was a member on the meeting day: the member register**
 * (medlemsforteckning). BRL 9 kap. 8-9 §§ require it and fix its content, so it
 * is the record of who the members are; it is append-only and exempt from every
 * purge, so it can still answer for a meeting held years ago; and only a person
 * who is a member on the meeting day has a vote at it.
 *
 * **Which bostadsratt a membership covers: the residencies with the MEMBER
 * role**, which is what the apartment register itself reads to list an
 * apartment's holders. The member register cannot answer this, and the reason is
 * a rule in the move flow rather than an oversight here: an EXIT row is written
 * only when a person's *last* tenant-ownership ends, because a member who sells
 * one of two apartments is still a member and an EXIT could never be taken back.
 * So the archive leaves an open ENTRY on the apartment they sold, and a merge
 * keyed on it would join that member to whoever bought it - two households
 * sharing one vote, which is the exact opposite of the rule the merge exists to
 * apply.
 *
 * A membership with no residency covering the day therefore keeps its vote and
 * merges with nobody. That is what a purged residency behind a long-past meeting
 * looks like, and it is the safe direction: the count stays right and only the
 * merging degrades. The record of a meeting that has been held is its protokoll
 * (EFL 6 kap. 39-40 §§) rather than anything derived here.
 *
 * ## A bitrade carries no vote
 *
 * EFL 6 kap. 7 § lets a member or an ombud bring at most one bitrade, who may
 * speak at the meeting. That is the whole of what it grants. So a bitrade is on
 * the list EFL 6 kap. 27 § requires - it names bitraden explicitly - and
 * contributes nothing to any vote count here. It is counted separately for that
 * reason: a roll that reported bodies in the room would be reporting a number
 * nobody may act on.
 *
 * ## The storage limitation is reported, never applied
 *
 * BRL 9 kap. 14 § 1's one permitted deviation turns on what a space is used for,
 * and nothing in this platform records that: an apartment carries a number, a
 * floor, a participation share and an initial share capital, none of which tells
 * a garage from a flat. So {@link VotingRoll.storageOnlyVoteLimited} states
 * whether the clause stands and the meeting applies it. An answer invented from
 * a participation share would take somebody's vote away on a guess, which is the
 * one error a voting roll must not make quietly.
 */

/** One line of attendance, as much of it as the roll needs. */
export interface RollAttendance {
  personId: string;
  capacity: "MEMBER" | "PROXY_HOLDER" | "ASSISTANT";
  /** Set where the board struck the line off the list again. */
  withdrawnAt: Date | null;
}

/**
 * One tenant-ownership a membership covered on the meeting day.
 *
 * A flat pair rather than a period, because the roll asks about one day: the
 * caller has already narrowed the residencies to the ones covering it, and a
 * period here would invite this file to re-answer a question with a rule of its
 * own beside the one the register service already applies.
 */
export interface RollHolding {
  personId: string;
  apartmentId: string;
}

/** One proxy appointment, as much of it as the roll needs. */
export interface RollProxyAppointment {
  memberPersonId: string;
  proxyHolderPersonId: string;
  /** The day the member signed the fullmakt, from the `@db.Date` column. */
  authorisedOn: Date;
  /** Set where the authority was taken back. */
  withdrawnAt: Date | null;
}

/** An ombud present and holding one member's authority. */
export interface RollProxyHolder {
  personId: string;
  /** The member on this line whose authority they hold. */
  memberPersonId: string;
}

/** One vote, and who holds and exercises it. */
export interface VotingRollLine {
  /**
   * The members who share this one vote, sorted so two reads of one register
   * produce one roll.
   */
  memberPersonIds: readonly string[];

  /**
   * The tenant-ownerships the vote is held through, sorted.
   *
   * Empty where no MEMBER residency covers the meeting day for this membership.
   * The vote stands either way - EFL 6 kap. 3 § gives it to the member and not
   * to the holding - and the line merges with nobody, because there is no shared
   * bostadsratt to merge on. See the file comment for when that happens.
   */
  apartmentIds: readonly string[];

  /** More than one member shares this vote (BRL 9 kap. 14 § 1). */
  jointlyHeld: boolean;

  /** Members on this line present themselves, sorted. */
  presentMemberPersonIds: readonly string[];

  /**
   * The ombud present who hold a current authority from a member on this line.
   *
   * Plural, and not one chosen for the meeting. Joint holders are separate
   * members, so two of them may each have appointed a different ombud while both
   * stay away - and the one vote they share cannot be split between them. The
   * line names both, the vote counts once, and which of them exercises it is for
   * the meeting to settle when it approves the roll.
   */
  proxyHolders: readonly RollProxyHolder[];

  /**
   * Whether the one vote this line carries is present at the meeting: a member
   * on it is there, or an ombud with a current authority from one of them is.
   */
  votePresent: boolean;
}

/** The roll as a whole. */
export interface VotingRoll {
  /** One line per vote, ordered by the sorted member ids for stability. */
  lines: readonly VotingRollLine[];

  /**
   * Every vote the association has on the meeting day, present or not, which is
   * `lines.length` said as a number.
   */
  votesTotal: number;

  /**
   * How many of them are in the room.
   *
   * The size of the roll and deliberately not a majority basis: EFL 6 kap. 33 §
   * measures an ordinary majority against "de avgivna rosterna" - the votes
   * cast - and somebody present who does not vote has cast none. What a decision
   * needed is the chair's to state, which is why the decision row carries the
   * counts rather than deriving them from this.
   */
  votesPresent: number;

  /**
   * Bitraden on the list, and not one of them a vote. EFL 6 kap. 27 § names them
   * among those the list covers; EFL 6 kap. 7 § gives them the right to speak
   * and nothing else.
   */
  assistantsPresent: number;

  /**
   * People recorded as present as members whom the register does not show as
   * members on the meeting day, sorted.
   *
   * Not dropped in silence, which is the point of the field. Check-in happens
   * before the meeting and the register keeps moving until the day itself, so
   * this is what a transfer completed in between looks like - and a roll that
   * simply omitted the person would leave the chair with a name on the list at
   * the door and no line for it here.
   */
  presentWithoutMembership: readonly string[];

  /**
   * People recorded as present as ombud who are exercising no vote, sorted.
   *
   * Four things look like this and all four are answers the chair needs at the
   * door: the authority was withdrawn, it has run out under EFL 6 kap. 4 §, the
   * member who gave it is no longer a member, or that member turned up and is
   * exercising their own right - which is the one case where nothing is wrong
   * and the ombud simply has nothing left to do. Reported rather than dropped,
   * because somebody standing there with a fullmakt has to be answered, and the
   * answer is that they may not vote rather than that they are not present.
   */
  proxyHoldersWithoutVote: readonly string[];

  /**
   * Whether the bylaws limit the vote of a member holding nothing but a garage,
   * a store or other storage space (BRL 9 kap. 14 § 1).
   *
   * Reported and never applied. See the file comment.
   */
  storageOnlyVoteLimited: boolean;
}

export interface VotingRollInput {
  /**
   * The member register archive with its corrections applied, for every person.
   *
   * Corrections first, through `resolveRegisterEvents`, which is the only
   * correct way to read this archive: a CORRECTION carries the event type of the
   * row it replaces, and reading the raw rows would count a corrected entry as a
   * third kind of membership event.
   */
  events: readonly ResolvedRegisterEvent[];

  /** The meeting day, from the `@db.Date` column. */
  meetingDay: Date;

  /**
   * The tenant-ownerships each membership covered on the meeting day, from the
   * residencies with the MEMBER role. See the file comment for why these do not
   * come out of the archive above.
   */
  holdings: readonly RollHolding[];

  attendances: readonly RollAttendance[];
  proxyAppointments: readonly RollProxyAppointment[];

  /** BRL 9 kap. 14 § 1's clause, as the association recorded it. */
  storageOnlyVoteLimited: boolean;
}

/**
 * Draws the roll.
 *
 * Read the file comment before changing anything here. Four properties are
 * load-bearing and each of them is a statutory rule rather than a design
 * preference: a member holding two apartments is one vote, joint holders of one
 * bostadsratt are one vote, a bitrade is no vote, and an ombud's authority is
 * re-checked against the meeting day rather than trusted from its registration.
 */
export function votingRoll(input: VotingRollInput): VotingRoll {
  const meetingDay = localDayOfColumn(input.meetingDay);
  const members = membersOn(input.events, meetingDay, input.holdings);
  const groups = mergeJointHoldings(members);

  const presentAs = presenceByCapacity(input.attendances);
  const standing = currentAuthorities(input.proxyAppointments, meetingDay);

  const lines: VotingRollLine[] = [];
  const memberOfSomeLine = new Set<string>();
  const authorityUsed = new Set<string>();

  for (const group of groups) {
    const memberPersonIds = [...group.personIds].sort();
    for (const personId of memberPersonIds) {
      memberOfSomeLine.add(personId);
    }

    const presentMemberPersonIds = memberPersonIds.filter((personId) =>
      presentAs.MEMBER.has(personId),
    );

    const proxyHolders: RollProxyHolder[] = [];
    for (const memberPersonId of memberPersonIds) {
      /*
       * An ombud acts for a member who is not personally present. EFL 6 kap. 4 §
       * says so in its first words - "en medlem som inte ar personligen
       * narvarande" - so a member who turned up exercises their own right and
       * the authority they gave has nothing left to do. Counting it as well
       * would put a second representative on a line that carries one vote.
       */
      if (presentAs.MEMBER.has(memberPersonId)) {
        continue;
      }
      const holder = standing.get(memberPersonId);
      if (holder === undefined || !presentAs.PROXY_HOLDER.has(holder)) {
        continue;
      }
      authorityUsed.add(holder);
      proxyHolders.push({ personId: holder, memberPersonId });
    }

    lines.push({
      memberPersonIds,
      apartmentIds: [...group.apartmentIds].sort(),
      jointlyHeld: memberPersonIds.length > 1,
      presentMemberPersonIds,
      proxyHolders,
      /*
       * One vote either way. A member on the line being there is enough, and so
       * is an ombud with a current authority from one of them - EFL 6 kap. 4 §
       * has the ombud exercise the member's right, which is the one right the
       * line carries, so the two paths lead to the same single vote rather than
       * to two.
       */
      votePresent: presentMemberPersonIds.length > 0 || proxyHolders.length > 0,
    });
  }

  // Ordered by the sorted member ids, so one register produces one roll however
  // the rows came back from the database.
  lines.sort((left, right) => {
    const first = left.memberPersonIds.join(" ");
    const second = right.memberPersonIds.join(" ");
    if (first === second) {
      return 0;
    }
    return first < second ? -1 : 1;
  });

  return {
    lines,
    votesTotal: lines.length,
    votesPresent: lines.filter((line) => line.votePresent).length,
    assistantsPresent: presentAs.ASSISTANT.size,
    presentWithoutMembership: [...presentAs.MEMBER]
      .filter((personId) => !memberOfSomeLine.has(personId))
      .sort(),
    proxyHoldersWithoutVote: [...presentAs.PROXY_HOLDER]
      .filter((personId) => !authorityUsed.has(personId))
      .sort(),
    storageOnlyVoteLimited: input.storageOnlyVoteLimited,
  };
}

/** One membership on the meeting day, with the apartments it covered. */
interface MembershipOnTheDay {
  personId: string;
  apartmentIds: Set<string>;
}

/**
 * Who was a member on the meeting day, and which tenant-ownerships they held.
 *
 * One entry per person and never per holding, which is the first of the two
 * statutory rules: EFL 6 kap. 3 § gives the vote to the member.
 *
 * A membership with no entry - an EXIT the archive holds with nothing before it -
 * is treated as having covered every day up to that exit. An exit is the
 * register's own statement that a membership existed, so a missing entry is a gap
 * in the archive rather than evidence that the person was not a member, and the
 * register extract already shows such a row for the same reason. The write path
 * never produces one; this is the reading for an archive that has been repaired
 * by hand.
 */
function membersOn(
  events: readonly ResolvedRegisterEvent[],
  meetingDay: LocalDay,
  holdings: readonly RollHolding[],
): MembershipOnTheDay[] {
  const byPerson = new Map<string, ResolvedRegisterEvent[]>();
  for (const event of events) {
    const list = byPerson.get(event.personId);
    if (list === undefined) {
      byPerson.set(event.personId, [event]);
    } else {
      list.push(event);
    }
  }

  const heldByPerson = new Map<string, Set<string>>();
  for (const holding of holdings) {
    const held = heldByPerson.get(holding.personId);
    if (held === undefined) {
      heldByPerson.set(holding.personId, new Set([holding.apartmentId]));
    } else {
      held.add(holding.apartmentId);
    }
  }

  const members: MembershipOnTheDay[] = [];
  for (const [personId, personEvents] of byPerson) {
    const covers = membershipPeriods(personEvents).some((period) => {
      const beganInTime =
        period.entry === null ||
        compareLocalDays(localDayOfColumn(period.entry.eventOn), meetingDay) <=
          0;
      /*
       * The exit day itself is not a day of membership. It is the day the
       * membership ended, which is how every other reader of a dated close in
       * this codebase treats one - a residency's move-out date is the first day
       * not held. A meeting on the day somebody's membership ended is a meeting
       * they have no vote at.
       */
      const hadNotEnded =
        period.exit === null ||
        compareLocalDays(localDayOfColumn(period.exit.eventOn), meetingDay) > 0;
      return beganInTime && hadNotEnded;
    });
    if (!covers) {
      continue;
    }

    members.push({
      personId,
      apartmentIds: heldByPerson.get(personId) ?? new Set<string>(),
    });
  }

  return members;
}

/** A set of memberships that share one vote. */
interface VotingGroup {
  personIds: Set<string>;
  apartmentIds: Set<string>;
}

/**
 * Merges the memberships that hold a bostadsratt jointly into one vote each.
 *
 * BRL 9 kap. 14 § 1, second sentence. The connected components of "shares a
 * tenant-ownership", by way of a union-find over the apartment each membership
 * covers: an apartment already claimed by a group pulls this membership into it,
 * and a membership holding two such apartments pulls their groups together. See
 * the file comment for why the transitive case resolves this way rather than
 * being split.
 *
 * A membership with no apartment is a group of its own, because there is nothing
 * for it to share.
 */
function mergeJointHoldings(
  members: readonly MembershipOnTheDay[],
): VotingGroup[] {
  const groupOfApartment = new Map<string, VotingGroup>();
  const groups = new Set<VotingGroup>();

  for (const member of members) {
    const joined = new Set<VotingGroup>();
    for (const apartmentId of member.apartmentIds) {
      const existing = groupOfApartment.get(apartmentId);
      if (existing !== undefined) {
        joined.add(existing);
      }
    }

    const group: VotingGroup = {
      personIds: new Set([member.personId]),
      apartmentIds: new Set(member.apartmentIds),
    };
    groups.add(group);

    for (const other of joined) {
      for (const personId of other.personIds) {
        group.personIds.add(personId);
      }
      for (const apartmentId of other.apartmentIds) {
        group.apartmentIds.add(apartmentId);
      }
      groups.delete(other);
    }

    for (const apartmentId of group.apartmentIds) {
      groupOfApartment.set(apartmentId, group);
    }
  }

  return [...groups];
}

/** Who is standing on the list, by the capacity they are on it in. */
function presenceByCapacity(attendances: readonly RollAttendance[]): {
  MEMBER: Set<string>;
  PROXY_HOLDER: Set<string>;
  ASSISTANT: Set<string>;
} {
  const present = {
    MEMBER: new Set<string>(),
    PROXY_HOLDER: new Set<string>(),
    ASSISTANT: new Set<string>(),
  };
  for (const attendance of attendances) {
    // A line struck off is not a line. The date is what makes "was recorded and
    // struck off again" answerable at all, and it is what the roll must not
    // count.
    if (attendance.withdrawnAt !== null) {
      continue;
    }
    present[attendance.capacity].add(attendance.personId);
  }
  return present;
}

/**
 * Which member each standing, current authority names as its ombud.
 *
 * The validity is asked again here rather than trusted from the registration
 * that wrote the row, because the meeting day can be moved afterwards: an
 * authority that was inside its year when the board checked it may be outside it
 * on the day, and EFL 6 kap. 4 §'s year runs from the day the member signed
 * whatever the platform did in between.
 *
 * One entry per member, which the table's own unique constraint already
 * guarantees: a member may not be represented by more than one ombud (EFL
 * 6 kap. 4 § forsta stycket).
 */
function currentAuthorities(
  appointments: readonly RollProxyAppointment[],
  meetingDay: LocalDay,
): Map<string, string> {
  const holders = new Map<string, string>();
  for (const appointment of appointments) {
    if (appointment.withdrawnAt !== null) {
      continue;
    }
    if (
      !isProxyAuthorityCurrent(
        localDayOfColumn(appointment.authorisedOn),
        meetingDay,
      )
    ) {
      continue;
    }
    holders.set(appointment.memberPersonId, appointment.proxyHolderPersonId);
  }
  return holders;
}
