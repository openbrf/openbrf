import { useId, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { ApiFailure } from "../api/client";
import type { TranslationKey } from "../i18n/translation-key";
import { PRIMARY_BUTTON, QUIET_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import {
  dismissNewsMailingRequest,
  type NewsDeliveryReport,
  type NewsItem,
  type NewsRecipients,
  type NewsVisibility,
  publishNews,
  removeNews,
} from "./news-api";

/**
 * One news item, with everything the board can do to it.
 *
 * Publication is one decision here, not two: the board says whether the item is
 * on the website and who it is for in the same act, because a news item is
 * published once to the people it was written for rather than carrying a
 * standing audience that gets revisited.
 *
 * Each mailing is offered exactly once. Once the instance has claimed one -
 * which the item reports as a date - that checkbox is gone and a sentence
 * stands in its place, because there is no second mailing to ask for: the
 * server writes that column once and never clears it, so an edit and a
 * republish cannot put the announcement in anybody's mailbox again.
 *
 * The two channels are offered separately and answered separately. The email
 * is on by default because it costs nothing and reaches everyone in the
 * register; the text message is off, because it is billed per member and
 * reaches only those who have given the association a number. An instance with
 * no SMS provider is told so where the toggle would be, rather than being
 * offered a switch that cannot work.
 *
 * A mailing something else asked for is a notice above those controls and
 * nothing more. Answering it is the publish the board already does, with the
 * checkbox where it already stands: a second way to send would be a second
 * path to the one act that cannot be taken back, and it would not be the path
 * the server claims the mailing on.
 */

const PUBLISH_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-found": "news.errors.notFound",
  "personal-identity-number": "news.errors.personalIdentityNumber",
};

const REMOVE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "not-found": "news.errors.notFound",
};

/**
 * The sentence each refusal of a mailing request gets.
 *
 * The API answers with a code and the browser chooses the words, the same
 * split every other table here keeps: the API is English throughout, so
 * anything it phrased would arrive in English on a screen that is Swedish by
 * default. The table cannot be total - the server may answer with a code this
 * build has never heard of - so an unrecognised one falls back to the general
 * sentence rather than being printed. A board member has nothing to do with
 * "already-mailed".
 */
const MAILING_REQUEST_FAILURES: Readonly<Record<string, TranslationKey>> = {
  /*
   * Its own sentence rather than the label beside a mailed item. That label
   * names the day the mailing went out, and in this path the browser holds no
   * day - the refusal says only that one has - so it would render with an
   * empty gap where the date belongs. This answers the question that was asked.
   */
  "already-mailed": "siteAdmin.news.mailingRequest.alreadyMailed",
  "not-found": "news.errors.notFound",
};

/** A refused call, with the table and the general sentence it answers by. */
interface Refusal {
  failure: ApiFailure;
  reasons: Readonly<Record<string, TranslationKey>>;
  fallback: TranslationKey;
}

export interface NewsItemPanelProps {
  item: NewsItem;
  /** Who a mailing would reach right now, per channel. Null while unread. */
  recipients: NewsRecipients | null;
  onEdit: (item: NewsItem) => void;
  onChanged: () => void;
}

export function NewsItemPanel({
  item,
  recipients,
  onEdit,
  onChanged,
}: NewsItemPanelProps): ReactElement {
  const { t, i18n } = useTranslation();
  const audienceName = useId();

  const [visibility, setVisibility] = useState<NewsVisibility>(item.visibility);
  /*
   * The mailing is offered only while one is still possible, and it defaults
   * to on: the decision log says the board mails the members when it publishes,
   * and the toggle is there to say otherwise rather than to have to remember.
   */
  const mailable = item.emailQueuedAt === null;
  const [sendEmail, setSendEmail] = useState(true);
  /*
   * The SMS mailing is offered on the same terms and defaults the other way.
   * It is billed per member and reaches only the members who gave a number, so
   * it is a decision the board makes rather than one it has to remember to
   * undo.
   */
  const textable = item.smsQueuedAt === null;
  const smsConfigured = recipients?.sms.configured ?? false;
  const [sendSms, setSendSms] = useState(false);
  const [outcome, setOutcome] = useState<TranslationKey | null>(null);
  const [reachedTo, setReachedTo] = useState<number | null>(null);

  const publication = useSaveAction(publishNews, (published) => {
    /*
     * One sentence, and the mailing it names is whichever was claimed.
     *
     * A publish can claim both, and the counts differ - everyone with an
     * address, and the smaller set with a number. Rather than run two
     * confirmations together, the email count is reported where there is one,
     * because it is the mailing that reaches the whole membership; the SMS
     * count stands alone only when the text message was the mailing claimed.
     */
    setReachedTo(published.mailedTo ?? published.textedTo);
    setOutcome(
      published.published
        ? published.mailedTo !== null
          ? "news.item.publishedAndMailed"
          : published.textedTo !== null
            ? "news.item.publishedAndTexted"
            : "news.item.published"
        : "news.item.unpublished",
    );
    onChanged();
  });

  const removal = useSaveAction(removeNews, () => {
    onChanged();
  });

  /*
   * The board's answer, held until the re-read carries it.
   *
   * The notice has to go the moment the board answers it - one that stayed up
   * until the read landed would read as a request nobody had dealt with, and
   * invite a second press. The answer is dropped again as soon as the item
   * says something other than what it said when the answer was given, so a
   * second request placed after this one was dismissed is shown rather than
   * hidden by the answer to the first.
   */
  const [dismissed, setDismissed] = useState(false);
  const [requestAsRead, setRequestAsRead] = useState(item.mailingRequested);
  if (requestAsRead !== item.mailingRequested) {
    setRequestAsRead(item.mailingRequested);
    setDismissed(false);
  }

  const dismissal = useSaveAction(dismissNewsMailingRequest, () => {
    setDismissed(true);
    setOutcome("siteAdmin.news.mailingRequest.dismissed");
    onChanged();
  });

  /**
   * Clears what the other controls left behind, before a new one starts.
   *
   * The panel shows one sentence, chosen from the three save states in a fixed
   * order, so a failure that is still sitting in one of them is not merely
   * stale - it decides what the board reads about a different act. A
   * publication that failed earlier would stand beside a dismissal that
   * succeeded, and would hide one that failed. Only one of these is ever in
   * flight, so the one starting owns the answer.
   */
  const startAlone = (current: { reset: () => void }): void => {
    for (const action of [publication, removal, dismissal]) {
      if (action !== current) {
        action.reset();
      }
    }
    setOutcome(null);
  };

  const refusal: Refusal | null =
    publication.state.kind === "failed"
      ? {
          failure: publication.state.failure,
          reasons: PUBLISH_FAILURES,
          fallback: "news.errors.unknown",
        }
      : removal.state.kind === "failed"
        ? {
            failure: removal.state.failure,
            reasons: REMOVE_FAILURES,
            fallback: "news.errors.unknown",
          }
        : dismissal.state.kind === "failed"
          ? {
              failure: dismissal.state.failure,
              reasons: MAILING_REQUEST_FAILURES,
              fallback: "siteAdmin.news.mailingRequest.failed",
            }
          : null;

  const busy =
    publication.state.kind === "saving" ||
    removal.state.kind === "saving" ||
    dismissal.state.kind === "saving";

  return (
    <article className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 shadow-raised">
      <header className="flex flex-col gap-1">
        <p className="text-chip text-ink-muted uppercase">
          {item.published
            ? t(
                item.visibility === "PUBLIC"
                  ? "news.item.publishedPublic"
                  : "news.item.publishedMember",
              )
            : t("news.item.draft")}
        </p>
        <h3 className="text-title">{item.title}</h3>
        <p className="font-data text-small text-ink-muted">
          {t("news.item.address", { slug: item.slug })}
        </p>
        {item.publishedAt === null ? null : (
          <p className="font-data text-small text-ink-muted">
            {t("news.item.publishedOn", {
              date: formatDate(item.publishedAt, i18n.language),
            })}
          </p>
        )}
      </header>

      {item.mailingRequested && !dismissed ? (
        /* The sentence says that something asked and never which person did.
           Who asked is in the audit log; putting a name here would turn the
           board's question - should this go out - into a question about the
           requester, and the wire shape carries no person for it to name. */
        <Notice tone="warn">
          <span className="flex flex-col items-start gap-2">
            {t("siteAdmin.news.mailingRequest.notice")}
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                startAlone(dismissal);
                void dismissal.submit(item.id);
              }}
              className={SECONDARY_BUTTON}
            >
              {t("siteAdmin.news.mailingRequest.dismiss")}
            </button>
          </span>
        </Notice>
      ) : null}

      <fieldset className="flex flex-col gap-2">
        <legend className="text-label text-ink-muted uppercase">
          {t("news.item.audience")}
        </legend>
        <div className="flex flex-wrap gap-4">
          {(["MEMBER", "PUBLIC"] as const).map((candidate) => (
            <label
              key={candidate}
              className="flex min-h-11 items-center gap-2 text-small text-ink"
            >
              <input
                type="radio"
                name={`${audienceName}-${item.id}`}
                value={candidate}
                checked={visibility === candidate}
                onChange={() => {
                  setVisibility(candidate);
                }}
                className="size-4 accent-trust"
              />
              {t(
                candidate === "PUBLIC"
                  ? "news.item.audiencePublic"
                  : "news.item.audienceMember",
              )}
            </label>
          ))}
        </div>
      </fieldset>

      {mailable ? (
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 items-center gap-2 text-small text-ink">
            <input
              type="checkbox"
              checked={sendEmail}
              onChange={(event) => {
                setSendEmail(event.target.checked);
              }}
              className="size-4 accent-trust"
            />
            {recipients === null
              ? t("news.item.sendEmailUnknown")
              : t("news.item.sendEmail", { count: recipients.count })}
          </label>
          <p className="text-small text-ink-muted">
            {t("news.item.sendEmailHint")}
          </p>
        </div>
      ) : (
        <p className="font-data text-small text-ink-muted">
          {t("news.item.alreadyMailed", {
            date: formatDate(item.emailQueuedAt ?? "", i18n.language),
          })}
        </p>
      )}

      {!textable ? (
        <p className="font-data text-small text-ink-muted">
          {t("news.item.alreadyTexted", {
            date: formatDate(item.smsQueuedAt ?? "", i18n.language),
          })}
        </p>
      ) : recipients === null || smsConfigured ? (
        /* Offered while the count is still unknown as well. Whether this
           instance has a provider is not known until the read lands, and
           saying it has none would be a claim nobody has checked - the same
           honesty the email side keeps with its own unknown label. */
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 items-center gap-2 text-small text-ink">
            <input
              type="checkbox"
              checked={sendSms}
              onChange={(event) => {
                setSendSms(event.target.checked);
              }}
              className="size-4 accent-trust"
            />
            {recipients === null
              ? t("news.item.sendSmsUnknown")
              : t("news.item.sendSms", { count: recipients.sms.count })}
          </label>
          <p className="text-small text-ink-muted">
            {t("news.item.sendSmsHint")}
          </p>
        </div>
      ) : (
        /* Said plainly rather than hidden, and only once it is known. A board
           that expected to be able to text its members has to learn that this
           instance cannot, and where to go about it - not find the option
           quietly absent. */
        <p className="text-small text-ink-muted">
          {t("news.item.sendSmsUnavailable")}
        </p>
      )}

      {item.emailQueuedAt === null ? null : (
        <DeliverySection
          heading={t("news.delivery.heading")}
          report={item.delivery.email}
          notConfiguredNotice={t("news.delivery.mailNotConfigured")}
        />
      )}

      {item.smsQueuedAt === null ? null : (
        <DeliverySection
          heading={t("news.delivery.smsHeading")}
          report={item.delivery.sms}
          notConfiguredNotice={t("news.delivery.smsNotConfigured")}
        />
      )}

      {outcome === null ? null : (
        <Notice tone="ok" live>
          {t(outcome, { count: reachedTo ?? 0 })}
        </Notice>
      )}

      {refusal === null ? null : (
        <Notice tone="danger" live>
          {/* The date is what the "already mailed" sentence names. The
              sentences that do not name it ignore the value. */}
          {t(
            failureMessageKey(
              refusal.failure,
              refusal.reasons,
              refusal.fallback,
            ),
            { date: formatDate(item.emailQueuedAt ?? "", i18n.language) },
          )}
        </Notice>
      )}

      <footer className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            startAlone(publication);
            void publication.submit(item.id, {
              published: true,
              visibility,
              ...(mailable ? { sendEmail } : {}),
              ...(textable && smsConfigured ? { sendSms } : {}),
            });
          }}
          className={PRIMARY_BUTTON}
        >
          {publication.state.kind === "saving"
            ? t("news.item.publishing")
            : t("news.item.publish")}
        </button>

        <button
          type="button"
          onClick={() => {
            onEdit(item);
          }}
          className={SECONDARY_BUTTON}
        >
          {t("news.item.edit")}
        </button>

        {item.published ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              startAlone(publication);
              void publication.submit(item.id, { published: false });
            }}
            className={QUIET_BUTTON}
          >
            {publication.state.kind === "saving"
              ? t("news.item.unpublishing")
              : t("news.item.unpublish")}
          </button>
        ) : null}

        <button
          type="button"
          disabled={busy}
          onClick={() => {
            // Confirmed because the item leaves the website with the row, and
            // nothing here puts a removed news item back.
            if (
              window.confirm(
                t("news.item.removeConfirm", { title: item.title }),
              )
            ) {
              startAlone(removal);
              void removal.submit(item.id);
            }
          }}
          className={QUIET_BUTTON}
        >
          {removal.state.kind === "saving"
            ? t("news.item.removing")
            : t("news.item.remove")}
        </button>
      </footer>
    </article>
  );
}

/**
 * One channel's delivery report.
 *
 * The same three counts either way, because they mean the same thing on both:
 * claimed and not yet handed over, accepted by a provider, and failed. Only the
 * heading and the notice differ, and the notice is the whole of what a board
 * needs to tell the two apart - which of the two did not go out.
 */
function DeliverySection({
  heading,
  report,
  notConfiguredNotice,
}: {
  heading: string;
  report: NewsDeliveryReport;
  notConfiguredNotice: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-label text-ink-muted uppercase">{heading}</h4>
      <p className="font-data text-small text-ink">
        {[
          t("news.delivery.sent", { count: report.sent }),
          t("news.delivery.pending", { count: report.pending }),
          t("news.delivery.failed", { count: report.failed }),
        ].join("  ")}
      </p>
      {report.notConfigured ? (
        <Notice tone="warn">{notConfiguredNotice}</Notice>
      ) : null}
    </section>
  );
}

/**
 * A stored instant as a calendar date in the reader's own language.
 *
 * The date and not the time, exactly as the website prints it: when a notice
 * went up is information the board uses, and the minute it went up is not.
 */
function formatDate(iso: string, locale: string): string {
  const value = new Date(iso);
  return Number.isNaN(value.getTime())
    ? iso
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: "Europe/Stockholm",
      }).format(value);
}
