import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { saveMeetingBylaws } from "../api/instance";
import {
  MAX_MEMBERS_PER_PROXY_HOLDER,
  type MeetingBylaws,
  MIN_MEMBERS_PER_PROXY_HOLDER,
} from "../api/meetings";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

export interface MeetingBylawsPanelProps {
  /** The four clauses as stored. Never null: see the panel comment. */
  meetingBylaws: MeetingBylaws;
  onSaved?: (value: { meetingBylaws: MeetingBylaws }) => void;
  editable?: boolean;
}

const BYLAWS_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "proxy-limit-out-of-range": "settings.meetingBylaws.errors.proxyLimitInvalid",
  "invalid-body": "settings.meetingBylaws.errors.proxyLimitInvalid",
};

/**
 * What the association's bylaws say about the general meeting.
 *
 * Transcribed and never decided here, like the motion deadline beside it: what
 * this panel records is what the association's own stadgar already say.
 *
 * ## Why these four and no others
 *
 * BRL 9 kap. 14 § applies EFL 6 kap. to a housing cooperative with six
 * exceptions, and four of the six turn on the bylaws. Two are about who may act
 * for a member: only the member's spouse or cohabitant or another member may be
 * a proxy holder, and nobody may represent more than one member, in each case
 * unless the bylaws determine otherwise (§ 14 p. 4). One is about who may be
 * brought along: a member may bring only their spouse or cohabitant or another
 * member as an assistant, unless the bylaws determine otherwise (§ 14 p. 5). And
 * one is about the vote itself: a deviation from one member one vote is
 * permitted only where it limits the vote of a member holding nothing but a
 * garage, a store or another space used primarily for storage (§ 14 p. 1).
 *
 * The other two exceptions are not settings and never will be. Postal voting
 * does not apply to a housing cooperative at all (§ 14 p. 3, excepting EFL 6
 * kap. 6 §), and the meeting's powers may not be delegated to fullmaktige (§ 14
 * p. 2). Neither is something an association may switch on, so neither is a
 * field here.
 *
 * ## Nothing here is empty, and that is the point
 *
 * Unlike the motion deadline, which has no default because EFL 6 kap. 15 §
 * supplies no rule where the bylaws are silent, every clause here has a rule
 * that applies unless the bylaws displace it. So an association that has
 * recorded nothing is not half-configured: it is under the statute, and the
 * values this panel opens with say so. The proxy limit opens at one because that
 * is the housing cooperative's rule - EFL 6 kap. 5 §'s general three does not
 * apply - which is a figure a board transcribing its own stadgar should see
 * rather than have to know.
 *
 * ## Two of these are applied and two are stated
 *
 * The panel says which, because the difference decides what a board should
 * expect at a meeting. The platform holds membership, so it checks whether a
 * proxy holder is another member and counts how many members one is carrying.
 * It holds no record of who is anybody's spouse or cohabitant, and none of what
 * a space in the building is used for - an apartment carries a number, a floor,
 * a participation share and an initial share capital, and none of those tells a
 * garage from a flat. Those two are reported to the board and applied by the
 * meeting, which is where EFL 6 kap. 27 § puts the decision in any case.
 *
 * Saying so here rather than only on the meeting screen is deliberate: this is
 * where somebody switches the clause on, and a switch that looked like an
 * enforcement would be read as one.
 */
export function MeetingBylawsPanel({
  meetingBylaws,
  onSaved,
  editable = true,
}: MeetingBylawsPanelProps): ReactElement {
  const { t } = useTranslation();

  const [proxyWidened, setProxyWidened] = useState(
    meetingBylaws.proxyHolderEligibilityWidened,
  );
  const [proxyLimit, setProxyLimit] = useState(
    String(meetingBylaws.maxMembersPerProxyHolder),
  );
  const [storageLimited, setStorageLimited] = useState(
    meetingBylaws.storageOnlyVoteLimited,
  );
  const [assistantWidened, setAssistantWidened] = useState(
    meetingBylaws.assistantEligibilityWidened,
  );

  const save = useSaveAction(saveMeetingBylaws, onSaved);

  const limit = wholeNumberIn(proxyLimit);
  const limitUsable =
    limit !== null &&
    limit >= MIN_MEMBERS_PER_PROXY_HOLDER &&
    limit <= MAX_MEMBERS_PER_PROXY_HOLDER;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (limit === null || !limitUsable) {
      return;
    }
    void save.submit({
      proxyHolderEligibilityWidened: proxyWidened,
      maxMembersPerProxyHolder: limit,
      storageOnlyVoteLimited: storageLimited,
      assistantEligibilityWidened: assistantWidened,
    });
  };

  return (
    <Panel
      title={t("settings.meetingBylaws.title")}
      description={t("settings.meetingBylaws.description")}
      notice={
        <>
          <Notice tone="info">
            {t("settings.meetingBylaws.statutoryNotice")}
          </Notice>
          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                failureMessageKey(
                  save.state.failure,
                  BYLAWS_FAILURES,
                  "settings.errors.unknown",
                ),
              )}
            </Notice>
          ) : save.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("settings.saved")}
            </Notice>
          ) : editable ? null : (
            <Notice tone="info">{t("settings.readOnlyNotice")}</Notice>
          )}
        </>
      }
      actions={
        editable ? (
          <button
            type="submit"
            form="meeting-bylaws"
            className={PRIMARY_BUTTON}
            disabled={save.state.kind === "saving" || !limitUsable}
          >
            {save.state.kind === "saving"
              ? t("settings.saving")
              : t("settings.save")}
          </button>
        ) : undefined
      }
    >
      <form
        id="meeting-bylaws"
        className="flex flex-col gap-4"
        onSubmit={onSubmit}
      >
        <label className="flex items-start gap-2 text-small">
          <input
            type="checkbox"
            checked={proxyWidened}
            disabled={!editable}
            onChange={(event) => {
              setProxyWidened(event.target.checked);
            }}
          />
          <span className="flex flex-col gap-0.5">
            {t("settings.meetingBylaws.proxyWidened")}
            <span className={HINT}>
              {t("settings.meetingBylaws.proxyWidenedHint")}
            </span>
          </span>
        </label>

        <label className={LABEL}>
          {t("settings.meetingBylaws.proxyLimit")}
          <input
            className={`${FIELD_DATA} w-24`}
            type="number"
            min={MIN_MEMBERS_PER_PROXY_HOLDER}
            max={MAX_MEMBERS_PER_PROXY_HOLDER}
            value={proxyLimit}
            disabled={!editable}
            onChange={(event) => {
              setProxyLimit(event.target.value);
            }}
          />
          <span className={HINT}>
            {t("settings.meetingBylaws.proxyLimitHint")}
          </span>
        </label>

        <label className="flex items-start gap-2 text-small">
          <input
            type="checkbox"
            checked={storageLimited}
            disabled={!editable}
            onChange={(event) => {
              setStorageLimited(event.target.checked);
            }}
          />
          <span className="flex flex-col gap-0.5">
            {t("settings.meetingBylaws.storageLimited")}
            <span className={HINT}>
              {t("settings.meetingBylaws.storageLimitedHint")}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-2 text-small">
          <input
            type="checkbox"
            checked={assistantWidened}
            disabled={!editable}
            onChange={(event) => {
              setAssistantWidened(event.target.checked);
            }}
          />
          <span className="flex flex-col gap-0.5">
            {t("settings.meetingBylaws.assistantWidened")}
            <span className={HINT}>
              {t("settings.meetingBylaws.assistantWidenedHint")}
            </span>
          </span>
        </label>
      </form>
    </Panel>
  );
}

/**
 * The whole number a field holds, or null when it holds no usable one.
 *
 * `Number` rather than `Number.parseInt`, on the motion deadline's reasoning: a
 * number input accepts exponent notation and `Number.parseInt("1e1", 10)` is 1,
 * so a board that typed 10 would have stored a limit of one. Blank is answered
 * before the conversion, since `Number("")` is 0 - and zero is not a limit a
 * bylaws clause could name, because a clause refusing every proxy the statute
 * permits is worse than no clause at all.
 */
function wholeNumberIn(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}
