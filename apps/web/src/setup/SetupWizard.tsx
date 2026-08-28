import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { AddressView, InstanceSettings } from "../api/instance";
import { completeSetup, fetchAddresses, fetchSettings } from "../api/instance";
import type { TranslationKey } from "../i18n/translation-key";
import { AddressesPanel } from "../settings/AddressesPanel";
import { ApartmentsPanel } from "../settings/ApartmentsPanel";
import { BrandingPanel } from "../settings/BrandingPanel";
import { HousingCooperativePanel } from "../settings/HousingCooperativePanel";
import { SmtpPanel } from "../settings/SmtpPanel";
import {
  PANEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";

/**
 * The steps, in order.
 *
 * `skippable` encodes the plan's rule directly: everything after the
 * administrator account and the housing cooperative's name can be left for
 * later, and everything left for later is completable in settings because both
 * screens render the same panels.
 */
const STEPS = [
  {
    id: "administrator",
    labelKey: "setup.step.administrator",
    skippable: false,
  },
  {
    id: "housingCooperative",
    labelKey: "setup.step.housingCooperative",
    skippable: false,
  },
  { id: "addresses", labelKey: "setup.step.addresses", skippable: true },
  { id: "apartments", labelKey: "setup.step.apartments", skippable: true },
  { id: "smtp", labelKey: "setup.step.smtp", skippable: true },
  { id: "branding", labelKey: "setup.step.branding", skippable: true },
  { id: "done", labelKey: "setup.step.done", skippable: false },
] as const satisfies readonly {
  id: string;
  labelKey: TranslationKey;
  skippable: boolean;
}[];

type StepId = (typeof STEPS)[number]["id"];

/** What one load of the instance's state produces. */
interface Loaded {
  settings: InstanceSettings | null;
  addresses: readonly AddressView[];
}

const EMPTY: Loaded = { settings: null, addresses: [] };

export interface SetupWizardProps {
  /**
   * Whether the public first step is still open. False when an administrator
   * already exists and an admin is resuming the wizard from settings.
   */
  administratorNeeded: boolean;
  /** Where to go once setup is finished. */
  onFinished: () => void;
  /** Renders the administrator step. Injected so it can be tested apart. */
  administratorStep: (props: { onCreated: () => void }) => ReactElement;
}

/**
 * The first-boot wizard.
 *
 * Every step writes as it goes rather than collecting a form and posting it at
 * the end. That is deliberate: an instance whose operator closes the tab after
 * step three keeps the three steps' work, and the remaining steps are the same
 * panels the settings screen shows. A wizard that only commits on the last
 * screen would make skipping and resuming a different code path from settings,
 * and the two would drift.
 */
export function SetupWizard({
  administratorNeeded,
  onFinished,
  administratorStep,
}: SetupWizardProps): ReactElement {
  const { t } = useTranslation();

  const [stepId, setStepId] = useState<StepId>(
    administratorNeeded ? "administrator" : "housingCooperative",
  );
  const [skipped, setSkipped] = useState<readonly StepId[]>([]);
  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [finishFailed, setFinishFailed] = useState(false);

  const read = useCallback(async (): Promise<Loaded> => {
    const [instance, addressList] = await Promise.all([
      fetchSettings(),
      fetchAddresses(),
    ]);
    return {
      settings: instance.ok ? instance.value : null,
      addresses: addressList.ok ? addressList.value : [],
    };
  }, []);

  useEffect(() => {
    // Nothing to read before an account exists: both endpoints need a session.
    if (stepId === "administrator") {
      return;
    }
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, [stepId, read]);

  const reload = (): void => {
    void read().then(setLoaded);
  };

  const { settings, addresses } = loaded;

  const index = STEPS.findIndex((step) => step.id === stepId);
  const step = STEPS[index] ?? STEPS[0];

  const goTo = (id: StepId): void => {
    setStepId(id);
  };

  const advance = (): void => {
    const next = STEPS[index + 1];
    if (next !== undefined) {
      goTo(next.id);
    }
  };

  const skip = (): void => {
    setSkipped(skipped.includes(step.id) ? skipped : [...skipped, step.id]);
    advance();
  };

  const finish = async (): Promise<void> => {
    const result = await completeSetup();
    if (!result.ok) {
      setFinishFailed(true);
      return;
    }
    onFinished();
  };

  const canGoBack =
    index > 0 &&
    !(administratorNeeded && STEPS[index - 1]?.id === "administrator");

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 py-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-display">{t("setup.title")}</h1>
        <p className="text-body text-ink-muted">{t("setup.intro")}</p>
      </header>

      <StepIndicator currentIndex={index} skipped={skipped} />

      {stepId === "administrator"
        ? administratorStep({
            onCreated: () => {
              goTo("housingCooperative");
            },
          })
        : null}

      {stepId === "housingCooperative" ? (
        <HousingCooperativePanel
          key={settings?.housingCooperative.name ?? "unnamed"}
          value={settings?.housingCooperative ?? null}
          submitLabel={t("setup.next")}
          onSaved={() => {
            reload();
            advance();
          }}
        />
      ) : null}

      {stepId === "addresses" ? (
        <AddressesPanel addresses={addresses} onChanged={reload} />
      ) : null}

      {stepId === "apartments" ? (
        <ApartmentsPanel addresses={addresses} onChanged={reload} />
      ) : null}

      {stepId === "smtp" && settings !== null ? (
        <SmtpPanel
          key={`smtp-${settings.smtp.host ?? ""}`}
          value={settings.smtp}
          submitLabel={t("settings.save")}
          onSaved={reload}
        />
      ) : null}

      {stepId === "branding" && settings !== null ? (
        <BrandingPanel
          key={`branding-${settings.branding.primaryColor ?? ""}`}
          value={settings.branding}
          onSaved={reload}
        />
      ) : null}

      {stepId === "done" ? (
        <section className={`flex flex-col gap-4 ${PANEL}`}>
          <h2 className="text-title">{t("setup.done.title")}</h2>
          <p className="text-body">{t("setup.done.body")}</p>

          {skipped.length > 0 ? (
            <Notice tone="info">
              {t("setup.done.skippedNotice", {
                steps: skipped.map((id) => t(labelKeyOf(id))).join(", "),
              })}
            </Notice>
          ) : null}

          {settings?.smtp.configured === false ? (
            <Notice tone="warn">{t("settings.smtp.notConfigured")}</Notice>
          ) : null}

          {finishFailed ? (
            <Notice tone="danger" live>
              {t("settings.errors.unknown")}
            </Notice>
          ) : null}

          <div>
            <button
              type="button"
              onClick={() => {
                void finish();
              }}
              className={PRIMARY_BUTTON}
            >
              {t("setup.finish")}
            </button>
          </div>
        </section>
      ) : null}

      {stepId === "administrator" ? null : (
        <nav
          aria-label={t("setup.title")}
          className="flex flex-wrap items-center gap-3"
        >
          {canGoBack ? (
            <button
              type="button"
              onClick={() => {
                const previous = STEPS[index - 1];
                if (previous !== undefined) {
                  goTo(previous.id);
                }
              }}
              className={QUIET_BUTTON}
            >
              {t("setup.back")}
            </button>
          ) : null}

          {step.skippable ? (
            <>
              <button type="button" onClick={skip} className={QUIET_BUTTON}>
                {t("setup.skip")}
              </button>
              <button
                type="button"
                onClick={advance}
                className={SECONDARY_BUTTON}
              >
                {t("setup.next")}
              </button>
            </>
          ) : null}
        </nav>
      )}
    </div>
  );
}

function labelKeyOf(id: StepId): TranslationKey {
  return (
    STEPS.find((step) => step.id === id)?.labelKey ?? "setup.step.administrator"
  );
}

/**
 * Where the operator is in the sequence.
 *
 * The current step carries three signals at once: the brass rule, the word
 * "step N of M", and its own name in full. Colour alone would leave a
 * red-green colour blind board member counting dots.
 */
function StepIndicator({
  currentIndex,
  skipped,
}: {
  currentIndex: number;
  skipped: readonly StepId[];
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-2">
      <p className="text-label text-ink-muted uppercase">
        {t("setup.progressLabel", {
          current: currentIndex + 1,
          total: STEPS.length,
        })}
      </p>
      <ol className="flex flex-wrap gap-2">
        {STEPS.map((step, index) => {
          const current = index === currentIndex;
          const wasSkipped = skipped.includes(step.id);
          return (
            <li
              key={step.id}
              aria-current={current ? "step" : undefined}
              className={`rounded-control border-b-[3px] px-2 py-1 text-chip uppercase ${
                current
                  ? "border-trust bg-trust-soft text-ink"
                  : wasSkipped
                    ? "border-dashed border-warn text-ink-muted"
                    : "border-line text-ink-muted"
              }`}
            >
              {t(step.labelKey)}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
