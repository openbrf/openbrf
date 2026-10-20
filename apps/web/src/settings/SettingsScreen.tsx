import { Link, Navigate } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";

import type { AddressView, InstanceSettings, Viewer } from "../api/instance";
import { fetchAddresses, fetchSettings } from "../api/instance";
import { useSession } from "../auth/auth-client";
import { BoardZone } from "../ui/BoardZone";
import { SECONDARY_BUTTON } from "../ui/controls";
import { LoadFailure } from "../ui/LoadFailure";
import { Notice } from "../ui/Notice";
import { AddressesPanel } from "./AddressesPanel";
import { ApartmentsPanel } from "./ApartmentsPanel";
import { BoardMailboxPanel } from "./BoardMailboxPanel";
import { BookableResourcesPanel } from "./BookableResourcesPanel";
import { BrandingPanel } from "./BrandingPanel";
import { ContactInboxPanel } from "./ContactInboxPanel";
import { HousingCooperativePanel } from "./HousingCooperativePanel";
import { IssueReportingPanel } from "./IssueReportingPanel";
import { IssueTypesPanel } from "./IssueTypesPanel";
import { MeetingBylawsPanel } from "./MeetingBylawsPanel";
import { MotionDeadlinePanel } from "./MotionDeadlinePanel";
import { ProfilePanel } from "./ProfilePanel";
import { DataProtectionContactsPanel } from "./DataProtectionContactsPanel";
import { FinancesPanel } from "./FinancesPanel";
import { RetentionPanel } from "./RetentionPanel";
import { SecurityPanel } from "./SecurityPanel";
import { SelfSignupPanel } from "./SelfSignupPanel";
import { SignupRequestQueuePanel } from "./SignupRequestQueuePanel";
import { SmsPanel } from "./SmsPanel";
import { SmtpPanel } from "./SmtpPanel";
import { SupportAccessPanel } from "./SupportAccessPanel";
import { isReadOnly, ReadOnlyRegion } from "../support/read-only";
import { ThemesPanel } from "../themes/ThemesPanel";
import {
  panelsIn,
  sectionsFor,
  settingsAccessOf,
  type SettingsPanelId,
  type SettingsPanelInput,
} from "./settings-sections";
import { SettingsNav } from "./SettingsNav";
import { useFocusAcrossReload } from "./use-focus-across-reload";

export interface SettingsScreenProps {
  viewer: Viewer;
  /**
   * The section in the address, as typed: undefined on /settings itself, and
   * possibly one that does not exist or that this viewer has nothing in.
   */
  section: string | undefined;
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
 * The settings screen: the frame every section shares, and the section open in
 * the address.
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
 * the API enforces the same rules and refuses the call either way. Which
 * section holds which panel, and who is offered each, is settings-sections.ts.
 *
 * A support session (ADR 0028) sees what the administrator's capabilities it
 * holds would show, and changes none of it: every panel is read-only, and each
 * sits in a disabled fieldset, so a panel that has no read-only form of its own
 * offers no control that would send anything either.
 *
 * The read below is made once for every section and stays mounted while the
 * reader moves between them, so switching sections fetches nothing again and
 * a failed read or an unfinished setup is reported whichever section is open.
 *
 * Several panels are keyed on the values they were seeded with. They hold their
 * fields in local state, so without a key a reload after a save would leave the
 * form showing what was typed rather than what is now stored.
 */
export function SettingsScreen({
  viewer,
  section,
}: SettingsScreenProps): ReactElement {
  const { t } = useTranslation();
  const { data: session } = useSession();

  const isSupportSession = isReadOnly(viewer);
  const access = settingsAccessOf(viewer.capabilities, isSupportSession);
  // What the viewer may change, which for a support session is nothing.
  const canManage = access.canManage && !isSupportSession;
  const canEditAddresses = access.canEditAddresses && !isSupportSession;
  const canManageSite = access.canManageSite && !isSupportSession;
  // Off the capabilities rather than the object above, which is a new one on
  // every render: the read below is remade whenever this changes.
  const canRead = viewer.capabilities.includes("association:read");

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

  /*
   * Which read is the current one. Two quick saves start two reads, and if the
   * older one lands last the keyed panels are built again from values that are
   * no longer stored. Only the newest is applied; leaving the screen
   * supersedes whatever is in flight the same way.
   */
  const currentRead = useRef(0);

  /*
   * Saves folded into the snapshot by patchSettings, each with the read that was
   * current when it was made. That read began before the save committed, so it
   * can answer with the value from before it.
   */
  const patches = useRef<
    { after: number; patch: (current: InstanceSettings) => InstanceSettings }[]
  >([]);

  /*
   * Puts a read that has landed into the snapshot. A save made after it began
   * is applied to it again: dropping the read instead would lose what it
   * carries for the save that started it (the retention window the nightly
   * purge uses would go back to the value before the board changed it).
   */
  const settle = useCallback((version: number, next: Loaded): void => {
    const newer = patches.current.filter((each) => each.after >= version);
    patches.current = newer.filter((each) => each.after > version);
    setLoaded(
      next.settings === null
        ? next
        : {
            ...next,
            settings: newer.reduce(
              (settings, each) => each.patch(settings),
              next.settings,
            ),
          },
    );
  }, []);

  useEffect(() => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        settle(version, next);
      }
    });
    return () => {
      currentRead.current += 1;
    };
  }, [read, settle]);

  // A panel keyed on what a save changes is built again by the reload, and
  // would take the focus of whoever sent it with Enter along.
  const [profileSaves, setProfileSaves] = useState(0);
  const applied = useMemo(
    () => ({ loaded, profileSaves }),
    [loaded, profileSaves],
  );
  const { rootRef, remember } = useFocusAcrossReload(applied);

  const reload = (): void => {
    const version = ++currentRead.current;
    void read().then((next) => {
      if (version === currentRead.current) {
        remember();
        settle(version, next);
      }
    });
  };

  /*
   * Folds a save the panel has already made into the shared snapshot, without
   * reading again. A panel that saves only inside itself is built again from
   * this snapshot when the reader returns to its section, and would show what
   * was stored before the save - and the next save from it would undo the
   * change. No refetch and no new key: the panel keeps its notice and focus,
   * and moving between sections still fetches nothing. The control that was
   * saving is disabled until the answer lands and has lost focus by then, so
   * focus is remembered here as it is before a reload is applied.
   */
  const patchSettings = (
    patch: (current: InstanceSettings) => InstanceSettings,
  ): void => {
    patches.current.push({ after: currentRead.current, patch });
    remember();
    setLoaded((previous) =>
      previous.settings === null
        ? previous
        : { ...previous, settings: patch(previous.settings) },
    );
  };

  /*
   * The language saved on the profile panel. The viewer is loaded once above
   * this screen and is not reloaded by a save, so without this the panel is
   * built again from the language the viewer had when the page opened.
   */
  const [savedLocale, setSavedLocale] = useState<string | null>(null);
  const currentViewer =
    savedLocale === null ? viewer : { ...viewer, preferredLocale: savedLocale };

  const { ready, settings, addresses, loadFailed } = loaded;
  /*
   * Only a read that answered decides this. Before it lands an unset completion
   * date is unknown, and after one that failed it still is. A null `settings`
   * without a failure is the answer "no cooperative yet", which is unfinished.
   */
  const setupUnfinished =
    canRead &&
    ready &&
    !loadFailed &&
    settings?.housingCooperative.setupCompletedAt == null;

  const sections = sectionsFor(access);
  const current = sections.find((each) => each.id === section);
  if (current === undefined) {
    /*
     * /settings itself, a section that does not exist, or one this viewer has
     * nothing in: the first section they do have, in place of the address
     * rather than after it, so the back button does not return to a page that
     * only sends them on again. Every account has its own, so there is always
     * a first.
     */
    return (
      <Navigate
        to="/settings/$section"
        params={{ section: sections[0]?.id ?? "account" }}
        replace
      />
    );
  }

  const panels = panelsIn(current.id, access);
  const waitsForTheRead = panels.some((panel) => panel.needs !== "nothing");
  /* Not while the read is out, and not after one that failed: the panels are
     seeded from it and editable, and the cooperative write upserts - a blank
     form saved over a cooperative that exists would clear its organisation
     number. */
  const hasTheRead = canRead && ready && !loadFailed;

  const shows = (needs: SettingsPanelInput): boolean =>
    needs === "nothing" ||
    (hasTheRead && (needs === "addresses" || settings !== null));

  const renderPanel = (id: SettingsPanelId): ReactNode => {
    switch (id) {
      case "profile":
        return (
          <ProfilePanel
            viewer={currentViewer}
            onSaved={(saved) => {
              // The save button is disabled until this answer, and has lost
              // focus by now. The count makes a save that stores the language
              // the viewer already has restore it too.
              remember();
              setSavedLocale(saved.preferredLocale);
              setProfileSaves((count) => count + 1);
            }}
          />
        );
      case "security":
        return (
          <SecurityPanel
            twoFactorEnabled={session?.user.twoFactorEnabled === true}
          />
        );
      case "housingCooperative":
        return (
          <HousingCooperativePanel
            key={settings?.housingCooperative.name ?? "unnamed"}
            value={settings?.housingCooperative ?? null}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "addresses":
        return (
          <AddressesPanel
            addresses={addresses}
            editable={canEditAddresses}
            onChanged={reload}
          />
        );
      case "apartments":
        return (
          <ApartmentsPanel
            addresses={addresses}
            editable={canEditAddresses}
            onChanged={reload}
          />
        );
    }
    // Every panel below is built from the instance settings, which `shows`
    // has already required.
    if (settings === null) {
      return null;
    }
    switch (id) {
      case "branding":
        return (
          <BrandingPanel
            key={`branding-${settings.branding.primaryColor ?? ""}`}
            value={settings.branding}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "themes":
        // Beside the colour, the other half of how the instance looks.
        return <ThemesPanel />;
      case "smtp":
        return (
          <SmtpPanel
            key={`smtp-${settings.smtp.source}-${settings.smtp.host ?? ""}-${settings.smtp.source === "settings" ? String(settings.smtp.passwordSet) : ""}`}
            value={settings.smtp}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "boardMailbox":
        return (
          <BoardMailboxPanel
            key={`board-mailbox-${settings.boardMailbox.host ?? ""}-${String(settings.boardMailbox.passwordSet)}`}
            value={settings.boardMailbox}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "sms":
        return (
          <SmsPanel
            key={`sms-${settings.sms.driver ?? ""}-${settings.sms.gatewayUrl ?? ""}-${String(settings.sms.tokenSet)}`}
            value={settings.sms}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "selfSignup":
        return (
          <SelfSignupPanel
            enabled={settings.selfSignup.enabled}
            editable={canManage}
            onSaved={(saved) => {
              patchSettings((current) => ({
                ...current,
                selfSignup: { ...current.selfSignup, ...saved },
              }));
            }}
          />
        );
      case "signupQueue":
        /* Beside the switch that produced them, and shown to whoever may
           actually decide a request: the board, and an admin. */
        return <SignupRequestQueuePanel addresses={addresses} />;
      case "contactInbox":
        /* The second inbound queue an anonymous visitor can put something
           in, read by the same circle for the same reason. A capability of
           its own would have had a grant list identical to this one's. */
        return <ContactInboxPanel canPlaceOnPage={canManageSite} />;
      case "issueReporting":
        return (
          <IssueReportingPanel
            publicFormEnabled={settings.issueReporting.publicFormEnabled}
            editable={canManage}
            onSaved={(saved) => {
              patchSettings((current) => ({
                ...current,
                issueReporting: { ...current.issueReporting, ...saved },
              }));
            }}
            canPlaceOnPage={canManageSite}
          />
        );
      case "issueTypes":
        /* Beside the switch that decides whether the website carries a form,
           because the audience on a type is what that form then offers. The
           board configures the catalogue; an administrator decides whether
           the public one exists. */
        return <IssueTypesPanel />;
      case "bookableResources":
        /* What the house offers and how much of it one household may take.
           The board's own policy for its own building, which is why it shares
           a section with the issue catalogue rather than sitting with the
           administrator's settings. */
        return <BookableResourcesPanel />;
      case "motionDeadline":
        /* The deadline the association's own bylaws set for motions to the
           general meeting. Read by the board, who answer for the clause, and
           changed by an administrator - the split the retention policy
           follows. Transcribed from stadgarna rather than decided here, which
           is why it has no default. */
        return (
          <MotionDeadlinePanel
            key={JSON.stringify(settings.motionDeadline)}
            motionDeadline={settings.motionDeadline}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "meetingBylaws":
        /* The four clauses BRL 9 kap. 14 § leaves to the association's own
           bylaws, beside the motion deadline because they are read out of
           the same paragraph of the stadgar. Unlike the deadline these have
           no empty state: every one of them has a statutory rule that applies
           unless the bylaws displace it, so an association that has recorded
           nothing is under the statute rather than half-configured. Two of
           the four are checked when a proxy is registered and two are
           reported for the meeting to apply; the panel says which. */
        return (
          <MeetingBylawsPanel
            key={JSON.stringify(settings.meetingBylaws)}
            meetingBylaws={settings.meetingBylaws}
            editable={canManage}
            onSaved={reload}
          />
        );
      case "retention":
        return (
          <RetentionPanel
            // Not keyed on the stored value: a save folds it into the
            // snapshot, and a key that followed it would build the panel again
            // and take its "Saved" notice and the focus with it.
            daysAfterMoveOut={settings.retention.daysAfterMoveOut}
            editable={canManage}
            onSaved={(saved) => {
              patchSettings((current) => ({
                ...current,
                retention: { ...current.retention, ...saved },
              }));
            }}
          />
        );
      case "dataProtectionContacts":
        /* Beside retention, which is the other setting the association is
           answerable for rather than one about how the instance behaves. */
        return (
          <DataProtectionContactsPanel
            contacts={settings.dataProtectionContacts}
            mayManage={canManage}
            onSaved={(saved) => {
              patchSettings((current) => ({
                ...current,
                dataProtectionContacts: saved,
              }));
            }}
          />
        );
      case "finances":
        /* With retention, because it is the other setting that decides when
           the instance erases what it holds: the financial year is what the
           charge and fee windows count from. */
        return (
          <FinancesPanel
            key={JSON.stringify(settings.finances)}
            finances={settings.finances}
            editable={canManage}
            onSaved={reload}
          />
        );
    }
    return null;
  };

  const renderAnyPanel = (id: SettingsPanelId): ReactNode =>
    id === "supportAccess" ? (
      <SupportAccessPanel editable={canManage} />
    ) : (
      renderPanel(id)
    );

  const sectionContent = (
    <>
      {waitsForTheRead && canRead && !ready ? (
        <p role="status" className="text-body text-ink-muted">
          {t("settings.loading")}
        </p>
      ) : null}

      {/* Nothing yet to configure here: the association has no name, and
          everything in this section hangs on it. The wizard's notice above
          tells an administrator where to give it one. */}
      {hasTheRead &&
      settings === null &&
      panels.every((panel) => panel.needs === "settings") ? (
        <p className="text-body text-ink-muted">
          {t("settings.errors.housingCooperativeMissing")}
        </p>
      ) : null}

      <div ref={rootRef} className="contents">
        {panels.map((panel) =>
          shows(panel.needs) ? (
            <ReadOnlyRegion key={panel.id} readOnly={isSupportSession}>
              {renderAnyPanel(panel.id)}
            </ReadOnlyRegion>
          ) : null,
        )}
      </div>
    </>
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("settings.title")}</h1>
        <p className="text-body text-ink-muted">{t("settings.intro")}</p>
      </header>

      {loadFailed ? (
        // Its own sentence: this notice reports a failed READ, and the shared
        // "could not be saved" would tell a board their settings had been lost.
        <LoadFailure messageKey="settings.errors.loadFailed" onRetry={reload} />
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

      <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <div className="lg:sticky lg:top-5">
          <SettingsNav sections={sections} current={current.id} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {/* The association's sections are the board's: their panels sit in
              one zone with its sign, and the account section, which is the
              viewer's own, does not. */}
          {current.group === "association" ? (
            <BoardZone title={t(current.labelKey)}>{sectionContent}</BoardZone>
          ) : (
            sectionContent
          )}
        </div>
      </div>
    </div>
  );
}
