import type { ReactElement } from "react";

/**
 * That a request's month was extended, when it was told, and why.
 *
 * The date is set in the register face like every other date the register
 * shows (DESIGN.md, the Mono-Grid Rule), so the message is the label, the date
 * and the reason as three parts rather than one interpolated sentence. The
 * reason is the board's own free text and keeps the ordinary typography.
 *
 * The label comes translated: the access report writes it in the subject's
 * language and the request list in the reader's, so the caller holds the
 * translator that applies.
 */
export function ExtensionNote({
  label,
  date,
  reason,
}: {
  label: string;
  date: string;
  reason: string;
}): ReactElement {
  return (
    <>
      {label} <span className="font-data">{date}</span>: {reason}
    </>
  );
}
