import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import {
  fetchMeeting,
  fetchMeetings,
  type Meeting,
  type MeetingSummary,
} from "../api/meetings";
import { Notice } from "../ui/Notice";
import { MeetingAgendaPanel } from "./MeetingAgendaPanel";
import { MeetingCheckInPanel } from "./MeetingCheckInPanel";
import { MeetingDecisionsPanel } from "./MeetingDecisionsPanel";
import { MeetingListPanel } from "./MeetingListPanel";
import { MeetingNoticePanel } from "./MeetingNoticePanel";
import { MeetingProxyPanel } from "./MeetingProxyPanel";
import { useMeetingPeople } from "./use-meeting-people";
import { VotingRegisterPanel } from "./VotingRegisterPanel";

export interface MeetingsScreenProps {
  viewer: Viewer;
}

/**
 * The general meeting (foreningsstamman), as the board arranges and runs it.
 *
 * One capability across the whole screen, unlike the events and motions screens
 * which each have two halves for two audiences. Arranging a meeting, writing its
 * agenda, summoning the members, registering an authority, checking people in,
 * reading the voting register and minuting a decision are one office doing one
 * job, and `meetings:manage` gates all of it. There is no member's own view of a
 * meeting here, deliberately: what a member holds at a general meeting is the
 * right to attend, speak and vote, and none of that is something this platform
 * does - the meeting happens in a room or on a call, and what the platform does
 * is the record-keeping.
 *
 * Hiding the screen from an account that does not hold the capability is
 * courtesy only. The API refuses every call on it either way.
 *
 * ## One reader, and it is this component
 *
 * Every act on every panel below ends by asking for the meeting again, and none
 * of them reads for itself. That is `refreshes`, and it is the same rule the
 * event sign-up panel follows for the same reason: an act that read for itself
 * would be a second reader with its own idea of when its answer is stale.
 *
 * Here it is more than a tidiness. The voting register is derived from the
 * member register, the residencies, the attendance lines and the standing
 * authorities together, and every write answers with the one row it wrote -
 * never with the register. So a check-in's answer cannot tell the screen how
 * many votes are now in the room, whether a proxy holder has just been left with
 * nothing to exercise because the member turned up, or whether the person
 * checked in is on the register at all. Only a read can, which is why every act
 * discards its answer and bumps this counter.
 *
 * The re-read happens whether the act succeeded or was refused. Several of these
 * refusals are about state a board has to look at next - an authority that does
 * not cover the meeting day, a proxy holder already carrying as many members as
 * the bylaws allow - and the panel showing it has to be showing the server's
 * answer rather than the one it last saw.
 *
 * ## Why the meeting is read whole
 *
 * The endpoint answers with the agenda, the list of those present, the
 * authorities, the association's bylaws and the register in one payload. A
 * screen that fetched the parts separately would show a state that never existed
 * at any single moment - a register computed before a check-in beside a list
 * written after it - which at a door, with a queue, is worse than a slower
 * screen.
 *
 * ## Why two panels are remounted on what the server said
 *
 * The agenda and each decision are drafts a board is part way through typing,
 * held as the panel's own state rather than re-derived on every render. The keys
 * below tie those drafts to the answer they were seeded from, so a save that
 * landed replaces the fields and a re-read that changed nothing leaves a
 * half-typed correction alone.
 */
export function MeetingsScreen({ viewer }: MeetingsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canManage = viewer.capabilities.includes("meetings:manage");

  const [meetings, setMeetings] = useState<readonly MeetingSummary[] | null>(
    null,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  /**
   * Bumped to ask for the meetings again without changing what is asked for.
   *
   * An act needs a fresh read of the same thing, which is a request the reading
   * effects below cannot tell from the one they already made. This is how they
   * are told, and it keeps them the only things that read.
   */
  const [refreshes, setRefreshes] = useState(0);

  const people = useMeetingPeople();

  /**
   * Which read of one meeting is the current one.
   *
   * Two can be in flight at once - a board strikes somebody off while the answer
   * to the check-in before it is still coming back - and both answers are well
   * formed, so the screen cannot tell them apart by content. What it can say is
   * that only the newest may be applied; without that, whichever arrives last
   * wins and the older one puts a struck line back on the list.
   */
  const currentRead = useRef(0);

  useEffect(() => {
    if (!canManage) {
      return;
    }
    let active = true;
    void fetchMeetings().then((result) => {
      if (!active) {
        return;
      }
      if (result.ok) {
        setMeetings(result.value);
        setLoadFailed(false);
      } else {
        setLoadFailed(true);
      }
    });
    return () => {
      active = false;
    };
  }, [canManage, refreshes]);

  useEffect(() => {
    if (selectedId === null) {
      // Nothing to read, and nothing to clear: the meeting on screen is dropped
      // by whatever changed the selection, not by this effect.
      return;
    }
    const version = ++currentRead.current;
    void fetchMeeting(selectedId).then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      if (result.ok) {
        setMeeting(result.value);
        setLoadFailed(false);
      } else {
        /*
         * The meeting on screen is kept. A failed re-read leaves the board
         * looking at the last thing the server said, which is still a true
         * picture of a moment - and the notice above says the read failed. What
         * must not happen is the panels emptying under somebody at a door.
         */
        setLoadFailed(true);
      }
    });
    /*
     * Leaving, or selecting another meeting, supersedes whatever is in flight,
     * so an answer that arrives afterwards is dropped by the same check that
     * drops a superseded one.
     */
    return () => {
      currentRead.current += 1;
    };
  }, [selectedId, refreshes]);

  const reload = (): void => {
    setRefreshes((count) => count + 1);
  };

  /**
   * Opens one meeting, dropping whatever the last one left on screen.
   *
   * The clearing happens here rather than in the reading effect, and it has to:
   * a board that opened a second meeting would otherwise read the first one's
   * agenda, list and register for as long as the new read took, which at a door
   * is a screen confidently showing the wrong meeting. Opening the meeting that
   * is already open changes nothing, so it does not blank the panels either.
   */
  const selectMeeting = (meetingId: string): void => {
    if (meetingId !== selectedId) {
      setMeeting(null);
    }
    setSelectedId(meetingId);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("meetings.title")}</h1>
        <p className="text-body text-ink-muted">{t("meetings.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("meetings.loadFailed")}
        </Notice>
      ) : null}

      {/* The names come from the address book, and a meeting is still workable
          without them: every identifier renders as itself. Said once here rather
          than repeated on the six panels that would each have to say it. */}
      {people.failed ? (
        <Notice tone="warn" live>
          {t("meetings.peopleLoadFailed")}
        </Notice>
      ) : null}

      {!canManage ? null : meetings === null ? (
        loadFailed ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("meetings.loading")}
          </p>
        )
      ) : (
        <MeetingListPanel
          meetings={meetings}
          selectedId={selectedId}
          onSelect={selectMeeting}
          onChanged={reload}
        />
      )}

      {meeting === null ? null : (
        <>
          <MeetingAgendaPanel
            /*
             * The draft follows the agenda the server answered with. Keyed on
             * the titles in their order rather than on a revision the API does
             * not carry: a save that landed changes them, and a re-read that
             * changed nothing leaves a half-typed row alone.
             */
            key={`agenda:${meeting.id}:${meeting.agenda
              .map((item) => item.title)
              .join(" ")}`}
            meeting={meeting}
            onChanged={reload}
          />

          <MeetingNoticePanel
            meeting={meeting}
            people={people}
            onChanged={reload}
          />

          <MeetingProxyPanel
            meeting={meeting}
            people={people}
            onChanged={reload}
          />

          <MeetingCheckInPanel
            meeting={meeting}
            people={people}
            onChanged={reload}
          />

          <VotingRegisterPanel meeting={meeting} people={people} />

          <MeetingDecisionsPanel
            key={`decisions:${meeting.id}:${meeting.agenda
              .map((item) =>
                item.decision === null ? "-" : item.decision.recordedAt,
              )
              .join(" ")}`}
            meeting={meeting}
            people={people}
            onChanged={reload}
          />
        </>
      )}
    </div>
  );
}
