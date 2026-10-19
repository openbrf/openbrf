import {
  PAGE_CONTENT_LIMITS,
  type PageWriteReason,
  slugFromTitle,
} from "@openbrf/shared";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { ApiFailure } from "../api/client";
import {
  type AdminPage,
  deletePage,
  fetchPages,
  PAGE_STATUSES,
  type PageStatus,
  previewPage,
  savePage,
  setFrontPage,
  setPageStatus,
  uploadSiteImage,
} from "../api/site";
import type { TranslationKey } from "../i18n/translation-key";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { failureMessageKey, refusedFields } from "../ui/save-state";
import {
  BannerFields,
  type BlockFieldsContext,
  ButtonFields,
  ColumnsFields,
  HeadingFields,
  ImageTextFields,
  type LinkablePage,
  PictureFields,
} from "./LayoutBlockFields";
import {
  blockLabel,
  blocksOf,
  type EditorBlock,
  editorBlocks,
  emptyFaqItem,
  insertBlock,
  type InsertableBlock,
  INSERTABLE,
  insertLabel,
  isRegistered,
  moveBlock,
  needsPhotoConsent,
  newBlockWith,
  removeBlock,
  removeFaqItem,
  replaceBlock,
  replaceBlockWith,
  runsToText,
  scanPage,
  submittableBlocks,
  textToRuns,
  withBlock,
  withFaqItem,
  withUploadedPicture,
} from "./page-blocks";

/**
 * One page, as the board writes it.
 *
 * Loaded on demand, because the text editor behind a paragraph is the only
 * heavy thing in the client and nobody who is not writing a page should be
 * downloading it.
 */
const RichText = lazy(async () => import("./RichText"));

/**
 * The counts a calendar block may be set to.
 *
 * Derived from the API's own limit rather than written out, so the field cannot
 * offer a number the write path would refuse.
 */
const CALENDAR_COUNTS: readonly number[] = Array.from(
  { length: PAGE_CONTENT_LIMITS.calendarCount },
  (_, at) => at + 1,
);

/**
 * What a refusal from the write API says on this screen.
 *
 * Every reason the page endpoints can answer with is named here, so a refusal
 * the board can act on never arrives as "something went wrong". The two
 * guardrail refusals additionally say where: the API sends positions, and the
 * screen turns them into the block numbers a person is looking at.
 *
 * Checked against {@link PageWriteReason}, the union the API throws with, so a
 * reason the server gains and this screen has no sentence for fails the web
 * build rather than reaching a board member as the unknown sentence.
 */
const REASONS: Readonly<Record<string, TranslationKey>> = {
  "invalid-slug": "siteAdmin.errors.invalidSlug",
  "slug-taken": "siteAdmin.errors.slugTaken",
  "invalid-body": "siteAdmin.errors.invalidBody",
  "personal-identity-number": "siteAdmin.errors.personalIdentityNumber",
  "photo-consent-required": "siteAdmin.errors.photoConsentRequired",
  "image-not-found": "siteAdmin.errors.imageNotFound",
  "image-not-public": "siteAdmin.errors.imageNotPublic",
  "not-found": "siteAdmin.errors.pageGone",
  "front-page": "siteAdmin.errors.frontPage",
  "front-page-not-public": "siteAdmin.errors.frontPageNotPublic",
  /*
   * One sentence for all four acts that take a precondition. What the board has
   * to do is the same in each: read the page again, and decide about the copy
   * that is there rather than the one it was looking at.
   */
  "page-changed": "siteAdmin.errors.pageChanged",
} satisfies Record<PageWriteReason | "invalid-body", TranslationKey>;

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

export interface PageEditorProps {
  page: AdminPage;
  /** The association's pages, which a button may lead to. */
  pages: readonly LinkablePage[];
  onChanged: (page: AdminPage) => void;
  onRemoved: (id: string) => void;
}

export function PageEditor({
  page,
  pages,
  onChanged,
  onRemoved,
}: PageEditorProps): ReactElement {
  const { t } = useTranslation();

  const [title, setTitle] = useState(page.title);
  /**
   * The address the board typed under Advanced, or null while it has not.
   *
   * Null is what lets the server decide: a page that still follows its title
   * gets the address the new title gives, and any other page keeps its own. A
   * save sends an address only when the board wrote one.
   */
  const [typedSlug, setTypedSlug] = useState<string | null>(null);
  /**
   * The status the board chose on this screen, or null while it has not. One
   * choice of three rather than a publish button and an audience button beside
   * it, because the board means one thing.
   *
   * Null for the same reason as the address: a status nobody chose here is the
   * page's own, read from the copy this editor holds. When somebody else takes
   * the page down or closes it to the members while it is open here, the copy
   * read again after the conflict carries that status, and the next save keeps
   * it. A status copied in when the editor opened would put the page back where
   * it was, in front of the readers the other editor had just closed it to.
   */
  const [chosenStatus, setChosenStatus] = useState<PageStatus | null>(null);
  const status = chosenStatus ?? page.status;
  /** Whether the next save makes this page the front page. */
  const [makeFront, setMakeFront] = useState(false);
  // Only a public page can be the front page, and the page may have stopped
  // being one since the switch was turned on.
  const front = makeFront && status === "PUBLIC";
  const statusHintId = useId();
  const frontPageHintId = useId();
  const [entries, setEntries] = useState<EditorBlock[]>(() =>
    editorBlocks(page.content.blocks),
  );
  const [identifiable, setIdentifiable] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * The pictures declared to show identifiable persons, by the identity of
   * the block they are in - or of the block in a column, for one in a column.
   *
   * By identity and not by position, because the answer is given before the
   * file is chosen and read again when it is: anything moved or removed in
   * between renumbers the blocks, and a declaration read off the wrong one
   * would upload a picture of identifiable people as showing nobody. That is
   * recorded on the stored file, and the publication guardrail then never asks
   * for a publiceringssamtycke for it again.
   */
  const [declared, setDeclared] = useState<ReadonlySet<string>>(new Set());
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [consentAsked, setConsentAsked] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The paragraph a return has just split off, and where its caret goes. */
  const [splitFocus, setSplitFocus] = useState<{
    id: string;
    offset: number;
  } | null>(null);
  /**
   * The last move, by the button that made it.
   *
   * Moving a block down re-inserts the list item that holds the pressed
   * button, and the browser drops the focus of an element it moves, so the
   * button is found again by its block's identity and focused once more. The
   * announcement is the move's result as a sentence, because the focus coming
   * back to the same button does not say where the block went.
   */
  const [moved, setMoved] = useState<{
    key: string;
    announcement: string;
  } | null>(null);
  /**
   * The paragraph a return or a paste was held in because the page has no
   * room for another block, so the reason is given where the board is
   * writing rather than only beside the add buttons further down.
   */
  const [heldAt, setHeldAt] = useState<string | null>(null);
  /**
   * The paragraphs typing or a paste was held in because they were full. A
   * paste can cut a paragraph it started, which has no identity until the
   * change that makes it block arrives, so those are kept in `heldLong` until
   * then.
   */
  const [longAt, setLongAt] = useState<readonly string[]>([]);
  const heldLong = useRef<readonly number[]>([]);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  const moveButton =
    (key: string) =>
    (element: HTMLButtonElement | null): void => {
      if (element === null) {
        moveButtons.current.delete(key);
      } else {
        moveButtons.current.set(key, element);
      }
    };
  useEffect(() => {
    if (moved !== null) {
      moveButtons.current.get(moved.key)?.focus();
    }
  }, [moved]);

  /**
   * Uploads a picture for the block, or the block in a column, with this
   * identity, carrying the declaration made for that identity.
   *
   * The answer is applied by identity to the list as it stands when it
   * arrives, so a block moved or described while the bytes were on their way
   * keeps what was done to it.
   */
  const uploadPicture = (id: string, file: File): void => {
    const shows = declared.has(id);
    void (async () => {
      setBusy(true);
      const result = await uploadSiteImage(file, shows);
      setBusy(false);
      if (!result.ok) {
        setFailure(result.failure);
        return;
      }
      if (result.value.showsIdentifiablePersons) {
        setIdentifiable((current) => new Set([...current, result.value.id]));
      }
      setEntries((current) =>
        withUploadedPicture(current, id, result.value.id),
      );
    })();
  };

  const fields: BlockFieldsContext = {
    pages,
    busy,
    declared,
    declare: (id, shows) => {
      setDeclared((current) => {
        const next = new Set(current);
        if (shows) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
    },
    upload: uploadPicture,
    moveButton,
    moved: (key, announcement) => {
      setMoved({ key, announcement });
    },
    splitFocus,
    focusSplit: (id, offset) => {
      setSplitFocus({ id, offset });
    },
  };

  const blocks = blocksOf(entries);
  const room = Math.max(PAGE_CONTENT_LIMITS.blocks - entries.length, 0);
  const hits = scanPage({ title, blocks });

  /**
   * One act against this page, with the refusals it can answer with handled.
   *
   * The success value is optional because removing a page answers with none,
   * and a delete needs everything else this does: it takes the same
   * precondition as a save, so it is refused the same way and the board has to
   * be told the same thing. Answers whether the act went through, which is what
   * a delete needs in order to close the editor behind itself.
   */
  const run = useCallback(
    async (
      action: () => Promise<
        { ok: true; value?: AdminPage } | { ok: false; failure: ApiFailure }
      >,
    ): Promise<boolean> => {
      setBusy(true);
      setSaved(false);
      const result = await action();

      if (!result.ok) {
        setFailure(result.failure);
        if (result.failure.reason === "photo-consent-required") {
          setConsentAsked(true);
        }
        /*
         * Somebody else saved this page while it was open here, so the copy the
         * next save would claim against is gone. Read the page again and hand
         * it up, which moves the revision this editor holds while leaving what
         * the board has written where it is - the component is keyed on the
         * page's id, so a fresh page object does not remount it.
         *
         * That makes the next save possible rather than automatic: it will
         * write over the other version, and the message beside this says so.
         * The alternative - refusing until somebody reloads - loses the board's
         * unsaved work to protect a version they have not seen.
         */
        if (result.failure.reason === "page-changed") {
          const pages = await fetchPages();
          const fresh = pages.ok
            ? pages.value.find((one) => one.id === page.id)
            : undefined;
          if (fresh !== undefined) {
            onChanged(fresh);
          }
        }
        /*
         * Last, so every control stays disabled until the page this editor
         * holds is the one a save would claim against. Cleared before the
         * reload, a second press would send the revision that was just refused
         * and be refused again.
         */
        setBusy(false);
        return false;
      }

      setBusy(false);

      setFailure(null);
      setSaved(true);
      if (result.value !== undefined) {
        onChanged(result.value);
      }
      return true;
    },
    [onChanged, page.id],
  );

  const submittable = submittableBlocks(blocks);
  const body = { blocks: submittable.blocks };
  const consent = consentConfirmed ? { photoConsentConfirmed: true } : {};

  /*
   * The address the page will have once saved, as far as this screen can know
   * it: the one typed, the one a new title gives while the page follows its
   * title, or the one it has. The stored one while the title still gives it,
   * because the server may have numbered it - `styrelsen-2` - and the screen
   * must not show the board an address the page does not have. A new title
   * may be numbered too, once saved, if another page holds its address.
   */
  const address =
    typedSlug ??
    (page.slugFollowsTitle && slugFromTitle(title) !== slugFromTitle(page.title)
      ? slugFromTitle(title)
      : page.slug);
  /*
   * Every address the board typed, the stored one included. Typing it is the
   * choice to keep it: left out, a page that follows its title would take the
   * address its new title gives, which is not the one this screen showed.
   */
  const slugEdit = typedSlug === null ? {} : { slug: typedSlug };

  /**
   * Saves what is on the screen: the body and the status, in the order that
   * keeps the new words inside the audience the board chose, then the front
   * page, each claiming the revision the one before it produced.
   *
   * The order is the one that never shows anybody words not meant for them. A
   * page opening to more readers - a draft going on the website, a members'
   * page going public - has its body saved first, so the status is set on the
   * words the board is looking at and the guardrails run on those. A page
   * closing to fewer - taken down, or from the street to the members - has its
   * status set first, so the edits saved beside it are never read by the
   * audience it is leaving, even for a moment, and a refused status leaves
   * them unsaved rather than saved where the old audience reads them. The
   * front page is chosen last, because only a page that is already public can
   * be one.
   *
   * Each step that succeeds is handed up before the next is tried, so a step
   * refused on its merits - a personal identity number on the page, a picture
   * nobody has confirmed the consents for - leaves the editor holding the
   * revision the server has, and the next save is not refused as though
   * somebody else had written the page.
   */
  const saveAll = async (): Promise<
    { ok: true; value: AdminPage } | { ok: false; failure: ApiFailure }
  > => {
    let latest = page;
    const saveBody = async () => {
      const stored = await savePage(page.id, {
        ...slugEdit,
        title,
        content: body,
        ...consent,
        expectedRevision: latest.revision,
      });
      if (stored.ok) {
        latest = stored.value;
        setTypedSlug(null);
      }
      return stored;
    };
    const saveStatus = async () => {
      const changed = await setPageStatus(page.id, {
        status,
        ...consent,
        expectedRevision: latest.revision,
      });
      if (changed.ok) {
        latest = changed.value;
        setChosenStatus(null);
      }
      return changed;
    };

    // PAGE_STATUSES runs from the fewest readers to the most.
    const closing =
      PAGE_STATUSES.indexOf(status) < PAGE_STATUSES.indexOf(page.status);
    for (const step of closing
      ? [saveStatus, saveBody]
      : [saveBody, saveStatus]) {
      if (step === saveStatus && latest.status === status) {
        continue;
      }
      if (latest !== page) {
        onChanged(latest);
      }
      const result = await step();
      if (!result.ok) {
        return result;
      }
    }

    if (front && !latest.frontPage) {
      onChanged(latest);
      const chosen = await setFrontPage(page.id, {
        expectedRevision: latest.revision,
      });
      if (!chosen.ok) {
        return chosen;
      }
      latest = chosen.value;
      setMakeFront(false);
    }
    return { ok: true, value: latest };
  };

  /**
   * The places a refusal named, as a person reads them.
   *
   * The API answers with positions - the title, or a block's index - because a
   * response body may never carry the value that was refused. One-based here,
   * because the board is looking at a list of blocks and not at an array.
   *
   * Mapped back through the positions that were sent, because the half-written
   * blocks this screen leaves out of a submission are still on the screen: the
   * API's third block can be the board's fourth, and a notice naming the wrong
   * one sends somebody to edit a paragraph that is not the problem. It is also
   * what keeps this notice and the personal-identity-number warning above
   * agreeing about the same page.
   */
  const refusedPlaces =
    failure === null
      ? []
      : locationsOf(failure).map((place) =>
          place === "title"
            ? t("siteAdmin.editor.placeTitle")
            : t("siteAdmin.editor.placeBlock", {
                number: (submittable.positions[place] ?? place) + 1,
              }),
        );

  const askConsent = consentAsked || needsPhotoConsent(blocks, identifiable);

  return (
    <div className="flex flex-col gap-5">
      <Panel
        title={t("siteAdmin.editor.heading")}
        description={t("siteAdmin.editor.description")}
        notice={
          <div className="flex flex-col gap-3">
            <Notice tone="info">{t("siteAdmin.editor.freeTextWarning")}</Notice>
            {hits.length === 0 ? null : (
              <Notice tone="warn" live>
                {t("siteAdmin.editor.scanWarning", {
                  places: hits
                    .map((hit) =>
                      hit.block === null
                        ? t("siteAdmin.editor.placeTitle")
                        : t("siteAdmin.editor.placeBlock", {
                            number: hit.block + 1,
                          }),
                    )
                    .join(", "),
                })}
              </Notice>
            )}
            {failure === null ? null : (
              <Notice tone="danger" live>
                {t(failureKey(failure), {
                  count: PAGE_CONTENT_LIMITS.runText,
                })}
                {refusedPlaces.length === 0
                  ? null
                  : ` ${t("siteAdmin.editor.refusedAt", {
                      places: refusedPlaces.join(", "),
                    })}`}
              </Notice>
            )}
            {saved ? (
              <Notice tone="ok" live>
                {t("siteAdmin.editor.saved")}
              </Notice>
            ) : null}
          </div>
        }
        actions={
          <>
            <button
              type="button"
              className={PRIMARY_BUTTON}
              disabled={busy}
              onClick={() => {
                void run(saveAll);
              }}
            >
              {t("siteAdmin.editor.save")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  const result = await previewPage({
                    slug: address,
                    title,
                    content: body,
                  });
                  setBusy(false);
                  if (result.ok) {
                    setFailure(null);
                    setPreview(result.value.html);
                    return;
                  }
                  setFailure(result.failure);
                })();
              }}
            >
              {t("siteAdmin.editor.preview")}
            </button>
            <button
              type="button"
              className={QUIET_BUTTON}
              // The front page stays until another is chosen, which the
              // sentence below the title says.
              disabled={busy || page.frontPage}
              onClick={() => {
                /*
                 * Confirmed because the page goes with the row: the API deletes
                 * it outright, and nothing on this screen puts a deleted page
                 * back. The same reason the archive asks before removing a
                 * document.
                 */
                if (
                  !window.confirm(
                    t("siteAdmin.editor.removeConfirm", { title: page.title }),
                  )
                ) {
                  return;
                }
                void (async () => {
                  /*
                   * Through `run` like every other act on this page, so a
                   * refusal is named rather than shown as a bare failure. What
                   * it adds here is the page-changed path: a deletion decided
                   * on a copy somebody else has rewritten is refused, the page
                   * is read again, and the board sees what it would have been
                   * deleting before deciding a second time.
                   */
                  const removed = await run(async () => {
                    const result = await deletePage(page.id, {
                      expectedRevision: page.revision,
                    });
                    return result.ok ? { ok: true as const } : result;
                  });
                  if (removed) {
                    onRemoved(page.id);
                  }
                })();
              }}
            >
              {t("siteAdmin.editor.remove")}
            </button>
          </>
        }
      >
        <label className={LABEL}>
          {t("siteAdmin.editor.title")}
          <input
            className={FIELD}
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
          <span className={`${HINT} font-data`}>
            {t("siteAdmin.editor.address", { address: `/${address}` })}
          </span>
        </label>

        <fieldset
          className="flex flex-col gap-2"
          aria-describedby={statusHintId}
        >
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
                  setChosenStatus(option);
                  if (option !== "PUBLIC") {
                    setMakeFront(false);
                  }
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
             * because the root always has a page the board chose - another
             * page is chosen instead, which turns this one off.
             */}
            <input
              type="checkbox"
              role="switch"
              checked={page.frontPage || front}
              disabled={busy || page.frontPage || status !== "PUBLIC"}
              aria-describedby={frontPageHintId}
              onChange={(event) => {
                setMakeFront(event.target.checked);
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

        {/*
         * The address is made from the title, so most boards never open this.
         * A disclosure rather than a field beside the title, because changing
         * the address of a published page breaks the links people have to it,
         * and that is a choice to make deliberately.
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
                setTypedSlug(event.target.value);
              }}
            />
            <span className={HINT}>{t("siteAdmin.editor.slugHint")}</span>
            {/*
             * Why the address no longer follows the title, said only when it
             * is known: a page that has been published was settled by that,
             * and one that never was has an address somebody typed or one it
             * kept from before addresses followed titles.
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

        <p className="sr-only" role="status">
          {moved?.announcement}
        </p>

        <ol className="flex flex-col gap-4">
          {entries.map((entry, index) => {
            const block = entry.block;
            const named = {
              number: index + 1,
              kind: t(blockLabel(block.type)),
            };
            const move = (direction: -1 | 1): void => {
              const next = moveBlock(entries, index, direction);
              setEntries(next);
              setMoved({
                key: `${entry.id}:${String(direction)}`,
                announcement: t("siteAdmin.editor.movedTo", {
                  kind: named.kind,
                  number: next.indexOf(entry) + 1,
                  count: next.length,
                }),
              });
            };
            return (
              <li key={entry.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-label text-ink-muted uppercase">
                    {named.kind}
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={t("siteAdmin.editor.moveUpNamed", named)}
                    ref={moveButton(`${entry.id}:-1`)}
                    onClick={() => {
                      move(-1);
                    }}
                  >
                    {t("siteAdmin.editor.moveUp")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={t("siteAdmin.editor.moveDownNamed", named)}
                    ref={moveButton(`${entry.id}:1`)}
                    onClick={() => {
                      move(1);
                    }}
                  >
                    {t("siteAdmin.editor.moveDown")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={t("siteAdmin.editor.removeBlockNamed", named)}
                    onClick={() => {
                      setEntries(removeBlock(entries, index));
                    }}
                  >
                    {t("siteAdmin.editor.removeBlock")}
                  </button>
                </div>

                {block.type === "paragraph" ? (
                  <Suspense
                    fallback={
                      <p className={HINT} role="status">
                        {t("siteAdmin.editor.loadingEditor")}
                      </p>
                    }
                  >
                    <RichText
                      label={t("siteAdmin.editor.paragraphLabel", {
                        number: index + 1,
                      })}
                      runs={block.runs}
                      focusAt={
                        splitFocus?.id === entry.id
                          ? splitFocus.offset
                          : undefined
                      }
                      maxParagraphs={1 + room}
                      onFull={() => {
                        setHeldAt(entry.id);
                      }}
                      onLong={(blocks, refused) => {
                        // A refusal is followed by no change to clear it at.
                        heldLong.current = refused === true ? [] : blocks;
                        setLongAt(blocks.includes(0) ? [entry.id] : []);
                      }}
                      onChange={(paragraphs, caret) => {
                        /*
                         * The block keeps its identity whether this was typing
                         * or a return, because a new one remounts the editor
                         * being typed into and the keyboard focus falls to the
                         * page. On a return the editor cuts its own document
                         * back to the first paragraph, the rest become blocks
                         * of their own, and the one the caret went to takes
                         * the focus as it is created.
                         */
                        const [first = [], ...rest] = paragraphs;
                        const added = rest.map((runs) =>
                          newBlockWith({ type: "paragraph", runs }),
                        );
                        setEntries(
                          replaceBlockWith(entries, index, [
                            withBlock(entry, {
                              type: "paragraph",
                              runs: first,
                            }),
                            ...added,
                          ]),
                        );
                        // A change that was kept ends the notice, unless it
                        // is the paste that cut text, which it then follows.
                        const cut = heldLong.current.flatMap((block) => {
                          const id =
                            block === 0 ? entry.id : added[block - 1]?.id;
                          return id === undefined ? [] : [id];
                        });
                        heldLong.current = [];
                        setLongAt(cut);
                        const target = added[caret.paragraph - 1];
                        if (target !== undefined) {
                          setSplitFocus({
                            id: target.id,
                            offset: caret.offset,
                          });
                        }
                      }}
                    />
                    {longAt.includes(entry.id) ? (
                      <Notice tone="warn" live>
                        {t(
                          room === 0
                            ? "siteAdmin.editor.paragraphFullPageFull"
                            : "siteAdmin.editor.paragraphFull",
                          { count: PAGE_CONTENT_LIMITS.runText },
                        )}
                      </Notice>
                    ) : null}
                    {room === 0 && heldAt === entry.id ? (
                      <Notice tone="warn" live>
                        {t("siteAdmin.editor.pageFull", {
                          count: PAGE_CONTENT_LIMITS.blocks,
                        })}
                      </Notice>
                    ) : null}
                  </Suspense>
                ) : null}

                {block.type === "heading" ? (
                  <HeadingFields
                    block={block}
                    onChange={(next) => {
                      setEntries(
                        replaceBlock(entries, index, withBlock(entry, next)),
                      );
                    }}
                  />
                ) : null}

                {block.type === "image" ? (
                  <div className="flex flex-col gap-3">
                    <PictureFields
                      id={entry.id}
                      alt={block.alt}
                      required={false}
                      context={fields}
                      onAlt={(alt) => {
                        setEntries(
                          replaceBlock(
                            entries,
                            index,
                            withBlock(entry, { ...block, alt }),
                          ),
                        );
                      }}
                    />
                    <label className={LABEL}>
                      {t("siteAdmin.editor.caption")}
                      <input
                        className={FIELD}
                        maxLength={PAGE_CONTENT_LIMITS.caption}
                        value={block.caption ?? ""}
                        onChange={(event) => {
                          setEntries(
                            replaceBlock(
                              entries,
                              index,
                              withBlock(entry, {
                                ...block,
                                caption: event.target.value,
                              }),
                            ),
                          );
                        }}
                      />
                    </label>
                  </div>
                ) : null}

                {block.type === "button" ? (
                  <ButtonFields
                    block={block}
                    pages={pages}
                    onChange={(next) => {
                      setEntries(
                        replaceBlock(entries, index, withBlock(entry, next)),
                      );
                    }}
                  />
                ) : null}

                {block.type === "banner" ? (
                  <BannerFields
                    entry={entry}
                    block={block}
                    context={fields}
                    onChange={(next) => {
                      setEntries(
                        replaceBlock(entries, index, withBlock(entry, next)),
                      );
                    }}
                  />
                ) : null}

                {block.type === "imageText" ? (
                  <ImageTextFields
                    entry={entry}
                    block={block}
                    context={fields}
                    onEntry={(next) => {
                      setEntries((current) =>
                        current.map((one) =>
                          one.id === entry.id ? next : one,
                        ),
                      );
                    }}
                  />
                ) : null}

                {block.type === "columns" ? (
                  <ColumnsFields
                    entry={entry}
                    block={block}
                    context={fields}
                    onEntry={(next) => {
                      setEntries((current) =>
                        current.map((one) =>
                          one.id === entry.id ? next : one,
                        ),
                      );
                    }}
                  />
                ) : null}

                {block.type === "eventCalendar" ? (
                  <label className={LABEL}>
                    {t("siteAdmin.editor.calendarCount")}
                    <select
                      className={FIELD}
                      value={String(block.count)}
                      onChange={(event) => {
                        setEntries(
                          replaceBlock(
                            entries,
                            index,
                            withBlock(entry, {
                              type: "eventCalendar",
                              count: Number(event.target.value),
                            }),
                          ),
                        );
                      }}
                    >
                      {/*
                       * A list of the counts the API accepts rather than a
                       * number field, so there is no way to type one it would
                       * refuse. One is the smallest: a block showing no dates
                       * renders as nothing, which is not a page a board meant
                       * to arrange.
                       */}
                      {CALENDAR_COUNTS.map((count) => (
                        <option key={count} value={String(count)}>
                          {count}
                        </option>
                      ))}
                    </select>
                    <span className={HINT}>
                      {t("siteAdmin.editor.calendarHint")}
                    </span>
                  </label>
                ) : null}

                {block.type === "documentList" ? (
                  <label className={LABEL}>
                    {t("siteAdmin.editor.documentBinder")}
                    <input
                      className={FIELD}
                      maxLength={PAGE_CONTENT_LIMITS.category}
                      value={block.category ?? ""}
                      onChange={(event) => {
                        const category = event.target.value;
                        setEntries(
                          replaceBlock(
                            entries,
                            index,
                            withBlock(
                              entry,
                              /*
                               * An emptied field is no binder rather than a
                               * binder named "". The API stores it the same
                               * way; keeping the two in step here is what
                               * makes the field read back as the board left
                               * it after a save.
                               */
                              category.trim() === ""
                                ? { type: "documentList" }
                                : { type: "documentList", category },
                            ),
                          ),
                        );
                      }}
                    />
                    <span className={HINT}>
                      {t("siteAdmin.editor.documentBinderHint")}
                    </span>
                  </label>
                ) : null}

                {/*
                 * Two blocks with nothing to configure. They still say what
                 * they will publish, because that is the part a board member
                 * cannot see from here: a roster is empty until the consents
                 * are recorded, and a fact nobody has answered is not on the
                 * page.
                 */}
                {block.type === "boardRoster" ? (
                  <p className={HINT}>{t("siteAdmin.editor.rosterHint")}</p>
                ) : null}

                {block.type === "associationFacts" ? (
                  <p className={HINT}>{t("siteAdmin.editor.factsHint")}</p>
                ) : null}

                {/*
                 * A plugin's block, kept while its plugin is not installed.
                 * The board can move it or take it out; what it holds is the
                 * plugin's to edit, and it goes back to the server untouched.
                 */}
                {isRegistered(block) ? null : (
                  <p className={HINT}>
                    {t("siteAdmin.editor.unregisteredHint")}
                  </p>
                )}

                {block.type === "faq" ? (
                  <div className="flex flex-col gap-3">
                    {block.items.map((item, at) => (
                      <div
                        className="flex flex-col gap-2"
                        // By position, and it is safe here in a way it is not
                        // for a block: a question is two plain inputs whose
                        // value is read from the props on every render, so a
                        // reordered list shows the right text rather than the
                        // document an editor was built from.
                        key={at}
                      >
                        <label className={LABEL}>
                          {t("siteAdmin.editor.faqQuestion", {
                            number: at + 1,
                          })}
                          <input
                            className={FIELD}
                            maxLength={PAGE_CONTENT_LIMITS.faqQuestion}
                            value={item.question}
                            onChange={(event) => {
                              setEntries(
                                replaceBlock(
                                  entries,
                                  index,
                                  withBlock(entry, {
                                    type: "faq",
                                    items: withFaqItem(block.items, at, {
                                      ...item,
                                      question: event.target.value,
                                    }),
                                  }),
                                ),
                              );
                            }}
                          />
                        </label>
                        <label className={LABEL}>
                          {t("siteAdmin.editor.faqAnswer", { number: at + 1 })}
                          {/*
                           * A plain field, though the answer is stored as runs
                           * like every other stretch of text on a page. The
                           * stored shape is the website's, so an answer goes
                           * through the same renderer - and the same escaping -
                           * as a paragraph; what this screen does not offer yet
                           * is the marks, which can be added without anything
                           * stored having to change.
                           */}
                          <input
                            className={FIELD}
                            maxLength={PAGE_CONTENT_LIMITS.runText}
                            value={runsToText(item.answer)}
                            onChange={(event) => {
                              setEntries(
                                replaceBlock(
                                  entries,
                                  index,
                                  withBlock(entry, {
                                    type: "faq",
                                    items: withFaqItem(block.items, at, {
                                      ...item,
                                      answer: textToRuns(event.target.value),
                                    }),
                                  }),
                                ),
                              );
                            }}
                          />
                        </label>
                        <div>
                          <button
                            type="button"
                            className={QUIET_BUTTON}
                            onClick={() => {
                              setEntries(
                                replaceBlock(
                                  entries,
                                  index,
                                  withBlock(entry, {
                                    type: "faq",
                                    items: removeFaqItem(block.items, at),
                                  }),
                                ),
                              );
                            }}
                          >
                            {t("siteAdmin.editor.faqRemoveItem")}
                          </button>
                        </div>
                      </div>
                    ))}
                    <div>
                      <button
                        type="button"
                        className={SECONDARY_BUTTON}
                        // A page the write path would refuse is not a page the
                        // board should be able to build and only be told about
                        // when they press save.
                        disabled={
                          block.items.length >= PAGE_CONTENT_LIMITS.faqItems
                        }
                        onClick={() => {
                          setEntries(
                            replaceBlock(
                              entries,
                              index,
                              withBlock(entry, {
                                type: "faq",
                                items: [...block.items, emptyFaqItem()],
                              }),
                            ),
                          );
                        }}
                      >
                        {t("siteAdmin.editor.faqAddItem")}
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-2">
          {INSERTABLE.map((kind: InsertableBlock) => (
            <button
              key={kind}
              type="button"
              className={SECONDARY_BUTTON}
              disabled={room === 0}
              onClick={() => {
                setEntries(insertBlock(entries, kind));
              }}
            >
              {t(insertLabel(kind))}
            </button>
          ))}
        </div>
        {room === 0 ? (
          <p className={HINT}>
            {t("siteAdmin.editor.pageFull", {
              count: PAGE_CONTENT_LIMITS.blocks,
            })}
          </p>
        ) : null}

        {askConsent ? (
          <label className="flex min-h-11 items-start gap-3 text-small text-ink">
            <input
              type="checkbox"
              checked={consentConfirmed}
              onChange={(event) => {
                setConsentConfirmed(event.target.checked);
              }}
              className="mt-1 size-4 accent-trust"
            />
            {t("siteAdmin.editor.photoConsent")}
          </label>
        ) : null}
      </Panel>

      {preview === null ? null : (
        <Panel
          title={t("siteAdmin.preview.heading")}
          description={t("siteAdmin.preview.description")}
        >
          {/*
           * Sandboxed and fed the document rather than an address: the frame
           * runs no script, reaches no origin and carries no session, so a
           * preview cannot do anything the published page could not.
           */}
          <iframe
            title={t("siteAdmin.preview.frameTitle")}
            sandbox=""
            srcDoc={preview}
            className="h-[32rem] w-full rounded-control border border-line"
          />
        </Panel>
      )}
    </div>
  );
}

/**
 * The sentence for a refusal.
 *
 * A body the schema refused is named by the field it refused. The page's own
 * title and address are theirs to correct; a link is about a link; and only a
 * run of text past the length a block holds is about paragraphs. Anything else
 * the schema refuses gets the general sentence, because pointing the board at a
 * field it did not write sends them looking in the wrong place.
 */
function failureKey(failure: ApiFailure): TranslationKey {
  const fields = refusedFields(failure);
  if (fields.includes("title")) {
    return "siteAdmin.errors.invalidTitle";
  }
  if (fields.includes("slug")) {
    return "siteAdmin.errors.invalidSlug";
  }
  // A picture with no description, a banner with no heading and a button
  // with nowhere to go: the refusals a banner, a picture beside text and a
  // button can be given that the board fixes in one field each.
  if (fields.some((field) => /(?:^|\.)alt$/.test(field))) {
    return "siteAdmin.errors.altRequired";
  }
  if (fields.some((field) => /(?:^|\.)blocks\.heading$/.test(field))) {
    return "siteAdmin.errors.bannerHeading";
  }
  if (fields.some((field) => /\.target(?:\.(?:pageId|url))?$/.test(field))) {
    return "siteAdmin.errors.buttonTarget";
  }
  if (
    fields.some((field) => /(?:^|\.)runs\.text$/.test(field)) &&
    !fields.some((field) => field.endsWith(".link"))
  ) {
    return "siteAdmin.errors.tooLong";
  }
  return failureMessageKey(failure, REASONS, "siteAdmin.errors.unknown");
}

/**
 * The positions a refusal named: the page's title, or a block's index.
 *
 * A screening refusal names them as parts; a schema refusal names the path of
 * each field it refused, which for a block starts with its index.
 */
function locationsOf(failure: ApiFailure): ("title" | number)[] {
  const detail = failure.detail;
  if (!Array.isArray(detail)) {
    return [];
  }
  const places = detail.flatMap((entry): ("title" | number)[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { part, index, path } = entry as {
      part?: unknown;
      index?: unknown;
      path?: unknown;
    };
    if (part === "title") {
      return ["title"];
    }
    if (typeof path === "string") {
      const block = /(?:^|\.)blocks\.(\d+)(?:\.|$)/.exec(path)?.[1];
      return block === undefined ? [] : [Number(block)];
    }
    return typeof index === "number" ? [index] : [];
  });
  return [...new Set(places)];
}
