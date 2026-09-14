/**
 * The Standard Schema interface, version 1, as this package needs it.
 *
 * Declared here rather than imported, for the reason the rest of this package
 * declares its own types: what an action's input and output are validated by is
 * the host's business, and naming a validator in the published contract would
 * make every plugin author's build depend on the one the host happens to use
 * today. A structural interface says what the host requires - something that can
 * validate an unknown value and report issues - and any library implementing the
 * standard satisfies it, zod included.
 *
 * It is a subset: the parts the registry actually calls. `validate` is the one
 * that matters, and note that it RETURNS its issues rather than throwing, which
 * is the difference between this and a validator's own `parse`.
 *
 * The full specification is at standardschema.dev.
 */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    /** The version of the standard this schema implements. */
    readonly version: 1;
    /** The library that produced the schema, for diagnostics. */
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
    readonly types?:
      { readonly input: Input; readonly output: Output } | undefined;
  };
}

export type StandardSchemaResult<Output> =
  | { readonly value: Output; readonly issues?: undefined }
  | { readonly issues: readonly StandardSchemaIssue[] };

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[];
}
