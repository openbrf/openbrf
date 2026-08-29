import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";

import {
  attachIssuePhoto,
  type IssueApartment,
  type ReportableIssueType,
  reportIssue,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";

/**
 * What the file picker offers.
 *
 * A courtesy, not a control: the API identifies a file from its own bytes and
 * refuses anything else, because an accept attribute is a hint to a dialog and
 * a request can be made without one.
 */
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Matches the server's cap, so the form stops before the API has to. */
const MAX_PHOTOS = 6;

const REPORT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-not-found": "issues.report.errors.typeNotFound",
  "apartment-not-found": "issues.report.errors.apartmentNotFound",
  "invalid-body": "issues.report.errors.unknown",
};

export interface ReportIssuePanelProps {
  /**
   * The types this account may report under, as the server filtered them.
   *
   * Passed in rather than fetched here so the screen owns one read. The filter
   * is the server's and this form does not widen it: a type that is not in this
   * list is refused by the API as if it did not exist.
   */
  types: readonly ReportableIssueType[];
  apartments: readonly IssueApartment[];
  /** Called once a report has been filed, so the caller can reload the list. */
  onReported: () => void;
}

const EMPTY = { typeId: "", apartmentId: "", location: "", description: "" };

/**
 * The report form.
 *
 * The warning above the description is required rather than decorative. Issue
 * free text is where health data and a neighbour's details arrive without
 * anybody meaning to put them there, and the platform's answer is to say who
 * reads it - not to scan the text and refuse it, which would turn away exactly
 * the reports the module exists for.
 *
 * Photographs are staged here and uploaded once the report exists, because a
 * photograph has to hang on something. A failed upload is reported on its own:
 * the report is filed either way, and telling somebody their report failed
 * because a photograph did would send them to write it again.
 */
export function ReportIssuePanel({
  types,
  apartments,
  onReported,
}: ReportIssuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(EMPTY);
  const [photos, setPhotos] = useState<readonly File[]>([]);
  /*
   * The photographs that did not make it, by name.
   *
   * A name rather than a flag because the reporter has to know which of the
   * files is missing from the report, and there is no second chance to work it
   * out: the report is filed, so submitting the form again would file another.
   */
  const [failedPhotos, setFailedPhotos] = useState<readonly string[]>([]);

  /**
   * Files the report, then hangs the staged photographs on it.
   *
   * One action from the reporter's side, two calls underneath, because a
   * photograph has to hang on something that exists. The report's own result is
   * what this returns: a photograph that failed to upload is reported beside the
   * form, and telling somebody their report failed because a photograph did
   * would send them away to write the whole thing again.
   */
  const submit = useSaveAction(
    async (input: {
      typeId: string;
      apartmentId: string | null;
      location: string | null;
      description: string;
      photos: readonly File[];
    }) => {
      const filed = await reportIssue({
        typeId: input.typeId,
        apartmentId: input.apartmentId,
        location: input.location,
        description: input.description,
      });
      if (!filed.ok) {
        return filed;
      }

      // Every one is attempted. Stopping at the first refusal would throw away
      // the photographs after it for a reason that has nothing to do with them
      // - one file too large is not a verdict on the next.
      const failed: string[] = [];
      for (const photo of input.photos) {
        const attached = await attachIssuePhoto(filed.value.id, photo);
        if (!attached.ok) {
          failed.push(photo.name);
        }
      }
      setFailedPhotos(failed);

      return filed;
    },
    () => {
      setDraft(EMPTY);
      setPhotos([]);
      onReported();
    },
  );

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setFailedPhotos([]);
    void submit.submit({
      typeId: draft.typeId,
      apartmentId: draft.apartmentId === "" ? null : draft.apartmentId,
      location: draft.location.trim() === "" ? null : draft.location.trim(),
      description: draft.description.trim(),
      photos,
    });
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])];
    // Cleared so choosing the same file twice still fires a change event.
    event.target.value = "";
    setPhotos((current) => [...current, ...chosen].slice(0, MAX_PHOTOS));
  };

  const ready = draft.typeId !== "" && draft.description.trim() !== "";

  if (types.length === 0) {
    return (
      <Panel
        title={t("issues.report.title")}
        description={t("issues.report.description")}
      >
        <Notice tone="info">{t("issues.report.noTypes")}</Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("issues.report.title")}
      description={t("issues.report.description")}
      notice={
        submit.state.kind === "failed" ? (
          <Notice tone="danger" live>
            {t(
              failureMessageKey(
                submit.state.failure,
                REPORT_FAILURES,
                "issues.report.errors.unknown",
              ),
            )}
          </Notice>
        ) : submit.state.kind === "saved" ? (
          /* Both, when both are true. A warning on its own leaves the reporter
             unsure whether the report itself landed, which is the one thing
             that would send them away to write the whole thing again. */
          <>
            <Notice tone="ok" live>
              {t("issues.report.submitted")}
            </Notice>
            {failedPhotos.length === 0 ? null : (
              <Notice tone="warn" live>
                {t("issues.photos.openFailed", {
                  names: failedPhotos.join(", "),
                })}
              </Notice>
            )}
          </>
        ) : null
      }
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit}>
        <label className={LABEL}>
          {t("issues.report.type")}
          <select
            name="issueType"
            value={draft.typeId}
            onChange={(event) => {
              setDraft({ ...draft, typeId: event.target.value });
            }}
            className={FIELD}
          >
            <option value="">{t("issues.report.typePlaceholder")}</option>
            {types.map((type) => (
              <option key={type.id} value={type.id}>
                {type.name}
              </option>
            ))}
          </select>
        </label>

        {apartments.length === 0 ? null : (
          <label className={LABEL}>
            {t("issues.report.apartment")}
            <select
              name="issueApartment"
              value={draft.apartmentId}
              onChange={(event) => {
                setDraft({ ...draft, apartmentId: event.target.value });
              }}
              className={`${FIELD} font-data`}
            >
              <option value="">{t("issues.report.apartmentNone")}</option>
              {apartments.map((apartment) => (
                <option key={apartment.id} value={apartment.id}>
                  {apartment.address} {apartment.number}
                </option>
              ))}
            </select>
          </label>
        )}

        <label className={LABEL}>
          {t("issues.report.location")}
          <input
            type="text"
            name="issueLocation"
            autoComplete="off"
            value={draft.location}
            onChange={(event) => {
              setDraft({ ...draft, location: event.target.value });
            }}
            className={FIELD}
          />
          <span className={HINT}>{t("issues.report.locationHint")}</span>
        </label>

        <label className={LABEL}>
          {t("issues.report.descriptionLabel")}
          <textarea
            name="issueDescription"
            rows={5}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
            className={`${FIELD} py-2`}
          />
        </label>

        {/* Standing, not live: it is there before anything is typed, because
            it is what the reporter needs to know while they write. */}
        <Notice tone="warn">{t("issues.report.sensitiveWarning")}</Notice>

        <section className="flex flex-col gap-2">
          <h3 className="text-label text-ink-muted uppercase">
            {t("issues.photos.title")}
          </h3>
          <p className={HINT}>{t("issues.photos.hint")}</p>

          {photos.length === 0 ? (
            <p className={HINT}>{t("issues.photos.none")}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {photos.map((photo, index) => (
                <li
                  key={`${photo.name}-${String(index)}`}
                  className="flex items-center gap-3 rounded-control border border-line px-3 py-2"
                >
                  <span className="min-w-0 truncate text-small">
                    {photo.name}
                  </span>
                  <button
                    type="button"
                    className={`${QUIET_BUTTON} ml-auto`}
                    onClick={() => {
                      setPhotos((current) =>
                        current.filter((_, at) => at !== index),
                      );
                    }}
                  >
                    {t("issues.photos.remove")}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {photos.length >= MAX_PHOTOS ? (
            <p className={HINT}>{t("issues.photos.limit")}</p>
          ) : (
            <div>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept={ACCEPTED_TYPES}
                  multiple
                  onChange={onPick}
                  className="peer sr-only"
                />
                <span
                  className={[
                    SECONDARY_BUTTON,
                    // The input is visually hidden, so the focus ring has to be
                    // drawn on the part the viewer can actually see. Same
                    // construction as the theme toggle, for the same reason.
                    "peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2",
                    "peer-focus-visible:outline-trust",
                  ].join(" ")}
                >
                  {t("issues.photos.add")}
                </span>
              </label>
            </div>
          )}
        </section>

        <div>
          <button
            type="submit"
            disabled={!ready || submit.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {submit.state.kind === "saving"
              ? t("issues.report.submitting")
              : t("issues.report.submit")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
