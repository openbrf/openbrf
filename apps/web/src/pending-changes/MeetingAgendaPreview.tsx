import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchMeeting, type Meeting } from "../api/meetings";
import { formatEventDay } from "../events/event-calendar";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";

/** What `meeting_set_agenda` holds, narrowed from the input the queue sends. */
interface AgendaProposal {
  meetingId: string;
  expectedItemIds: readonly string[];
  titles: readonly string[];
}

/**
 * The held input as an agenda proposal, or null when it is not one.
 *
 * The input is `unknown` on the wire, so every field is checked rather than
 * assumed. A null answer leaves the generic preview alone on the screen, which
 * is always shown and never depends on this one.
 */
export function agendaProposalOf(input: unknown): AgendaProposal | null {
  if (typeof input !== "object" || input === null) {
    return null;
  }
  const { meetingId, expectedItemIds, items } = input as Record<
    string,
    unknown
  >;
  if (
    typeof meetingId !== "string" ||
    !Array.isArray(expectedItemIds) ||
    !expectedItemIds.every((id): id is string => typeof id === "string") ||
    !Array.isArray(items)
  ) {
    return null;
  }
  const titles: string[] = [];
  for (const item of items as unknown[]) {
    const title =
      typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)["title"]
        : undefined;
    if (typeof title !== "string") {
      return null;
    }
    titles.push(title);
  }
  return { meetingId, expectedItemIds, titles };
}

/**
 * Which of the current items the proposal leaves out, by position in the
 * current agenda.
 *
 * The write replaces the whole list and carries titles only, so an item is kept
 * when a proposed item has its title; one title standing twice on either side
 * is matched one for one.
 */
export function droppedPositions(
  current: readonly string[],
  proposed: readonly string[],
): Set<number> {
  const left = new Map<string, number>();
  for (const title of proposed) {
    left.set(title, (left.get(title) ?? 0) + 1);
  }
  const dropped = new Set<number>();
  current.forEach((title, index) => {
    const count = left.get(title) ?? 0;
    if (count > 0) {
      left.set(title, count - 1);
    } else {
      dropped.add(index);
    }
  });
  return dropped;
}

/** The proposed items no current item has the title of, matched likewise. */
export function addedPositions(
  current: readonly string[],
  proposed: readonly string[],
): Set<number> {
  const left = new Map<string, number>();
  for (const title of current) {
    left.set(title, (left.get(title) ?? 0) + 1);
  }
  const added = new Set<number>();
  proposed.forEach((title, index) => {
    const count = left.get(title) ?? 0;
    if (count > 0) {
      left.set(title, count - 1);
    } else {
      added.add(index);
    }
  });
  return added;
}

/** What one read of one meeting answered, with the read it answers. */
interface Read {
  meetingId: string;
  attempt: number;
  meeting: Meeting | null;
}

/**
 * The preview of `meeting_set_agenda` (ADR 0039, §5): which meeting it is, and
 * the agenda as it stands beside the one it would leave, with the items it
 * drops marked.
 *
 * The held input names the meeting and the items it was written against by id,
 * which says nothing to the person confirming. The meeting is read now, as the
 * meetings screen reads it, so what stands beside the proposal is the agenda
 * the confirmation would replace and not the one the proposer saw. When the two
 * differ the card says so, because the write is then refused with
 * `agenda-changed` rather than written over.
 *
 * It sits above the generic preview and does not replace it: that one shows
 * every value as it will be sent and cannot disagree with it. Everything here is
 * text, so a title a model wrote is shown and never run.
 */
export function MeetingAgendaPreview({
  proposal,
}: {
  proposal: AgendaProposal;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [read, setRead] = useState<Read | null>(null);
  // Bumped by the retry button; a read that a newer one superseded is dropped.
  const [attempt, setAttempt] = useState(0);
  const { meetingId } = proposal;

  useEffect(() => {
    let current = true;
    void fetchMeeting(meetingId).then((result) => {
      if (current) {
        setRead({
          meetingId,
          attempt,
          meeting: result.ok ? result.value : null,
        });
      }
    });
    return () => {
      current = false;
    };
  }, [meetingId, attempt]);

  // Only the answer to the read being waited for counts: the one from before
  // a retry, or for another meeting, is not shown while the new one runs.
  const answered =
    read !== null && read.meetingId === meetingId && read.attempt === attempt;
  if (!answered) {
    return (
      <p role="status" className="text-small text-ink-muted">
        {t("pendingChanges.meetingAgenda.loading")}
      </p>
    );
  }
  if (read.meeting === null) {
    return (
      <LoadFailure
        messageKey="pendingChanges.meetingAgenda.loadFailed"
        onRetry={() => {
          setAttempt((value) => value + 1);
        }}
      />
    );
  }

  const { meeting } = read;
  const currentTitles = meeting.agenda.map((item) => item.title);
  const dropped = droppedPositions(currentTitles, proposal.titles);
  const added = addedPositions(currentTitles, proposal.titles);
  const unchangedSince =
    meeting.agenda.length === proposal.expectedItemIds.length &&
    meeting.agenda.every(
      (item, index) => item.id === proposal.expectedItemIds[index],
    );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-body">
        <span className="font-semibold">
          {t(`meetings.kind.${meeting.kind}`)}
        </span>{" "}
        <span className="font-data text-data">
          <time dateTime={meeting.heldOn}>
            {formatEventDay(meeting.heldOn, i18n.language)}
          </time>
        </span>
      </p>

      {meeting.concludedAt === null ? null : (
        <Notice tone="warn">{t("meetings.agenda.heldNotice")}</Notice>
      )}
      {meeting.concludedAt !== null || !meeting.summoned ? null : (
        <Notice tone="warn">{t("meetings.agenda.summonedNotice")}</Notice>
      )}
      {unchangedSince ? null : (
        <Notice tone="warn">{t("pendingChanges.meetingAgenda.changed")}</Notice>
      )}
      {dropped.size === 0 ? null : (
        <Notice tone="warn">
          {t("pendingChanges.meetingAgenda.dropsCount", {
            count: dropped.size,
          })}
        </Notice>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <AgendaColumn
          heading={t("pendingChanges.meetingAgenda.current")}
          titles={currentTitles}
          flagged={dropped}
          flag={t("pendingChanges.meetingAgenda.dropped")}
          empty={t("meetings.agenda.empty")}
        />
        <AgendaColumn
          heading={t("pendingChanges.meetingAgenda.proposed")}
          titles={proposal.titles}
          flagged={added}
          flag={t("pendingChanges.meetingAgenda.added")}
          empty={t("meetings.agenda.empty")}
        />
      </div>
    </div>
  );
}

/**
 * One running order. A flagged item says so in words as well as in weight,
 * since colour alone is not a signal a board member can be left to read.
 */
function AgendaColumn({
  heading,
  titles,
  flagged,
  flag,
  empty,
}: {
  heading: string;
  titles: readonly string[];
  flagged: ReadonlySet<number>;
  flag: string;
  empty: string;
}): ReactElement {
  return (
    <section className="flex flex-col gap-2" aria-label={heading}>
      <h4 className="text-label text-ink-muted uppercase">{heading}</h4>
      {titles.length === 0 ? (
        <p className="text-small text-ink-muted">{empty}</p>
      ) : (
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          {titles.map((title, index) => (
            // A position is the only identity a proposed title has.
            <li key={index}>
              <span className="break-words whitespace-pre-wrap">{title}</span>
              {flagged.has(index) ? (
                <>
                  {" "}
                  <span className="text-chip font-semibold uppercase">
                    {flag}
                  </span>
                </>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
