import { Link } from "@tanstack/react-router";
import { useId, useRef, useState, type ReactElement } from "react";
import type { PostImageView, PostView } from "@openbrf/shared";
import { useTranslation } from "react-i18next";

import { likePost, markPostRead, reportPost } from "../api/feed";
import { HINT } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";
import { authorLabel, Avatar, Byline, writtenAt } from "./Author";
import { feedFailureKey } from "./feed-failures";
import { copyText, MoreMenu, type MoreAction } from "./MoreMenu";
import { PostText } from "./PostText";
import { PostThread } from "./PostThread";
import { ReportDialog } from "./ReportDialog";
import { useSeen } from "./use-seen";

export interface PostCardProps {
  post: PostView;
  /** Who is reading, which is what tells their own post from a neighbour's. */
  viewerPersonId: string;
  /**
   * Whether the card is the post's own page: its comments open from the start,
   * and its date is not a link to the page it is already on.
   */
  standalone?: boolean;
  /**
   * Whether to say which audience the post was for. Said in the whole feed,
   * where posts to Alla, Styrelsen and a group sit side by side, and left out
   * where one audience is open and the heading already says it.
   */
  showAudience: boolean;
  /**
   * What the server answered an act on the post with - a like, a read - to be
   * put onto the post as it is held now. A patch rather than the whole post,
   * so an answer cannot put back a post as it was before a poll changed it.
   */
  onChange: (patch: Partial<PostView>) => void;
  /** Asks for the post to be read again, once a comment has changed its count. */
  onRefresh: () => void;
}

/**
 * One post in the feed.
 *
 * Who wrote it, when and to whom; what they wrote, with its line breaks and its
 * links; the images on it; and what the house has done with it - who likes it,
 * the comments under it, and how many have read it.
 *
 * ## "Läst av N" is a count and never names
 *
 * Who opened which post is personal data with one stated purpose (ADR 0026): a
 * count for everybody, and on an important post the board's list of who has
 * not. A card that named readers would be a list of who reads what in the
 * house, which is not a purpose anybody stated. The card marks the post read
 * once it has been on screen, which is when the reader had it in front of them.
 *
 * ## What the ⋯ offers, and what it never will
 *
 * Copying the text, and in a group, reporting the post to the board - the only
 * thing that carries anything out of a group, and what it carries is this post
 * and nothing else. Not on a post already struck, which the board has answered
 * about; not on one's own; not in Styrelsen, where the board is the whole
 * audience; and not yet in Alla, whose moderation comes later.
 *
 * There is no delete, by the author or by anybody else. What somebody wrote is a
 * record of what was said: the board strikes through rather than erases, and
 * the only thing that removes a post is the retention clock.
 *
 * ## A struck post, and an erased one
 *
 * A struck post stays exactly where it is with its author's name on it. What
 * changes is the text and the images: withheld from the audience, still shown
 * to whoever wrote it and to the board - and the card renders the answer the
 * server gave rather than deciding it here. An erased post has lost its text and
 * its author to the retention clock, and stays for the comments under it, each
 * on a clock of its own; it is never attributed to the board.
 */
export function PostCard({
  post,
  viewerPersonId,
  standalone = false,
  showAudience,
  onChange,
  onRefresh,
}: PostCardProps): ReactElement {
  const { t, i18n } = useTranslation();
  const [threadOpen, setThreadOpen] = useState(standalone);
  const [reportOpen, setReportOpen] = useState(false);
  const [reported, setReported] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const card = useRef<HTMLElement>(null);
  const threadId = useId();

  const erased = post.erasedAt !== null;
  const mine =
    post.author?.kind === "person" && post.author.personId === viewerPersonId;

  useSeen(
    card,
    () => {
      void markPostRead({ postId: post.id }).then((result) => {
        // Nothing is said about a read that did not land. It decides a count
        // and nothing about what anybody may read, so a notice here would
        // report a failure the reader can neither act on nor care about.
        if (result.ok) {
          onChange({ readBy: result.value.readBy });
        }
        return result;
      });
    },
    // Not one's own, which its author wrote rather than read, and not an erased
    // one, which records nothing.
    !mine && !erased,
  );

  const like = useSaveAction(likePost, onChange);
  const report = useSaveAction(reportPost, () => {
    setReportOpen(false);
    setReported(true);
  });

  const reportable =
    post.audience.kind === "GROUP" &&
    post.struckAt === null &&
    !erased &&
    !mine;
  const author =
    post.author === null ? t("feed.authorBoard") : authorLabel(post.author, t);
  const body = post.body;
  const text = body ?? post.news?.title ?? null;

  const actions: MoreAction[] = [
    ...(text === null
      ? []
      : [
          {
            label: t("feed.copyText"),
            onSelect: () => {
              void copyText(text).then(setCopied);
            },
          },
        ]),
    ...(reportable
      ? [
          {
            label: t("feed.report.open"),
            onSelect: () => {
              report.reset();
              setReportOpen(true);
            },
          },
        ]
      : []),
  ];

  return (
    <article
      ref={card}
      aria-labelledby={`${threadId}-by`}
      className="flex flex-col gap-3 rounded-panel border border-line bg-raised p-4 shadow-raised"
    >
      <header className="flex items-start gap-3">
        {erased ? (
          <Avatar author={null} byBoard={false} />
        ) : (
          <Avatar author={post.author} byBoard={post.byBoard} />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span id={`${threadId}-by`} className="text-body font-semibold">
              {erased ? (
                // In the author's place, because there is no author left to
                // name: a post naming nobody would otherwise read as the board's.
                t("feed.erased")
              ) : (
                <Byline author={post.author} byBoard={post.byBoard} />
              )}
            </span>
            {mine ? <Chip>{t("feed.you")}</Chip> : null}
            {post.pinned ? <Chip>{t("feed.pinned")}</Chip> : null}
            {post.important ? (
              <Chip tone="warn">{t("feed.important")}</Chip>
            ) : null}
            {post.struckAt === null ? null : (
              // The word as well as the tone: a reader who cannot tell the
              // tones apart still reads that this post was struck through.
              <Chip tone="warn">{t("feed.struck")}</Chip>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-ink-muted">
            {standalone ? (
              <time dateTime={post.createdAt} className="font-data text-data">
                {writtenAt(post.createdAt, i18n.language)}
              </time>
            ) : (
              // The post's own address, which a mailing or a report can link
              // to, and which a reader can copy from here.
              <Link
                to="/feed/$postId"
                params={{ postId: post.id }}
                className="font-data text-data underline decoration-line-strong hover:text-ink"
              >
                <time dateTime={post.createdAt}>
                  {writtenAt(post.createdAt, i18n.language)}
                </time>
              </Link>
            )}
            {showAudience ? (
              <span>
                {t("feed.to", {
                  audience:
                    post.audience.name ??
                    (post.audience.kind === "BOARD"
                      ? t("feed.audience.board")
                      : t("feed.audience.all")),
                })}
              </span>
            ) : null}
            {post.editedAt === null ? null : <span>{t("feed.edited")}</span>}
          </div>
        </div>
        {erased ? null : (
          <MoreMenu label={t("feed.postMore", { author })} actions={actions} />
        )}
      </header>

      <PostContent post={post} />

      {copied === null ? null : (
        <p role="status" className={HINT}>
          {copied ? t("feed.copied") : t("feed.copyFailed")}
        </p>
      )}
      {reported ? (
        <Notice tone="info" live>
          {t("feed.report.sent")}
        </Notice>
      ) : null}
      {like.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(feedFailureKey(like.state.failure))}
        </Notice>
      ) : null}

      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-2">
        {erased ? null : (
          <button
            type="button"
            className="inline-flex min-h-11 items-center gap-1.5 text-small text-ink-muted hover:text-ink disabled:opacity-60"
            aria-pressed={post.liked}
            // One at a time, so a second press cannot ask for the opposite of
            // an answer it has not seen yet.
            disabled={like.state.kind === "saving"}
            onClick={() => {
              void like.submit({ postId: post.id, liked: !post.liked });
            }}
          >
            {post.liked ? t("feed.liked") : t("feed.like")}
            <span className="font-data text-data">{post.likes}</span>
          </button>
        )}
        <button
          type="button"
          className="inline-flex min-h-11 items-center text-small text-ink-muted hover:text-ink"
          aria-expanded={threadOpen}
          aria-controls={threadId}
          onClick={() => {
            setThreadOpen((open) => !open);
          }}
        >
          {t("feed.comments", { count: post.comments })}
        </button>
        <span className="ml-auto text-small text-ink-muted">
          {t("feed.readBy", { count: post.readBy })}
        </span>
      </footer>

      {threadOpen ? (
        <div id={threadId}>
          <PostThread post={post} onCommented={onRefresh} />
        </div>
      ) : null}

      {reportOpen ? (
        <ReportDialog
          author={author}
          sending={report.state.kind === "saving"}
          failureKey={
            report.state.kind === "failed"
              ? feedFailureKey(report.state.failure)
              : null
          }
          onSend={(note) => {
            void report.submit({ postId: post.id, note });
          }}
          onClose={() => {
            setReportOpen(false);
          }}
        />
      ) : null}
    </article>
  );
}

/**
 * What a post says, or what happened to it.
 *
 * The cases are written out rather than collapsed, because the struck one is the
 * whole of what moderation does here and this component must not be able to
 * fall into it by accident: a body that was absent for any reason other than a
 * strike-through would read as the board having taken text out of the feed.
 * The other absences are a board post, whose text is its news item's, and the
 * retention clock's, and each says so.
 */
function PostContent({ post }: { post: PostView }): ReactElement {
  const { t } = useTranslation();

  if (post.erasedAt !== null) {
    return <p className="text-body text-ink-muted">{t("feed.erasedText")}</p>;
  }
  if (post.news !== null && post.body === null) {
    return (
      <div className="flex flex-col gap-1">
        <h3 className="text-title">{post.news.title}</h3>
        <p>
          <Link to="/news" className="text-small text-trust underline">
            {t("feed.readNews")}
          </Link>
        </p>
      </div>
    );
  }
  if (post.struckAt === null) {
    return (
      <>
        {post.body === null ? null : <PostText text={post.body} />}
        <PostImages images={post.images} />
      </>
    );
  }
  if (post.body === null) {
    return (
      <p className="text-body text-ink-muted">{t("feed.struckWithheld")}</p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <PostText
        text={post.body}
        className="line-through decoration-line-strong"
      />
      <PostImages images={post.images} />
      <p className={HINT}>{t("feed.struckReadable")}</p>
    </div>
  );
}

/**
 * The images on a post, each a link to itself at full size.
 *
 * Laid out at their own proportions, so a card holds its place while they load
 * and the feed does not jump under the reader's thumb. Served from this
 * instance's own media route, which asks the feed whether this reader may read
 * the post on every request - or, for the board's report queue, whether a
 * report it is answering opens the post to it.
 */
export function PostImages({
  images,
}: {
  images: readonly PostImageView[];
}): ReactElement | null {
  const { t } = useTranslation();
  if (images.length === 0) {
    return null;
  }
  return (
    <ul
      className={`grid gap-2 ${images.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}
    >
      {images.map((image, index) => (
        <li key={image.id}>
          <a href={image.url} target="_blank" rel="noopener noreferrer">
            <img
              src={image.url}
              alt={t("feed.imageAlt", {
                number: index + 1,
                count: images.length,
              })}
              width={image.width ?? undefined}
              height={image.height ?? undefined}
              loading="lazy"
              className="h-auto max-h-96 w-full rounded-control border border-line bg-sunken object-cover"
            />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A sign on the card: in the room, so soft-filled (DESIGN.md). */
function Chip({
  children,
  tone,
}: {
  children: string;
  tone?: "warn";
}): ReactElement {
  return (
    <span
      className={`inline-flex items-center rounded-control px-2 py-1 text-chip uppercase ${
        tone === "warn"
          ? "border-l-4 border-warn bg-warn-soft text-ink"
          : "border border-line text-ink-muted"
      }`}
    >
      {children}
    </span>
  );
}
