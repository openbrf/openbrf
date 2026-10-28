import { recipientHost, type PluginProcessing } from "@openbrf/plugin-sdk";
import type { TFunction } from "i18next";
import { useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { catalogText } from "../i18n/catalog-text";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import type { CatalogPlugin, ProcessorAgreementAnswer } from "./plugin-api";
import {
  ACTION_EFFECT_LABELS,
  actionPersonalDataLabel,
  actionSurfaceLabel,
  permissionLabel,
  personalDataLabel,
} from "./plugin-labels";
import {
  draftFromRecipients,
  recipientAnswer,
  recipientDeclaration,
  RecipientQuestion,
  RecipientRecorded,
} from "./RecipientQuestion";

export interface ConsentPanelProps {
  entry: CatalogPlugin;
  /** The board's language, for the catalog's own bilingual text. */
  locale: string;
  busy?: boolean;
  /**
   * Called with the board's answer about where the plugin sends personal data,
   * or with null where the record already classifies the plugin and is kept.
   */
  onConfirm: (answer: ProcessorAgreementAnswer | null) => void;
  onCancel: () => void;
}

/**
 * What a board agrees to before a plugin is installed.
 *
 * The screen exists because a backend plugin runs at full process privilege
 * (ADR 0003 - there is no sandbox in v1). Curation of the catalog is what
 * stands between an instance and hostile code; this is what stands between a
 * board and code that is merely more far-reaching than they expected. So it
 * states the two things a board is answerable for under GDPR - what the plugin
 * may do, and which personal data it will handle - in full sentences rather
 * than as permission codes.
 *
 * The two limits that hold regardless of what a plugin asked for are stated
 * here as well, because a board reading a list of permissions has no other way
 * to know where the list stops.
 *
 * It also asks whether the plugin sends personal data outside the instance,
 * and to whom - filled in from where the plugin declares it connects to, where
 * it declares that - and nothing installs until the board has answered and
 * classified the recipient, so the recipient is classified in the art. 28
 * record by the same act that consents to the plugin. A plugin the record already
 * classifies - a reinstall, an update, or one removed and installed again - is
 * not asked again, and what the record says stands.
 */
export function ConsentPanel({
  entry,
  locale,
  busy = false,
  onConfirm,
  onCancel,
}: ConsentPanelProps): ReactElement {
  const { t } = useTranslation();
  const [understood, setUnderstood] = useState(false);
  const [recipient, setRecipient] = useState(() =>
    draftFromRecipients(entry.recipients),
  );
  const recorded = entry.recipientState;
  const answer = recipientAnswer(recipient);
  const answered = recorded !== "notRecorded" || answer !== null;
  const categories = (values: readonly string[]): string =>
    values.map((category) => t(personalDataLabel(category))).join(", ");

  return (
    <Panel
      title={t("plugins.consent.title")}
      description={t("plugins.consent.intro", {
        name: catalogText(entry.name, locale),
        version: entry.version,
      })}
      notice={<Notice tone="info">{t("plugins.consent.privacyNote")}</Notice>}
      actions={
        <>
          <button
            type="button"
            disabled={!understood || !answered || busy}
            onClick={() => {
              if (recorded !== "notRecorded") {
                onConfirm(null);
              } else if (answer !== null) {
                onConfirm(answer);
              }
            }}
            className={PRIMARY_BUTTON}
          >
            {busy
              ? t("plugins.consent.installing")
              : t("plugins.consent.confirm")}
          </button>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className={SECONDARY_BUTTON}
          >
            {t("plugins.consent.cancel")}
          </button>
        </>
      }
    >
      <p className="text-body text-ink">
        {catalogText(entry.description, locale)}
      </p>

      <Declaration
        title={t("plugins.consent.permissionsTitle")}
        items={entry.permissions.map((permission) =>
          t(permissionLabel(permission)),
        )}
        emptyLabel={t("plugins.consent.noPermissions")}
      />

      {/*
        The resident routes (ADR 0051), beside the address-book permission
        they lower the floor of: what a resident without a board seat can do
        with a plugin that reads the register, and what the host keeps it
        from doing there. The titles are the catalog's, since the plugin's
        locale files are not on the instance before the download, and each
        opens to the address it covers. Absent for a plugin that declares none.
      */}
      {entry.residentRoutes.length === 0 ? null : (
        <ResidentRoutesDeclaration
          pluginId={entry.id}
          routes={entry.residentRoutes}
          locale={locale}
        />
      )}

      <Declaration
        title={t("plugins.consent.personalDataTitle")}
        items={entry.personalData.map((category) =>
          t(personalDataLabel(category)),
        )}
        emptyLabel={t("plugins.consent.noPersonalData")}
      />

      {/*
        What the processing of that data is for, on what basis, for how long
        and about whom (ADR 0035): what the install writes into the record of
        processing activities, so the board reads it before it is written there.
        Absent for a plugin that handles nobody's data, which gets no row. An
        older plugin that names personal data and declares nothing gets a row
        for the board to write, and the screen says so.
      */}
      {entry.personalData.length === 0 ? null : (
        <Declaration
          title={t("plugins.consent.processing.title")}
          items={
            entry.processing === null
              ? []
              : processingItems(t, entry.processing, locale)
          }
          emptyLabel={t("plugins.consent.processing.undeclared")}
        />
      )}
      {entry.processing !== null && entry.installedVersion !== null ? (
        <p className="text-small text-ink-muted">
          {t("plugins.consent.processing.update")}
        </p>
      ) : null}

      {/*
        What it keeps about a person, and for how long at most (ADR 0047). Its
        titles are in the plugin's locale files, which are not on the instance
        before the download, so each collection is named as the plugin names
        it, with the categories it holds and its bound.
      */}
      {entry.personRecords.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <Declaration
            title={t("plugins.consent.personRecords.title")}
            items={entry.personRecords.map((collection) =>
              t("plugins.consent.personRecords.collection", {
                collection: collection.collection,
                categories: categories(collection.personalData),
                days: collection.keepAtMostDays,
              }),
            )}
          />
          <p className="text-small text-ink-muted">
            {t("plugins.consent.personRecords.host")}
          </p>
        </section>
      )}

      {/*
        The widest part of the declaration, and so the part that most needs
        reading before anything is downloaded: an action names a capability and
        offers it to callers outside the board's own screens. Each entry says
        what it does to the records, because that is what separates one that
        reads the register from one that deletes out of it.

        No empty label, so a plugin proposing no action shows no list at all.
        The two above answer a question a board has whatever the plugin asked
        for - what may it do, whose data does it touch - and "nothing" is an
        answer to it. A plugin that proposes no action has not raised the
        question, and a heading saying so would introduce a mechanism this
        install does not use.
      */}
      <Declaration
        title={t("plugins.actions.title")}
        items={entry.actions.map((action) =>
          [
            action.id,
            action.capability,
            t(ACTION_EFFECT_LABELS[action.effect]),
            /*
             * The two halves that were missing, and the reason they belong on
             * THIS screen rather than beside the arming toggle: the board is
             * consenting to the declaration here, and an action's personal
             * data and its eligible surfaces are what the declaration is FOR.
             * The aggregate list above says which categories the plugin
             * touches somewhere; it cannot say which action receives each, and
             * it says nothing at all about how far one may be offered.
             */
            action.personalData.length === 0
              ? t("plugins.actions.noPersonalData")
              : action.personalData
                  .map((category) => t(actionPersonalDataLabel(category)))
                  .join(", "),
            action.surfaces
              .map((surface) => t(actionSurfaceLabel(surface)))
              .join(", "),
          ].join(" - "),
        )}
      />

      {/*
        What other plugins may hand this one, and what this one hands another
        (ADR 0030). Each is a flow of personal data between two plugins the
        board consents to separately, so each screen states its own half: a
        host plugin says what its points accept, an addon what it extends and
        what it hands over. Absent where the plugin raises neither, on the
        actions list's terms.

        The names come from the catalog rather than from the host plugin's
        locale files, which are not on the instance before it is installed.
        Where the catalog does not list the host plugin the ids stand in, so
        the line is never dropped.
      */}
      <Declaration
        title={t("plugins.consent.extensions.pointsTitle")}
        items={entry.extensionPoints.map((point) =>
          point.personalData.length === 0
            ? t("plugins.consent.extensions.pointNoPersonalData", {
                title: catalogText(point.title, locale),
                description: catalogText(point.description, locale),
              })
            : t("plugins.consent.extensions.point", {
                title: catalogText(point.title, locale),
                description: catalogText(point.description, locale),
                categories: categories(point.personalData),
              }),
        )}
      />
      <Declaration
        title={t("plugins.consent.extensions.extendsTitle")}
        items={entry.extends.map((extension) => {
          const names = {
            plugin:
              extension.pluginName === null
                ? extension.plugin
                : catalogText(extension.pluginName, locale),
            point:
              extension.pointTitle === null
                ? extension.point
                : catalogText(extension.pointTitle, locale),
          };
          return extension.personalData.length === 0
            ? t("plugins.consent.extensions.extendsNoPersonalData", names)
            : t("plugins.consent.extensions.extends", {
                ...names,
                categories: categories(extension.personalData),
              });
        })}
      />
      {entry.extends.length === 0 ? null : (
        <p className="text-small text-ink-muted">
          {t("plugins.consent.extensions.addonNote")}
        </p>
      )}

      {/*
        Who may use the installed plugins it joins (ADR 0052): each is held to
        the floor of what its group reads, so a plugin every account could use
        before answers only the board and the administrator after the restart. A
        warning rather than a line of the declaration, because it changes
        plugins the board consented to earlier, and absent where nothing rises.
      */}
      {entry.holdsToBoard.length === 0 ? null : (
        <Notice tone="warn">
          {t("plugins.consent.extensions.holdsToBoard", {
            count: entry.holdsToBoard.length,
            plugins: entry.holdsToBoard
              .map((plugin) =>
                plugin.name === null
                  ? plugin.id
                  : catalogText(plugin.name, locale),
              )
              .join(", "),
          })}
        </Notice>
      )}

      {/*
        What the plugin is, rather than what it may touch: a language model
        chooses what it does, and that decides which actions it reaches and how
        the audit log names its writes. Absent for a plugin that is no AI
        package, on the actions list's terms.
      */}
      {entry.ai ? (
        <Declaration
          title={t("plugins.consent.ai.title")}
          items={[
            t("plugins.consent.ai.model"),
            t("plugins.consent.ai.reach"),
            t("plugins.consent.ai.audit"),
          ]}
        />
      ) : null}

      {/*
        The licence a paid plugin reads (ADR 0042): that it does nothing
        without one, and each service it may show the association's licence
        to. The audiences are a grant, as the permissions are, so each is named
        rather than counted. Absent for a plugin that reads no licence, on the
        actions list's terms.
      */}
      {entry.licence === null ? null : (
        <LicenceDeclaration
          licence={entry.licence}
          released={entry.released}
          notCovered={entry.releaseNotCovered}
        />
      )}

      {/*
        The part of the declaration that decides something about the instance
        rather than about this plugin: the route it names becomes the one
        address connected apps sign in to, only one installed plugin may hold
        it, and it stops answering a signed-in session. Last, so it is what a
        board reads immediately before ticking the acknowledgement.

        Absent for a plugin that declares none, on the actions list's terms: a
        plugin serving no such route has not raised the question, and a heading
        about connected-app sign-in would put a mechanism on the screen that
        this install does not use.

        The route itself is not shown. What full address it composes to is the
        server's answer, and a second composition here could disagree with it.
      */}
      {entry.oauthProtectedResource === null ? null : (
        <Declaration
          title={t("plugins.consent.oauthResource.title")}
          items={[
            t("plugins.consent.oauthResource.serves"),
            t("plugins.consent.oauthResource.onlyOne"),
            t("plugins.consent.oauthResource.session"),
          ]}
        />
      )}

      {/*
        The device routes (ADR 0031): paths that answer a device holding a
        token the board issues, with nobody signed in. Beside the sign-in
        route, because both are reached by something other than a person in
        the browser. Absent for a plugin that declares none.
      */}
      {entry.deviceRoutes.length === 0 ? null : (
        <Declaration
          title={t("plugins.consent.deviceRoutes.title")}
          items={[
            t("plugins.consent.deviceRoutes.reach"),
            t("plugins.consent.deviceRoutes.readOnly"),
            t("plugins.consent.deviceRoutes.paths", {
              paths: entry.deviceRoutes.map((route) => route.path).join(", "),
            }),
          ]}
        />
      )}

      {/*
        Where the plugin connects to, and what each place receives (ADR 0037).
        After the sign-in route and the device routes rather than among the
        lists above, so it sits directly before the question it fills in.

        Absent for a plugin that declares none, on the actions list's terms,
        and so for every entry an index of version 1 lists: no such entry can
        say, and a heading saying "nowhere" would claim what it cannot know.
      */}
      {entry.recipients.length === 0 ? null : (
        <section className="flex flex-col gap-2">
          <Declaration
            title={t("plugins.consent.recipients.title")}
            items={entry.recipients.map((declared) =>
              [
                recipientHost(declared.origin),
                catalogText(declared.purpose, locale),
                declared.personalData.length === 0
                  ? t("plugins.consent.recipients.noPersonalData")
                  : declared.personalData
                      .map((category) => t(personalDataLabel(category)))
                      .join(", "),
              ].join(" - "),
            )}
          />
          <p className="text-small text-ink-muted">
            {t("plugins.consent.recipients.declarationNote")}
          </p>
        </section>
      )}

      {/* min-h-11 is the 44px touch target: this checkbox is the control that
          records the board's consent, so it must not be the one control on the
          screen that is hard to hit on a phone. */}
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
          {t("plugins.consent.acknowledge")}
        </span>
      </label>

      {/*
        After the acknowledgement rather than among the declaration: the lists
        above are what the catalog says and the board reads, and this is what
        the board says and the record keeps. Directly above the install button,
        so a button held shut sits beside the question still open.
      */}
      {recorded === "notRecorded" ? (
        <RecipientQuestion
          draft={recipient}
          onChange={setRecipient}
          declaration={recipientDeclaration(entry.recipients)}
          disabled={busy}
        />
      ) : (
        <RecipientRecorded state={recorded} />
      )}
    </Panel>
  );
}

/**
 * The processing declaration as sentences, in the board's language: the
 * purpose, the basis with the interest relied on where that is the basis, the
 * retention and whose data it is.
 */
function processingItems(
  t: TFunction,
  processing: PluginProcessing,
  locale: string,
): string[] {
  return [
    t("plugins.consent.processing.purpose", {
      text: catalogText(processing.purpose, locale),
    }),
    processing.legitimateInterest === undefined
      ? t("plugins.consent.processing.legalBasis", {
          basis: t(`plugins.consent.processing.basis.${processing.legalBasis}`),
        })
      : t("plugins.consent.processing.legitimateInterest", {
          text: catalogText(processing.legitimateInterest, locale),
        }),
    t("plugins.consent.processing.retention", {
      text: catalogText(processing.retention, locale),
    }),
    t("plugins.consent.processing.dataSubjects", {
      subjects: processing.dataSubjects
        .map((subject) => t(`plugins.consent.processing.subject.${subject}`))
        .join(", "),
    }),
  ];
}

/**
 * What a licensed plugin's consent says about its licence, and, for a release
 * the licence held does not cover, that the plugin is dormant after it.
 *
 * The notice comes before the acknowledgement, so the board reads it before
 * it updates rather than finding the plugin dormant afterwards.
 */
function LicenceDeclaration({
  licence,
  released,
  notCovered,
}: {
  licence: NonNullable<CatalogPlugin["licence"]>;
  released: string | null;
  notCovered: CatalogPlugin["releaseNotCovered"];
}): ReactElement {
  const { t } = useTranslation();
  const named = {
    entitlement: licence.entitlement,
    issuer: licence.issuer.name,
  };

  return (
    <>
      <Declaration
        title={t("plugins.consent.licence.title")}
        items={[
          t("plugins.consent.licence.needs", named),
          ...licence.audiences.map((audience) =>
            t("plugins.consent.licence.audience", { ...named, audience }),
          ),
        ]}
      />
      {notCovered === null || released === null ? null : (
        <Notice tone="warn">
          {t("plugins.consent.licence.notCovered", {
            updatesUntil: notCovered.updatesUntil,
            released,
          })}
        </Notice>
      )}
    </>
  );
}

/**
 * What a plugin's consent says about its resident routes: who may use them,
 * each route's title opening to its address, and what the plugin can and
 * cannot do there.
 */
function ResidentRoutesDeclaration({
  pluginId,
  routes,
  locale,
}: {
  pluginId: string;
  routes: CatalogPlugin["residentRoutes"];
  locale: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">
        {t("plugins.consent.residentRoutes.title")}
      </h3>
      <p className="text-small text-ink">
        {t("plugins.consent.residentRoutes.who")}
      </p>
      <ul className="flex flex-col gap-1.5">
        {routes.map((route) => (
          <li
            key={route.path}
            className="border-l-2 border-line-strong pl-3 text-small text-ink"
          >
            {/* min-h-11 is the 44px touch target of the control that opens
                it, left a list item so the marker says it opens. */}
            <details>
              <summary className="min-h-11 cursor-pointer py-2">
                {catalogText(route.title, locale)}
              </summary>
              <code className="font-data text-small break-all text-ink-muted">
                {`/api/plugin/${pluginId}/${route.path}`}
              </code>
            </details>
          </li>
        ))}
      </ul>
      <p className="text-small text-ink">
        {[
          t("plugins.consent.residentRoutes.reach"),
          t("plugins.consent.residentRoutes.register"),
          t("plugins.consent.residentRoutes.choice"),
        ].join(" ")}
      </p>
    </section>
  );
}

/**
 * One list the board reads before it consents.
 *
 * A list with an empty label says "nothing" rather than going quiet, because
 * an absent list reads as a screen that failed to load. A list given none is
 * absent when it is empty instead: it belongs to a part of the declaration
 * that only some plugins raise at all, and a heading with nothing under it
 * would be the screen asking the board about a mechanism this install does not
 * use.
 */
function Declaration({
  title,
  items,
  emptyLabel,
}: {
  title: string;
  items: readonly string[];
  emptyLabel?: string;
}): ReactElement | null {
  if (items.length === 0 && emptyLabel === undefined) {
    return null;
  }

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-label text-ink-muted uppercase">{title}</h3>
      {items.length === 0 ? (
        <p className="text-small text-ink-muted">{emptyLabel}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {items.map((item) => (
            <li
              key={item}
              className="border-l-2 border-line-strong pl-3 text-small text-ink"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
