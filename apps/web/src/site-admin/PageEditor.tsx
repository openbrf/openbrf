import { lazy, Suspense, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { ApiFailure } from "../api/client";
import {
  type AdminPage,
  deletePage,
  publishPage,
  previewPage,
  savePage,
  setPageVisibility,
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
import { failureMessageKey } from "../ui/save-state";
import {
  blocksOf,
  type EditorBlock,
  editorBlocks,
  insertBlock,
  type InsertableBlock,
  INSERTABLE,
  moveBlock,
  needsPhotoConsent,
  newBlockWith,
  removeBlock,
  replaceBlock,
  replaceBlockWith,
  runsToText,
  scanPage,
  submittableBlocks,
  textToRuns,
  withBlock,
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
 * What a refusal from the write API says on this screen.
 *
 * Every reason the page endpoints can answer with is named here, so a refusal
 * the board can act on never arrives as "something went wrong". The two
 * guardrail refusals additionally say where: the API sends positions, and the
 * screen turns them into the block numbers a person is looking at.
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
};

export interface PageEditorProps {
  page: AdminPage;
  onChanged: (page: AdminPage) => void;
  onRemoved: (id: string) => void;
}

export function PageEditor({
  page,
  onChanged,
  onRemoved,
}: PageEditorProps): ReactElement {
  const { t } = useTranslation();

  const [title, setTitle] = useState(page.title);
  const [slug, setSlug] = useState(page.slug);
  const [entries, setEntries] = useState<EditorBlock[]>(() =>
    editorBlocks(page.content.blocks),
  );
  const [identifiable, setIdentifiable] = useState<ReadonlySet<string>>(
    new Set(),
  );
  /**
   * The image blocks whose picture has been declared to show identifiable
   * persons, by the block's own identity.
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

  const blocks = blocksOf(entries);
  const hits = scanPage({ title, blocks });

  const run = useCallback(
    async (
      action: () => Promise<
        { ok: true; value: AdminPage } | { ok: false; failure: ApiFailure }
      >,
    ): Promise<void> => {
      setBusy(true);
      setSaved(false);
      const result = await action();
      setBusy(false);

      if (!result.ok) {
        setFailure(result.failure);
        if (result.failure.reason === "photo-consent-required") {
          setConsentAsked(true);
        }
        return;
      }

      setFailure(null);
      setSaved(true);
      onChanged(result.value);
    },
    [onChanged],
  );

  const submittable = submittableBlocks(blocks);
  const body = { blocks: submittable.blocks };
  const consent = consentConfirmed ? { photoConsentConfirmed: true } : {};

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
                {t(
                  failureMessageKey(
                    failure,
                    REASONS,
                    "siteAdmin.errors.unknown",
                  ),
                )}
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
                void run(async () =>
                  savePage(page.id, { slug, title, content: body, ...consent }),
                );
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
                    slug,
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
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => {
                const publishing = !page.published;
                void run(async () => {
                  /*
                   * Publishing means publishing the page on the screen, so the
                   * draft is saved first. The body lives in this component
                   * until it is saved, and publishing without saving would put
                   * the previously stored version on the website - for a page
                   * written and not yet saved, a blank one.
                   *
                   * Taking a page down deliberately does not save: removing it
                   * from the website is not the moment to commit whatever edits
                   * happened to be half-finished beside it.
                   */
                  if (publishing) {
                    const stored = await savePage(page.id, {
                      slug,
                      title,
                      content: body,
                      ...consent,
                    });
                    if (!stored.ok) {
                      return stored;
                    }
                  }
                  return publishPage(page.id, {
                    published: publishing,
                    ...consent,
                  });
                });
              }}
            >
              {page.published
                ? t("siteAdmin.editor.unpublish")
                : t("siteAdmin.editor.publish")}
            </button>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              disabled={busy}
              onClick={() => {
                void run(async () =>
                  setPageVisibility(page.id, {
                    visibility:
                      page.visibility === "PUBLIC" ? "MEMBER" : "PUBLIC",
                    ...consent,
                  }),
                );
              }}
            >
              {page.visibility === "PUBLIC"
                ? t("siteAdmin.editor.makeMemberOnly")
                : t("siteAdmin.editor.makePublic")}
            </button>
            <button
              type="button"
              className={QUIET_BUTTON}
              disabled={busy}
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
                  setBusy(true);
                  const result = await deletePage(page.id);
                  setBusy(false);
                  if (result.ok) {
                    onRemoved(page.id);
                    return;
                  }
                  setFailure(result.failure);
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
        </label>

        <label className={LABEL}>
          {t("siteAdmin.editor.slug")}
          <input
            className={FIELD}
            value={slug}
            onChange={(event) => {
              setSlug(event.target.value);
            }}
          />
          <span className={HINT}>{t("siteAdmin.editor.slugHint")}</span>
        </label>

        <ol className="flex flex-col gap-4">
          {entries.map((entry, index) => {
            const block = entry.block;
            return (
              <li key={entry.id} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-label text-ink-muted uppercase">
                    {t(`siteAdmin.editor.blocks.${block.type}`)}
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    onClick={() => {
                      setEntries(moveBlock(entries, index, -1));
                    }}
                  >
                    {t("siteAdmin.editor.moveUp")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    onClick={() => {
                      setEntries(moveBlock(entries, index, 1));
                    }}
                  >
                    {t("siteAdmin.editor.moveDown")}
                  </button>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
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
                      onChange={(paragraphs) => {
                        setEntries(
                          replaceBlockWith(
                            entries,
                            index,
                            /*
                             * Ordinary typing keeps the identity, because this
                             * runs on every keystroke and a new one would
                             * remount the editor being typed into.
                             *
                             * A return is the other case, and there the block
                             * keeping its identity is what goes wrong. An
                             * editor reads its runs once, when it is created,
                             * so a first block that keeps its identity is not
                             * remounted and its document still holds every
                             * paragraph of the split - the text now shows twice
                             * on the screen, once in the editor that was not
                             * rebuilt and once in the block split out of it,
                             * and the next keystroke splits it again. So a
                             * return rebuilds all of them: each editor is then
                             * created from the one paragraph it is showing.
                             */
                            paragraphs.length === 1
                              ? [
                                  withBlock(entry, {
                                    type: "paragraph",
                                    runs: paragraphs[0] ?? [],
                                  }),
                                ]
                              : paragraphs.map((runs) =>
                                  newBlockWith({ type: "paragraph", runs }),
                                ),
                          ),
                        );
                      }}
                    />
                  </Suspense>
                ) : null}

                {block.type === "heading" ? (
                  <div className="flex flex-wrap items-end gap-3">
                    <label className={LABEL}>
                      {t("siteAdmin.editor.headingLevel")}
                      <select
                        className={FIELD}
                        value={String(block.level)}
                        onChange={(event) => {
                          setEntries(
                            replaceBlock(
                              entries,
                              index,
                              withBlock(entry, {
                                ...block,
                                level: event.target.value === "3" ? 3 : 2,
                              }),
                            ),
                          );
                        }}
                      >
                        <option value="2">
                          {t("siteAdmin.editor.headingLevelTwo")}
                        </option>
                        <option value="3">
                          {t("siteAdmin.editor.headingLevelThree")}
                        </option>
                      </select>
                    </label>
                    <label className={`${LABEL} flex-1`}>
                      {t("siteAdmin.editor.headingText")}
                      <input
                        className={FIELD}
                        value={runsToText(block.runs)}
                        onChange={(event) => {
                          setEntries(
                            replaceBlock(
                              entries,
                              index,
                              withBlock(entry, {
                                ...block,
                                runs: textToRuns(event.target.value),
                              }),
                            ),
                          );
                        }}
                      />
                    </label>
                  </div>
                ) : null}

                {block.type === "image" ? (
                  <div className="flex flex-col gap-3">
                    {/*
                     * The declaration is answered before the file is chosen,
                     * because it travels with the bytes: the media layer records
                     * it on the stored file, and it is what the publication
                     * guardrail acts on. A picture nobody has declared cannot be
                     * checked against a publication consent at all.
                     */}
                    <label className="flex min-h-11 items-start gap-3 text-small text-ink">
                      <input
                        type="checkbox"
                        checked={declared.has(entry.id)}
                        onChange={(event) => {
                          setDeclared((current) => {
                            const next = new Set(current);
                            if (event.target.checked) {
                              next.add(entry.id);
                            } else {
                              next.delete(entry.id);
                            }
                            return next;
                          });
                        }}
                        className="mt-1 size-4 accent-trust"
                      />
                      {t("siteAdmin.editor.identifiable")}
                    </label>
                    <label className={LABEL}>
                      {t("siteAdmin.editor.picture")}
                      <input
                        className={FIELD}
                        type="file"
                        accept="image/*"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file === undefined) {
                            return;
                          }
                          const shows = declared.has(entry.id);
                          void (async () => {
                            setBusy(true);
                            const result = await uploadSiteImage(file, shows);
                            setBusy(false);
                            if (!result.ok) {
                              setFailure(result.failure);
                              return;
                            }
                            if (result.value.showsIdentifiablePersons) {
                              setIdentifiable(
                                (current) =>
                                  new Set([...current, result.value.id]),
                              );
                            }
                            setEntries((current) =>
                              withUploadedPicture(
                                current,
                                entry.id,
                                result.value.id,
                              ),
                            );
                          })();
                        }}
                      />
                      <span className={HINT}>
                        {t("siteAdmin.editor.pictureHint")}
                      </span>
                    </label>
                    <label className={LABEL}>
                      {t("siteAdmin.editor.alt")}
                      <input
                        className={FIELD}
                        value={block.alt}
                        onChange={(event) => {
                          setEntries(
                            replaceBlock(
                              entries,
                              index,
                              withBlock(entry, {
                                ...block,
                                alt: event.target.value,
                              }),
                            ),
                          );
                        }}
                      />
                      <span className={HINT}>
                        {t("siteAdmin.editor.altHint")}
                      </span>
                    </label>
                    <label className={LABEL}>
                      {t("siteAdmin.editor.caption")}
                      <input
                        className={FIELD}
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
              onClick={() => {
                setEntries(insertBlock(entries, kind));
              }}
            >
              {t(`siteAdmin.editor.add.${kind}`)}
            </button>
          ))}
        </div>

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

/** The positions a refusal named: the page's title, or a block's index. */
function locationsOf(failure: ApiFailure): ("title" | number)[] {
  const detail = failure.detail;
  if (!Array.isArray(detail)) {
    return [];
  }
  return detail.flatMap((entry): ("title" | number)[] => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { part, index } = entry as { part?: unknown; index?: unknown };
    if (part === "title") {
      return ["title"];
    }
    return typeof index === "number" ? [index] : [];
  });
}
