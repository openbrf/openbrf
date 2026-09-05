import { useState, type FormEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  type Meeting,
  registerProxy,
  REPRESENTATIVE_GROUNDS,
  type RepresentativeGround,
  withdrawProxy,
} from "../api/meetings";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { useSaveAction } from "../ui/save-state";
import { meetingFailureKey } from "./meeting-failures";
import { MeetingPersonName } from "./MeetingPersonName";
import { PersonSelect } from "./PersonSelect";
import type { MeetingPeople } from "./use-meeting-people";

export interface MeetingProxyPanelProps {
  meeting: Meeting;
  people: MeetingPeople;
  onChanged: () => void;
}

/**
 * The proxy authorisations (fullmakter) registered against this meeting.
 *
 * ## What a proxy authorisation is here
 *
 * Representation, and never a transfer of the vote: the member keeps it and
 * somebody else exercises it. Which is why a member who turns up in person is
 * the one case where a registered authority is simply spent - the voting
 * register reports that proxy holder as exercising nothing, and nothing is
 * wrong.
 *
 * ## The two rules the platform checks, and the two it states
 *
 * BRL 9 kap. 14 § 4 lets the member's spouse or cohabitant, or another member,
 * be the proxy holder unless the bylaws determine otherwise, and lets nobody
 * represent more than one member unless the bylaws determine otherwise. That
 * "one" replaces EFL 6 kap. 5 §'s general three, so an association that has
 * recorded nothing is under one rather than three.
 *
 * The platform holds membership, so it checks both of those: whether the person
 * named is another member, and how many members they are already carrying at
 * this meeting. It holds no record of who is anybody's spouse or cohabitant, so
 * that ground is attested by the board rather than proved by the platform - the
 * form takes it as a ground the board states, and the notice above says so.
 * Inventing an answer would take somebody's vote away on a guess.
 *
 * The bylaws in force are rendered rather than left implicit, because they are
 * what the form's refusals will be measured against and a board registering an
 * authority at the door needs to know before it is refused, not after.
 *
 * ## The day the member signed it
 *
 * Asked for, and not the day it is registered. EFL 6 kap. 4 § holds an
 * authorisation good for at most a year from the day the member signed it, and
 * the server measures that year against the meeting day rather than against
 * today - so an authority is refused for being older than the meeting by a year,
 * and refused for being dated after it, and both refusals name the date that is
 * wrong.
 *
 * ## Taking one back
 *
 * A date on the row and never a delete, like every other withdrawal in this
 * codebase: "this authority was registered and taken back" is a different thing
 * to say than "there was never one", and a board that struck the wrong row has
 * to be able to see that it did.
 */
export function MeetingProxyPanel({
  meeting,
  people,
  onChanged,
}: MeetingProxyPanelProps): ReactElement {
  const { t } = useTranslation();

  const [memberPersonId, setMemberPersonId] = useState("");
  const [proxyHolderPersonId, setProxyHolderPersonId] = useState("");
  const [ground, setGround] = useState<RepresentativeGround>("MEMBER");
  const [authorisedOn, setAuthorisedOn] = useState("");
  /** Which authority the withdrawal in flight is for; see the check-in panel. */
  const [withdrawing, setWithdrawing] = useState<string | null>(null);

  const register = useSaveAction(registerProxy);
  const withdraw = useSaveAction(withdrawProxy);

  const held = meeting.concludedAt !== null;
  const busy =
    register.state.kind === "saving" || withdraw.state.kind === "saving";
  const { bylaws } = meeting;

  const sendable =
    memberPersonId !== "" &&
    proxyHolderPersonId !== "" &&
    authorisedOn.trim() !== "";

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!sendable) {
      return;
    }
    withdraw.reset();
    /*
     * The outcome is not read. An authority registered and one refused both
     * change what the voting register says - a refused one because the board's
     * next act depends on which rule refused it - so the screen re-reads either
     * way and shows what came back.
     */
    void register
      .submit({
        id: meeting.id,
        values: {
          memberPersonId,
          proxyHolderPersonId,
          ground,
          authorisedOn,
        },
      })
      .then(() => {
        onChanged();
      });
  };

  const onWithdraw = (authorisationId: string): void => {
    register.reset();
    setWithdrawing(authorisationId);
    void withdraw
      .submit({ id: meeting.id, authorisationId })
      .then(() => {
        onChanged();
      })
      .finally(() => {
        setWithdrawing(null);
      });
  };

  const failure =
    register.state.kind === "failed"
      ? register.state.failure
      : withdraw.state.kind === "failed"
        ? withdraw.state.failure
        : null;

  return (
    <Panel
      title={t("meetings.proxies.title")}
      description={t("meetings.proxies.description")}
      notice={
        <>
          <Notice tone="info">
            {bylaws.proxyHolderEligibilityWidened
              ? t("meetings.proxies.eligibilityWidened", {
                  limit: bylaws.maxMembersPerProxyHolder,
                })
              : t("meetings.proxies.eligibilityStatutory", {
                  limit: bylaws.maxMembersPerProxyHolder,
                })}
          </Notice>
          {failure !== null ? (
            <Notice tone="danger" live>
              {t(meetingFailureKey(failure))}
            </Notice>
          ) : register.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.proxies.registered")}
            </Notice>
          ) : withdraw.state.kind === "saved" ? (
            <Notice tone="ok" live>
              {t("meetings.proxies.withdrawn")}
            </Notice>
          ) : null}
        </>
      }
      actions={
        held ? undefined : (
          <>
            <button
              type="submit"
              form="meeting-proxy"
              className={PRIMARY_BUTTON}
              disabled={busy || !sendable}
            >
              {register.state.kind === "saving"
                ? t("meetings.proxies.registering")
                : t("meetings.proxies.register")}
            </button>
            <p className={HINT}>{t("meetings.proxies.groundHint")}</p>
          </>
        )
      }
    >
      {held ? (
        <Notice tone="info">{t("meetings.proxies.heldNotice")}</Notice>
      ) : (
        <form
          id="meeting-proxy"
          className="flex flex-wrap gap-4"
          onSubmit={onSubmit}
        >
          <PersonSelect
            label={t("meetings.proxies.member")}
            people={people}
            value={memberPersonId}
            onChange={setMemberPersonId}
          />

          <PersonSelect
            label={t("meetings.proxies.proxyHolder")}
            people={people}
            value={proxyHolderPersonId}
            onChange={setProxyHolderPersonId}
          />

          <label className={LABEL}>
            {t("meetings.proxies.ground")}
            <select
              className={`${FIELD} w-64`}
              value={ground}
              onChange={(event) => {
                setGround(event.target.value as RepresentativeGround);
              }}
            >
              {REPRESENTATIVE_GROUNDS.map((value) => (
                <option key={value} value={value}>
                  {t(`meetings.ground.${value}`)}
                </option>
              ))}
            </select>
          </label>

          <label className={LABEL}>
            {t("meetings.proxies.authorisedOn")}
            <input
              className={`${FIELD_DATA} w-48`}
              type="date"
              value={authorisedOn}
              onChange={(event) => {
                setAuthorisedOn(event.target.value);
              }}
            />
          </label>
        </form>
      )}

      {meeting.proxyAuthorisations.length === 0 ? (
        <p className="text-body text-ink-muted">
          {t("meetings.proxies.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {meeting.proxyAuthorisations.map((authorisation) => {
            const standing = authorisation.withdrawnAt === null;
            return (
              <li key={authorisation.id}>
                <article
                  className={[
                    "flex flex-col gap-2 rounded-control border bg-page px-3 py-3",
                    standing ? "border-line" : "border-dashed border-line",
                  ].join(" ")}
                >
                  <p className="flex flex-wrap items-center gap-2 text-body">
                    <MeetingPersonName
                      person={people.find(authorisation.proxyHolderPersonId)}
                      personId={authorisation.proxyHolderPersonId}
                    />
                    <span className="text-ink-muted">
                      {t("meetings.proxies.actsFor")}
                    </span>
                    <MeetingPersonName
                      person={people.find(authorisation.memberPersonId)}
                      personId={authorisation.memberPersonId}
                    />
                  </p>

                  <p className={HINT}>
                    {t(`meetings.ground.${authorisation.ground}`)}
                    {" · "}
                    {t("meetings.proxies.signedOn", {
                      date: authorisation.authorisedOn,
                    })}
                  </p>

                  {standing ? (
                    held ? null : (
                      <div>
                        <button
                          type="button"
                          className={QUIET_BUTTON}
                          disabled={busy}
                          // The name carries the two people, because every row
                          // offers the same act and "take back" on its own does
                          // not say whose authority.
                          aria-label={t("meetings.proxies.withdrawNamed", {
                            proxyHolder:
                              people.find(authorisation.proxyHolderPersonId)
                                ?.name ?? authorisation.proxyHolderPersonId,
                            member:
                              people.find(authorisation.memberPersonId)?.name ??
                              authorisation.memberPersonId,
                          })}
                          onClick={() => {
                            onWithdraw(authorisation.id);
                          }}
                        >
                          {busy && withdrawing === authorisation.id
                            ? t("meetings.proxies.withdrawing")
                            : t("meetings.proxies.withdraw")}
                        </button>
                      </div>
                    )
                  ) : (
                    <p className="text-small text-ink-muted">
                      {t("meetings.proxies.wasWithdrawn")}
                    </p>
                  )}
                </article>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
