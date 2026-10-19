import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchOwnBookings } from "../api/bookings";
import { fetchUpcomingOccurrences } from "../api/events";
import { fetchReadableNews } from "../api/news-reader";
import { BookingPeriod } from "../bookings/BookingPeriod";
import {
  formatTimeOfDay,
  localDayOfInstant,
} from "../bookings/booking-calendar";
import { formatEventDay } from "../events/event-calendar";
import { latestNews, nextEvents, upcomingBookings } from "./overview-panels";
import { ITEM_ROW, ReadPanel } from "./ReadPanel";
import { useRead } from "./use-read";

/** The viewer's own bookings still to come. Shown with bookings:book. */
export function BookingsPanel(): ReactElement {
  const { t } = useTranslation();
  const { state, retry } = useRead(fetchOwnBookings);

  return (
    <ReadPanel
      title={t("overview.bookings.title")}
      description={t("overview.bookings.description")}
      read={state}
      failureKey="overview.bookings.loadFailed"
      onRetry={retry}
      more={{ to: "/bookings", label: t("overview.bookings.more") }}
    >
      {(bookings) => {
        const upcoming = upcomingBookings(bookings);
        return upcoming.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("overview.bookings.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {upcoming.map((booking) => (
              <li key={booking.id} className={ITEM_ROW}>
                <span className="text-body font-semibold">
                  {booking.resourceName}
                </span>
                <BookingPeriod booking={booking} />
              </li>
            ))}
          </ul>
        );
      }}
    </ReadPanel>
  );
}

/** The next dates on the association's calendar. Shown with events:attend. */
export function EventsPanel(): ReactElement {
  const { t, i18n } = useTranslation();
  const { state, retry } = useRead(fetchUpcomingOccurrences);

  return (
    <ReadPanel
      title={t("overview.events.title")}
      description={t("overview.events.description")}
      read={state}
      failureKey="overview.events.loadFailed"
      onRetry={retry}
      more={{ to: "/events", label: t("overview.events.more") }}
    >
      {(occurrences) => {
        const next = nextEvents(occurrences);
        return next.length === 0 ? (
          <p className="text-body text-ink-muted">
            {t("overview.events.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {next.map((occurrence) => (
              <li key={occurrence.occurrenceId} className={ITEM_ROW}>
                <span className="text-body font-semibold">
                  {occurrence.title}
                </span>
                <span className="font-data text-data">
                  <time dateTime={occurrence.on}>
                    {formatEventDay(occurrence.on, i18n.language)}
                  </time>{" "}
                  <time dateTime={occurrence.startsAt}>
                    {formatTimeOfDay(occurrence.startsAt, i18n.language)}
                  </time>
                </span>
                {occurrence.location === null ? null : (
                  <span className="text-small text-ink-muted">
                    {occurrence.location}
                  </span>
                )}
                {occurrence.own !== null &&
                occurrence.own.withdrawnAt === null ? (
                  <span className="inline-flex items-center rounded-control border-l-4 border-ok bg-ok-soft px-2 py-1 text-chip text-ink uppercase">
                    {t("events.attend.yours")}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        );
      }}
    </ReadPanel>
  );
}

/** The newest news items. Shown with news:comment. */
export function NewsPanel(): ReactElement {
  const { t } = useTranslation();
  const { state, retry } = useRead(fetchReadableNews);

  return (
    <ReadPanel
      title={t("overview.news.title")}
      description={t("overview.news.description")}
      read={state}
      failureKey="overview.news.loadFailed"
      onRetry={retry}
      more={{ to: "/news", label: t("overview.news.more") }}
    >
      {(articles) => {
        const latest = latestNews(articles);
        return latest.length === 0 ? (
          <p className="text-body text-ink-muted">{t("overview.news.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {latest.map((article) => (
              <li key={article.id} className={ITEM_ROW}>
                <span className="text-body font-semibold">{article.title}</span>
                <time
                  dateTime={article.publishedAt}
                  className="ml-auto font-data text-data text-ink-muted"
                >
                  {localDayOfInstant(article.publishedAt)}
                </time>
              </li>
            ))}
          </ul>
        );
      }}
    </ReadPanel>
  );
}
