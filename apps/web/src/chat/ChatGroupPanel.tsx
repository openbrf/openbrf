import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import {
  addGroupMember,
  fetchGroupCandidates,
  fetchGroupMembers,
  leaveGroup,
  type ChatGroupCandidate,
  type ChatGroupMember,
} from "../api/chat";
import { FIELD, FIELD_DATA, HINT, LABEL, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { chatFailureKey } from "./chat-failures";

export interface ChatGroupPanelProps {
  chatId: string;
  /** Called once this account has left, so the screen can read its rooms again. */
  onLeft: () => void;
}

/**
 * Who is in a group, and the two acts a member of one has.
 *
 * ## Anybody in the room may put somebody in
 *
 * And nobody may take anybody else out. A private room in which one member could
 * throw out another would be a tribunal, and whoever pressed first would be its
 * judge. What ends somebody's place against their will is moving out, which the
 * register decides.
 *
 * So there is one control per person and it is on the reader's own row: leave.
 * The others are a list of names, with the day each was put into the room.
 *
 * ## The picker is the neighbours and not the register
 *
 * It offers the people who live here, searched by name and bounded, and never
 * somebody with protected personal data - the same rule the resident directory
 * lives under. That is a real limit and the right one: a room made by a
 * neighbour is not a place to put somebody whose whereabouts are protected.
 *
 * The list is the server's answer and this panel does not filter it: who may be
 * offered is a question about the register, and a browser deciding it would be
 * deciding it from a list it had already been given.
 */
export function ChatGroupPanel({
  chatId,
  onLeft,
}: ChatGroupPanelProps): ReactElement {
  const { t } = useTranslation();

  const [members, setMembers] = useState<readonly ChatGroupMember[] | null>(
    null,
  );
  const [candidates, setCandidates] = useState<readonly ChatGroupCandidate[]>(
    [],
  );
  /*
   * A read of this room that did not answer, one piece of state per read.
   *
   * Held rather than dropped, on the rule the screen above states: this panel
   * owns both reads, so it owns their refusals. Without them a member list that
   * could not be read says "reading who is in it" for ever, and a picker that
   * could not be read says there is nobody to add - two sentences about the room
   * that are not true.
   *
   * Two, because one would be cleared by whichever read answered next: the
   * picker is read again on every keystroke, and its answer says nothing about
   * whether the member list arrived.
   */
  const [membersFailure, setMembersFailure] = useState<ApiFailure | null>(null);
  const [candidatesFailure, setCandidatesFailure] = useState<ApiFailure | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState("");

  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const result = await fetchGroupMembers({ chatId });
      if (abandoned) {
        return;
      }
      if (!result.ok) {
        setMembersFailure(result.failure);
        return;
      }
      setMembers(result.value);
      setMembersFailure(null);
    })();

    return () => {
      abandoned = true;
    };
  }, [chatId]);

  /*
   * The picker is read again whenever the search changes, and the answer is
   * dropped if the room changed under it. Nothing is debounced: the list is
   * bounded at the server and a person types a few letters, so the cost of a
   * read per keystroke is one small query against an index.
   */
  useEffect(() => {
    let abandoned = false;

    void (async () => {
      const result = await fetchGroupCandidates({ chatId, search });
      if (abandoned) {
        return;
      }
      if (!result.ok) {
        // The list is emptied as well, because a list left standing would be
        // answering a search this room never answered.
        setCandidates([]);
        setCandidatesFailure(result.failure);
        return;
      }
      setCandidates(result.value);
      setCandidatesFailure(null);
    })();

    return () => {
      abandoned = true;
    };
  }, [chatId, search, members]);

  const add = useSaveAction(addGroupMember, (updated) => {
    setMembers(updated);
    setChosen("");
  });
  const leave = useSaveAction(leaveGroup, onLeft);

  const adding = add.state.kind === "saving";
  const failure =
    add.state.kind === "failed"
      ? add.state.failure
      : leave.state.kind === "failed"
        ? leave.state.failure
        : (membersFailure ?? candidatesFailure);

  const person = useCallback(
    (member: ChatGroupMember): string =>
      member.person.kind === "person"
        ? member.person.name
        : member.person.kind === "protected"
          ? t("chat.authorProtected")
          : t("chat.authorUnknown"),
    [t],
  );

  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-body font-semibold">{t("chat.members")}</h3>

      {failure === null ? null : (
        <Notice tone="danger" live>
          {t(chatFailureKey(failure))}
        </Notice>
      )}

      {members === null ? (
        membersFailure !== null ? null : (
          <p role="status" className="text-body text-ink-muted">
            {t("chat.membersReading")}
          </p>
        )
      ) : (
        <ul className="flex flex-col gap-1">
          {members.map((member) => (
            <li
              key={`${member.joinedAt}-${person(member)}`}
              className="flex flex-wrap items-center gap-2 text-body"
            >
              <span>{person(member)}</span>
              {member.createdTheGroup ? (
                <span className="inline-flex items-center rounded-control border border-line px-2 py-1 text-chip text-ink-muted uppercase">
                  {t("chat.createdTheGroup")}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen !== "") {
            void add.submit({ chatId, personId: chosen });
          }
        }}
      >
        <label className={LABEL}>
          {t("chat.addSearch")}
          <input
            type="search"
            className={FIELD}
            value={search}
            maxLength={100}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </label>

        <label className={LABEL}>
          {t("chat.addMember")}
          <select
            /*
             * The data face, because every option carries an apartment number
             * and a number in the interface face is a number a reader cannot
             * line up against the register. An option cannot hold two faces, so
             * the field takes the one the apartment needs - which is what the
             * move-in screen's apartment picker does.
             */
            className={FIELD_DATA}
            value={chosen}
            onChange={(event) => {
              setChosen(event.target.value);
            }}
          >
            <option value="">{t("chat.addNobody")}</option>
            {candidates.map((candidate) => (
              <option key={candidate.personId} value={candidate.personId}>
                {candidate.apartment === null
                  ? candidate.name
                  : t("chat.candidate", {
                      name: candidate.name,
                      apartment: candidate.apartment,
                    })}
              </option>
            ))}
          </select>
        </label>

        <p className={HINT}>{t("chat.addHint")}</p>

        <div className="flex flex-wrap gap-2">
          <button
            type="submit"
            className={QUIET_BUTTON}
            disabled={adding || chosen === ""}
          >
            {adding ? t("chat.adding") : t("chat.addSubmit")}
          </button>
          <button
            type="button"
            className={QUIET_BUTTON}
            disabled={leave.state.kind === "saving"}
            onClick={() => {
              void leave.submit({ chatId });
            }}
          >
            {leave.state.kind === "saving"
              ? t("chat.leaving")
              : t("chat.leave")}
          </button>
        </div>
        <p className={HINT}>{t("chat.leaveHint")}</p>
      </form>
    </section>
  );
}
