import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import type { TranslationKey } from "../i18n/translation-key";
import { LoadFailure } from "../ui/LoadFailure";
import { formatMoment } from "../ui/moment";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey } from "../ui/save-state";
import { TwoPressConfirm } from "../ui/TwoPressConfirm";
import {
  type DeviceToken,
  fetchDeviceTokens,
  revokeDeviceToken,
} from "./devices-api";

/** Everything one read produces, applied to the screen in one step. */
interface Loaded {
  /** Whether the read has settled; before it does, an empty list is unknown. */
  ready: boolean;
  devices: readonly DeviceToken[];
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, devices: [], loadFailed: false };

/**
 * The revoke refusals, and the sentence each becomes. A token already revoked
 * - from the plugin's own screen, or in another tab - answers not found, and
 * reading the list again is the way out.
 */
const REVOKE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "device-token-not-found": "devices.errors.notFound",
};

/**
 * Every live device token on the instance, and the board's way of cutting one
 * (ADR 0031).
 *
 * The board issues the tokens from a plugin's own screen, so the board has to
 * be able to revoke them here as well: cutting a screen on the wall never
 * depends on the plugin's screen being right. Under `site:manage`, which is
 * what issuing takes; the route checks it and the API enforces it.
 *
 * Sorted by plugin and then newest first, as the API answers. The day a device
 * was last heard from is what stands in for an expiry, so it is on every row.
 */
export function DevicesScreen(): ReactElement {
  const { t, i18n } = useTranslation();
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  /** Only the newest read may be applied; see ConnectedAppsScreen. */
  const currentRead = useRef(0);

  const read = useCallback(async (): Promise<Loaded> => {
    const result = await fetchDeviceTokens();
    return result.ok
      ? { ...EMPTY, ready: true, devices: result.value.devices }
      : { ...EMPTY, ready: true, loadFailed: true };
  }, []);

  const readInto = useCallback((): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        setLoaded(next);
      }
    });
  }, [read]);

  useEffect(() => {
    readInto();
    return () => {
      currentRead.current += 1;
    };
  }, [readInto]);

  const { ready, devices, loadFailed } = loaded;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("devices.title")}</h1>
        <p className="text-body text-ink-muted">{t("devices.intro")}</p>
      </header>

      {loadFailed ? (
        <LoadFailure messageKey="devices.loadFailed" onRetry={readInto} />
      ) : null}

      {!ready && !loadFailed ? (
        <p role="status" className="text-body text-ink-muted">
          {t("devices.loading")}
        </p>
      ) : null}

      {ready && !loadFailed ? (
        <Panel title={t("devices.listTitle")}>
          {devices.length === 0 ? (
            <p className="text-body text-ink-muted">{t("devices.empty")}</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {devices.map((device) => (
                <DeviceRow
                  key={device.id}
                  device={device}
                  locale={i18n.language}
                  onChanged={readInto}
                />
              ))}
            </ul>
          )}
        </Panel>
      ) : null}
    </div>
  );
}

/**
 * One device, and revoking its token.
 *
 * The state of the act is the row's own, on the connected apps' precedent: a
 * failure belongs beside the device it happened to.
 */
function DeviceRow({
  device,
  locale,
  onChanged,
}: {
  device: DeviceToken;
  locale: string;
  onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  /** Revoking is two presses, see {@link TwoPressConfirm}. */
  const [confirming, setConfirming] = useState(false);
  const [failureKey, setFailureKey] = useState<TranslationKey | null>(null);

  const revoke = async (): Promise<void> => {
    setBusy(true);
    setFailureKey(null);
    const result = await revokeDeviceToken(device.id);
    setBusy(false);

    if (!result.ok) {
      setFailureKey(
        failureMessageKey(
          result.failure,
          REVOKE_FAILURES,
          "devices.errors.revokeFailed",
        ),
      );
      return;
    }

    setConfirming(false);
    // Re-read rather than struck from the list here: what is live is the
    // server's answer.
    onChanged();
  };

  return (
    <li className="flex flex-col gap-1 rounded-control border border-line bg-page px-3 py-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-body">{device.label}</span>
        <span className="font-data text-small text-ink-muted">
          {device.pluginId}
        </span>
      </div>

      <p className="text-small">
        <span className="text-label text-ink-muted uppercase">
          {t("devices.issuedBy")}
        </span>{" "}
        {device.issuedBy?.name ?? t("devices.issuedByUnknown")}
      </p>

      <p className="text-small text-ink-muted">
        <span className="text-label uppercase">{t("devices.issuedAt")}</span>{" "}
        <span className="font-data">
          {formatMoment(device.issuedAt, locale)}
        </span>
      </p>

      <p className="text-small text-ink-muted">
        <span className="text-label uppercase">{t("devices.lastUsedAt")}</span>{" "}
        <span className="font-data">
          {device.lastUsedAt === null
            ? t("devices.neverUsed")
            : formatMoment(device.lastUsedAt, locale)}
        </span>
      </p>

      <TwoPressConfirm
        confirming={confirming}
        busy={busy}
        askText={t("devices.revoke")}
        askLabel={t("devices.revokeLabelFor", { device: device.label })}
        confirmText={busy ? t("devices.revoking") : t("devices.revokeConfirm")}
        keepText={t("devices.revokeCancel")}
        onAsk={() => {
          setConfirming(true);
        }}
        onConfirm={() => {
          void revoke();
        }}
        onKeep={() => {
          setConfirming(false);
        }}
      />

      {confirming ? (
        <Notice tone="warn" live>
          {t("devices.revokeWarning")}
        </Notice>
      ) : null}

      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}
    </li>
  );
}
