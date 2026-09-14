import type { ActionSummary } from "@openbrf/plugin-sdk";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  fetchConnectedAppActions,
  fetchOAuthClient,
  grantConsent,
  type OAuthClientDetails,
} from "./consent-api";

export interface OAuthConsentScreenProps {
  /**
   * The authorization request exactly as the browser received it.
   *
   * The unparsed search string, leading "?" and all. It is signed over its own
   * parameters, so it is read from here and passed on and never rebuilt.
   */
  authorizationRequest: string;
  /** Hands the browser back to the app that asked, once consent is recorded. */
  onGranted: (redirectUri: string) => void;
  /** Leaves this request and returns to the application. */
  onLeave: () => void;
}

/**
 * Why an authorization request cannot be used, as a sentence.
 *
 * A total map is not possible - the API can answer with a reason this build
 * has not heard of - so an unknown code falls back to the general sentence.
 * The code itself never reaches the screen: it is English, the interface is
 * Swedish by default, and it names a protocol a member has no reason to know.
 */
const UNUSABLE_MESSAGE: Readonly<Record<string, TranslationKey>> = {
  "invalid-request": "connectedApps.consent.errors.invalidRequest",
  expired: "connectedApps.consent.errors.expired",
  "unknown-client": "connectedApps.consent.errors.unknownClient",
  "signature-invalid": "connectedApps.consent.errors.signatureInvalid",
};

function unusableMessage(reason: string): TranslationKey {
  return UNUSABLE_MESSAGE[reason] ?? "connectedApps.consent.errors.unusable";
}

/**
 * Whether a refusal is about the request rather than about this moment.
 *
 * Every refusal in the client's half of the range, except the two that are
 * about the person's own standing: a lapsed session says nothing about the
 * app's request, and telling a member their request cannot be used when what
 * actually happened is that they were signed out sends them to start
 * something over in the app that was never wrong.
 */
function refusesTheRequest(status: number): boolean {
  return status >= 400 && status < 500 && status !== 401 && status !== 403;
}

/**
 * What the screen has been told, or null while nothing has answered yet.
 *
 * Loading is the absence of an outcome rather than an outcome of its own, so
 * that nothing about the first read is decided while the screen renders: the
 * read is the one thing here that talks to the instance, and everything else
 * follows from the request, which is in hand from the first frame.
 */
type Outcome =
  /** The first read did not answer. Trying again is the useful act. */
  | { kind: "load-failed" }
  /** The request itself will not do, so there is nothing to try again. */
  | { kind: "unusable"; reason: string }
  | { kind: "asking"; client: OAuthClientDetails; groups: ActionGroup[] };

/** The four things this screen can be, one of which is "nothing yet". */
type Showing = Outcome | { kind: "loading" };

/** One group of actions, as one list on the screen. */
interface ActionGroup {
  group: string;
  title: string;
  entries: { name: string; title: string }[];
}

/**
 * The interface's own wording where it has it, the instance's otherwise.
 *
 * The catalogue carries both the key and a string the instance already
 * resolved, and the two can disagree: the instance resolves against the
 * language the request declared, which is the browser's, while this interface
 * renders in the association's. A board member reading Swedish on a machine
 * set to English would otherwise see the group headings in English above a
 * page in Swedish.
 *
 * A plugin's own keys live in a namespace the browser loads only when it needs
 * that plugin's view, so the key is used only when it actually resolves.
 * Falling back to the resolved string keeps a heading in the wrong language,
 * which is worse than nothing rendering only in the sense that a raw key would
 * be worse than both.
 */
function preferInterfaceWording(
  translate: (key: string) => string,
  exists: (key: string) => boolean,
  key: string,
  resolved: string,
): string {
  if (!exists(key)) {
    return resolved;
  }
  /*
   * `exists` is true for a parent as well as for a leaf, and translating a
   * parent yields a complaint rather than a sentence. So the translation has
   * to be a string that is not simply the key handed back before it can be
   * preferred to what the instance already resolved.
   */
  const translated = translate(key);
  return typeof translated === "string" &&
    translated !== "" &&
    translated !== key
    ? translated
    : resolved;
}

/**
 * What the request says, read and never rewritten.
 *
 * Only the three things the screen has to show or decide on: who is asking,
 * where the answer goes, and when the request stops being valid.
 */
interface AuthorizationRequest {
  clientId: string;
  redirectHost: string | null;
  redirectIsLoopback: boolean;
  /** When the request expires, in milliseconds, or null when it says nothing. */
  expiresAt: number | null;
}

export function OAuthConsentScreen({
  authorizationRequest,
  onGranted,
  onLeave,
}: OAuthConsentScreenProps): ReactElement {
  const { t, i18n } = useTranslation();
  const request = useMemo(
    () => readRequest(authorizationRequest),
    [authorizationRequest],
  );
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [understood, setUnderstood] = useState(false);
  const [granting, setGranting] = useState(false);
  /** True when the last attempt to record the consent did not go through. */
  const [grantFailed, setGrantFailed] = useState(false);

  useEffect(() => {
    if (request === null) {
      return;
    }

    // The effect owns its own calls and drops answers that arrive after the
    // screen is gone, or after a retry has replaced them.
    let active = true;

    const read = async (): Promise<void> => {
      const [client, catalogue] = await Promise.all([
        fetchOAuthClient(request.clientId),
        fetchConnectedAppActions(),
      ]);
      if (!active) {
        return;
      }
      /*
       * Read after the request rather than before it, because the clock is
       * not something to consult while the screen renders. The instance checks
       * the expiry too and its answer is the one that decides; reading it here
       * only chooses the sentence, and "start it again in the app" is more use
       * to a member than the general "cannot be used".
       */
      if (request.expiresAt !== null && request.expiresAt <= Date.now()) {
        setOutcome({ kind: "unusable", reason: "expired" });
        return;
      }
      if (!client.ok && client.failure.status === 404) {
        // Settled rather than a failure: registering a client is an
        // administrator's act, and reading again will not produce one.
        setOutcome({ kind: "unusable", reason: "unknown-client" });
        return;
      }
      if (!client.ok || !catalogue.ok) {
        setOutcome({ kind: "load-failed" });
        return;
      }
      setOutcome({
        kind: "asking",
        client: client.value,
        groups: groupActions(
          catalogue.value.actions,
          (key) => t(key as TranslationKey),
          (key) => i18n.exists(key),
        ),
      });
    };

    void read();
    return () => {
      active = false;
    };
    // t and i18n are stable for the life of the screen; naming them here
    // would re-read the catalogue on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, attempt]);

  const onConfirm = async (): Promise<void> => {
    setGranting(true);
    setGrantFailed(false);
    const result = await grantConsent(authorizationRequest);
    if (result.ok) {
      const url = result.value.url;
      if (typeof url === "string" && url !== "") {
        onGranted(url);
        return;
      }
      setGranting(false);
      setGrantFailed(true);
      return;
    }
    if (refusesTheRequest(result.failure.status)) {
      /*
       * The instance refused the request itself. Nothing about it will be
       * different on a second attempt, so the screen stops offering one: a
       * button that posts a signature the server has already rejected reads as
       * a fault the member could fix by pressing it again.
       *
       * A plain 400 on this route is the signature: the endpoint verifies the
       * query before it does anything else and refuses an unverifiable one
       * there. Every other refusal keeps whatever reason it named, and one
       * this build has not heard of becomes the general sentence.
       */
      setOutcome({
        kind: "unusable",
        reason:
          result.failure.status === 400
            ? "signature-invalid"
            : result.failure.reason,
      });
      return;
    }
    setGranting(false);
    setGrantFailed(true);
  };

  /**
   * A request that is not one at all.
   *
   * Settled from the address alone and before anything is asked of the
   * instance: without a client and a signature there is nobody to ask about
   * and nothing to verify.
   */
  const showing: Showing =
    request === null
      ? { kind: "unusable", reason: "invalid-request" }
      : (outcome ?? { kind: "loading" });

  if (showing.kind === "loading") {
    return (
      <p role="status" className="text-body text-ink-muted">
        {t("connectedApps.consent.loading")}
      </p>
    );
  }

  if (showing.kind === "load-failed") {
    return (
      <LoadFailure
        messageKey="connectedApps.consent.errors.loadFailed"
        onRetry={() => {
          setOutcome(null);
          setAttempt((previous) => previous + 1);
        }}
      />
    );
  }

  if (showing.kind === "unusable") {
    return (
      <Panel
        title={t("connectedApps.consent.title")}
        actions={
          <button type="button" onClick={onLeave} className={SECONDARY_BUTTON}>
            {t("connectedApps.consent.back")}
          </button>
        }
      >
        {/*
          The way out is the only control. There is deliberately no retry: what
          failed is the request the app composed, and posting it again cannot
          make a signature verify. It is started over in the app.
        */}
        <Notice tone="danger">{t(unusableMessage(showing.reason))}</Notice>
      </Panel>
    );
  }

  const name = clientName(showing.client) ?? t("connectedApps.consent.someApp");

  return (
    <Panel
      title={t("connectedApps.consent.title")}
      description={t("connectedApps.consent.intro", { name })}
      notice={
        <Notice tone="info">{t("connectedApps.consent.privacyNote")}</Notice>
      }
      actions={
        <>
          <button
            type="button"
            disabled={!understood || granting}
            onClick={() => {
              void onConfirm();
            }}
            className={PRIMARY_BUTTON}
          >
            {granting
              ? t("connectedApps.consent.working")
              : t("connectedApps.consent.confirm")}
          </button>
          <button
            type="button"
            disabled={granting}
            onClick={onLeave}
            className={SECONDARY_BUTTON}
          >
            {t("connectedApps.consent.cancel")}
          </button>
        </>
      }
    >
      {/*
        Hosts, never whole addresses. What a member needs in order to recognise
        an app, and to see that the answer is not being sent somewhere else, is
        where each one lives; a full URL with its path and its query is longer,
        less recognisable, and easier to disguise something in.
      */}
      <dl className="flex flex-col gap-2">
        <Fact
          label={t("connectedApps.consent.clientHost")}
          value={clientHost(showing.client)}
        />
        <Fact
          label={t("connectedApps.consent.redirectHost")}
          value={request?.redirectHost ?? null}
        />
      </dl>

      {request?.redirectIsLoopback === true ? (
        <Notice tone="warn">
          {t("connectedApps.consent.loopbackWarning")}
        </Notice>
      ) : null}

      {showing.groups.length === 0 ? (
        <Declaration
          title={t("connectedApps.consent.actionsTitle")}
          entries={[]}
          emptyLabel={t("connectedApps.consent.noActions")}
        />
      ) : (
        showing.groups.map((group) => (
          <Declaration
            key={group.group}
            title={group.title}
            entries={group.entries}
          />
        ))
      )}

      {/*
        Under the list, because it is what the list does not say: the list is
        this instant's answer, and nothing about it is recorded as a promise.
      */}
      <Notice tone="info">{t("connectedApps.consent.scopeNotice")}</Notice>

      {/* min-h-11 is the 44px touch target: this checkbox is the control that
          records the decision, so it must not be the one control on the screen
          that is hard to hit on a phone. */}
      <label className="flex min-h-11 items-start gap-3">
        <input
          type="checkbox"
          name="understood"
          checked={understood}
          onChange={(event) => {
            setUnderstood(event.target.checked);
          }}
          className="mt-1 size-5 rounded-control border border-line-strong"
        />
        <span className="text-small text-ink">
          {t("connectedApps.consent.acknowledge")}
        </span>
      </label>

      {grantFailed ? (
        <Notice tone="danger" live>
          {t("connectedApps.consent.errors.failed")}
        </Notice>
      ) : null}
    </Panel>
  );
}

/** One named fact about the request. Absent values say so in words. */
function Fact({
  label,
  value,
}: {
  label: string;
  value: string | null;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-label text-ink-muted uppercase">{label}</dt>
      <dd className="font-data text-body text-ink">
        {value ?? t("connectedApps.consent.hostUnknown")}
      </dd>
    </div>
  );
}

/**
 * One list of actions the member reads before deciding.
 *
 * The heading and each entry are rendered as the catalogue resolved them. The
 * catalogue answers in text rather than in keys because a plugin's own strings
 * live in that plugin's namespace, which this bundle does not carry, and a
 * screen that translated half its list and printed keys for the other half
 * would be worse than one that translated none of it.
 *
 * A list given an empty label says "nothing" rather than going quiet, because
 * an absent list reads as a screen that failed to load.
 */
function Declaration({
  title,
  entries,
  emptyLabel,
}: {
  title: string;
  entries: readonly { name: string; title: string }[];
  emptyLabel?: string;
}): ReactElement | null {
  if (entries.length === 0 && emptyLabel === undefined) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-small text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {entries.map((entry) => (
            <li
              key={entry.name}
              className="border-l-2 border-line-strong pl-3 text-small text-ink"
            >
              {entry.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The catalogue in the order it arrived, gathered into its groups. */
function groupActions(
  actions: readonly ActionSummary[],
  translate: (key: string) => string,
  exists: (key: string) => boolean,
): ActionGroup[] {
  const groups = new Map<string, ActionGroup>();
  for (const action of actions) {
    const entry = {
      name: action.name,
      title: preferInterfaceWording(
        translate,
        exists,
        action.titleKey,
        action.title,
      ),
    };
    const existing = groups.get(action.group);
    if (existing === undefined) {
      groups.set(action.group, {
        group: action.group,
        title: preferInterfaceWording(
          translate,
          exists,
          action.groupTitleKey,
          action.groupTitle,
        ),
        entries: [entry],
      });
    } else {
      existing.entries.push(entry);
    }
  }
  return [...groups.values()];
}

/**
 * What the request says, or null when it is not one.
 *
 * A client id and a signature are what make it a request; without either there
 * is nothing to ask a member about. Read with the browser's own parser and
 * never written back: everything that leaves this screen is the string as it
 * arrived.
 */
function readRequest(search: string): AuthorizationRequest | null {
  const params = new URLSearchParams(search);
  const clientId = params.get("client_id");
  const signature = params.get("sig");
  if (
    clientId === null ||
    clientId === "" ||
    signature === null ||
    signature === ""
  ) {
    return null;
  }

  const redirectUri = params.get("redirect_uri");
  const expiry = Number(params.get("exp"));

  return {
    clientId,
    redirectHost: hostOf(redirectUri),
    redirectIsLoopback: isLoopback(redirectUri),
    expiresAt: Number.isFinite(expiry) && expiry > 0 ? expiry * 1000 : null,
  };
}

/** The app's own name, when it registered one. */
function clientName(client: OAuthClientDetails): string | null {
  const name = client.client_name;
  return typeof name === "string" && name.trim() !== "" ? name : null;
}

/**
 * Where the app itself lives.
 *
 * A client that identified itself by the address of its own metadata document
 * has that address as its id, which is the most truthful host to show. One
 * registered by an administrator has no such id and carries a declared address
 * instead.
 */
function clientHost(client: OAuthClientDetails): string | null {
  return hostOf(client.client_id) ?? hostOf(client.client_uri ?? null);
}

/** The host of an address. Null rather than a placeholder when it is not one. */
function hostOf(value: string | null): string | null {
  if (value === null || value === "") {
    return null;
  }
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * Whether the answer goes back to the member's own machine.
 *
 * Normal for an app running on the desk in front of them, and worth saying out
 * loud for one they do not recognise: a loopback address is where a program on
 * this computer listens, so the authorization code is handed to whatever that
 * is.
 */
function isLoopback(value: string | null): boolean {
  if (value === null || value === "") {
    return false;
  }
  let hostname: string;
  try {
    hostname = new URL(value).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.startsWith("127.") ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}
