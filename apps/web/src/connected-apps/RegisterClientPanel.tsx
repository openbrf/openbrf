import { useEffect, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_DATA,
  HINT,
  LABEL,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { registerClientFailureKey } from "./connected-app-failures";
import {
  fetchProtectedResource,
  registerOAuthClient,
  type RegisteredClient,
} from "./connections-api";

/**
 * A credential, on the mono grid.
 *
 * The same treatment the authenticator app's setup link gets in the security
 * panel: a secret in text form is read character by character and typed into
 * something else, so it sits on the data face, stays selectable, and wraps
 * rather than being truncated out of reach.
 */
const CREDENTIAL =
  "rounded-control border border-line bg-sunken p-2 font-data text-data break-all";

/**
 * Registering a client by hand.
 *
 * Most apps register themselves by presenting the URL of their own metadata
 * document, which is the path this product expects. This panel is for the one
 * that cannot - typically something the association had written for itself.
 *
 * Its own capability, and a different one from the list beside it: reading who
 * has connected what is association:read, and minting a client secret is
 * changing how the instance is configured. Hiding the panel is courtesy only;
 * the API refuses the call either way.
 *
 * The secret is shown once because it exists once. Nothing stores it and no
 * endpoint answers with it again, so a registration whose secret was not saved
 * is a registration that has to be done over.
 */
export function RegisterClientPanel(): ReactElement {
  const { t } = useTranslation();

  const [clientName, setClientName] = useState("");
  const [redirectUris, setRedirectUris] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<TranslationKey | null>(null);
  /**
   * What the last registration answered with.
   *
   * Held only for as long as this panel is on screen and never read back from
   * anywhere: the response that carried the secret is the one and only place it
   * exists.
   */
  const [registered, setRegistered] = useState<RegisteredClient | null>(null);

  const [resource, setResource] = useState<string | null>(null);
  const [resourceFailed, setResourceFailed] = useState(false);
  /**
   * Which read of the resource document is the current one.
   *
   * One read today, on mount, and versioned anyway: leaving the panel while it
   * is in flight would otherwise apply an answer to a screen nobody is looking
   * at, and the rule is the same one the screens follow for their lists.
   */
  const currentRead = useRef(0);

  useEffect(() => {
    const version = ++currentRead.current;
    void fetchProtectedResource().then((result) => {
      if (version !== currentRead.current) {
        return;
      }
      if (result.ok && result.value.resource !== undefined) {
        setResource(result.value.resource);
        setResourceFailed(false);
        return;
      }
      setResourceFailed(true);
    });
    return () => {
      currentRead.current += 1;
    };
  }, []);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    /*
     * Whatever the last registration answered with is dropped before this one
     * starts. A secret belongs to the client it was minted for, and leaving one
     * on screen beside another client's id is how the wrong pair gets saved.
     */
    setRegistered(null);

    const result = await registerOAuthClient({
      clientName: clientName.trim(),
      redirectUris: redirectUriLines(redirectUris),
    });

    setBusy(false);
    if (!result.ok) {
      setFailure(registerClientFailureKey(result.failure));
      return;
    }

    setClientName("");
    setRedirectUris("");
    setRegistered(result.value);
  };

  return (
    <Panel
      title={t("connectedApps.register.title")}
      description={t("connectedApps.register.description")}
      notice={
        failure === null ? null : (
          <Notice tone="danger" live>
            {t(failure)}
          </Notice>
        )
      }
    >
      {/* A standing fact about the instance rather than part of a registration:
          every client sends this address, whether it was registered here or
          presented a metadata document of its own. */}
      <div className="flex flex-col gap-1">
        <span className="text-label text-ink-muted uppercase">
          {t("connectedApps.register.resource")}
        </span>
        <code className={CREDENTIAL}>
          {resource ??
            t(
              resourceFailed
                ? "connectedApps.register.resourceUnknown"
                : "connectedApps.register.resourceLoading",
            )}
        </code>
        <span className={HINT}>{t("connectedApps.register.resourceHint")}</span>
      </div>

      <form
        className="flex flex-col gap-4 border-t border-line pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className={LABEL}>
          {t("connectedApps.register.clientName")}
          <input
            type="text"
            name="clientName"
            autoComplete="off"
            required
            /*
             * The same bound the endpoint accepts. It is what makes a refused
             * body on this form mean the addresses and nothing else, which is
             * what the sentence for that refusal says.
             */
            maxLength={200}
            value={clientName}
            onChange={(event) => {
              setClientName(event.target.value);
            }}
            className={FIELD}
          />
        </label>

        <label className={LABEL}>
          {t("connectedApps.register.redirectUris")}
          <textarea
            name="redirectUris"
            required
            rows={3}
            value={redirectUris}
            onChange={(event) => {
              setRedirectUris(event.target.value);
            }}
            className={FIELD_DATA}
          />
          <span className={HINT}>
            {t("connectedApps.register.redirectUrisHint")}
          </span>
        </label>

        <div>
          <button type="submit" disabled={busy} className={SECONDARY_BUTTON}>
            {busy
              ? t("connectedApps.register.submitting")
              : t("connectedApps.register.submit")}
          </button>
        </div>
      </form>

      {registered === null ? null : (
        <div className="flex flex-col gap-2 border-t border-line pt-4">
          <Notice tone="ok" live>
            {t("connectedApps.register.registered")}
          </Notice>

          <span className="text-label text-ink-muted uppercase">
            {t("connectedApps.register.clientId")}
          </span>
          <code className={CREDENTIAL}>{registered.clientId}</code>

          {registered.clientSecret === null ? (
            <span className={HINT}>{t("connectedApps.register.noSecret")}</span>
          ) : (
            <>
              <span className="text-label text-ink-muted uppercase">
                {t("connectedApps.register.clientSecret")}
              </span>
              <code className={CREDENTIAL}>{registered.clientSecret}</code>
              <span className={HINT}>
                {t("connectedApps.register.secretOnce")}
              </span>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}

/**
 * The addresses, one per line.
 *
 * Blank lines are dropped rather than sent: a trailing newline is what a text
 * area is left with after typing one address, and an empty string would be
 * refused by the endpoint as an address that is not one.
 */
function redirectUriLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}
