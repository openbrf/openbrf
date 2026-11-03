import {
  MAINTENANCE_RESPONSIBILITIES,
  type MaintenanceResponsibility,
  RESPONSIBILITY_GUIDE_LIMITS,
} from "@openbrf/shared";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { Trans, useTranslation } from "react-i18next";

import {
  fetchResponsibilityGuide,
  type ResponsibilityGuide,
  saveResponsibilityGuide,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import { localDayOfInstant } from "../bookings/booking-calendar";
import { MAINTENANCE_RESPONSIBILITY_LABEL } from "../issues/issue-labels";
import {
  FIELD,
  HINT,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { DATA_TAGS } from "../ui/data-tags";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

const GUIDE_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "personal-identity-number":
    "settings.responsibilityGuide.errors.personalIdentityNumber",
  "part-required": "settings.responsibilityGuide.errors.partRequired",
  "too-many-items": "settings.responsibilityGuide.errors.tooManyItems",
  "text-too-long": "settings.responsibilityGuide.errors.textTooLong",
  "invalid-body": "settings.responsibilityGuide.errors.unknown",
};

/**
 * The example the product ships (decision 27 of the issue module plan): a
 * common division of the upkeep, in the reader's language, to start from and
 * change. Never stored as it stands: the board loads it into the form, and it
 * stays labelled as an example until the board adopts the guide.
 *
 * The division most bylaws take, with the two lines BRL 7 kap. 12 § itself
 * keeps off the tenant-owner - pipes that serve more than one apartment, and
 * ventilation ducts - with the association. Nothing here is a statement about
 * any association's bylaws.
 */
const EXAMPLE: readonly {
  part: TranslationKey;
  responsibility: MaintenanceResponsibility;
}[] = [
  {
    part: "settings.responsibilityGuide.template.surfaces",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.kitchenAndBathroom",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.floorDrain",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.smokeAlarm",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.innerDoors",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.windowsInside",
    responsibility: "TENANT_OWNER",
  },
  {
    part: "settings.responsibilityGuide.template.windowsOutside",
    responsibility: "ASSOCIATION",
  },
  {
    part: "settings.responsibilityGuide.template.sharedPipes",
    responsibility: "ASSOCIATION",
  },
  {
    part: "settings.responsibilityGuide.template.ventilationDucts",
    responsibility: "ASSOCIATION",
  },
  {
    part: "settings.responsibilityGuide.template.radiators",
    responsibility: "ASSOCIATION",
  },
  {
    part: "settings.responsibilityGuide.template.commonAreas",
    responsibility: "ASSOCIATION",
  },
  {
    part: "settings.responsibilityGuide.template.buildingShell",
    responsibility: "ASSOCIATION",
  },
];

/** A line being edited, with a key of its own for the list. */
interface DraftLine {
  key: number;
  part: string;
  responsibility: MaintenanceResponsibility;
  note: string;
}

/**
 * The association's responsibility guide (ansvarsfördelning), as the board
 * writes it from its own bylaws (decision 27).
 *
 * BRL 7 kap. 12 § lets the bylaws move the line between the association's
 * upkeep and the tenant-owner's, so the guide is the board's reading of its
 * own bylaws and never the platform's statement of the law. The panel offers
 * an example to start from and keeps it labelled as one until the board ticks
 * that the table follows its bylaws: only then are residents shown it before
 * they report a fault. The handlers see it either way, with the label.
 *
 * Saved whole, as one act: the server replaces every line, so the order on
 * screen is the order a reader is shown.
 */
export function ResponsibilityGuidePanel(): ReactElement {
  const { t } = useTranslation();
  const [guide, setGuide] = useState<ResponsibilityGuide | "failed" | null>(
    null,
  );
  /** Bumped by every save, so the form opens again on what was saved. */
  const [revision, setRevision] = useState(0);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    void fetchResponsibilityGuide().then((read) => {
      if (active) {
        setGuide(read.ok ? read.value : "failed");
      }
    });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Panel
      title={t("settings.responsibilityGuide.title")}
      description={t("settings.responsibilityGuide.description")}
      notice={
        <>
          <Notice tone="info">
            {t("settings.responsibilityGuide.lawNote")}
          </Notice>
          {saved ? (
            <Notice tone="ok" live>
              {t("settings.responsibilityGuide.saved")}
            </Notice>
          ) : null}
        </>
      }
    >
      {guide === null ? (
        <p role="status" className={HINT}>
          {t("settings.responsibilityGuide.loading")}
        </p>
      ) : guide === "failed" ? (
        <Notice tone="danger" live>
          {t("settings.responsibilityGuide.loadFailed")}
        </Notice>
      ) : (
        <GuideForm
          key={revision}
          guide={guide}
          onEdited={() => {
            setSaved(false);
          }}
          onSaved={(next) => {
            setGuide(next);
            setRevision((count) => count + 1);
            setSaved(true);
          }}
        />
      )}
    </Panel>
  );
}

function GuideForm({
  guide,
  onEdited,
  onSaved,
}: {
  guide: ResponsibilityGuide;
  /** Called on every change to the draft, which clears the last notice. */
  onEdited: () => void;
  onSaved: (guide: ResponsibilityGuide) => void;
}): ReactElement {
  const { t } = useTranslation();
  const nextKey = useRef(guide.items.length);
  const firstField = useRef<HTMLInputElement>(null);
  const [lines, setLines] = useState<DraftLine[]>(() =>
    guide.items.map((item, index) => ({
      key: index,
      part: item.part,
      responsibility: item.responsibility,
      note: item.note ?? "",
    })),
  );
  const [adopted, setAdopted] = useState(guide.adoptedAt !== null);

  const save = useSaveAction(saveResponsibilityGuide, onSaved);
  const saving = save.state.kind === "saving";

  /** Every change to the draft: a refusal was about the draft that was sent. */
  const edited = (): void => {
    onEdited();
    if (save.state.kind === "failed") {
      save.reset();
    }
  };

  const change = (key: number, patch: Partial<DraftLine>): void => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    );
    edited();
  };

  const newKey = (): number => {
    nextKey.current += 1;
    return nextKey.current;
  };

  return (
    <LockedForm
      locked={saving}
      focusFallback={firstField}
      className="flex flex-col gap-4"
      onSend={() => {
        void save.submit({
          items: lines.map((line) => ({
            part: line.part,
            responsibility: line.responsibility,
            note: line.note.trim() === "" ? null : line.note,
          })),
          adopted,
        });
      }}
    >
      {adopted ? null : (
        <p className="text-small font-semibold text-ink">
          {t("settings.responsibilityGuide.example")}
        </p>
      )}

      {lines.length === 0 ? (
        <div className="flex flex-col gap-2">
          <p className={HINT}>{t("settings.responsibilityGuide.empty")}</p>
          <p className={HINT}>
            {t("settings.responsibilityGuide.loadExampleHint")}
          </p>
          <div>
            <button
              type="button"
              className={SECONDARY_BUTTON}
              onClick={() => {
                setLines(
                  EXAMPLE.map((line) => ({
                    key: newKey(),
                    part: t(line.part),
                    responsibility: line.responsibility,
                    note: "",
                  })),
                );
                setAdopted(false);
                edited();
              }}
            >
              {t("settings.responsibilityGuide.loadExample")}
            </button>
          </div>
        </div>
      ) : (
        <ol className="flex flex-col gap-3">
          {lines.map((line, index) => {
            const number = { number: index + 1 };
            return (
              <li
                key={line.key}
                className="grid gap-2 border-b border-line pb-3 sm:grid-cols-[2fr_1fr_2fr_auto] sm:items-end"
              >
                <input
                  ref={index === 0 ? firstField : undefined}
                  type="text"
                  aria-label={t(
                    "settings.responsibilityGuide.partNamed",
                    number,
                  )}
                  value={line.part}
                  maxLength={RESPONSIBILITY_GUIDE_LIMITS.part}
                  required
                  onChange={(event) => {
                    change(line.key, { part: event.target.value });
                  }}
                  className={FIELD}
                />
                <select
                  aria-label={t(
                    "settings.responsibilityGuide.responsibilityNamed",
                    number,
                  )}
                  value={line.responsibility}
                  onChange={(event) => {
                    change(line.key, {
                      responsibility: event.target
                        .value as MaintenanceResponsibility,
                    });
                  }}
                  className={FIELD}
                >
                  {MAINTENANCE_RESPONSIBILITIES.map((value) => (
                    <option key={value} value={value}>
                      {t(MAINTENANCE_RESPONSIBILITY_LABEL[value])}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  aria-label={t(
                    "settings.responsibilityGuide.noteNamed",
                    number,
                  )}
                  value={line.note}
                  maxLength={RESPONSIBILITY_GUIDE_LIMITS.note}
                  onChange={(event) => {
                    change(line.key, { note: event.target.value });
                  }}
                  className={FIELD}
                />
                <button
                  type="button"
                  aria-label={t(
                    "settings.responsibilityGuide.removeNamed",
                    number,
                  )}
                  className={`${QUIET_BUTTON} min-h-11`}
                  onClick={() => {
                    setLines((current) =>
                      current.filter((other) => other.key !== line.key),
                    );
                    edited();
                  }}
                >
                  {t("settings.responsibilityGuide.remove")}
                </button>
              </li>
            );
          })}
        </ol>
      )}

      <div>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={lines.length >= RESPONSIBILITY_GUIDE_LIMITS.items}
          onClick={() => {
            setLines((current) => [
              ...current,
              {
                key: newKey(),
                part: "",
                responsibility: "TENANT_OWNER",
                note: "",
              },
            ]);
            edited();
          }}
        >
          {t("settings.responsibilityGuide.add")}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        <label className="flex min-h-11 items-center gap-2 text-small">
          <input
            type="checkbox"
            checked={adopted}
            onChange={(event) => {
              setAdopted(event.target.checked);
              edited();
            }}
            className="size-4"
          />
          {t("settings.responsibilityGuide.adopted")}
        </label>
        <p className={HINT}>{t("settings.responsibilityGuide.adoptedHint")}</p>
        {guide.adoptedAt === null ? null : (
          <p className={HINT}>
            <Trans
              i18nKey="settings.responsibilityGuide.adoptedOn"
              values={{ date: localDayOfInstant(guide.adoptedAt) }}
              components={DATA_TAGS}
            />
          </p>
        )}
      </div>

      {save.state.kind === "failed" ? (
        <Notice tone="danger" live>
          {t(
            failureMessageKey(
              save.state.failure,
              GUIDE_FAILURES,
              "settings.responsibilityGuide.errors.unknown",
            ),
          )}
        </Notice>
      ) : null}

      <div>
        <button type="submit" className={PRIMARY_BUTTON}>
          {saving
            ? t("settings.responsibilityGuide.saving")
            : t("settings.responsibilityGuide.save")}
        </button>
      </div>
    </LockedForm>
  );
}
