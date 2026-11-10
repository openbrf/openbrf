import type { TFunction } from "i18next";
import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import type { IssueHandler } from "../api/issues";

/**
 * A handler as the issue screens name them: the assignee, the handler who
 * entered an issue, the one who acted on its timeline.
 *
 * The three shapes the server answers with. A handler with protected personal
 * data is named to nobody, and the screen says the name is withheld rather
 * than printing nothing, which would read as nobody; one the register no
 * longer holds says so.
 */
export function IssueHandlerName({
  handler,
}: {
  handler: IssueHandler;
}): ReactElement {
  const { t } = useTranslation();
  return <span>{issueHandlerName(handler, t)}</span>;
}

/** The same words as text, for an option in a list. */
export function issueHandlerName(handler: IssueHandler, t: TFunction): string {
  switch (handler.kind) {
    case "person":
      return handler.name;
    case "protected":
      return t("issues.handler.protected");
    case "unknown":
      return t("issues.handler.unknown");
  }
}
