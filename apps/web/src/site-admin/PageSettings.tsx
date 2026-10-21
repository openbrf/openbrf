import { useId } from "react";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { type AdminPage, PAGE_STATUSES, type PageStatus } from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, HINT, LABEL, QUIET_BUTTON } from "../ui/controls";
import { Panel } from "../ui/Panel";
import { PageMenuSwitch } from "./PageMenuSwitch";

/**
 * The page's own settings, beside it: who can read it, whether it is the
 * front page, and - under Advanced - its address.
 *
 * What is chosen here is saved with the page, by the editor's one save, in
 * the order that never shows anybody words not meant for them (see saveAll in
 * the page editor).
 */

/** What each status is called, here and in the list of pages. */
export const PAGE_STATUS_LABELS: Readonly<Record<PageStatus, TranslationKey>> =
  {
    DRAFT: "siteAdmin.state.draft",
    MEMBERS_ONLY: "siteAdmin.state.memberOnly",
    PUBLIC: "siteAdmin.state.public",
  };

/** Who each status lets read the page, said beside the choice. */
const PAGE_STATUS_HINTS: Readonly<Record<PageStatus, TranslationKey>> = {
  DRAFT: "siteAdmin.editor.statusDraftHint",
  MEMBERS_ONLY: "siteAdmin.editor.statusMembersOnlyHint",
  PUBLIC: "siteAdmin.editor.statusPublicHint",
};

export interface PageSettingsProps {
  page: AdminPage;
  status: PageStatus;
  onStatus: (status: PageStatus) => void;
  /** Whether the next save makes this page the front page. */
  front: boolean;
  onFront: (front: boolean) => void;
  /** The address the page will have once saved, as far as the screen knows. */
  address: string;
  onAddress: (address: string) => void;
  busy: boolean;
  onDelete: () => void;
  /** Told of the page as the server has it after "Show in menu" changed. */
  onChanged: (page: AdminPage) => void;
  /** Told when "Show in menu" sends a write and when its answer is in. */
  onMenuWriting?: (writing: boolean) => void;
}

export function PageSettings({
  page,
  status,
  onStatus,
  front,
  onFront,
  address,
  onAddress,
  busy,
  onDelete,
  onChanged,
  onMenuWriting,
}: PageSettingsProps): ReactElement {
  const { t } = useTranslation();
  const statusHintId = useId();
  const frontPageHintId = useId();

  return (
    <Panel
      title={t("siteAdmin.editor.pageSettings")}
      actions={
        <button
          type="button"
          className={QUIET_BUTTON}
          // The front page stays until another is chosen, which the sentence
          // under the switch says.
          disabled={busy || page.frontPage}
          onClick={onDelete}
        >
          {t("siteAdmin.editor.remove")}
        </button>
      }
    >
      <p className={`${HINT} font-data`}>
        {t("siteAdmin.editor.address", { address: `/${address}` })}
      </p>

      <fieldset className="flex flex-col gap-2" aria-describedby={statusHintId}>
        <legend className={LABEL}>{t("siteAdmin.editor.status")}</legend>
        {PAGE_STATUSES.map((option) => (
          <label
            key={option}
            className="flex min-h-11 items-start gap-3 text-small text-ink"
          >
            <input
              type="radio"
              name={`page-status-${page.id}`}
              value={option}
              checked={status === option}
              // The front page stays public until another one is chosen.
              disabled={busy || (page.frontPage && option !== "PUBLIC")}
              onChange={() => {
                onStatus(option);
              }}
              className="mt-1 size-4 accent-trust"
            />
            <span className="flex flex-col gap-1">
              <span>{t(PAGE_STATUS_LABELS[option])}</span>
              <span className={HINT}>{t(PAGE_STATUS_HINTS[option])}</span>
            </span>
          </label>
        ))}
        <p id={statusHintId} className={HINT}>
          {page.frontPage
            ? t("siteAdmin.editor.frontPageKeepsPublic")
            : t("siteAdmin.editor.statusSaved")}
        </p>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-start gap-3 text-small text-ink">
          {/*
           * A switch, said as one: it is on for the front page and off for
           * every other. It cannot be turned off on the front page itself,
           * because the root always has a page the board chose - another page
           * is chosen instead, which turns this one off.
           */}
          <input
            type="checkbox"
            role="switch"
            checked={page.frontPage || front}
            disabled={busy || page.frontPage || status !== "PUBLIC"}
            aria-describedby={frontPageHintId}
            onChange={(event) => {
              onFront(event.target.checked);
            }}
            className="mt-1 size-4 accent-trust"
          />
          {t("siteAdmin.editor.frontPage")}
        </label>
        <p id={frontPageHintId} className={HINT}>
          {page.frontPage
            ? t("siteAdmin.editor.frontPageIsThis")
            : t("siteAdmin.editor.frontPageHint")}
        </p>
        {page.frontPage ? (
          <p className={HINT}>{t("siteAdmin.editor.removeFrontPage")}</p>
        ) : null}
      </div>

      <PageMenuSwitch
        page={page}
        onChanged={onChanged}
        busy={busy}
        onWriting={onMenuWriting}
      />

      {/*
       * The address is made from the title, so most boards never open this. A
       * disclosure rather than a field beside the title, because changing the
       * address of a published page breaks the links people have to it, and
       * that is a choice to make deliberately.
       */}
      <details className="flex flex-col gap-2">
        <summary className="min-h-11 cursor-pointer text-small text-ink">
          {t("siteAdmin.editor.advanced")}
        </summary>
        <label className={LABEL}>
          {t("siteAdmin.editor.slug")}
          <input
            className={`${FIELD} font-data`}
            value={address}
            onChange={(event) => {
              onAddress(event.target.value);
            }}
          />
          <span className={HINT}>{t("siteAdmin.editor.slugHint")}</span>
          {/*
           * Why the address no longer follows the title, said only when it is
           * known: a page that has been published was settled by that, and one
           * that never was has an address somebody typed or one it kept from
           * before addresses followed titles.
           */}
          <span className={HINT}>
            {page.slugFollowsTitle
              ? t("siteAdmin.editor.slugFollowsTitle")
              : page.publishedAt === null
                ? t("siteAdmin.editor.slugFixed")
                : t("siteAdmin.editor.slugSettled")}
          </span>
        </label>
      </details>
    </Panel>
  );
}
