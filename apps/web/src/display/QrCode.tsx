import type { ReactElement } from "react";
import { encode } from "uqr";

/**
 * A QR code of a text, drawn as an SVG of the modules the encoder sets.
 *
 * Drawn here from the module grid rather than taken as markup from the
 * encoder, so nothing is put into the page as HTML. Dark modules on a light
 * ground in both colour modes, with the quiet zone the standard asks for: a
 * phone's camera reads a light-on-dark code less reliably, and the code is
 * there to be read off this screen.
 */
export function QrCode({
  text,
  label,
}: {
  text: string;
  /** What the code holds, for a reader that cannot see it. */
  label: string;
}): ReactElement {
  const { data, size } = encode(text, { ecc: "M", border: 4 });
  const cells: string[] = [];
  for (const [y, row] of data.entries()) {
    for (const [x, dark] of row.entries()) {
      if (dark) {
        cells.push(`M${String(x)} ${String(y)}h1v1h-1z`);
      }
    }
  }
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      className="size-56 rounded-control"
    >
      <rect width={size} height={size} fill="#ffffff" />
      <path d={cells.join("")} fill="#000000" />
    </svg>
  );
}
