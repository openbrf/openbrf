import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Meeting, VotingRegisterLine } from "../api/meetings";
import { HINT } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { MeetingPersonName } from "./MeetingPersonName";
import type { MeetingPeople } from "./use-meeting-people";

export interface VotingRegisterPanelProps {
  meeting: Meeting;
  people: MeetingPeople;
}

/**
 * The voting register (rostlangden): one line per vote, and who exercises it.
 *
 * ## A reading and never a form
 *
 * There is no control on this panel, because there is nothing here anybody
 * writes. The register is derived from the member register, the residencies, the
 * attendance lines and the standing authorities every time the meeting is read,
 * and it is deliberately never stored: a saved count goes stale the moment
 * somebody moves or a transfer completes, and it goes stale silently. What
 * changes a line is checking somebody in or registering an authority, which is
 * what the panels above are for.
 *
 * ## One vote per membership
 *
 * EFL 6 kap. 3 § gives the vote to the member. BRL 9 kap. 14 § 1 permits a
 * deviation in one case only and it is not this one, so a member holding two
 * apartments has one vote and joint holders of one bostadsratt have one between
 * them. A line naming several members is that second case, and the panel says so
 * in words: two people reading a register that showed one row for two names
 * would otherwise reasonably expect two votes.
 *
 * A line can name several proxy holders for the same reason. Joint holders are
 * separate members and may each have appointed a different one while both stay
 * away, and the vote they share cannot be split between them - which of them
 * exercises it is for the meeting to settle when it approves this register under
 * EFL 6 kap. 27 §.
 *
 * ## What is counted, and what is deliberately not
 *
 * Votes present is the size of the register in the room and is not a majority
 * basis. EFL measures an ordinary majority against the votes cast, and somebody
 * present who does not vote has cast none - so what a decision needed is the
 * chair's to state, and the decision panel takes the counts rather than deriving
 * them from here.
 *
 * Assistants are counted separately and carry nothing. They are on the list
 * because 6 kap. 27 § covers them and they may speak under 6 kap. 7 §.
 *
 * ## The two lists that exist so nobody is dropped in silence
 *
 * Somebody recorded present as a member whom the register does not show as a
 * member on the meeting day is named rather than omitted: check-in happens
 * before the meeting and the register keeps moving until the day itself, so this
 * is what a transfer completed in between looks like - and a chair with a name
 * at the door and no line for it here has been told nothing.
 *
 * A proxy holder present who exercises no vote is named for the same reason, and
 * four different things look like it: the authority was withdrawn, it has run
 * out under EFL 6 kap. 4 §, the member who gave it is no longer a member, or
 * that member turned up and is exercising their own right - which is the one case
 * where nothing is wrong at all. The panel says all four rather than picking
 * one, because the platform cannot tell them apart and guessing would send a
 * board looking for a problem that is not there.
 *
 * ## The clause the platform reports and does not apply
 *
 * Where the bylaws limit the vote of a member holding nothing but a garage, a
 * store or another space used primarily for storage (BRL 9 kap. 14 § 1), the
 * register says the clause stands and applies nothing. An apartment carries a
 * number, a floor, a participation share and an initial share capital, and none
 * of those tells a garage from a flat - so the meeting applies it, which is
 * where 6 kap. 27 § puts the decision in any case.
 */
export function VotingRegisterPanel({
  meeting,
  people,
}: VotingRegisterPanelProps): ReactElement {
  const { t } = useTranslation();
  const register = meeting.votingRegister;

  return (
    <Panel
      title={t("meetings.register.title")}
      description={
        meeting.concludedAt === null
          ? t("meetings.register.descriptionArranging")
          : t("meetings.register.descriptionHeld")
      }
      notice={
        register.storageOnlyVoteLimited ? (
          <Notice tone="warn">{t("meetings.register.storageOnly")}</Notice>
        ) : null
      }
    >
      <dl className="flex flex-wrap gap-6">
        <Count
          label={t("meetings.register.votesTotal")}
          value={register.votesTotal}
        />
        <Count
          label={t("meetings.register.votesPresent")}
          value={register.votesPresent}
        />
        <Count
          label={t("meetings.register.assistantsPresent")}
          value={register.assistantsPresent}
        />
      </dl>

      <p className={HINT}>{t("meetings.register.notAMajorityBasis")}</p>

      {register.lines.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("meetings.register.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {register.lines.map((line) => (
            <li key={line.memberPersonIds.join("+")}>
              <RegisterLine line={line} people={people} />
            </li>
          ))}
        </ul>
      )}

      {register.presentWithoutMembership.length === 0 ? null : (
        <Aside
          heading={t("meetings.register.withoutMembershipHeading")}
          explanation={t("meetings.register.withoutMembershipExplanation")}
          personIds={register.presentWithoutMembership}
          people={people}
        />
      )}

      {register.proxyHoldersWithoutVote.length === 0 ? null : (
        <Aside
          heading={t("meetings.register.withoutVoteHeading")}
          explanation={t("meetings.register.withoutVoteExplanation")}
          personIds={register.proxyHoldersWithoutVote}
          people={people}
        />
      )}
    </Panel>
  );
}

/** One figure, with the word that says what it counts. */
function Count({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-label text-ink-muted uppercase">{label}</dt>
      <dd className="font-data text-display">{value}</dd>
    </div>
  );
}

/** One vote: who holds it, whether it is in the room, and through whom. */
function RegisterLine({
  line,
  people,
}: {
  line: VotingRegisterLine;
  people: MeetingPeople;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <article
      className={[
        "flex flex-col gap-2 rounded-control border bg-page px-3 py-2",
        line.votePresent ? "border-line-strong" : "border-dashed border-line",
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {line.memberPersonIds.map((personId) => (
            <li key={personId} className="text-body">
              <MeetingPersonName
                person={people.find(personId)}
                personId={personId}
              />
            </li>
          ))}
        </ul>
        <span className="text-chip uppercase">
          {line.votePresent
            ? t("meetings.register.votePresent")
            : t("meetings.register.voteAbsent")}
        </span>
      </div>

      {/* Said in words rather than left to be inferred from two names on one
          row, because one vote shared by two people is exactly what a reader
          would otherwise read as two votes. */}
      {line.jointlyHeld ? (
        <p className={HINT}>{t("meetings.register.jointlyHeld")}</p>
      ) : null}

      {/* Empty where no MEMBER residency covers the meeting day. The vote stands
          either way - EFL 6 kap. 3 § gives it to the member and not to the
          holding - so the absence is stated rather than rendered as a blank. */}
      {line.apartmentIds.length === 0 ? (
        <p className={HINT}>{t("meetings.register.noHolding")}</p>
      ) : null}

      {line.presentMemberPersonIds.length === 0 ? null : (
        <p className={HINT}>
          {t("meetings.register.presentInPerson", {
            count: line.presentMemberPersonIds.length,
          })}
        </p>
      )}

      {line.proxyHolders.length === 0 ? null : (
        <ul className="flex flex-col gap-1">
          {line.proxyHolders.map((holder) => (
            <li
              key={`${holder.personId}+${holder.memberPersonId}`}
              className={HINT}
            >
              {t("meetings.register.exercisedBy")}{" "}
              <MeetingPersonName
                person={people.find(holder.personId)}
                personId={holder.personId}
              />
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

/** A named list of people the register has something to say about. */
function Aside({
  heading,
  explanation,
  personIds,
  people,
}: {
  heading: string;
  explanation: string;
  personIds: readonly string[];
  people: MeetingPeople;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">{heading}</h3>
      <p className={HINT}>{explanation}</p>
      <ul className="flex flex-col gap-1">
        {personIds.map((personId) => (
          <li key={personId} className="text-small">
            <MeetingPersonName
              person={people.find(personId)}
              personId={personId}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}
