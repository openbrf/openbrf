import { useRef, useState, type ReactElement } from "react";
import type { AudienceListView, AudienceView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { createGroup } from "../api/feed";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL, QUIET_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import type { AudienceListFailure } from "./use-audiences";
import { groupNameFailureKey } from "./feed-failures";
import { GROUP_NAME_MAX_LENGTH } from "./feed-limits";
import { GroupPanel } from "./GroupPanel";

/** What an audience is called on screen: a group's own name, or its kind's. */
export function audienceName(
  audience: Pick<AudienceView, "kind" | "name">,
  t: (key: TranslationKey) => string,
): string {
  if (audience.name !== null) {
    return audience.name;
  }
  return audience.kind === "BOARD"
    ? t("feed.audience.board")
    : t("feed.audience.all");
}

export interface AudiencePanelProps {
  list: AudienceListView;
  /** The last read of the list that did not answer, with the list still on screen. */
  failure: AudienceListFailure | null;
  /** The audience open, or null for the whole feed. */
  selected: string | null;
  onSelect: (audienceId: string | null) => void;
  /** Reads the list again, after a failed read or once it has changed. */
  onReload: () => Promise<boolean>;
  /** Called with a group this account has just made, which it then opens. */
  onCreated: (audienceId: string) => void;
  /** Called once this account has left the group that was open. */
  onLeft: () => void;
}

/**
 * The audiences (målgrupper) this account is in, and the acts that change them.
 *
 * Alla, Styrelsen for a board seat holder, and each group the reader is in -
 * each one a way of reading the feed narrowed to it, with what is new in it
 * since the reader last looked. "Hela flödet" is every one of them at once.
 *
 * ## Which audiences exist is the server's answer
 *
 * Nothing here adds an audience to the list or takes one off it. Making a group
 * and leaving one are both followed by reading the list again, because a list
 * this screen edited would be a list nothing on the server ever said - and a
 * group is invisible to anybody who is not in it, so the list is also the whole
 * of what the reader can learn about which groups there are.
 *
 * ## Making a group, and who is in one
 *
 * Somebody who lives here may make a group; the administrator, who lives
 * nowhere, is not offered the form. Who is in the group that is open, and the
 * two acts a member has - putting a neighbour in and leaving - are the group's
 * own panel below the list, keyed on the group so nothing typed for one is in
 * the next.
 *
 * ## A failure belongs to the panel that owns the act
 *
 * Making a group is this panel's act, so its refusal is shown here - also when
 * there is no audience to open, which is exactly the case the form exists for:
 * somebody who lives here, is in no group yet and is refused the one they are
 * making.
 */
export function AudiencePanel({
  list,
  failure,
  selected,
  onSelect,
  onReload,
  onCreated,
  onLeft,
}: AudiencePanelProps): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  const create = useSaveAction(createGroup, (made) => {
    setName("");
    onCreated(made.audienceId);
  });
  const creating = create.state.kind === "saving";
  const open = list.audiences.find((each) => each.id === selected) ?? null;

  return (
    <Panel
      title={t("feed.audiences.title")}
      description={t("feed.audiences.intro")}
      notice={
        create.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(groupNameFailureKey(create.state.failure))}
          </Notice>
        ) : failure === "notOffered" ? (
          // Refused, not unanswered: nothing here is broken, so no retry.
          <Notice tone="info">{t("feed.notOffered")}</Notice>
        ) : failure !== null ? (
          <LoadFailure
            messageKey="feed.audiences.relistFailed"
            onRetry={() => {
              void onReload();
            }}
          />
        ) : null
      }
    >
      {list.audiences.length === 0 ? (
        <Notice tone="info">{t("feed.audiences.noGroupYet")}</Notice>
      ) : (
        // A landmark of its own, named like the panel: it is how the reader
        // moves between the audiences, and a screen reader lists it as such.
        <nav aria-label={t("feed.audiences.title")}>
          <ul className="flex flex-col gap-1">
            <li>
              <AudienceButton
                label={t("feed.audiences.everything")}
                unread={0}
                current={selected === null}
                onPress={() => {
                  onSelect(null);
                }}
              />
            </li>
            {list.audiences.map((audience) => (
              <li key={audience.id}>
                <AudienceButton
                  label={audienceName(audience, t)}
                  unread={audience.unread}
                  current={audience.id === selected}
                  onPress={() => {
                    onSelect(audience.id);
                  }}
                />
              </li>
            ))}
          </ul>
        </nav>
      )}

      {list.mayCreateGroup ? (
        <LockedForm
          className="flex flex-col gap-2 border-t border-line pt-4"
          locked={creating}
          focusFallback={nameRef}
          onSend={() => {
            void create.submit({ name });
          }}
        >
          <label className={LABEL}>
            {t("feed.group.name")}
            <input
              ref={nameRef}
              type="text"
              className={FIELD}
              value={name}
              maxLength={GROUP_NAME_MAX_LENGTH}
              required
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          </label>
          <p className={HINT}>{t("feed.group.hint")}</p>
          <div>
            <button
              type="submit"
              className={QUIET_BUTTON}
              disabled={creating || name.trim() === ""}
            >
              {creating ? t("feed.group.creating") : t("feed.group.create")}
            </button>
          </div>
        </LockedForm>
      ) : null}

      {open?.kind === "GROUP" ? (
        <GroupPanel
          // A different group is a different panel: its member list, its
          // search and the neighbour picked in it are all that group's.
          key={open.id}
          audienceId={open.id}
          onLeft={onLeft}
        />
      ) : null}
    </Panel>
  );
}

/**
 * One audience in the list: its name, and what is new in it.
 *
 * The open one is marked for a screen reader by `aria-current` and for
 * everybody else by the brass edge DESIGN.md gives an active selection - and by
 * weight, so the mark is not colour alone.
 */
function AudienceButton({
  label,
  unread,
  current,
  onPress,
}: {
  label: string;
  unread: number;
  current: boolean;
  onPress: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      aria-current={current}
      className={`flex min-h-11 w-full items-center gap-2 rounded-control border-l-4 px-3 text-left text-small transition-colors duration-150 ease-out hover:bg-sunken ${
        current
          ? "border-trust bg-sunken font-semibold text-ink"
          : "border-transparent text-ink-muted"
      }`}
      onClick={onPress}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {unread > 0 ? (
        <span className="rounded-control bg-trust px-1.5 font-data text-data text-on-trust">
          <span aria-hidden="true">{unread}</span>
          <span className="sr-only">
            {t("feed.audiences.unread", { count: unread })}
          </span>
        </span>
      ) : null}
    </button>
  );
}
