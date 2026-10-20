import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import {
  BOARD_POST_AUDIENCES,
  type AudienceKind,
  type PostView,
} from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import { uploadPostImage, writeBoardPost, writePost } from "../api/feed";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Dialog } from "../ui/Dialog";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { useNow } from "../ui/use-now";
import { toInstant, toWallClock } from "../ui/wall-clock";
import { writtenAt } from "./Author";
import { feedFailureKey, uploadFailureKey } from "./feed-failures";
import {
  BOARD_POST_TITLE_MAX_LENGTH,
  MAX_IMAGES_PER_POST,
  POST_MAX_LENGTH,
} from "./feed-limits";
import { PostText } from "./PostText";

/**
 * The image types the media layer accepts, offered by the file picker so a
 * writer is not shown a PDF they then cannot attach. The server identifies
 * every file from its own bytes either way.
 */
const ACCEPTED_IMAGES = "image/png,image/jpeg,image/webp,image/gif";

/**
 * A preview address the browser made for a picked file, or null if it is not
 * one.
 *
 * Only a `blob:` address, the kind that points into this browser's own memory,
 * is shown as an image. The browser makes nothing else, but the picked file is
 * the writer's input, so the address it yields is read and checked like any
 * other before it goes into the page.
 */
function localFileAddress(made: string): string | null {
  let url: URL;
  try {
    url = new URL(made);
  } catch {
    return null;
  }
  return url.protocol === "blob:" ? url.href : null;
}

/** One image the writer picked, and how far its upload has got. */
interface Attachment {
  /** This screen's own key for it, since an upload has no identifier yet. */
  key: number;
  fileName: string;
  /** The writer's own file, shown back to them. Null where a browser has none. */
  preview: string | null;
  /** The uploaded image's identifier once the server has it. */
  imageId: string | null;
  failure: ApiFailure | null;
}

/** An audience the composer can write to, as "Till" names it. */
export interface ComposerAudience {
  id: string;
  kind: AudienceKind;
  name: string;
}

/**
 * Who a post is from: the writer, or Styrelsen with or without "via" the
 * writer's name.
 */
type From = "self" | "board" | "boardVia";

export interface PostComposerProps {
  /** Who the post goes to unless the writer chooses: the audience that is open. */
  audience: ComposerAudience;
  /**
   * What "Till" offers, the open audience among them: Alla, Styrelsen and
   * Administratörer for a board seat holder, and the group that is open. Empty
   * for everybody else, who writes to `audience`.
   */
  choices?: readonly ComposerAudience[];
  /** Who the post is from, as the dialog names them: the writer themselves. */
  authorName: string;
  /**
   * Whether "Från" offers Styrelsen, and with it the board's options. The
   * server's answer (`mayPostAsBoard`), which it asks again on the write.
   */
  mayPostAsBoard?: boolean;
  onClose: () => void;
  /** Called with the post once the server has it. */
  onWritten: (post: PostView) => void;
}

/**
 * Writing a post: "Skriv ett inlägg".
 *
 * From the writer, to the audience that is open - Alla while the whole feed is
 * on screen, and the group or Styrelsen while one of them is. Text is required
 * and images are optional; nothing else can be attached, because a post is
 * read in the feed and a document is filed in the archive.
 *
 * ## Images go up as they are picked
 *
 * Each picked image is uploaded at once and the post is written with their
 * identifiers, so pressing "Skapa" is one write rather than a write and four
 * uploads that might half succeed. An uploaded image is on no post and is
 * served to nobody until the post is written - the dialog shows the writer the
 * file they picked, read in their own browser - and one left behind by a dialog
 * that was closed is swept by the server.
 *
 * ## Nothing is optimistic
 *
 * The post is not put on the feed by this dialog. The write is answered with the
 * post, the dialog closes, and the feed reads it - the same way everybody else's
 * arrives.
 *
 * ## A refusal keeps the draft
 *
 * A personal identity number in the text, a write budget spent: the dialog
 * stays open with everything in it, and says what was refused, so the writer can
 * take the number out rather than write the post again.
 *
 * ## The board's composer
 *
 * A board seat holder chooses who the post is from - themselves, Styrelsen, or
 * Styrelsen via their name - and which audience it goes to: Alla, Styrelsen or
 * Administratörer, and as themselves the group that is open. Written as
 * Styrelsen it is a news item (ADR 0026), so it has a title and offers what a
 * news item can do: "Viktigt meddelande" sends the mailing, "Fäst överst" pins
 * it, comments can be turned off, and it can wait for an instant ahead. Only a
 * post to Alla can be shown on the website to everyone; one to Styrelsen or
 * Administratörer is read by that audience alone, and mailed to it alone. The
 * server asks the register on every write whether this account may; the dialog
 * offers it only where the server said it would.
 */
export function PostComposer({
  audience,
  choices = [],
  authorName,
  mayPostAsBoard = false,
  onClose,
  onWritten,
}: PostComposerProps): ReactElement {
  const { t, i18n } = useTranslation();
  const formId = useId();
  const [from, setFrom] = useState<From>("self");
  const [to, setTo] = useState(audience.id);
  const [headline, setHeadline] = useState("");
  const [important, setImportant] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [commentsAllowed, setCommentsAllowed] = useState(true);
  const [onWebsite, setOnWebsite] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  // The earliest instant the schedule offers, kept moving while the dialog is
  // open; the server refuses one that has passed either way.
  const now = useNow();
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const nextKey = useRef(0);

  /*
   * The previews are this browser's own copies of the picked files, and are
   * handed back when the dialog goes. Held in a ref as well, because the
   * clean-up runs once and has to see every preview made since.
   */
  const previews = useRef(new Set<string>());
  useEffect(() => {
    const made = previews.current;
    return () => {
      for (const url of made) {
        URL.revokeObjectURL(url);
      }
      made.clear();
    };
  }, []);

  const write = useSaveAction(writePost, onWritten);
  const writeAsBoard = useSaveAction(writeBoardPost, onWritten);
  const asBoard = mayPostAsBoard && from !== "self";
  const action = asBoard ? writeAsBoard : write;
  const writing =
    write.state.kind === "saving" || writeAsBoard.state.kind === "saving";
  /*
   * Written as Styrelsen it goes where a post as the board may - never into a
   * group, which is not the board's to speak in - so "Till" offers those, and
   * keeps the choice when it is still among them.
   */
  const offered = asBoard
    ? choices.filter((each) => BOARD_POST_AUDIENCES.includes(each.kind))
    : choices.length === 0
      ? [audience]
      : choices;
  const target =
    offered.find((each) => each.id === to) ??
    offered.find((each) => each.kind === "ALL") ??
    offered[0] ??
    null;
  // The website is the street's, and only Alla's posts are on it.
  const toHouse = target?.kind === "ALL";
  const scheduledAt = asBoard ? toInstant(scheduleAt) : null;
  const sendable =
    body.trim() !== "" &&
    (!asBoard || headline.trim() !== "") &&
    target !== null;
  const uploading = attachments.some(
    (each) => each.imageId === null && each.failure === null,
  );
  const ready = attachments.filter((each) => each.imageId !== null);
  const room = MAX_IMAGES_PER_POST - attachments.length;

  const attach = (files: readonly File[]): void => {
    for (const file of files.slice(0, Math.max(0, room))) {
      nextKey.current += 1;
      const key = nextKey.current;
      const made =
        typeof URL.createObjectURL === "function"
          ? URL.createObjectURL(file)
          : null;
      if (made !== null) {
        previews.current.add(made);
      }
      const preview = made === null ? null : localFileAddress(made);
      setAttachments((held) => [
        ...held,
        { key, fileName: file.name, preview, imageId: null, failure: null },
      ]);
      void uploadPostImage({ file }).then((result) => {
        setAttachments((held) =>
          held.map((each) =>
            each.key !== key
              ? each
              : result.ok
                ? { ...each, imageId: result.value.id }
                : { ...each, failure: result.failure },
          ),
        );
        return result;
      });
    }
  };

  const detach = (key: number): void => {
    setAttachments((held) => {
      const leaving = held.find((each) => each.key === key);
      if (leaving?.preview != null) {
        URL.revokeObjectURL(leaving.preview);
        previews.current.delete(leaving.preview);
      }
      return held.filter((each) => each.key !== key);
    });
  };

  const failureKey =
    action.state.kind === "failed"
      ? feedFailureKey(action.state.failure)
      : null;
  const byline =
    from === "board"
      ? t("feed.composer.fromBoard")
      : from === "boardVia"
        ? t("feed.composer.fromBoardVia", { name: authorName })
        : authorName;

  return (
    <Dialog
      title={t("feed.composer.title")}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => {
              setPreviewing((value) => !value);
            }}
            aria-pressed={previewing}
          >
            {t("feed.composer.preview")}
          </button>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t("feed.composer.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className={PRIMARY_BUTTON}
            disabled={writing || uploading || !sendable}
          >
            {scheduledAt === null
              ? writing
                ? t("feed.composer.creating")
                : t("feed.composer.create")
              : writing
                ? t("feed.composer.scheduling")
                : t("feed.composer.schedulePublish")}
          </button>
        </>
      }
    >
      {mayPostAsBoard ? null : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
          <dt className="text-ink-muted">{t("feed.composer.from")}</dt>
          <dd>{authorName}</dd>
          <dt className="text-ink-muted">{t("feed.composer.to")}</dt>
          <dd>{audience.name}</dd>
        </dl>
      )}

      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}

      <LockedForm
        id={formId}
        className="flex flex-col gap-3"
        locked={writing}
        focusFallback={bodyRef}
        onSend={() => {
          if (uploading || !sendable || target === null) {
            return;
          }
          const imageIds = ready.flatMap((each) =>
            each.imageId === null ? [] : [each.imageId],
          );
          if (asBoard) {
            void writeAsBoard.submit({
              audienceId: target.id,
              title: headline,
              body,
              imageIds,
              namesAuthor: from === "boardVia",
              important,
              pinned,
              commentsAllowed,
              scheduledAt,
              onWebsite: toHouse && onWebsite,
            });
            return;
          }
          void write.submit({ audienceId: target.id, body, imageIds });
        }}
      >
        {mayPostAsBoard ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={LABEL}>
              {t("feed.composer.from")}
              <select
                className={FIELD}
                value={from}
                onChange={(event) => {
                  setFrom(event.target.value as From);
                }}
              >
                <option value="self">{authorName}</option>
                <option value="board">{t("feed.composer.fromBoard")}</option>
                <option value="boardVia">
                  {t("feed.composer.fromBoardVia", { name: authorName })}
                </option>
              </select>
            </label>
            <label className={LABEL}>
              {t("feed.composer.to")}
              <select
                className={FIELD}
                value={target?.id ?? audience.id}
                onChange={(event) => {
                  setTo(event.target.value);
                }}
              >
                {offered.map((each) => (
                  <option key={each.id} value={each.id}>
                    {each.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        {asBoard ? (
          <label className={LABEL}>
            {t("feed.composer.headline")}
            <input
              type="text"
              className={FIELD}
              value={headline}
              maxLength={BOARD_POST_TITLE_MAX_LENGTH}
              required
              onChange={(event) => {
                setHeadline(event.target.value);
              }}
            />
            <span className={HINT}>{t("feed.composer.headlineHint")}</span>
          </label>
        ) : null}

        <label className={LABEL}>
          {t("feed.composer.text")}
          <textarea
            ref={bodyRef}
            className={`${FIELD_MULTILINE} min-h-32`}
            value={body}
            maxLength={POST_MAX_LENGTH}
            required
            // Focused as the dialog opens: somebody who pressed "Skriv ett
            // inlägg" is about to write one.
            autoFocus
            onChange={(event) => {
              setBody(event.target.value);
            }}
          />
        </label>

        <div className="flex flex-col gap-2">
          <label className={LABEL}>
            {t("feed.composer.images")}
            <input
              type="file"
              accept={ACCEPTED_IMAGES}
              multiple
              disabled={room <= 0}
              className="text-small text-ink file:mr-3 file:min-h-11 file:rounded-control file:border file:border-line-strong file:bg-raised file:px-3 file:text-small file:font-semibold file:text-ink"
              onChange={(event) => {
                attach([...(event.target.files ?? [])]);
                // Emptied, so picking the same file again after removing it is
                // a change the field reports.
                event.target.value = "";
              }}
            />
          </label>
          <p className={HINT}>
            {t("feed.composer.imagesHint", { count: MAX_IMAGES_PER_POST })}
          </p>

          {attachments.length === 0 ? null : (
            <ul className="flex flex-col gap-2">
              {attachments.map((each) => (
                <li
                  key={each.key}
                  className="flex items-center gap-3 rounded-control border border-line p-2"
                >
                  {each.preview === null ? null : (
                    <img
                      src={each.preview}
                      alt=""
                      className="size-12 rounded-control object-cover"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-small">
                    {each.fileName}
                  </span>
                  <span className="text-small text-ink-muted" role="status">
                    {each.failure !== null
                      ? t(uploadFailureKey(each.failure))
                      : each.imageId === null
                        ? t("feed.composer.uploading")
                        : t("feed.composer.uploaded")}
                  </span>
                  <button
                    type="button"
                    className={QUIET_BUTTON}
                    aria-label={t("feed.composer.removeNamed", {
                      name: each.fileName,
                    })}
                    onClick={() => {
                      detach(each.key);
                    }}
                  >
                    {t("feed.composer.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {asBoard ? (
          <fieldset className="flex flex-col gap-1 rounded-control border border-line p-3">
            <legend className="px-1 text-label text-ink-muted uppercase">
              {t("feed.composer.boardOptions")}
            </legend>
            <Toggle
              checked={important}
              onChange={setImportant}
              label={t("feed.composer.important")}
              hint={
                toHouse || target === null
                  ? t("feed.composer.importantHint")
                  : t("feed.composer.importantHintConfined", {
                      audience: target.name,
                    })
              }
            />
            <Toggle
              checked={pinned}
              onChange={setPinned}
              label={t("feed.composer.pinned")}
            />
            <Toggle
              checked={commentsAllowed}
              onChange={setCommentsAllowed}
              label={t("feed.composer.commentsAllowed")}
            />
            {toHouse ? (
              <Toggle
                checked={onWebsite}
                onChange={setOnWebsite}
                label={t("feed.composer.onWebsite")}
                hint={t("feed.composer.onWebsiteHint")}
              />
            ) : null}
            <label className={`${LABEL} mt-2`}>
              {t("feed.composer.schedule")}
              <input
                type="datetime-local"
                className={FIELD}
                value={scheduleAt}
                min={toWallClock(new Date(now))}
                onChange={(event) => {
                  setScheduleAt(event.target.value);
                }}
              />
              <span className={HINT}>{t("feed.composer.scheduleHint")}</span>
            </label>
          </fieldset>
        ) : null}

        <p className={HINT}>
          {!asBoard
            ? t("feed.composer.hint")
            : toHouse || target === null
              ? t("feed.composer.boardHint")
              : t("feed.composer.boardHintConfined", { audience: target.name })}
        </p>
      </LockedForm>

      {previewing ? (
        <section
          aria-label={t("feed.composer.previewLabel")}
          className="flex flex-col gap-2 rounded-control border border-dashed border-line-strong p-3"
        >
          <p className="text-label text-ink-muted uppercase">
            {t("feed.composer.previewLabel")}
          </p>
          <p className="text-body font-semibold">{byline}</p>
          {asBoard ? (
            <p className="text-small text-ink-muted">
              {[
                ...(important ? [t("feed.important")] : []),
                ...(pinned ? [t("feed.pinned")] : []),
                ...(scheduledAt === null
                  ? []
                  : [
                      t("feed.scheduled.at", {
                        when: writtenAt(scheduledAt, i18n.language),
                      }),
                    ]),
              ].join(" · ")}
            </p>
          ) : null}
          {asBoard && headline.trim() !== "" ? (
            <h3 className="text-title">{headline}</h3>
          ) : null}
          {body.trim() === "" ? (
            <p className="text-small text-ink-muted">
              {t("feed.composer.previewEmpty")}
            </p>
          ) : (
            <PostText text={body} />
          )}
          {ready.some((each) => each.preview !== null) ? (
            <ul className="grid grid-cols-2 gap-2">
              {ready.map((each) =>
                each.preview === null ? null : (
                  <li key={each.key}>
                    <img
                      src={each.preview}
                      alt=""
                      className="h-auto w-full rounded-control border border-line object-cover"
                    />
                  </li>
                ),
              )}
            </ul>
          ) : null}
        </section>
      ) : null}
    </Dialog>
  );
}

/** One of the board's options: a checkbox, its label, and what it does. */
function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
}): ReactElement {
  return (
    <label className="flex min-h-11 items-start gap-3 py-2 text-body">
      <input
        type="checkbox"
        className="mt-1 size-4 accent-trust"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="flex flex-col gap-0.5">
        {label}
        {hint === undefined ? null : <span className={HINT}>{hint}</span>}
      </span>
    </label>
  );
}
