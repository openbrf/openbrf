import { useEffect, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";

import { fetchSignupState, submitSignupRequest } from "../api/signup";
import type { TranslationKey } from "../i18n/translation-key";
import { FIELD, FIELD_DATA, HINT, LABEL, PRIMARY_BUTTON } from "../ui/controls";
import { HONEYPOT_FIELD, HoneypotField } from "../ui/HoneypotField";
import { Notice } from "../ui/Notice";
import { useSaveAction } from "../ui/save-state";

/** Whether the door is open, as far as this screen has been told. */
type Access = { kind: "loading" } | { kind: "open" } | { kind: "closed" };

interface FieldDefinition {
  name: keyof typeof EMPTY;
  labelKey: TranslationKey;
  type: "text" | "email" | "tel";
  required: boolean;
  autoComplete: string;
  /** The endpoint's own limit, so the browser refuses before the server does. */
  maxLength: number;
  /**
   * Register data is typed in the mono face, so a value reads the same here as
   * in the register column it is matched against. An apartment number is a
   * fixed-shape code; a street address is prose and gains nothing from the
   * grid.
   */
  face?: "data";
}

const FIELDS: readonly FieldDefinition[] = [
  {
    name: "firstName",
    labelKey: "signup.firstName",
    type: "text",
    required: true,
    autoComplete: "given-name",
    maxLength: 100,
  },
  {
    name: "lastName",
    labelKey: "signup.lastName",
    type: "text",
    required: true,
    autoComplete: "family-name",
    maxLength: 100,
  },
  {
    name: "email",
    labelKey: "signup.email",
    type: "email",
    required: true,
    autoComplete: "email",
    maxLength: 320,
  },
  {
    name: "phone",
    labelKey: "signup.phone",
    type: "tel",
    required: false,
    autoComplete: "tel",
    maxLength: 40,
    face: "data",
  },
  {
    name: "claimedAddress",
    labelKey: "signup.address",
    type: "text",
    required: true,
    // Not "street-address": this is the address the applicant claims to live
    // at, checked by a human against the register, and a browser filling it in
    // from a saved profile would answer a different question.
    autoComplete: "off",
    maxLength: 200,
  },
  {
    name: "claimedApartmentNumber",
    labelKey: "signup.apartmentNumber",
    type: "text",
    required: true,
    autoComplete: "off",
    maxLength: 20,
    face: "data",
  },
];

const EMPTY = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  claimedAddress: "",
  claimedApartmentNumber: "",
};

/**
 * Every failure this form renders, as a translated sentence.
 *
 * Deliberately not `failureMessageKey`: that maps every 403 to "your account is
 * not allowed to change this", and the only 403 here is the association having
 * the form switched off - which is not about this visitor's account, and is not
 * even a failure to report as one.
 */
const FAILURE_KEY: Readonly<Record<string, TranslationKey>> = {
  "invalid-body": "signup.errors.invalid",
  "invalid-email": "signup.errors.invalid",
};

/**
 * Asking the board for an account.
 *
 * The screen is served to anyone, before sign-in, which decides two things
 * about it. The address and the apartment number are free text with no pickers:
 * a picker would enumerate the association's addresses and apartments to
 * whoever loaded the page, and everything on this platform sits behind a login
 * (decision 28). And the copy is honest about what a submission does, which is
 * nothing: no account, no person in the register, nothing at all until a board
 * member matches the claim to a real apartment and approves it.
 *
 * The closed state is a notice on this screen rather than a redirect or a 404.
 * A visitor who followed a link from the sign-in screen has to be told the
 * board has shut the form, not shown a page that looks broken.
 */
export function RequestAccountScreen(): ReactElement {
  const { t } = useTranslation();
  const [access, setAccess] = useState<Access>({ kind: "loading" });
  const [values, setValues] = useState(EMPTY);
  const [honeypot, setHoneypot] = useState("");
  const [sent, setSent] = useState(false);

  const save = useSaveAction(submitSignupRequest, () => {
    setSent(true);
  });

  useEffect(() => {
    // The effect owns its own call and drops an answer that arrives after the
    // screen is gone.
    let active = true;
    void fetchSignupState().then((result) => {
      if (active) {
        /*
         * A read that failed is treated as closed, like the setup screen treats
         * an unanswered question about first boot. Rendering the form on a
         * guess would offer a visitor a form whose every submission the server
         * refuses, and the submission itself corrects the screen the moment the
         * refusal is a real one.
         */
        setAccess({
          kind: result.ok && result.value.enabled ? "open" : "closed",
        });
      }
    });
    return () => {
      active = false;
    };
  }, []);

  /*
   * The toggle can go off between the load and the submission. The refusal is
   * the same fact the mount-time read answers, so it flips the screen rather
   * than rendering as an error under a form that no longer exists.
   */
  const refusedAsClosed =
    save.state.kind === "failed" &&
    save.state.failure.reason === "self-signup-disabled";

  if (access.kind === "loading") {
    return (
      <p role="status" className="p-6 text-body text-ink-muted">
        {t("app.loading")}
      </p>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-5 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-headline">{t("signup.title")}</h1>
        {access.kind === "open" && !refusedAsClosed && !sent ? (
          <p className="text-body text-ink-muted">{t("signup.intro")}</p>
        ) : null}
      </header>

      {access.kind === "closed" || refusedAsClosed ? (
        <Notice tone="info" live={refusedAsClosed}>
          {t("signup.closed")}
        </Notice>
      ) : sent ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-title">{t("signup.receivedTitle")}</h2>
          {/* The whole point of the screen, in the one place a visitor will
              read it: a request creates nothing, and a second one from the
              same address replaces this one rather than queueing twice. */}
          <Notice tone="ok" live>
            {t("signup.receivedBody")}
          </Notice>
        </section>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            const phone = values.phone.trim();
            const decoy = honeypot.trim();
            void save.submit({
              firstName: values.firstName.trim(),
              lastName: values.lastName.trim(),
              email: values.email.trim(),
              // Left out entirely when blank rather than sent as an empty
              // string, which the endpoint would encrypt and store as a phone
              // number that is not one.
              ...(phone === "" ? {} : { phone }),
              claimedAddress: values.claimedAddress.trim(),
              claimedApartmentNumber: values.claimedApartmentNumber.trim(),
              // Sent only when something filled the decoy in, which no person
              // can: the endpoint drops such a submission and answers as though
              // it had kept it.
              ...(decoy === "" ? {} : { [HONEYPOT_FIELD]: decoy }),
            });
          }}
        >
          {FIELDS.map((field) => (
            <label key={field.name} className={LABEL}>
              {t(field.labelKey)}
              <input
                type={field.type}
                name={field.name}
                required={field.required}
                maxLength={field.maxLength}
                autoComplete={field.autoComplete}
                value={values[field.name]}
                onChange={(event) => {
                  const { value } = event.target;
                  setValues((current) => ({ ...current, [field.name]: value }));
                }}
                className={field.face === "data" ? FIELD_DATA : FIELD}
              />
            </label>
          ))}

          <HoneypotField value={honeypot} onChange={setHoneypot} />

          <p className={HINT}>{t("signup.freeTextHint")}</p>

          <button
            type="submit"
            disabled={save.state.kind === "saving"}
            className={PRIMARY_BUTTON}
          >
            {save.state.kind === "saving"
              ? t("signup.working")
              : t("signup.submit")}
          </button>

          {save.state.kind === "failed" ? (
            <Notice tone="danger" live>
              {t(
                FAILURE_KEY[save.state.failure.reason] ??
                  "signup.errors.unknown",
              )}
            </Notice>
          ) : null}
        </form>
      )}
    </div>
  );
}
