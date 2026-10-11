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

function countIds(ids: readonly (string | null)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of ids) {
    if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

/**
 * What is wrong with the registry as a list of the templates declared in the
 * source: an id that is not a literal, a template declared and not registered,
 * one registered and not declared, and an id declared and registered a
 * different number of times.
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
  const declaredCounts = countIds(declared.map((template) => template.id));
  const registeredCounts = countIds(registered.map((template) => template.id));
  const unmatched = new Map(registeredCounts);
  for (const template of declared) {
    if (template.id === null) continue;
    const left = unmatched.get(template.id) ?? 0;
    if (left > 0) {
      unmatched.set(template.id, left - 1);
    } else if (registeredCounts.has(template.id)) {
      problems.push(
        `${template.path} declares ${template.id}, which the registry holds ${registeredCounts.get(template.id)} time(s) against ${declaredCounts.get(template.id)} declaration(s)`,
      );
    } else {
      problems.push(
        `${template.path} declares ${template.id}, which the registry does not reach`,
      );
    }
  }
  for (const [id, left] of unmatched) {
    if (left === 0) continue;
    problems.push(
      declaredCounts.has(id)
        ? `${id} is registered ${registeredCounts.get(id)} time(s) against ${declaredCounts.get(id)} declaration(s) in the source`
        : `${id} is registered and declared nowhere in the source`,
    );
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
