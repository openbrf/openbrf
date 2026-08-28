import { useEffect, useState } from "react";

import { fetchViewer } from "../api/instance";

/** The two logo paths the band needs, both on this instance's own origin. */
export interface BandLogoUrls {
  light: string | null;
  dark: string | null;
}

const NONE: BandLogoUrls = { light: null, dark: null };

/**
 * The housing cooperative's mark, for the band.
 *
 * A hook rather than a prop threaded down from each route, because the band is
 * part of the shell and every screen inside it carries the same mark. It reads
 * the viewer endpoint, which is where the cooperative's identity already
 * travels, and reports no logo on any failure: a band without a mark is the
 * unbranded default, while an error banner over a whole screen because a logo
 * did not load would be a worse answer than the one it replaced.
 */
export function useHousingCooperativeLogo(): BandLogoUrls {
  const [logo, setLogo] = useState<BandLogoUrls>(NONE);

  useEffect(() => {
    let active = true;

    void fetchViewer().then((result) => {
      if (!active || !result.ok) {
        return;
      }
      setLogo({
        light: result.value.housingCooperative?.logoUrl ?? null,
        dark: result.value.housingCooperative?.logoDarkUrl ?? null,
      });
    });

    return () => {
      active = false;
    };
  }, []);

  return logo;
}
