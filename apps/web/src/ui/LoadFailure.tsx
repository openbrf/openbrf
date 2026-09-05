import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { SECONDARY_BUTTON } from "./controls";
import { Notice } from "./Notice";

/**
 * A read that failed, and the way out of it.
 *
 * A screen whose first read fails has nothing on it: no list, and none of the
 * controls that would have let anybody act. Every screen said so and then told
 * the reader to reload the page, which is a browser action for what is usually
 * a moment's trouble on one request - and it throws away the sign-in, the route
 * and any panel that was open on the way. The address book already offered a
 * button instead; this is that shape, in one place, for the screens that did
 * not.
 *
 * The retry calls the screen's own read rather than reloading anything. Which
 * read that is belongs to the screen: several of them fetch more than one thing
 * and answer as a whole, and a control here that guessed would repeat the wrong
 * request.
 *
 * `live` is deliberately off. This notice is on screen before a reader reaches
 * it, which is the standing case the tone rule reserves for a quiet notice, and
 * a screen reader announcing "could not be read" over whatever the reader was
 * doing would be reporting an event that had already happened.
 */
export function LoadFailure({
  messageKey,
  onRetry,
}: {
  /** The sentence this screen uses for its own failed read. */
  messageKey: TranslationKey;
  /** The screen's read, run again. */
  onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <Notice tone="danger">
      {/*
        A span rather than a div: Notice renders its children inside one, and a
        div there is markup no parser is obliged to keep in the shape it was
        written in. Flex applies to a span as readily.
      */}
      <span className="flex flex-wrap items-center gap-3">
        <span>{t(messageKey)}</span>
        <button type="button" onClick={onRetry} className={SECONDARY_BUTTON}>
          {t("app.retry")}
        </button>
      </span>
    </Notice>
  );
}
