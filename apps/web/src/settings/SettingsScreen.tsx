import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { AddressView, InstanceSettings, Viewer } from "../api/instance";
import { fetchAddresses, fetchSettings } from "../api/instance";
import { useSession } from "../auth/auth-client";
import { SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { AddressesPanel } from "./AddressesPanel";
import { ApartmentsPanel } from "./ApartmentsPanel";
import { BrandingPanel } from "./BrandingPanel";
import { ContactInboxPanel } from "./ContactInboxPanel";
import { HousingCooperativePanel } from "./HousingCooperativePanel";
import { IssueReportingPanel } from "./IssueReportingPanel";
import { IssueTypesPanel } from "./IssueTypesPanel";
import { ProfilePanel } from "./ProfilePanel";
import { RetentionPanel } from "./RetentionPanel";
import { SecurityPanel } from "./SecurityPanel";
import { SelfSignupPanel } from "./SelfSignupPanel";
import { SignupRequestQueuePanel } from "./SignupRequestQueuePanel";
import { SmsPanel } from "./SmsPanel";
import { SmtpPanel } from "./SmtpPanel";
import { ThemesPanel } from "../themes/ThemesPanel";

export interface SettingsScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  /**
   * Whether the reads below have settled.
   *
   * Distinct from "there is nothing to show", because the two states look the
   * same and mean opposite things. Before the reads land, a null housing
   * cooperative and an empty address list are simply unknown - and the panels
   * that render them are editable, so a manager could type a name over a
   * cooperative that already has one (the write upserts) or add an entrance that
   * is already in the register. Apartment rows hang off address rows, so a
   * second row for one entrance splits that entrance's apartment numbers across
   * two of them.
   */
  ready: boolean;
  settings: InstanceSettings | null;
  addresses: readonly AddressView[];
  loadFailed: boolean;
}

const EMPTY: Loaded = {
  ready: false,
  settings: null,
  addresses: [],
  loadFailed: false,
};

/**
 * The settings screen.
 *
 * It renders the same panels the setup wizard does. That is not a saving of
 * effort: the plan requires every step of the wizard after the administrator
 * account and the name to be skippable and completable later here, and building
 * both screens from one set of panels is what makes that true by construction
 * rather than by somebody remembering to build each form twice.
 *
 * What a viewer sees follows from their capabilities. A resident gets their own
 * profile and their own security; a board member additionally reads the
 * instance settings; an admin can change them. Hiding a panel is courtesy only -
 * the API enforces the same rules and refuses the call either way.
 *
 * Several panels are keyed on the values they were seeded with. They hold their
 * fields in local state, so without a key a reload after a save would leave the
 * form showing what was typed rather than what is now stored.
 */
export function SettingsScreen({ viewer }: SettingsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { data: session } = useSession();

  const canRead = viewer.capabilities.includes("association:read");
  const canManage = viewer.capabilities.includes("association:manage");
  const canEditAddresses = viewer.capabilities.includes("addressBook:write");
  const canDecideSignup = viewer.capabilities.includes("signupRequest:decide");
  const canConfigureIssues = viewer.capabilities.includes("issues:configure");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);

  const read = useCallback(async (): Promise<Loaded> => {
    if (!canRead) {
      // Nothing to wait for: this viewer never asks for the instance settings,
      // and the panels that need them are not rendered for them either.
      return { ...EMPTY, ready: true };
    }
    const [instance, addressList] = await Promise.all([
      fetchSettings(),
      fetchAddresses(),
    ]);

    return {
      ready: true,
      settings: instance.ok ? instance.value : null,
      /*
       * A missing housing cooperative is not a failure to report: the resume
       * notice below already says setup is unfinished, and an error banner on
       * top of it would be two messages for one situation.
       *
       * A failed ADDRESS load is. Without it the panels render an empty list as
       * "no addresses registered", and the apartment register hangs off address
       * rows: a board reading that adds an entrance that already exists, and the
       * apartment numbers for one entrance then split across two address rows.
       */
      loadFailed:
        (!instance.ok &&
          instance.failure.reason !== "housing-cooperative-missing") ||
        !addressList.ok,
      addresses: addressList.ok ? addressList.value : [],
    };
  }, [canRead]);

  useEffect(() => {
    // The effect owns its own call and drops a response that arrives after the
    // screen is gone, rather than applying it to a component nobody is looking
    // at.
    let active = true;
    void read().then((next) => {
      if (active) {
        setLoaded(next);
      }
    });
    return () => {
      active = false;
    };
  }, [read]);

  const reload = (): void => {
    void read().then(setLoaded);
  };

  const { ready, settings, addresses, loadFailed } = loaded;
  // Gated on the read too: an unset completion date is unknown until then, so
  // without this the resume notice flashes on every settings visit.
  const setupUnfinished =
    canRead && ready && settings?.housingCooperative.setupCompletedAt == null;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("settings.title")}</h1>
        <p className="text-body text-ink-muted">{t("settings.intro")}</p>
      </header>

      {loadFailed ? (
        // Its own sentence: this notice reports a failed READ, and the shared
        // "could not be saved" would tell a board their settings had been lost.
        <Notice tone="danger" live>
          {t("settings.errors.loadFailed")}
        </Notice>
      ) : null}

      {setupUnfinished && canManage ? (
        <div className="flex flex-col gap-3">
          <Notice tone="info">{t("setup.resume.body")}</Notice>
          <div>
            <Link to="/setup" className={SECONDARY_BUTTON}>
              {t("setup.resume.open")}
            </Link>
          </div>
        </div>
      ) : null}

      {canRead && !ready ? (
        <p role="status" className="text-body text-ink-muted">
          {t("settings.loading")}
        </p>
      ) : null}

      {canRead && ready ? (
        <>
          <HousingCooperativePanel
            key={settings?.housingCooperative.name ?? "unnamed"}
            value={settings?.housingCooperative ?? null}
            editable={canManage}
            onSaved={reload}
          />

          <AddressesPanel
            addresses={addresses}
            editable={canEditAddresses}
            onChanged={reload}
          />

          <ApartmentsPanel
            addresses={addresses}
            editable={canEditAddresses}
            onChanged={reload}
          />

          {settings === null ? null : (
            <>
              <SmtpPanel
                key={`smtp-${settings.smtp.host ?? ""}-${String(settings.smtp.passwordSet)}`}
                value={settings.smtp}
                editable={canManage}
                onSaved={reload}
              />

              <SmsPanel
                key={`sms-${settings.sms.driver ?? ""}-${settings.sms.gatewayUrl ?? ""}-${String(settings.sms.tokenSet)}`}
                value={settings.sms}
                editable={canManage}
                onSaved={reload}
              />

              <BrandingPanel
                key={`branding-${settings.branding.primaryColor ?? ""}`}
                value={settings.branding}
                editable={canManage}
                onSaved={reload}
              />

              <RetentionPanel
                key={`retention-${String(settings.retention.daysAfterMoveOut)}`}
                daysAfterMoveOut={settings.retention.daysAfterMoveOut}
                editable={canManage}
              />

              <SelfSignupPanel
                enabled={settings.selfSignup.enabled}
                editable={canManage}
              />

              {/* Beside the switch that produced them, and shown to whoever
                  may actually decide a request: the board, and an admin. */}
              {canDecideSignup ? (
                <SignupRequestQueuePanel addresses={addresses} />
              ) : null}

              {/* The second inbound queue an anonymous visitor can put
                  something in, read by the same circle for the same reason.
                  A capability of its own would have had a grant list identical
                  to this one's. */}
              {canDecideSignup ? <ContactInboxPanel /> : null}

              <IssueReportingPanel
                publicFormEnabled={settings.issueReporting.publicFormEnabled}
                editable={canManage}
              />

              {/* Beside the switch that decides whether the website carries a
                  form, because the audience on a type is what that form then
                  offers. The board configures the catalogue; an administrator
                  decides whether the public one exists. */}
              {canConfigureIssues ? <IssueTypesPanel /> : null}

              {/* Installing and switching themes is an administrator's job,
                  and the API refuses the calls for anyone else. */}
              {canManage ? <ThemesPanel /> : null}
            </>
          )}
        </>
      ) : null}

      <ProfilePanel viewer={viewer} />

      <SecurityPanel
        twoFactorEnabled={session?.user.twoFactorEnabled === true}
      />
    </div>
  );
}
