import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { AUDIT_CHANNEL_LABEL } from "../register/audit-channel-label";
import { PANEL, PRIMARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { formatMoment } from "../ui/moment";
import { Notice, type NoticeTone } from "../ui/Notice";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import { pendingChangeFailure } from "./pending-change-failures";
import { PendingChangeInput } from "./PendingChangeInput";
import {
  confirmPendingChange,
  fetchMyPendingChanges,
  type PendingChange,
  rejectPendingChange,
} from "./pending-changes-api";

export interface PendingChangesScreenProps {
  /**
   * The change a link pointed at, such as the one a plugin's view sends the
   * person to after proposing. Shown first; if it is no longer waiting, the
   * screen says so rather than showing nothing.
   */
  focusId?: string;
}

/** Everything one read produces, applied in one step. */
interface Loaded {
  ready: boolean;
  pendingChanges: readonly PendingChange[];
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, pendingChanges: [], loadFailed: false };

/**
 * The person's own pending changes (väntande ändringar, ADR 0039).
 *
 * Each one is a call to an action that something proposed in their name - a
 * plugin's route today, the AI package later - and that has not run. This is
 * where it runs, and the only place: confirming is a person pressing a button
 * on the platform's own screen, and the API refuses a token on these routes.
 *
 * No capability gate. A pending change is its proposer's and nobody else's, and
 * the API answers anybody else's as one that does not exist. Whether the person
 * may still do what it holds is decided when they press confirm, against the
 * action's own capability; a refusal then leaves the change waiting and says
 * why beside it, and rejecting it is always possible. A failure that may have
 * left the change carried out, or ended, is said above the list instead, and
 * the list is read again. That read is what the queue held at the moment, not
 * what became of the change: a confirmation whose answer was lost may still
 * be running, and claim the change after the read listed it. So the sentence
 * says what is not known instead of drawing it from the list, and a card left
 * standing is safe to press, since the queue lets only one confirmation run.
 *
 * Confirming is one press and rejecting two. Confirming is what the person
 * came here to do and the preview above the button is the whole of what it
 * does; rejecting throws away something they may not get back without asking
 * again.
 */
export function PendingChangesScreen({
  focusId,
}: PendingChangesScreenProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /**
   * What the person last did here, said at the top once it is done: done, or
   * failed in a way that may have ended the change.
   */
  const [outcome, setOutcome] = useState<{
    id: string;
    key: TranslationKey;
    tone: NoticeTone;
  } | null>(null);
  const currentRead = useRef(0);

  const readInto = useCallback((): void => {
    const version = ++currentRead.current;
    void fetchMyPendingChanges().then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      setLoaded(
        result.ok
          ? {
              ...EMPTY,
              ready: true,
              pendingChanges: result.value.pendingChanges,
            }
          : { ...EMPTY, ready: true, loadFailed: true },
      );
    });
  }, []);

  useEffect(() => {
    readInto();
    return () => {
      currentRead.current += 1;
    };
  }, [readInto]);

  const { ready, pendingChanges, loadFailed } = loaded;

  // The one a link pointed at goes first, so it is what the person reads.
  const ordered =
    focusId === undefined
      ? pendingChanges
      : [
          ...pendingChanges.filter((change) => change.id === focusId),
          ...pendingChanges.filter((change) => change.id !== focusId),
        ];
  const focusGone =
    ready &&
    !loadFailed &&
    focusId !== undefined &&
    outcome?.id !== focusId &&
    !pendingChanges.some((change) => change.id === focusId);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("pendingChanges.title")}</h1>
        <p className="text-body text-ink-muted">{t("pendingChanges.intro")}</p>
      </header>

      {outcome === null ? null : (
        <Notice tone={outcome.tone} live>
          {t(outcome.key)}
        </Notice>
      )}

      {focusGone ? (
        <Notice tone="info">{t("pendingChanges.notWaiting")}</Notice>
      ) : null}

      {loadFailed ? (
        <LoadFailure
          messageKey="pendingChanges.loadFailed"
          onRetry={readInto}
        />
      ) : null}

      {!ready && !loadFailed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("pendingChanges.loading")}
        </p>
      ) : null}

      {ready && !loadFailed ? (
        ordered.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("pendingChanges.empty")}
          </p>
        ) : (
          <section
            className="flex flex-col gap-4"
            aria-label={t("pendingChanges.listTitle")}
          >
            {ordered.map((change) => (
              <PendingChangeCard
                key={change.id}
                change={change}
                locale={i18n.language}
                focused={change.id === focusId}
                onDone={(key, tone) => {
                  setOutcome({ id: change.id, key, tone });
                  readInto();
                }}
              />
            ))}
          </section>
        )
      ) : null}
    </div>
  );
}

/**
 * One pending change: what it is, where it came from, exactly what it would
 * send, and the two answers.
 *
 * The state of the act is the card's own, on the precedent the connected-app
 * rows set, so a refusal sits beside the change it happened to. Anything that
 * leaves the change not known to be waiting goes to `onDone`, because the card
 * may not outlast the queue read again.
 */
function PendingChangeCard({
  change,
  locale,
  focused,
  onDone,
}: {
  change: PendingChange;
  locale: string;
  focused: boolean;
  onDone: (key: TranslationKey, tone: NoticeTone) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const [busy, setBusy] = useState<"confirm" | "reject" | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [failureKey, setFailureKey] = useState<TranslationKey | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => {
    // A link pointed here: take the reader to it, as the page's subject.
    if (focused) {
      heading.current?.focus();
    }
  }, [focused]);

  const title = change.action?.title ?? change.actionName;

  const act = async (kind: "confirm" | "reject"): Promise<void> => {
    setBusy(kind);
    setFailureKey(null);
    const result =
      kind === "confirm"
        ? await confirmPendingChange(change.id)
        : await rejectPendingChange(change.id);
    setBusy(null);
    if (!result.ok) {
      const failure = pendingChangeFailure(
        result.failure,
        change,
        kind,
        (key) => i18n.exists(key),
      );
      if (failure.waiting) {
        setFailureKey(failure.key);
        return;
      }
      setRejecting(false);
      onDone(failure.key, "danger");
      return;
    }
    setRejecting(false);
    onDone(
      kind === "confirm"
        ? "pendingChanges.confirmed"
        : "pendingChanges.rejected",
      "ok",
    );
  };

  return (
    <article
      className={`flex flex-col gap-4 ${PANEL}`}
      aria-current={focused ? "true" : undefined}
    >
      <header className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="text-title">
          {title}
        </h2>
        {change.action === null ? (
          <Notice tone="warn">{t("pendingChanges.actionGone")}</Notice>
        ) : (
          <p className="text-small text-ink-muted">
            {change.action.description}
          </p>
        )}
      </header>

      <div className="flex flex-col gap-1 text-small text-ink-muted">
        <p>
          {t("pendingChanges.proposedThrough", {
            channel: t(AUDIT_CHANNEL_LABEL[change.channel]),
          })}
          {change.clientHost === null ? null : (
            <>
              {" "}
              <span className="font-data">
                {t("pendingChanges.proposedBy", { host: change.clientHost })}
              </span>
            </>
          )}
        </p>
        {/* The moments in the data face, the words around them in the UI's. */}
        <p>
          {t("pendingChanges.proposedAt")}{" "}
          <span className="font-data">
            {formatMoment(change.proposedAt, locale)}
          </span>
        </p>
        <p>
          {t("pendingChanges.expiresAt")}{" "}
          <span className="font-data">
            {formatMoment(change.expiresAt, locale)}
          </span>
        </p>
        <p>{t("pendingChanges.lapses")}</p>
      </div>

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-label text-ink-muted uppercase">
          {t("pendingChanges.preview")}
        </h3>
        <p className="text-small text-ink-muted">
          {t("pendingChanges.previewHint")}
        </p>
        <PendingChangeInput value={change.input} />
      </section>

      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        {change.action === null ? null : (
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={busy !== null}
            aria-label={t("pendingChanges.confirmLabel", { action: title })}
            onClick={() => {
              void act("confirm");
            }}
          >
            {busy === "confirm"
              ? t("pendingChanges.confirming")
              : t("pendingChanges.confirm")}
          </button>
        )}
        <TwoPressConfirm
          confirming={rejecting}
          busy={busy !== null}
          askText={t("pendingChanges.reject")}
          askLabel={t("pendingChanges.rejectLabel", { action: title })}
          confirmText={t("pendingChanges.rejectConfirm")}
          keepText={t("pendingChanges.rejectKeep")}
          onAsk={() => {
            setRejecting(true);
          }}
          onConfirm={() => {
            void act("reject");
          }}
          onKeep={() => {
            setRejecting(false);
          }}
        />
      </footer>
    </article>
  );
}
