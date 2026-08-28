import { type ReactElement, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

/**
 * The reference plugin's view.
 *
 * Exposed as `./View` through Module Federation and loaded by the browser from
 * the host's own origin, so nothing here is bundled into the application. Two
 * rules make it a view the host can render rather than a page that happens to
 * work: every user-visible string is a key in the plugin's own i18n namespace,
 * and every colour, radius and type size resolves through a design token, so a
 * theme restyles this view along with the rest of the interface.
 */

/** What GET /summary answers. Mirrors the route declared in src/server.ts. */
interface OccupancySummary {
  heading: string;
  summary: { apartments: number; residents: number; members: number };
  grouping: string;
  showMembers: boolean;
  limit: number;
}

type ViewState =
  | { status: "loading" }
  | { status: "failed" }
  | { status: "ready"; data: OccupancySummary };

const SUMMARY_URL = "/api/plugin/occupancy/summary";

function Figure({
  label,
  value,
}: {
  label: string;
  value: number;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-small text-ink-muted">{label}</span>
      <span className="font-data text-title">{value}</span>
    </div>
  );
}

export default function OccupancyView(): ReactElement {
  const { t } = useTranslation("plugin-occupancy");
  const [state, setState] = useState<ViewState>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();

    const load = async (): Promise<void> => {
      try {
        // Same origin, so the host's session cookie travels with the request
        // and the plugin never handles a credential of its own.
        const response = await fetch(SUMMARY_URL, {
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(String(response.status));
        }
        const data = (await response.json()) as OccupancySummary;
        setState({ status: "ready", data });
      } catch {
        if (!controller.signal.aborted) {
          setState({ status: "failed" });
        }
      }
    };

    void load();
    return () => {
      controller.abort();
    };
  }, []);

  return (
    <section className="flex flex-col gap-4 rounded-panel border border-line bg-raised p-5 text-ink shadow-raised">
      <h2 className="text-title">
        {state.status === "ready" ? state.data.heading : t("view.title")}
      </h2>

      {state.status === "loading" ? (
        <p className="text-small text-ink-muted">{t("view.loading")}</p>
      ) : null}

      {state.status === "failed" ? (
        <p role="alert" className="text-small text-danger">
          {t("view.error")}
        </p>
      ) : null}

      {state.status === "ready" ? (
        <>
          <div className="flex flex-wrap gap-6">
            <Figure
              label={t("view.apartments")}
              value={state.data.summary.apartments}
            />
            <Figure
              label={t("view.residents")}
              value={state.data.summary.residents}
            />
            {state.data.showMembers ? (
              <Figure
                label={t("view.members")}
                value={state.data.summary.members}
              />
            ) : null}
          </div>

          <footer className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line pt-3 text-small text-ink-muted">
            <span>
              {t("view.grouping", {
                label: t(`settings.grouping.${state.data.grouping}`),
              })}
            </span>
            <span>{t("view.rowLimit", { rows: state.data.limit })}</span>
          </footer>
        </>
      ) : null}
    </section>
  );
}
