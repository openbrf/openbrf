import { type ReactElement, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  fetchIssueApartments,
  fetchIssueResidents,
  type IssueApartment,
  type IssueResidentChoice,
} from "../api/issues";
import { FIELD, FIELD_DATA, HINT, LABEL, QUIET_BUTTON } from "../ui/controls";
import { Notice } from "../ui/Notice";

/** The apartment and the residency a handler has picked; "" for none. */
export interface ResidentPick {
  apartmentId: string;
  residencyId: string;
}

/**
 * One answered read of an apartment's residents, with the attempt it answered:
 * a read not yet answered for the apartment and attempt on screen is loading.
 */
type ResidentsRead = { apartmentId: string; attempt: number } & (
  { kind: "loaded"; residents: IssueResidentChoice[] } | { kind: "failed" }
);

/**
 * The resident picker on an issue a handler opens (decision 14, ADR 0054):
 * the apartment first, then who lives there today.
 *
 * Every handler gets it, the property manager included, because it is not the
 * address book: there is no search, nobody who has moved out or not yet in,
 * and a protected resident is shown as protected, never by name. The residents
 * of an apartment are read only once one is chosen, because that read is the
 * one the server records.
 *
 * Only the newest read of residents is shown: one for an apartment the handler
 * has since moved off is dropped when it lands, so a slow answer cannot put
 * another apartment's residents under this one.
 */
export function IssueResidentPicker({
  pick,
  onPick,
}: {
  pick: ResidentPick;
  onPick: (next: ResidentPick) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [apartments, setApartments] = useState<
    IssueApartment[] | "loading" | "failed"
  >("loading");
  const [read, setRead] = useState<ResidentsRead | null>(null);
  const [attempt, setAttempt] = useState(0);
  const newest = useRef(0);

  useEffect(() => {
    let live = true;
    void fetchIssueApartments().then((answer) => {
      if (live) {
        setApartments(answer.ok ? answer.value : "failed");
      }
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const version = ++newest.current;
    const apartmentId = pick.apartmentId;
    if (apartmentId === "") {
      return;
    }
    void fetchIssueResidents(apartmentId).then((answer) => {
      if (version !== newest.current) {
        return;
      }
      setRead(
        answer.ok
          ? { apartmentId, attempt, kind: "loaded", residents: answer.value }
          : { apartmentId, attempt, kind: "failed" },
      );
    });
  }, [pick.apartmentId, attempt]);

  // Only the answer to this apartment and attempt: anything else is loading.
  const current =
    read !== null &&
    read.apartmentId === pick.apartmentId &&
    read.attempt === attempt
      ? read
      : null;
  const residents = current?.kind === "loaded" ? current.residents : [];
  const protectedCount = residents.filter(
    (resident) => resident.kind === "protected",
  ).length;

  const label = (resident: IssueResidentChoice, index: number): string => {
    if (resident.kind === "person") {
      return resident.name;
    }
    // Numbered only where there is more than one, so two can be told apart.
    return protectedCount > 1
      ? t("issues.open.residentProtectedNumbered", {
          number: residents
            .slice(0, index + 1)
            .filter((entry) => entry.kind === "protected").length,
        })
      : t("issues.open.residentProtected");
  };

  if (apartments === "failed") {
    return (
      <Notice tone="warn" live>
        {t("issues.open.apartmentsFailed")}
      </Notice>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={LABEL}>
          {t("issues.open.apartment")}
          <select
            value={pick.apartmentId}
            disabled={apartments === "loading"}
            onChange={(event) => {
              // A new attempt, so an earlier answer for the same apartment,
              // chosen again, is not shown as this one's.
              setAttempt((count) => count + 1);
              onPick({ apartmentId: event.target.value, residencyId: "" });
            }}
            className={FIELD_DATA}
          >
            <option value="">{t("issues.open.apartmentNone")}</option>
            {apartments === "loading"
              ? null
              : apartments.map((apartment) => (
                  <option key={apartment.id} value={apartment.id}>
                    {`${apartment.address} ${apartment.number}`}
                  </option>
                ))}
          </select>
        </label>

        {pick.apartmentId === "" ? null : (
          <label className={LABEL}>
            {t("issues.open.resident")}
            <select
              value={pick.residencyId}
              disabled={current?.kind !== "loaded" || residents.length === 0}
              onChange={(event) => {
                onPick({
                  apartmentId: pick.apartmentId,
                  residencyId: event.target.value,
                });
              }}
              className={FIELD}
            >
              <option value="">{t("issues.open.residentNone")}</option>
              {residents.map((resident, index) => (
                <option key={resident.residencyId} value={resident.residencyId}>
                  {label(resident, index)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {pick.apartmentId === "" ? null : current === null ? (
        <p role="status" className={HINT}>
          {t("issues.open.residentsLoading")}
        </p>
      ) : current.kind === "failed" ? (
        <Notice tone="warn" live>
          {t("issues.open.residentsFailed")}{" "}
          <button
            type="button"
            className={QUIET_BUTTON}
            onClick={() => {
              setAttempt((count) => count + 1);
            }}
          >
            {t("issues.open.residentsRetry")}
          </button>
        </Notice>
      ) : residents.length === 0 ? (
        <p className={HINT}>{t("issues.open.residentsEmpty")}</p>
      ) : null}
    </div>
  );
}
