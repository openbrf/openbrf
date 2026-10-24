import type { EntitlementState } from "@openbrf/plugin-sdk";
import { localDayOf, localDaysBetween, parseLocalDay } from "@openbrf/shared";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactElement,
} from "react";
import { Trans, useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { isReadOnly } from "../support/read-only";
import { copyText } from "../ui/clipboard";
import {
  FIELD_MULTILINE,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { BoardPageNote, BoardPageTitle } from "../ui/BoardPage";
import { LoadFailure } from "../ui/LoadFailure";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import { useNow } from "../ui/use-now";
import {
  enterLicence,
  fetchLicences,
  type LicenceCheck,
  type LicenceEntitlement,
  type LicencesOverview,
  type LicenceView,
  removeLicence,
} from "./licence-api";

export interface LicencesScreenProps {
  viewer: Viewer;
}

/**
 * From how many days before its last day a licence says when it ends (ADR
 * 0042). Nothing is mailed because of it; the screen says it.
 */
const ENDING_NOTICE_DAYS = 30;

/** Everything one read produces, applied in one step. */
interface Loaded {
  ready: boolean;
  overview: LicencesOverview | null;
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, overview: null, loadFailed: false };

/** The refusals an entry answers with, each with its own sentence. */
const ENTER_ERRORS: Readonly<Record<string, TranslationKey>> = {
  "licence-too-large": "licences.enter.errors.tooLarge",
  "licence-unsupported-format": "licences.enter.errors.unsupportedFormat",
  "licence-not-a-licence": "licences.enter.errors.notALicence",
  "licence-signature-invalid": "licences.enter.errors.signatureInvalid",
  "licence-already-entered": "licences.enter.errors.alreadyEntered",
  "licence-limit-reached": "licences.enter.errors.limitReached",
};

/**
 * A value inside a sentence, in the data face: a date, a code, a name a licence
 * gives. Every value goes into a `Trans` sentence as a component rather than an
 * interpolation, because i18next does not escape here and an issuer's text
 * interpolated into the string would be read for tags.
 */
function data(value: string | number): ReactElement {
  return <span className="font-data">{value}</span>;
}

/** A value inside a sentence in the face around it, as text. */
function text(value: string): ReactElement {
  return <>{value}</>;
}

const CHECK_LABELS: Readonly<Record<LicenceCheck, TranslationKey>> = {
  verified: "licences.check.verified",
  "not-yet-checked": "licences.check.notYetChecked",
  tampered: "licences.check.tampered",
  "issuer-not-installed": "licences.check.issuerNotInstalled",
};

/**
 * The licence screen (ADR 0042): the line the board copies into an order, the
 * licences entered with what a key says about each, what each licensed plugin
 * finds, and entering and removing a file.
 *
 * Under `association:manage`, the capability that installs plugins. A support
 * session (ADR 0028) holds it and changes nothing: it reads the screen and is
 * offered no control. Hiding a control is courtesy; the API refuses the call
 * either way.
 *
 * Re-keying is not here and never will be: replacing the instance key is the
 * operator's act on the command line, and the screen says so.
 */
export function LicencesScreen({ viewer }: LicencesScreenProps): ReactElement {
  const { t } = useTranslation();
  const canRead = viewer.capabilities.includes("association:manage");
  const editable = canRead && !isReadOnly(viewer);

  // Nothing to wait for where this account never asks for the list.
  const [loaded, setLoaded] = useState<Loaded>(
    canRead ? EMPTY : { ...EMPTY, ready: true },
  );
  const currentRead = useRef(0);

  /**
   * Reads, and applies the answer only while it is still the newest one, on
   * the plugin screen's terms: a retry, an entry and a removal each re-read,
   * and an older answer landing last must not put the screen back.
   */
  const readInto = useCallback((): void => {
    if (!canRead) {
      return;
    }
    const version = ++currentRead.current;
    void fetchLicences().then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      // A failed re-read keeps what the last read showed, beside the failure:
      // after an entry or a removal the screen still says what it came to.
      setLoaded((previous) =>
        result.ok
          ? { ready: true, overview: result.value, loadFailed: false }
          : { ready: true, overview: previous.overview, loadFailed: true },
      );
    });
  }, [canRead]);

  useEffect(() => {
    readInto();
    return () => {
      currentRead.current += 1;
    };
  }, [readInto]);

  const { ready, overview, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <BoardPageTitle audience="administrator">
          {t("licences.title")}
        </BoardPageTitle>
        <BoardPageNote audience="administrator" />
        <p className="text-body text-ink-muted">{t("licences.intro")}</p>
      </header>

      {!canRead ? (
        <Notice tone="info">{t("licences.errors.forbidden")}</Notice>
      ) : null}

      {loadFailed ? (
        <LoadFailure
          messageKey="licences.errors.loadFailed"
          onRetry={readInto}
        />
      ) : null}

      {canRead && !ready ? (
        <p role="status" className="text-body text-ink-muted">
          {t("licences.loading")}
        </p>
      ) : null}

      {overview === null ? null : (
        <>
          <InstancePanel instance={overview.instance} />
          <LicensedPluginsPanel plugins={overview.plugins} />
          <LicenceListPanel
            overview={overview}
            editable={editable}
            onChanged={readInto}
          />
          {editable ? <EnterPanel onEntered={readInto} /> : null}
        </>
      )}
    </div>
  );
}

/** The instance id and public key, as one line to copy into an order. */
function InstancePanel({
  instance,
}: {
  instance: LicencesOverview["instance"];
}): ReactElement {
  const { t } = useTranslation();
  const line = `${instance.instanceId} ${instance.instanceKey}`;
  /**
   * The last copy, with the line it copied: a notice about it is shown only
   * while that is still the line on screen.
   */
  const [copied, setCopied] = useState<{ line: string; ok: boolean } | null>(
    null,
  );

  return (
    <Panel
      title={t("licences.instance.title")}
      description={t("licences.instance.description")}
      notice={
        instance.keyReadable ? null : (
          <Notice tone="warn">{t("licences.instance.keyUnreadable")}</Notice>
        )
      }
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code className="min-w-0 font-data text-small break-all text-ink">
          {line}
        </code>
        <button
          type="button"
          className={QUIET_BUTTON}
          onClick={() => {
            void copyText(line).then((ok) => {
              setCopied({ line, ok });
            });
          }}
        >
          {t("licences.instance.copy")}
        </button>
      </div>
      {copied?.line !== line ? null : (
        <p role="status" className="text-small text-ink-muted">
          {t(
            copied.ok
              ? "licences.instance.copied"
              : "licences.instance.copyFailed",
          )}
        </p>
      )}
      <p className="text-small text-ink-muted">
        {t("licences.instance.rekey")}
      </p>
    </Panel>
  );
}

/** Each installed plugin that reads a licence, and what it finds today. */
function LicensedPluginsPanel({
  plugins,
}: {
  plugins: LicencesOverview["plugins"];
}): ReactElement | null {
  const { t } = useTranslation();
  // Absent where no installed plugin reads a licence, on the findings panel's
  // precedent: a heading over nothing would ask about a mechanism not in play.
  if (plugins.length === 0) {
    return null;
  }

  return (
    <Panel
      title={t("licences.plugins.title")}
      description={t("licences.plugins.description")}
    >
      <ul className="flex flex-col gap-3">
        {plugins.map((plugin) => (
          <li key={plugin.pluginId} className="flex flex-col gap-1">
            <span className="font-data text-small text-ink">
              {plugin.pluginId}
            </span>
            <span className="text-small text-ink-muted">
              {t("licences.plugins.reads", {
                entitlement: plugin.entitlement,
                issuer: plugin.issuer.name,
              })}
            </span>
            <StateSentence state={plugin.state} />
            {plugin.state.status === "active" &&
            plugin.state.validUntil !== null ? (
              <EndingNotice validUntil={plugin.state.validUntil} />
            ) : null}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function StateSentence({ state }: { state: EntitlementState }): ReactElement {
  const { t } = useTranslation();
  const { key, values } = stateSentence(state);
  const components: Record<string, ReactElement> = {};
  for (const [name, value] of Object.entries(values)) {
    components[name] = data(value);
  }
  return (
    <span className="text-small text-ink">
      <Trans t={t} i18nKey={key} components={components} />
    </span>
  );
}

/** The sentences for what a licensed plugin finds. */
type StateKey = Extract<TranslationKey, `licences.plugins.state.${string}`>;

/** What a licensed plugin finds, as a sentence and the values it needs. */
function stateSentence(state: EntitlementState): {
  key: StateKey;
  values: Record<string, string>;
} {
  switch (state.status) {
    case "active":
      return { key: "licences.plugins.state.active", values: {} };
    case "absent":
      return { key: "licences.plugins.state.absent", values: {} };
    case "expired":
      return {
        key: "licences.plugins.state.expired",
        values: { validUntil: state.validUntil },
      };
    case "version-not-covered":
      return {
        key: "licences.plugins.state.versionNotCovered",
        values: { updatesUntil: state.updatesUntil, released: state.released },
      };
    case "wrong-instance":
      return { key: "licences.plugins.state.wrongInstance", values: {} };
    case "tampered":
      return { key: "licences.plugins.state.tampered", values: {} };
    case "not-yet-valid":
      return {
        key: "licences.plugins.state.notYetValid",
        values: { issuedOn: state.issuedOn },
      };
    default:
      // A state a newer server sends is still a state, said by its code.
      return {
        key: "licences.plugins.state.unknown",
        values: { status: (state as { status: string }).status },
      };
  }
}

/**
 * When a licence ends, from thirty days before its last day (ADR 0042), and
 * that it has ended once the day is past. Read on the association's calendar
 * day, as the host judges it; the browser's clock decides only what is said.
 */
function EndingNotice({
  validUntil,
}: {
  validUntil: string;
}): ReactElement | null {
  const { t } = useTranslation();
  const now = useNow(60_000);
  const end = parseLocalDay(validUntil);
  if (end === null) {
    return null;
  }
  const days = localDaysBetween(localDayOf(new Date(now)), end);
  if (days > ENDING_NOTICE_DAYS) {
    return null;
  }
  return (
    <Notice tone={days < 0 ? "danger" : "warn"}>
      <Trans
        t={t}
        i18nKey={
          days < 0
            ? "licences.entitlement.ended"
            : days === 0
              ? "licences.entitlement.endsToday"
              : "licences.entitlement.endsIn"
        }
        count={days > 0 ? days : undefined}
        components={{ date: data(validUntil) }}
      />
    </Notice>
  );
}

/** Every licence entered, with what a key says about each now. */
function LicenceListPanel({
  overview,
  editable,
  onChanged,
}: {
  overview: LicencesOverview;
  editable: boolean;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  /** The row whose removal is being asked about; one at a time. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [failure, setFailure] = useState<{
    id: string;
    message: TranslationKey;
  } | null>(null);

  const remove = async (id: string): Promise<void> => {
    // Single-flight: the buttons are held while one removal is out.
    if (removing) {
      return;
    }
    setRemoving(true);
    setFailure(null);
    const result = await removeLicence(id);
    setRemoving(false);
    setConfirming(null);
    if (!result.ok) {
      // A row another removal took first is gone either way: say so.
      setFailure({
        id,
        message:
          result.failure.reason === "licence-not-found"
            ? "licences.list.notFound"
            : "licences.list.removeFailed",
      });
    }
    // Read the list again whatever the answer: a removal with no answer, or
    // a server error, may still have gone through, and the list decides.
    onChanged();
  };

  // That a removal failed is said only while its row is still listed: once the
  // list shows it gone, it went after all.
  const shownFailure =
    failure === null ||
    (failure.message === "licences.list.removeFailed" &&
      !overview.licences.some((licence) => licence.id === failure.id))
      ? null
      : failure.message;

  return (
    <Panel
      title={t("licences.list.title")}
      description={t("licences.list.description")}
      notice={
        shownFailure === null ? null : (
          <Notice tone="danger" live>
            {t(shownFailure)}
          </Notice>
        )
      }
    >
      {overview.licences.length === 0 ? (
        <p className="text-body text-ink-muted">{t("licences.list.none")}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {overview.licences.map((licence) => (
            <LicenceRow
              key={licence.id}
              licence={licence}
              instance={overview.instance}
              editable={editable}
              confirming={confirming === licence.id}
              busy={removing}
              onAsk={() => {
                setFailure(null);
                setConfirming(licence.id);
              }}
              onKeep={() => {
                setConfirming(null);
              }}
              onConfirm={() => {
                void remove(licence.id);
              }}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function LicenceRow({
  licence,
  instance,
  editable,
  confirming,
  busy,
  onAsk,
  onKeep,
  onConfirm,
}: {
  licence: LicenceView;
  instance: LicencesOverview["instance"];
  editable: boolean;
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onKeep: () => void;
  onConfirm: () => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const { verified } = licence;
  // Every string from a payload is text, never markup: React renders it so.
  const name = verified?.association.name ?? licence.keyId;

  return (
    <li className="flex flex-col gap-1.5 border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-chip text-ink-muted uppercase">
          {licence.check === "verified"
            ? t("licences.check.verified")
            : t("licences.list.key", { keyId: licence.keyId })}
        </span>
        <span className="text-small text-ink-muted">
          <Trans
            t={t}
            i18nKey="licences.list.entered"
            components={{
              moment: data(formatMoment(licence.enteredAt, i18n.language)),
            }}
          />
        </span>
      </div>

      {verified === null ? (
        <p className="text-small text-ink">{t(CHECK_LABELS[licence.check])}</p>
      ) : (
        <>
          <p className="text-body text-ink">
            {verified.association.organizationNumber === null
              ? t("licences.list.issuedTo", { name: verified.association.name })
              : t("licences.list.issuedToNumber", {
                  name: verified.association.name,
                  organizationNumber: verified.association.organizationNumber,
                })}
          </p>
          <p className="text-small text-ink-muted">
            <Trans
              t={t}
              i18nKey="licences.list.issuedBy"
              components={{
                issuer: text(verified.issuer.name),
                issuedOn: data(verified.issuedOn),
              }}
            />
          </p>
          {verified.instanceId !== instance.instanceId ||
          verified.instanceKey !== instance.instanceKey ? (
            <Notice tone="warn">{t("licences.list.otherInstance")}</Notice>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {verified.entitlements.map((entitlement) => (
              <EntitlementLine
                key={entitlement.name}
                entitlement={entitlement}
              />
            ))}
          </ul>
        </>
      )}

      <p className="font-data text-small break-all text-ink-muted">
        {licence.licenceId === null
          ? t("licences.list.file", { sha256: licence.sha256 })
          : t("licences.list.licenceId", { licenceId: licence.licenceId })}
      </p>

      {editable ? (
        <div className="flex flex-col items-start gap-2">
          {confirming ? (
            <p className="text-small text-ink">
              {t("licences.list.removeWarning")}
            </p>
          ) : null}
          <TwoPressConfirm
            confirming={confirming}
            busy={busy}
            askText={t("licences.list.remove")}
            askLabel={t("licences.list.removeLabel", { name })}
            confirmText={t("licences.list.removeConfirm")}
            keepText={t("licences.list.removeCancel")}
            onAsk={onAsk}
            onConfirm={onConfirm}
            onKeep={onKeep}
          />
        </div>
      ) : null}
    </li>
  );
}

function EntitlementLine({
  entitlement,
}: {
  entitlement: LicenceEntitlement;
}): ReactElement {
  const { t } = useTranslation();
  const { name, validUntil, updatesUntil } = entitlement;
  // One sentence for each pair of bounds, so word order and punctuation stay
  // with the translation.
  const key: TranslationKey =
    validUntil === null
      ? updatesUntil === null
        ? "licences.entitlement.noEndAndEveryRelease"
        : "licences.entitlement.noEndAndUpdatesUntil"
      : updatesUntil === null
        ? "licences.entitlement.untilAndEveryRelease"
        : "licences.entitlement.untilAndUpdatesUntil";
  return (
    <li className="flex flex-col gap-1 border-l-2 border-line-strong pl-3">
      <span className="text-small text-ink">
        <Trans
          t={t}
          i18nKey={key}
          components={{
            name: data(name),
            validUntil: data(validUntil ?? ""),
            updatesUntil: data(updatesUntil ?? ""),
          }}
        />
      </span>
      {entitlement.validUntil === null ? null : (
        <EndingNotice validUntil={entitlement.validUntil} />
      )}
    </li>
  );
}

/** What the last entry came to, held until the draft changes. */
type EnterOutcome =
  | { kind: "entered"; verified: boolean }
  | { kind: "refused"; message: TranslationKey };

/**
 * Entering a licence: a file chosen, or its contents pasted.
 *
 * The file is read as text and sent as text, which is what a licence file is.
 * One entry at a time, with the fields held while it is out, so the draft the
 * answer is about is the draft on screen; the answer goes once the draft
 * changes.
 */
function EnterPanel({ onEntered }: { onEntered: () => void }): ReactElement {
  const { t } = useTranslation();
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState("");
  const [entering, setEntering] = useState(false);
  const [outcome, setOutcome] = useState<EnterOutcome | null>(null);
  /** Bumped to clear the file input, which React cannot set to a value. */
  const [fileInputKey, setFileInputKey] = useState(0);

  const ready = file !== null || pasted.trim() !== "";

  // One source at a time: choosing a file clears what was pasted, and pasting
  // clears the file, so the screen never holds two drafts that disagree.
  // A chooser closed without a file changes nothing: some browsers still send
  // `change` with an empty list, and a pasted draft must not go with it.
  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = event.target.files?.[0];
    if (chosen === undefined) {
      return;
    }
    setFile(chosen);
    setPasted("");
    setOutcome(null);
  };

  const submit = async (): Promise<void> => {
    if (entering || !ready) {
      return;
    }
    setEntering(true);
    setOutcome(null);

    let text: string;
    try {
      text = file === null ? pasted : await file.text();
    } catch {
      setEntering(false);
      setOutcome({
        kind: "refused",
        message: "licences.enter.errors.unreadableFile",
      });
      return;
    }

    const result = await enterLicence(text);
    setEntering(false);
    if (!result.ok) {
      setOutcome({
        kind: "refused",
        message:
          ENTER_ERRORS[result.failure.reason] ?? "licences.enter.errors.failed",
      });
      return;
    }
    setOutcome({
      kind: "entered",
      verified: result.value.check === "verified",
    });
    setFile(null);
    setPasted("");
    setFileInputKey((key) => key + 1);
    onEntered();
  };

  return (
    <Panel
      title={t("licences.enter.title")}
      description={t("licences.enter.description")}
      notice={
        outcome === null ? null : outcome.kind === "refused" ? (
          <Notice tone="danger" live>
            {t(outcome.message)}
          </Notice>
        ) : (
          <Notice tone="ok" live>
            {t(
              outcome.verified
                ? "licences.enter.enteredVerified"
                : "licences.enter.enteredUnchecked",
            )}
          </Notice>
        )
      }
      actions={
        <button
          type="button"
          disabled={!ready || entering}
          onClick={() => {
            void submit();
          }}
          className={PRIMARY_BUTTON}
        >
          {entering ? t("licences.enter.entering") : t("licences.enter.submit")}
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="cursor-pointer">
          <input
            key={fileInputKey}
            type="file"
            accept=".json,.licence,.license,application/json,text/plain"
            aria-label={t("licences.enter.choose")}
            className="peer sr-only"
            disabled={entering}
            onChange={onPick}
          />
          {/*
           * The input is visually hidden, so the focus ring and the disabled
           * state both have to be drawn on the part the viewer can see.
           */}
          <span
            className={[
              SECONDARY_BUTTON,
              "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
              "peer-focus-visible:outline-trust",
              "peer-disabled:opacity-60",
            ].join(" ")}
          >
            {t("licences.enter.choose")}
          </span>
        </label>
        {file === null ? null : (
          <span className="min-w-0 truncate text-small text-ink">
            {t("licences.enter.chosen", { fileName: file.name })}
          </span>
        )}
      </div>

      <label className={LABEL}>
        {t("licences.enter.paste")}
        <textarea
          rows={6}
          value={pasted}
          disabled={entering}
          spellCheck={false}
          onChange={(event) => {
            setPasted(event.target.value);
            setFile(null);
            setFileInputKey((key) => key + 1);
            setOutcome(null);
          }}
          className={`${FIELD_MULTILINE} font-data`}
        />
      </label>
    </Panel>
  );
}
