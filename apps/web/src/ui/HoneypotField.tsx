import type { ReactElement } from "react";

/**
 * The decoy field name, mirroring the API's own constant
 * (`apps/api/src/http/honeypot.ts`). Mirrored rather than imported, like every
 * other wire value in this client - and chosen to look like a field a form
 * might have while being one no browser autofills, because a filled decoy has
 * to mean a script and never a password manager being helpful.
 */
export const HONEYPOT_FIELD = "website";

interface HoneypotFieldProps {
  value: string;
  onChange: (value: string) => void;
}

/**
 * A field on a public form that no person can reach.
 *
 * A script that fills in every input it finds fills this one, and the endpoint
 * drops a submission that carries it - answering exactly as it would have
 * answered a real one, so nothing tells the script what happened.
 *
 * How it is hidden is the whole of its correctness, and all three parts are
 * load-bearing. It is visually hidden rather than removed, so a script reading
 * the page still finds it. It is `aria-hidden`, so it is absent from the
 * accessibility tree and a screen reader never announces it. And it is
 * `tabindex="-1"`, so nobody keyboarding through the form lands in it. A field
 * a resident using assistive technology could reach would be a field they would
 * fill in honestly - and their request to the board would be dropped without a
 * word to either of them.
 *
 * There is no label, and that is not an oversight: nothing here is addressed to
 * a person, so there is nothing to translate.
 */
export function HoneypotField({
  value,
  onChange,
}: HoneypotFieldProps): ReactElement {
  return (
    <div className="sr-only" aria-hidden="true">
      <input
        type="text"
        name={HONEYPOT_FIELD}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        tabIndex={-1}
        autoComplete="off"
      />
    </div>
  );
}
