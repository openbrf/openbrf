import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { Viewer } from "../api/instance";
import { fetchReadableNews, type NewsArticle } from "../api/news-reader";
import { HINT } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { NewsBody } from "./NewsBody";
import { NewsThread } from "./NewsThread";

export interface NewsScreenProps {
  viewer: Viewer;
}

/** Everything one load produces, applied to the screen in one step. */
interface Loaded {
  ready: boolean;
  articles: readonly NewsArticle[];
  loadFailed: boolean;
}

const EMPTY: Loaded = { ready: false, articles: [], loadFailed: false };

/**
 * The association's news, as the people who live in the house read it, and the
 * thread under whichever notice is open.
 *
 * `news:comment` is what this screen answers to, and it is a resident's rather
 * than a member's. Membership adds exactly one capability in this platform and it
 * is `motions:submit`, because putting an item to a general meeting is a right
 * EFL 6 kap. 15 § gives to a member. Answering a notice is nothing of the kind: a
 * partner, an adult child and a tenant all live in the house the notice is about,
 * and the board reaches them with it. So there is no member/resident split on
 * this screen at all, and the only capability that changes what is on it is the
 * board's own `site:manage`, which adds the strike-through control to each
 * comment.
 *
 * Reading the news needs no account on the association's website, and this screen
 * is not that. It exists because the thread does: a comment is never rendered on
 * the website - those pages read no session at all - so the notice has to be
 * readable in the one place the answers to it can be.
 *
 * ## Which notice is open
 *
 * The newest, until the reader opens another, and derived from the list rather
 * than stored beside it. A stored copy of the open notice would be a second
 * answer to what is on screen, and the one that went stale would be the one being
 * rendered. Nothing on this screen changes the list, so it is read once: the
 * thread is the part that changes, and the panel underneath owns every read of
 * it.
 */
export function NewsScreen({ viewer }: NewsScreenProps): ReactElement {
  const { t } = useTranslation();

  const canComment = viewer.capabilities.includes("news:comment");
  const canModerate = viewer.capabilities.includes("site:manage");

  const [loaded, setLoaded] = useState<Loaded>(EMPTY);
  const [opened, setOpened] = useState<string | null>(null);

  useEffect(() => {
    if (!canComment) {
      /*
       * Nothing is asked for on behalf of an account the endpoint will refuse.
       * The refusal would be correct and the notice on screen would be the wrong
       * one: "the news could not be read just now, reload the page" is advice for
       * a request that failed, and this one would fail again every time. What
       * such an account is told instead is decided during the render below.
       */
      return;
    }

    let active = true;
    void fetchReadableNews().then((result) => {
      if (!active) {
        return;
      }
      setLoaded({
        ready: true,
        articles: result.ok ? result.value : [],
        loadFailed: !result.ok,
      });
    });
    return () => {
      active = false;
    };
  }, [canComment]);

  const { articles, loadFailed } = loaded;
  /*
   * Derived rather than stored, because for one of the two cases there is
   * nothing to wait for: an account that is not offered the thread asks for
   * nothing, so a loading line would be a promise that something is coming.
   */
  const ready = !canComment || loaded.ready;
  const article = articles.find((one) => one.id === opened) ?? articles[0];

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-display">{t("newsReader.title")}</h1>
        <p className="text-body text-ink-muted">{t("newsReader.intro")}</p>
      </header>

      {loadFailed ? (
        <Notice tone="danger" live>
          {t("newsReader.loadFailed")}
        </Notice>
      ) : null}

      {canComment ? null : (
        <Notice tone="info">{t("newsReader.notOffered")}</Notice>
      )}

      {ready ? null : (
        <p role="status" className="text-body text-ink-muted">
          {t("newsReader.loading")}
        </p>
      )}

      {ready && canComment && !loadFailed ? (
        articles.length === 0 ? (
          <Notice tone="info">{t("newsReader.empty")}</Notice>
        ) : (
          <>
            <Panel
              title={t("newsReader.list.title")}
              description={t("newsReader.list.description")}
            >
              <ul className="flex flex-col gap-2">
                {articles.map((one) => (
                  <li key={one.id}>
                    <NoticeButton
                      article={one}
                      open={one.id === article?.id}
                      onOpen={() => {
                        setOpened(one.id);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </Panel>

            {article === undefined ? null : (
              <>
                <Panel
                  title={article.title}
                  description={t("newsReader.article.publishedOn", {
                    date: article.publishedAt.slice(0, 10),
                  })}
                >
                  <NewsBody content={article.content} />
                  {/* Where the same notice sits on the association's website, so
                      a reader who wants to send it to somebody without an
                      account has the address. The thread is not there. */}
                  <p className={HINT}>
                    {t("newsReader.article.address", { slug: article.slug })}
                  </p>
                </Panel>

                {/*
                 * Keyed on the notice, so opening another one is a new thread
                 * rather than the same panel handed different comments. What
                 * that resets is the half-written comment: text meant as an
                 * answer to one notice must not follow the reader to the next,
                 * where pressing send would put it under something else.
                 */}
                <NewsThread
                  key={article.id}
                  newsId={article.id}
                  canModerate={canModerate}
                />
              </>
            )}
          </>
        )
      ) : null}
    </div>
  );
}

/**
 * One notice in the list, as a control.
 *
 * `aria-pressed` rather than a link, because opening one changes what the rest of
 * this screen is showing rather than navigating anywhere: the address bar is not
 * part of the state, and a link that went nowhere would be announced as one.
 */
function NoticeButton({
  article,
  open,
  onOpen,
}: {
  article: NewsArticle;
  open: boolean;
  onOpen: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const published = article.publishedAt.slice(0, 10);

  return (
    <button
      type="button"
      aria-pressed={open}
      aria-label={t("newsReader.list.open", {
        title: article.title,
        date: published,
      })}
      onClick={onOpen}
      className={[
        "flex min-h-11 w-full flex-wrap items-center gap-3 rounded-control",
        "border px-3 py-2 text-left transition-colors duration-150 ease-out",
        open
          ? "border-ink bg-raised text-ink"
          : "border-line bg-page text-ink hover:border-ink",
      ].join(" ")}
    >
      <span className="text-body font-semibold">{article.title}</span>
      <span className="ml-auto font-data text-data text-ink-muted">
        <time dateTime={article.publishedAt}>{published}</time>
      </span>
    </button>
  );
}
