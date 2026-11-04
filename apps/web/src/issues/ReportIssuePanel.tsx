import { ISSUE_REPORT_LIMITS } from "@openbrf/shared";
import { useRef, useState, type ChangeEvent, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import {
  attachIssuePhoto,
  type IssueApartment,
  type IssuePlaceChoice,
  type ReportableIssueType,
  reportIssue,
  type ResponsibilityGuide,
} from "../api/issues";
import type { TranslationKey } from "../i18n/translation-key";
import {
  FIELD,
  FIELD_MULTILINE,
  HINT,
  LABEL,
  PRIMARY_BUTTON,
  QUIET_BUTTON,
  SECONDARY_BUTTON,
} from "../ui/controls";
import { LockedForm } from "../ui/LockedForm";
import { Notice } from "../ui/Notice";
import { Panel } from "../ui/Panel";
import { failureMessageKey, useSaveAction } from "../ui/save-state";
import type { PostPrefill } from "./post-prefill";
import { ResponsibilityGuideTable } from "./ResponsibilityGuideTable";

/**
 * What the file picker offers.
 *
 * A courtesy, not a control: the API identifies a file from its own bytes and
 * refuses anything else, because an accept attribute is a hint to a dialog and
 * a request can be made without one.
 */
const ACCEPTED_TYPES = "image/png,image/jpeg,image/webp,image/gif";

/** Matches the server's cap, so the form stops before the API has to. */
export const MAX_PHOTOS = 6;

const REPORT_FAILURES: Readonly<Record<string, TranslationKey>> = {
  "type-not-found": "issues.report.errors.typeNotFound",
  "apartment-not-found": "issues.report.errors.apartmentNotFound",
  "post-not-found": "issues.report.errors.postNotFound",
  "post-not-reportable": "issues.report.errors.postNotReportable",
  "post-already-reported": "issues.report.errors.postAlreadyReported",
  "ring-fenced-post": "issues.report.errors.ringFencedPost",
  "place-not-found": "issues.report.errors.placeNotFound",
  "place-with-apartment": "issues.report.errors.placeWithApartment",
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
  /**
   * The association's common-area places (decision 30), offered beside the
   * free-text location when the problem is not in a home. Empty offers none.
   */
  places?: readonly IssuePlaceChoice[];
  /**
   * What the form opens with when the report is made from a post in the feed
   * ("Gör felanmälan"): the post's text and images, and the post the report is
   * linked to. The caller mounts the form again when this changes.
   */
  prefill?: PostPrefill;
  /**
   * The responsibility guide the board has adopted, shown before the fields,
   * or null where there is none to show. The server hands a reporter only an
   * adopted guide, never the example.
   */
  guide?: ResponsibilityGuide | null;
  /**
   * Called once a report has been filed, so the caller can reload the list,
   * with the post it was made from, or null.
   */
  onReported: (fromPostId: string | null) => void;
}

const EMPTY = {
  typeId: "",
  apartmentId: "",
  placeId: "",
  location: "",
  description: "",
};

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
 *
 * Made from a post, the form opens with the post's text and its images, each
 * of which the reporter can change or take out before sending, and the report
 * is linked to the post as it is filed. The link is sent once: after the report
 * is filed the form is empty again, and a second report is one of its own.
 *
 * The association's responsibility guide comes before the fields, where the
 * board has adopted one (decision 27): what is the tenant-owner's own to put
 * right is worth knowing before writing it up. Folded, so it never stands
 * between a resident and a report about a leak, and its sentence says to
 * report anyway when unsure.
 */
export function ReportIssuePanel({
  types,
  apartments,
  places = [],
  prefill,
  guide = null,
  onReported,
}: ReportIssuePanelProps): ReactElement {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(
    prefill === undefined
      ? EMPTY
      : { ...EMPTY, description: prefill.description },
  );
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const [photos, setPhotos] = useState<readonly File[]>(
    prefill?.photos.slice(0, MAX_PHOTOS) ?? [],
  );
  /** The post this report is made from, until the report is filed. */
  const [fromPostId, setFromPostId] = useState<string | null>(
    prefill?.postId ?? null,
  );
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
      placeId: string | null;
      location: string | null;
      description: string;
      photos: readonly File[];
      postId: string | null;
    }) => {
      const filed = await reportIssue({
        typeId: input.typeId,
        apartmentId: input.apartmentId,
        placeId: input.placeId,
        location: input.location,
        description: input.description,
        ...(input.postId === null ? {} : { postId: input.postId }),
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
      setFromPostId(null);
      onReported(fromPostId);
    },
  );

  /*
   * The choices as the form shows them. A draft outlives a re-read of the
   * lists, and a choice the lists no longer hold (a type or place the board
   * switched off, a home the reporter moved out of) matches no option, so its
   * select shows none chosen. It is sent as none, as it is shown, rather than
   * sent unseen and refused with nothing on the form to correct.
   */
  /*
   * A report made from a post is offered no ring-fenced type: the server
   * refuses one (`ring-fenced-post`), because a post is read by the house and
   * the link would tell it a report was made.
   */
  const typeChoices =
    fromPostId === null ? types : types.filter((type) => !type.ringFenced);
  const typeId = offered(draft.typeId, typeChoices);
  const chosen = typeChoices.find((type) => type.id === typeId);
  const apartmentId = offered(draft.apartmentId, apartments);
  // A place is for what is not in a home: choosing an apartment leaves it out,
  // so a report never carries both.
  const placeId = apartmentId === "" ? offered(draft.placeId, places) : "";

  const onSend = (): void => {
    setFailedPhotos([]);
    void submit.submit({
      typeId,
      apartmentId: apartmentId === "" ? null : apartmentId,
      placeId: placeId === "" ? null : placeId,
      location: draft.location.trim() === "" ? null : draft.location.trim(),
      description: draft.description.trim(),
      photos,
      postId: fromPostId,
    });
  };

  const onPick = (event: ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])];
    // Cleared so choosing the same file twice still fires a change event.
    event.target.value = "";
    setPhotos((current) => [...current, ...chosen].slice(0, MAX_PHOTOS));
  };

  const ready = chosen !== undefined && draft.description.trim() !== "";

  if (typeChoices.length === 0) {
    return (
      <Panel
        title={t("issues.report.title")}
        description={t("issues.report.description")}
      >
        <Notice tone="info">
          {t(
            types.length === 0
              ? "issues.report.noTypes"
              : "issues.report.noTypesFromPost",
          )}
        </Notice>
      </Panel>
    );
  }

  return (
    <Panel
      title={t("issues.report.title")}
      /* Dropped for a ring-fenced type: the line says the property manager
         reads the report, and the warning below says never the property
         manager. */
      description={
        chosen?.ringFenced === true ? undefined : t("issues.report.description")
      }
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
      <LockedForm
        locked={submit.state.kind === "saving"}
        focusFallback={descriptionRef}
        className="flex flex-col gap-4"
        onSend={onSend}
      >
        {guide === null ? null : (
          <details className="flex flex-col gap-2">
            <summary className="min-h-11 cursor-pointer py-2 text-small font-semibold">
              {t("issues.guide.reporterTitle")}
            </summary>
            <p className={HINT}>{t("issues.guide.reporterIntro")}</p>
            <ResponsibilityGuideTable
              guide={guide}
              caption={t("issues.guide.reporterTitle")}
            />
          </details>
        )}

        <label className={LABEL}>
          {t("issues.report.type")}
          <select
            name="issueType"
            value={typeId}
            onChange={(event) => {
              setDraft({ ...draft, typeId: event.target.value });
            }}
            className={FIELD}
          >
            <option value="">{t("issues.report.typePlaceholder")}</option>
            {typeChoices.map((type) => (
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
              value={apartmentId}
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

        {places.length === 0 || apartmentId !== "" ? null : (
          <label className={LABEL}>
            {t("issues.report.place")}
            <select
              name="issuePlace"
              value={placeId}
              onChange={(event) => {
                setDraft({ ...draft, placeId: event.target.value });
              }}
              className={FIELD}
            >
              <option value="">{t("issues.report.placeNone")}</option>
              {places.map((place) => (
                <option key={place.id} value={place.id}>
                  {place.name}
                </option>
              ))}
            </select>
            <span className={HINT}>{t("issues.report.placeHint")}</span>
          </label>
        )}

        <label className={LABEL}>
          {t("issues.report.location")}
          <input
            type="text"
            name="issueLocation"
            autoComplete="off"
            maxLength={ISSUE_REPORT_LIMITS.location}
            value={draft.location}
            onChange={(event) => {
              setDraft({ ...draft, location: event.target.value });
            }}
            className={FIELD}
          />
          <span className={HINT}>{t("issues.report.locationHint")}</span>
        </label>

        {/* Standing, not live, and above the description: it is there before
            anything is typed, because it is what the reporter needs to know
            while they write. A ring-fenced type says who reads it instead,
            and what not to write (decision 32). */}
        <Notice tone="warn">
          {chosen?.ringFenced === true
            ? t("issues.ringFence.formWarning")
            : t("issues.report.sensitiveWarning")}
        </Notice>

        <label className={LABEL}>
          {t("issues.report.descriptionLabel")}
          <textarea
            ref={descriptionRef}
            name="issueDescription"
            rows={5}
            maxLength={ISSUE_REPORT_LIMITS.description}
            value={draft.description}
            onChange={(event) => {
              setDraft({ ...draft, description: event.target.value });
            }}
            className={`${FIELD_MULTILINE}`}
          />
        </label>

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
                    "peer-disabled:opacity-60",
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
      </LockedForm>
    </Panel>
  );
}

/** `id` while `choices` still holds it, otherwise none (""). */
function offered(id: string, choices: readonly { id: string }[]): string {
  return choices.some((choice) => choice.id === id) ? id : "";
}
