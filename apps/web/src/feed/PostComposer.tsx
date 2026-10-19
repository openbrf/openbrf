import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import type { PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import { uploadPostImage, writePost } from "../api/feed";
import {
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
import { feedFailureKey, uploadFailureKey } from "./feed-failures";
import { MAX_IMAGES_PER_POST, POST_MAX_LENGTH } from "./feed-limits";
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

export interface PostComposerProps {
  /** Who the post goes to, by identifier and as the dialog names it. */
  audience: { id: string; name: string };
  /** Who the post is from, as the dialog names them: the writer themselves. */
  authorName: string;
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
 */
export function PostComposer({
  audience,
  authorName,
  onClose,
  onWritten,
}: PostComposerProps): ReactElement {
  const { t } = useTranslation();
  const formId = useId();
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
  const writing = write.state.kind === "saving";
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
    write.state.kind === "failed" ? feedFailureKey(write.state.failure) : null;

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
            disabled={writing || uploading || body.trim() === ""}
          >
            {writing ? t("feed.composer.creating") : t("feed.composer.create")}
          </button>
        </>
      }
    >
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-small">
        <dt className="text-ink-muted">{t("feed.composer.from")}</dt>
        <dd>{authorName}</dd>
        <dt className="text-ink-muted">{t("feed.composer.to")}</dt>
        <dd>{audience.name}</dd>
      </dl>

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
          if (uploading || body.trim() === "") {
            return;
          }
          void write.submit({
            audienceId: audience.id,
            body,
            imageIds: ready.flatMap((each) =>
              each.imageId === null ? [] : [each.imageId],
            ),
          });
        }}
      >
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

        <p className={HINT}>{t("feed.composer.hint")}</p>
      </LockedForm>

      {previewing ? (
        <section
          aria-label={t("feed.composer.previewLabel")}
          className="flex flex-col gap-2 rounded-control border border-dashed border-line-strong p-3"
        >
          <p className="text-label text-ink-muted uppercase">
            {t("feed.composer.previewLabel")}
          </p>
          <p className="text-body font-semibold">{authorName}</p>
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
