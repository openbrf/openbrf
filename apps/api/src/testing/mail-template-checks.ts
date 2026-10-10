/**
 * The two rules `data-protection/mail-processing.spec.ts` holds the mail
 * templates to, as functions that answer with what is wrong, so that
 * `mail-template-discovery.spec.ts` can show each one finds a template that
 * breaks it. A rule that nothing has been seen to fail is one that may have
 * stopped checking.
 */

/** A template found in the source by `erasureSourceFacts`. */
export interface DeclaredMailTemplate {
  path: string;
  id: string | null;
}

/** A template in the registry the seed reads its mail-sending rows from. */
export interface RegisteredMailTemplate {
  id: string;
  processing: string | null;
}

/**
 * What is wrong with the registry as a list of the templates declared in the
 * source: an id that is not a literal, a template declared and not registered,
 * and one registered and not declared.
 */
export function registryCoverageProblems(
  declared: readonly DeclaredMailTemplate[],
  registered: readonly Pick<RegisteredMailTemplate, "id">[],
): string[] {
  const problems: string[] = [];
  for (const template of declared) {
    if (template.id === null) {
      problems.push(
        `${template.path} declares a mail template whose id is not a literal`,
      );
    }
  }
  const declaredIds = new Set(declared.map((template) => template.id));
  const registeredIds = new Set(registered.map((template) => template.id));
  for (const template of declared) {
    if (template.id !== null && !registeredIds.has(template.id)) {
      problems.push(
        `${template.path} declares ${template.id}, which the registry does not reach`,
      );
    }
  }
  for (const id of registeredIds) {
    if (!declaredIds.has(id)) {
      problems.push(`${id} is registered and declared nowhere in the source`);
    }
  }
  return problems;
}

/**
 * The registered templates that declare no processing without being on the
 * list of mails sent on none.
 */
export function unexplainedNoProcessing(
  registered: readonly RegisteredMailTemplate[],
  exceptions: Readonly<Record<string, string>>,
): string[] {
  return registered
    .filter(
      (template) =>
        template.processing === null && !Object.hasOwn(exceptions, template.id),
    )
    .map(
      (template) =>
        `${template.id} declares no processing and is not one of the mails sent on none`,
    );
}
