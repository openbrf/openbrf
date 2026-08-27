import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import { ColourLegend } from "./theme/ColourLegend";
import { ThemeModeToggle } from "./theme/ThemeModeToggle";

/**
 * Sample register rows, using the names from the design canvas.
 *
 * Held as data rather than written into the markup. They are values, not
 * interface copy, and the real board will render from a query of exactly this
 * shape.
 */
const SAMPLE_ROWS = [
  { apartment: "1001", name: "Anna Lindqvist", movedIn: "2019-06-01" },
  {
    apartment: "1103",
    name: "Sara Berg",
    movedIn: "2022-11-15",
    isProtected: true,
  },
] as const;

/** A line of register data, shown to prove the monospace grid aligns. */
const SAMPLE_DATA_LINE = ["1001", "2019-06-01", "070-123 45 67"] as const;

/**
 * Temporary theme proof surface.
 *
 * This demonstrates the whole chain end to end - token contract, generated
 * stylesheet, Tailwind mapping, self-hosted faces, and the mode switch - before
 * the application shell is built on top of it. It renders both surface families
 * the design system defines: the light room, and the committed register board.
 *
 * The app shell and its routes replace this in the next stage.
 */
export function App(): ReactElement {
  const { t } = useTranslation();

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-[30px] leading-tight font-bold">
          {t("welcome.title")}
        </h1>
        <p className="text-[15px] text-ink-muted">{t("welcome.tagline")}</p>
      </header>

      <ThemeModeToggle />

      {/*
        The register board. A statutory register renders on its own surface
        family so it reads as a register rather than as another table, and every
        data column uses the monospace face so figures align character for
        character.
      */}
      <section className="overflow-hidden rounded-panel bg-register shadow-raised">
        <div className="grid grid-cols-[84px_1fr_120px] border-b border-register bg-register-raised px-6 py-2.5 text-[11px] font-semibold tracking-[0.12em] text-register-ink-muted uppercase">
          <span>{t("register.column.apartment")}</span>
          <span>{t("register.column.name")}</span>
          <span>{t("register.column.movedIn")}</span>
        </div>
        {SAMPLE_ROWS.map((row) => (
          <div
            key={row.apartment + row.name}
            className="grid grid-cols-[84px_1fr_120px] items-center border-b border-register px-6 py-2.5 text-[15px] text-register-ink"
          >
            <span className="font-data text-[14px]">{row.apartment}</span>
            <span className="flex items-center gap-2 font-medium">
              {row.name}
              {"isProtected" in row && row.isProtected ? (
                <span className="rounded-control border border-warn-register px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em] text-warn-register uppercase">
                  {t("legend.warn")}
                </span>
              ) : null}
            </span>
            <span className="font-data text-[13px]">{row.movedIn}</span>
          </div>
        ))}
        <div className="bg-register-raised px-6 py-2.5">
          <ColourLegend />
        </div>
      </section>

      {/*
        The room: everyday surfaces sit on light panels, not on the board. The
        line below is in the data face, which is what keeps register columns
        aligned character for character.
      */}
      <section className="rounded-panel border border-line bg-raised p-6 shadow-raised">
        <p className="font-data text-[13px] text-ink-muted">
          {SAMPLE_DATA_LINE.join(" · ")}
        </p>
      </section>
    </main>
  );
}
