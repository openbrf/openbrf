import type { ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { HINT, PRIMARY_BUTTON, SECONDARY_BUTTON } from "../ui/controls";
import { Dialog } from "../ui/Dialog";
import { Notice } from "../ui/Notice";
import type { TranslationKey } from "../i18n/translation-key";

/**
 * The board striking a post or a comment in Alla through, asked once more
 * before it happens.
 *
 * A question rather than a single press, because a strike cannot be taken back:
 * nothing clears it, by design. What the dialog says is what striking does -
 * the text is withheld from the house, its writer and the board still read it,
 * and nothing is erased.
 */
export function StrikeDialog({
  subject,
  author,
  striking,
  failureKey,
  onStrike,
  onClose,
}: {
  subject: "post" | "comment";
  /** Who wrote it, as one string, for the heading. */
  author: string;
  striking: boolean;
  /** The refusal of the last attempt, shown inside the dialog it belongs to. */
  failureKey: TranslationKey | null;
  onStrike: () => void;
  onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <Dialog
      title={
        subject === "post"
          ? t("feed.strike.postTitle", { author })
          : t("feed.strike.commentTitle", { author })
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className={SECONDARY_BUTTON} onClick={onClose}>
            {t("feed.strike.cancel")}
          </button>
          <button
            type="button"
            className={PRIMARY_BUTTON}
            disabled={striking}
            onClick={onStrike}
          >
            {striking ? t("feed.strike.striking") : t("feed.strike.confirm")}
          </button>
        </>
      }
    >
      {failureKey === null ? null : (
        <Notice tone="danger" live>
          {t(failureKey)}
        </Notice>
      )}
      <p className={HINT}>{t("feed.strike.hint")}</p>
    </Dialog>
  );
}
