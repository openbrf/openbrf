import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ReactElement } from "react";

import type { TranslationKey } from "../i18n/translation-key";
import { createPerson } from "./register-api";
import { usePanelHeadingFocus } from "./use-panel-heading-focus";

/**
 * Adding a person to the register.
 *
 * Creates the person record only. Placing someone in an apartment is the move-in
 * flow, which also writes the statutory member register entry when they take over
 * a tenant-ownership; doing half of that here would leave the member register
 * (EFL 5 kap.) disagreeing with the residency table, in the one table that cannot
 * be corrected by editing. The description in the form says as much, so a board
 * member is not left wondering where the apartment field went.
 *
 * There is no personal identity number field. The API accepts one, checksum and
 * all, for the import to use; entering one by hand belongs with the apartment
 * register work rather than here, where it would sit on a screen that has no need
 * of it.
 */

interface FieldDefinition {
  name:
    | "firstName"
    | "lastName"
    | "email"
    | "phone"
    | "postalStreet"
    | "postalCode"
    | "postalCity";
  labelKey: TranslationKey;
  type: "text" | "email" | "tel";
  required: boolean;
  autoComplete: string;
  /**
   * Register data is entered in the mono face, so the value reads the same here
   * as it does in the register column it ends up in. Declared per field rather
   * than decided from the field name at render time, so a field added later
   * states its own face instead of inheriting prose by default. Names and
   * street addresses are prose and stay in the UI face.
   */
  face?: "data";
}

const FIELDS: readonly FieldDefinition[] = [
  {
    name: "firstName",
    labelKey: "register.addPerson.firstName",
    type: "text",
    required: true,
    autoComplete: "off",
  },
  {
    name: "lastName",
    labelKey: "register.addPerson.lastName",
    type: "text",
    required: true,
    autoComplete: "off",
  },
  {
    name: "email",
    labelKey: "register.addPerson.email",
    type: "email",
    required: false,
    autoComplete: "off",
  },
  {
    name: "phone",
    labelKey: "register.addPerson.phone",
    type: "tel",
    required: false,
    autoComplete: "off",
    face: "data",
  },
  {
    name: "postalStreet",
    labelKey: "register.addPerson.postalStreet",
    type: "text",
    required: false,
    autoComplete: "off",
  },
  {
    name: "postalCode",
    labelKey: "register.addPerson.postalCode",
    type: "text",
    required: false,
    autoComplete: "off",
  },
  {
    name: "postalCity",
    labelKey: "register.addPerson.postalCity",
    type: "text",
    required: false,
    autoComplete: "off",
  },
];

const EMPTY: Record<FieldDefinition["name"], string> = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  postalStreet: "",
  postalCode: "",
  postalCity: "",
};

export function AddPersonPanel({
  onClose,
  onAdded,
}: {
  onClose: () => void;
  onAdded: (personId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const heading = usePanelHeadingFocus();
  const [values, setValues] = useState(EMPTY);
  const [protectedPersonalData, setProtectedPersonalData] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [failed, setFailed] = useState(false);

  const submit = async (): Promise<void> => {
    setSubmitting(true);
    setFailed(false);
    try {
      const trimmed = (value: string): string | undefined =>
        value.trim() === "" ? undefined : value.trim();

      const { personId } = await createPerson({
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: trimmed(values.email),
        phone: trimmed(values.phone),
        postalStreet: trimmed(values.postalStreet),
        postalCode: trimmed(values.postalCode),
        postalCity: trimmed(values.postalCity),
        protectedPersonalData,
      });
      onAdded(personId);
    } catch {
      setFailed(true);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <aside
      aria-label={t("register.addPerson.heading")}
      className="flex flex-col gap-5 rounded-panel border border-line bg-raised p-5 shadow-raised"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 ref={heading} tabIndex={-1} className="text-headline">
          {t("register.addPerson.heading")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-control border border-line-strong px-3 text-small font-semibold text-ink"
        >
          {t("register.addPerson.cancel")}
        </button>
      </div>

      <p className="text-body text-ink-muted">
        {t("register.addPerson.description")}
      </p>

      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {FIELDS.map((field) => (
          <div key={field.name} className="flex flex-col gap-1">
            <label
              htmlFor={`add-person-${field.name}`}
              className="text-label text-ink-muted uppercase"
            >
              {t(field.labelKey)}
            </label>
            <input
              id={`add-person-${field.name}`}
              name={field.name}
              type={field.type}
              required={field.required}
              autoComplete={field.autoComplete}
              value={values[field.name]}
              onChange={(event) => {
                setValues((current) => ({
                  ...current,
                  [field.name]: event.target.value,
                }));
              }}
              className={`min-h-11 rounded-control border border-line-strong bg-raised px-3 text-body text-ink ${
                field.face === "data" ? "font-data" : ""
              }`}
            />
          </div>
        ))}

        <div className="flex flex-col gap-1">
          <label
            htmlFor="add-person-protected"
            className="flex min-h-11 items-center gap-3 text-body text-ink"
          >
            <input
              id="add-person-protected"
              type="checkbox"
              checked={protectedPersonalData}
              onChange={(event) => {
                setProtectedPersonalData(event.target.checked);
              }}
              className="size-5 accent-warn"
            />
            {t("register.addPerson.protectedPersonalData")}
          </label>
          <p className="text-small text-ink-muted">
            {t("register.addPerson.protectedHint")}
          </p>
        </div>

        {failed ? (
          <p role="alert" className="text-body text-danger">
            {t("register.addPerson.failed")}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-11 items-center justify-center rounded-control bg-ink px-4 text-small font-semibold text-page disabled:opacity-60"
        >
          {submitting
            ? t("register.addPerson.working")
            : t("register.addPerson.submit")}
        </button>
      </form>
    </aside>
  );
}
