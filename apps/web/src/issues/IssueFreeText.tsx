import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import type { OwnIssue } from "../api/issues";
import { localDayOfInstant } from "../bookings/booking-calendar";
import { DATA_TAGS } from "../ui/data-tags";
import { NotRecorded } from "../ui/NotRecorded";
import { Notice } from "../ui/Notice";

/**
 * How an issue's free text reads once some of it is gone (ADR 0057): taken out
 * by a handler, or with the whole free-text layer by the nightly purge after
 * the issue closed or by a granted erasure request. The words for the layer
 * name no cause, because both write the same date.
 *
 * The same words for the reporter and for the handlers. A redacted text is
 * empty on the server, so an empty field here would read as one somebody filed
 * blank; the mark says it was removed and when, and never by whom.
 */

/** "Removed by a handler on 2026-11-03", in place of a redacted text. */
export function RedactedMark({
  at,
  t,
}: {
  at: string;
  /** The document's translator, where the viewer's language is not the reader's. */
  t?: TFunction;
}): ReactElement {
  return (
    <span className="text-small text-ink-muted italic">
      <Trans
        t={t}
        i18nKey="issues.redaction.removedOn"
        values={{ date: localDayOfInstant(at) }}
        components={DATA_TAGS}
      />
    </span>
  );
}

/** "Free text removed on 2026-11-03", in place of a text the layer took with it. */
export function PurgedMark({
  at,
  t,
}: {
  at: string;
  /** The document's translator, where the viewer's language is not the reader's. */
  t?: TFunction;
}): ReactElement {
  return (
    <span className="text-small text-ink-muted italic">
      <Trans
        t={t}
        i18nKey="issues.redaction.purgedOn"
        values={{ date: localDayOfInstant(at) }}
        components={DATA_TAGS}
      />
    </span>
  );
}

/**
 * The description, or what became of it: the purge's notice once the free
 * text is gone, the mark once a handler removed it.
 *
 * The notice says the photographs went too, so it waits for them. A photograph
 * attached while the purge ran stands after the text is marked as removed,
 * until the run that takes it; meanwhile the description says only that the
 * free text was removed, as the location does.
 */
export function IssueDescription({
  issue,
}: {
  issue: Pick<
    OwnIssue,
    "description" | "descriptionRedactedAt" | "freeTextRemovedAt" | "photos"
  >;
}): ReactElement {
  if (issue.freeTextRemovedAt !== null && issue.photos.length > 0) {
    return (
      <p>
        <PurgedMark at={issue.freeTextRemovedAt} />
      </p>
    );
  }
  if (issue.freeTextRemovedAt !== null) {
    return (
      <Notice tone="info">
        <Trans
          i18nKey="issues.redaction.freeTextRemoved"
          values={{ date: localDayOfInstant(issue.freeTextRemovedAt) }}
          components={DATA_TAGS}
        />
      </Notice>
    );
  }
  if (issue.descriptionRedactedAt !== null) {
    return (
      <p>
        <RedactedMark at={issue.descriptionRedactedAt} />
      </p>
    );
  }
  return <p className="text-small whitespace-pre-line">{issue.description}</p>;
}

/**
 * The free-text location, the mark once it was removed by a handler or with
 * the free-text layer, or none recorded. Whether a location was given is not
 * kept once the layer is gone, so the mark there says the free text was
 * removed and claims no location.
 */
export function IssueLocation({
  issue,
}: {
  issue: Pick<
    OwnIssue,
    "location" | "locationRedactedAt" | "freeTextRemovedAt"
  >;
}): ReactElement {
  const { t } = useTranslation();
  if (issue.freeTextRemovedAt !== null && issue.location === null) {
    return <PurgedMark at={issue.freeTextRemovedAt} />;
  }
  if (issue.locationRedactedAt !== null) {
    return <RedactedMark at={issue.locationRedactedAt} />;
  }
  if (issue.location === null) {
    return <NotRecorded meaning={t("issues.mine.noPlace")} />;
  }
  return <>{issue.location}</>;
}

/** A message's or a note's text, or the mark once a handler removed it. */
export function ConversationText({
  body,
  redactedAt,
}: {
  body: string;
  redactedAt: string | null;
}): ReactElement {
  if (redactedAt !== null) {
    return (
      <p>
        <RedactedMark at={redactedAt} />
      </p>
    );
  }
  return <p className="text-small whitespace-pre-line">{body}</p>;
}
