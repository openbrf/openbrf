/**
 * The association's default language, read in one place.
 *
 * Beside the settings that store it, as `retention-policy.ts` is for the
 * retention policy: mail written before the claim and the purge that resets a
 * person's language both need the same answer, and a fallback that differed
 * between them would write one person's mail and erasure in two languages.
 */

import type { PrismaService } from "../database/prisma.service";
import { DEFAULT_LOCALE } from "../i18n/i18n.service";

/**
 * The association's default language, or the application's own when there is no
 * association row yet. A null locale would give the same result in the mail
 * service, but would ignore an association that chose English.
 */
export async function associationDefaultLocale(
  prisma: PrismaService,
): Promise<string> {
  const association = await prisma.association.findUnique({
    where: { id: 1 },
    select: { defaultLocale: true },
  });
  return association?.defaultLocale ?? DEFAULT_LOCALE;
}
