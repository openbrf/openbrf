-- The general meeting (foreningsstamma): the meeting itself, its agenda, who
-- was present and in what capacity, the proxy authorisations somebody else's
-- vote was exercised under, and what the meeting decided.
--
-- EFL 6 kap., which BRL 9 kap. 14 § applies to a housing cooperative with six
-- exceptions.
--
-- Service tier. No append-only trigger, no TRUNCATE guard and no REVOKE in
-- prisma/sql/harden-runtime-role.sql, because none of these tables is a
-- statutory register: the registers BRL 9 kap. requires are the member register
-- and the apartment register, and the lasting record of a general meeting is
-- the protokoll, which EFL 6 kap. 39 § has the chair keep and 40 § has kept
-- safely - a document in the association's archive rather than a row here. What
-- these tables hold is how the meeting was run, and a chair who mis-keys a
-- count has to be able to correct it.
--
-- Nothing here stores a vote count or an eligibility flag against a person. The
-- voting register EFL 6 kap. 27 § has drawn up at the meeting is derived from
-- the member register when it is asked for - src/meetings/voting-register.ts -
-- exactly as the booking allowance is counted out of the residencies at write
-- time. A stored count goes stale the moment somebody moves or a transfer
-- completes, and it goes stale without anything about the row looking wrong.

-- CreateEnum
--
-- Two kinds of meeting and no more. The arsstamma is not a third: it is the
-- ordinary meeting at which the annual report is laid (EFL 6 kap. 9 §), and
-- bylaws may require further ordinary meetings in one year (6 kap. 11 §).
CREATE TYPE "MeetingKind" AS ENUM ('ORDINARY', 'EXTRAORDINARY');

-- CreateEnum
--
-- The three the voting register lists: "narvarande medlemmar, ombud och
-- bitraden" (EFL 6 kap. 27 §). An assistant carries no vote - 6 kap. 7 § gives
-- it the right to speak at the meeting and no more.
CREATE TYPE "AttendanceCapacity" AS ENUM ('MEMBER', 'PROXY_HOLDER', 'ASSISTANT');

-- CreateEnum
--
-- How one person attended. Whether a meeting may be held digitally at all is a
-- different question, and EFL 6 kap. 14 § answers it from the bylaws.
CREATE TYPE "AttendanceMode" AS ENUM ('IN_PERSON', 'REMOTE');

-- CreateEnum
--
-- Which limb of BRL 9 kap. 14 § 4 a proxy holder's eligibility rests on. Two of
-- the three are decidable from what this platform holds and one is not: the
-- register says who is a member, and nothing here records who is anybody's
-- spouse or cohabitant.
CREATE TYPE "RepresentativeGround" AS ENUM ('MEMBER', 'SPOUSE_OR_COHABITANT', 'BYLAWS');

-- CreateEnum
CREATE TYPE "MeetingDecisionOutcome" AS ENUM ('CARRIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "VoteChoice" AS ENUM ('FOR', 'AGAINST', 'ABSTENTION');

-- AlterTable
--
-- The four bylaws clauses BRL 9 kap. 14 § leaves to the association, each
-- defaulted to the statutory position rather than to a blank. Unlike the motion
-- deadline above them, every one of these has a rule that applies unless the
-- bylaws displace it, so an association that has recorded nothing is under the
-- statute rather than unconfigured.
--
-- The proxy limit defaults to one and not to the three EFL 6 kap. 5 § allows an
-- economic association generally, because BRL 9 kap. 14 § 4 replaces that rule
-- for a housing cooperative. A default of three would let one person arrive
-- holding a block of votes the statute keeps out of a bostadsrattsforening.
ALTER TABLE "association" ADD COLUMN "bylawsWidenProxyHolderEligibility" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "association" ADD COLUMN "bylawsMaxMembersPerProxyHolder" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "association" ADD COLUMN "bylawsLimitStorageOnlyVote" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "association" ADD COLUMN "bylawsWidenAssistantEligibility" BOOLEAN NOT NULL DEFAULT false;

-- A limit a bylaws clause could name.
--
-- One is the floor because zero would refuse every proxy the statute permits,
-- and a setting that refuses what the law grants is worse than no setting. The
-- ceiling keeps a mis-typed value out of a rule the meeting relies on: the API
-- refuses the same range first and with a reason code, so a violation here is
-- reachable only by a hand-written statement, which is exactly the case a
-- constraint is for.
ALTER TABLE "association" ADD CONSTRAINT "association_bylawsMaxMembersPerProxyHolder_check"
  CHECK ("bylawsMaxMembersPerProxyHolder" BETWEEN 1 AND 999);

-- CreateTable
--
-- heldOn is a DATE and not a timestamp. A general meeting decides who may vote
-- at it as of the day it is held, and the question is which calendar day: read
-- as an instant, a meeting day would fall on the wrong side of local midnight
-- for the two hours a night Stockholm runs ahead of UTC.
--
-- The time and the place EFL 6 kap. 22 § has the notice state are deliberately
-- absent: they belong to the notice, and a second copy here would be a second
-- answer to one question.
CREATE TABLE "meeting" (
    "id" TEXT NOT NULL,
    "kind" "MeetingKind" NOT NULL,
    "heldOn" DATE NOT NULL,
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The agenda is a running order, so the position is part of the row and unique
-- per meeting: EFL 6 kap. 22 § has the notice state clearly the matters to be
-- dealt with, and the meeting works down them.
CREATE TABLE "agenda_item" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agenda_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
--
-- The outcome is a column and not something computed from the three counts, and
-- that is the statute rather than a shortcut: EFL 6 kap. 33 § carries an
-- ordinary question on more than half of the votes cast and gives the chair a
-- casting vote on a tie, 34 § elects whoever received the most votes, and BRL
-- 9 kap. 14 § 6 puts BRL 9 kap. 23 § and 24 § forsta stycket in place of EFL
-- 6 kap. 35 and 36 §§ where the bylaws are being changed. Which rule an item
-- falls under is a fact about the item that nothing here holds.
--
-- recordedByPersonId is a plain column and not a foreign key, for the reason
-- motion."submittedByPersonId" and booking."bookedByPersonId" are: every
-- referential action available either rewrites this row when a person is erased
-- or vetoes the erasure outright.
CREATE TABLE "meeting_decision" (
    "id" TEXT NOT NULL,
    "agendaItemId" TEXT NOT NULL,
    "outcome" "MeetingDecisionOutcome" NOT NULL,
    "votesFor" INTEGER NOT NULL,
    "votesAgainst" INTEGER NOT NULL,
    "votesAbstaining" INTEGER NOT NULL,
    "closedBallot" BOOLEAN NOT NULL DEFAULT false,
    "recordedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_decision_pkey" PRIMARY KEY ("id")
);

-- A tally cannot run backwards.
--
-- Not a mis-typed number but a nonsense one, and the one thing about a recorded
-- count that a table can decide without knowing which majority rule the item
-- falls under. The API refuses it first; this is what stops a hand-written
-- statement from putting a negative into the protokoll's own figures.
ALTER TABLE "meeting_decision" ADD CONSTRAINT "meeting_decision_counts_check"
  CHECK (
    "votesFor" >= 0 AND "votesAgainst" >= 0 AND "votesAbstaining" >= 0
  );

-- CreateTable
--
-- personId is a plain column, like every person reference outside the
-- registers.
CREATE TABLE "meeting_attendance" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "personId" TEXT NOT NULL,
    "capacity" "AttendanceCapacity" NOT NULL,
    "mode" "AttendanceMode" NOT NULL,
    "onBehalfOfPersonId" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "meeting_attendance_pkey" PRIMARY KEY ("id")
);

-- Only an assistant came with somebody, and an assistant always did.
--
-- This is what makes the unique index below express EFL 6 kap. 7 §'s "hogst ett
-- assistant" in the database. A null repeats freely in a PostgreSQL unique
-- index, so with this constraint in place the index binds the assistant lines
-- and leaves the member and proxy holder lines alone.
--
-- A proxy holder's line carries none on purpose: the statute lets one proxy
-- holder carry several members where the bylaws allow it, so which members a
-- proxy holder is here for is the authorisations they hold and not a single
-- column.
--
-- Nobody stands in for themselves, which is the second half. It is stated here
-- rather than only in the service because a self-referencing line would make a
-- assistant their own principal and satisfy every count in the register.
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_onBehalfOf_check"
  CHECK (
    ("onBehalfOfPersonId" IS NOT NULL) = ("capacity" = 'ASSISTANT')
    AND ("onBehalfOfPersonId" IS NULL OR "onBehalfOfPersonId" <> "personId")
  );

-- CreateTable
--
-- authorisedOn is a DATE because EFL 6 kap. 4 § runs one year from the day the
-- proxy authorisation was issued, and a year is counted in days.
--
-- The row records that the board saw a written, dated and signed proxy
-- authorisation. It records no signature and implies none: a document that has
-- to be signed under that Act may be signed with an advanced electronic
-- signature (EFL 1 kap. 15 §), which is a trust service this platform does not
-- provide.
CREATE TABLE "proxy_authorisation" (
    "id" TEXT NOT NULL,
    "meetingId" TEXT NOT NULL,
    "memberPersonId" TEXT NOT NULL,
    "proxyHolderPersonId" TEXT NOT NULL,
    "ground" "RepresentativeGround" NOT NULL,
    "authorisedOn" DATE NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "recordedByPersonId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxy_authorisation_pkey" PRIMARY KEY ("id")
);

-- Nobody is their own proxy holder.
--
-- A member appoints a proxy holder because they are not personally present (EFL
-- 6 kap. 4 § forsta stycket), so an authorisation naming the member as the
-- holder is not a narrow case to refuse but a contradiction. It matters more
-- than it looks: such a row would satisfy the per-holder count without anybody
-- standing in for anybody, and it would let a member reach the register twice.
ALTER TABLE "proxy_authorisation" ADD CONSTRAINT "proxy_authorisation_not_self_check"
  CHECK ("proxyHolderPersonId" <> "memberPersonId");

-- CreateTable
--
-- Reserved schema room. Nothing in this module casts a vote; the chair records
-- the outcome as counts, which is how EFL 6 kap. 39 § has the protokoll state
-- an omrostning.
--
-- "voterPersonId" is nullable from the start and that is the whole reason the
-- table is created now. A meeting may resolve to vote by closed ballot (sluten
-- omrostning), which is lawful on request and is the ordinary way an election is
-- held, and a closed ballot is a vote with no voter to record. Adding the column
-- later would mean migrating a table the association's minutes are built from.
CREATE TABLE "meeting_vote" (
    "id" TEXT NOT NULL,
    "agendaItemId" TEXT NOT NULL,
    "voterPersonId" TEXT,
    "choice" "VoteChoice" NOT NULL,
    "castAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_vote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_heldOn_idx" ON "meeting"("heldOn");

-- CreateIndex
CREATE UNIQUE INDEX "agenda_item_meetingId_position_key" ON "agenda_item"("meetingId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "meeting_decision_agendaItemId_key" ON "meeting_decision"("agendaItemId");

-- CreateIndex
CREATE INDEX "meeting_attendance_meetingId_capacity_idx" ON "meeting_attendance"("meetingId", "capacity");

-- CreateIndex
CREATE INDEX "meeting_attendance_personId_idx" ON "meeting_attendance"("personId");

-- CreateIndex
--
-- One line per person, meeting and capacity. Two would be one person counted
-- twice on the list the votes are read from - and a person is legitimately on
-- it twice with two capacities, which is why the capacity is part of the key: a
-- member who arrives holding a neighbour's proxy authorisation has two votes
-- and one body.
CREATE UNIQUE INDEX "meeting_attendance_meetingId_personId_capacity_key" ON "meeting_attendance"("meetingId", "personId", "capacity");

-- CreateIndex
--
-- At most one assistant per member or proxy holder (EFL 6 kap. 7 §). See the
-- check constraint on "onBehalfOfPersonId" above for why a plain unique index
-- states a rule that binds one capacity only.
CREATE UNIQUE INDEX "meeting_attendance_meetingId_onBehalfOfPersonId_key" ON "meeting_attendance"("meetingId", "onBehalfOfPersonId");

-- CreateIndex
CREATE INDEX "proxy_authorisation_meetingId_proxyHolderPersonId_idx" ON "proxy_authorisation"("meetingId", "proxyHolderPersonId");

-- CreateIndex
CREATE INDEX "proxy_authorisation_memberPersonId_idx" ON "proxy_authorisation"("memberPersonId");

-- CreateIndex
CREATE INDEX "proxy_authorisation_proxyHolderPersonId_idx" ON "proxy_authorisation"("proxyHolderPersonId");

-- CreateIndex
--
-- One row per member and proxy holder, and deliberately not one per member.
--
-- EFL 6 kap. 4 § forsta stycket allows a member no more than one proxy holder,
-- and that is a rule about the authorities standing at any moment. A unique key
-- on the member alone would force a replacement to overwrite the first
-- authority, and the replaced proxy holder's own record that they once held
-- somebody's vote would be gone - the audit entry names the member and not the
-- holder, so nothing else here could answer that person's access request for
-- it. So a replacement writes the withdrawal on the first row and a second row
-- for the second proxy holder, and the standing-authority rule is checked in
-- the service inside the transaction that writes.
--
-- It cannot be checked here. The rule applies to the rows with no withdrawal
-- date, which is a partial unique index, and the schema this migration is
-- generated from can declare neither that nor NULLS NOT DISTINCT - so an index
-- created here alone would read as drift the next time a migration is generated.
--
-- The mirror rule - nobody represents more than one member unless the bylaws
-- determine otherwise (BRL 9 kap. 14 § 4) - is a count against a setting and is
-- checked where the setting is read.
CREATE UNIQUE INDEX "proxy_authorisation_meetingId_memberPersonId_proxyHolderPer_key" ON "proxy_authorisation"("meetingId", "memberPersonId", "proxyHolderPersonId");

-- CreateIndex
CREATE INDEX "proxy_authorisation_meetingId_memberPersonId_idx" ON "proxy_authorisation"("meetingId", "memberPersonId");

-- CreateIndex
CREATE INDEX "meeting_vote_agendaItemId_idx" ON "meeting_vote"("agendaItemId");

-- CreateIndex
CREATE INDEX "meeting_vote_voterPersonId_idx" ON "meeting_vote"("voterPersonId");

-- AddForeignKey
--
-- The four tables below cascade from the meeting, because each of them says what
-- it is only through the meeting it belongs to - the argument an event
-- occurrence makes about its series. Nothing deletes a meeting, which is what
-- stands in front of the cascade.
ALTER TABLE "agenda_item" ADD CONSTRAINT "agenda_item_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_decision" ADD CONSTRAINT "meeting_decision_agendaItemId_fkey" FOREIGN KEY ("agendaItemId") REFERENCES "agenda_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_attendance" ADD CONSTRAINT "meeting_attendance_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "proxy_authorisation" ADD CONSTRAINT "proxy_authorisation_meetingId_fkey" FOREIGN KEY ("meetingId") REFERENCES "meeting"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_vote" ADD CONSTRAINT "meeting_vote_agendaItemId_fkey" FOREIGN KEY ("agendaItemId") REFERENCES "agenda_item"("id") ON DELETE CASCADE ON UPDATE CASCADE;
