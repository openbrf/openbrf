import type {
  EncryptedFieldId,
  FieldEncryptionService,
} from "../crypto/field-encryption.service";
import type { Prisma } from "../generated/prisma/client";
import { withheldPersonIds } from "./withheld-persons";

/**
 * Every withheld person's address, as one table's blind index for it, mapped
 * back to the person it belongs to.
 *
 * For the purges keyed on an address rather than on a person: the board
 * mailbox's correspondent and the public form's reporter. Neither row names
 * anybody in the register, so a legal hold or a restriction of processing can
 * only reach it through the address, and the question "is this address
 * somebody the purge may not touch" is answered from the register's side -
 * starting from the withheld people and asking which rows match, never the
 * other way.
 *
 * The two stored indexes are not comparable - CipherSweet derives a distinct
 * key per table and field, which `field-encryption.service.ts` states - so each
 * withheld person's address is decrypted and re-indexed under the caller's own
 * field. A hold is a dispute the board entered deliberately and a restriction a
 * request it granted, so this is a handful of rows in a cooperative that has
 * any at all.
 *
 * Who is withheld comes from `withheldPersonIds`, the one answer every purge
 * shares, so an address-keyed purge cannot come to disagree with the others
 * about what a restriction means. It takes a client so the purge can ask it on
 * its own transaction, after `lockLegalHoldRegistry`, and get the answer that
 * is true inside it.
 */
export async function withheldAddressIndexes(
  client: Prisma.TransactionClient,
  encryption: FieldEncryptionService,
  field: EncryptedFieldId,
): Promise<Map<string, string>> {
  const indexes = new Map<string, string>();

  const ids = await withheldPersonIds(client);
  if (ids.length === 0) {
    return indexes;
  }
  const persons = await client.person.findMany({
    where: { id: { in: ids } },
    select: { id: true, emailCipher: true },
  });

  for (const person of persons) {
    if (person.emailCipher === null) {
      // A person the purge has already stripped the contact details of. There
      // is nothing left to match a row against, which is the erasure working
      // rather than a gap: the hold still stops that person's own purge, and
      // it is the register that says who they are.
      continue;
    }
    const address = await encryption.decrypt(
      "person.email",
      person.emailCipher,
    );
    const index = await encryption.computeIndex(field, address);
    if (index !== null) {
      indexes.set(index, person.id);
    }
  }
  return indexes;
}
