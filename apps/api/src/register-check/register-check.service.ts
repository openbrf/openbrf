import { Injectable } from "@nestjs/common";

import { FieldEncryptionService } from "../crypto/field-encryption.service";
import { normalizeEmail, normalizePhone } from "../crypto/personal-data";
import { PrismaService } from "../database/prisma.service";
import {
  emailAddressesIn,
  findRegisterWords,
  phoneNumbersIn,
  type RegisterWordMatch,
  type RegisterWords,
  registerWordsOf,
} from "./register-words";

/** The strings one item carries, a missing one as null. */
export type CheckedItem = readonly (string | null)[];

/**
 * What an editor shows of an item the check withholds from devices.
 *
 * `words` are the matches it may show, as the text has them. `unshownWords`
 * says the text also names somebody whose words it may not show: a person
 * with protected personal data, whom the editor calls somebody in the
 * register.
 */
export interface WithheldFromDevices {
  readonly words: readonly string[];
  readonly unshownWords: boolean;
}

/** The register's words, read once, checked against as many items as needed. */
export interface RegisterCheck {
  /** Each item's matches, in the order given. An item with none passes. */
  matches(items: readonly CheckedItem[]): Promise<RegisterWordMatch[][]>;
  /** Whether each item passes, in the order given. */
  passes(items: readonly CheckedItem[]): Promise<boolean[]>;
}

/**
 * The check that keeps published text naming a resident off a device
 * (ADR 0032, "Nothing that names a resident reaches a device").
 *
 * An item's strings are checked against the register as it is when they are
 * read: the names of every person it holds, current and former, protected
 * personal data included, with the names the member register recorded for
 * them; every apartment number; and every email address and phone number.
 * The names and apartment numbers are read and looked for here. An email
 * address or phone number is never decrypted for it: what in the text could
 * be one is looked up by its blind index, as the address book's search does,
 * so the check reads no contact detail the register holds.
 *
 * What the check finds stays in the API. A content service returns an item or
 * leaves it out, and only the core's own editors, to the board, show which
 * words were found.
 */
@Injectable()
export class RegisterCheckService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: FieldEncryptionService,
  ) {}

  /** Reads the register's names and apartment numbers for one read. */
  async load(): Promise<RegisterCheck> {
    const words = await this.registerWords();
    return {
      matches: (items) => this.matchesIn(words, items),
      passes: async (items) =>
        (await this.matchesIn(words, items)).map(
          (matches) => matches.length === 0,
        ),
    };
  }

  /** Each item's matches, the register read for this call alone. */
  async matches(items: readonly CheckedItem[]): Promise<RegisterWordMatch[][]> {
    return (await this.load()).matches(items);
  }

  private async registerWords(): Promise<RegisterWords> {
    const [persons, entries, apartments] = await Promise.all([
      this.prisma.person.findMany({
        select: {
          firstName: true,
          lastName: true,
          protectedPersonalData: true,
        },
      }),
      /*
       * The member register keeps the name a person had at each entry, so a
       * name the person record has since changed from is still the register's.
       */
      this.prisma.memberRegisterEntry.findMany({
        distinct: ["personId", "recordedFirstName", "recordedLastName"],
        select: {
          recordedFirstName: true,
          recordedLastName: true,
          person: { select: { protectedPersonalData: true } },
        },
      }),
      this.prisma.apartment.findMany({ select: { number: true } }),
    ]);
    return registerWordsOf(
      [
        ...persons.map((person) => ({
          givenName: person.firstName,
          familyName: person.lastName,
          protectedPersonalData: person.protectedPersonalData,
        })),
        ...entries.map((entry) => ({
          givenName: entry.recordedFirstName,
          familyName: entry.recordedLastName,
          protectedPersonalData: entry.person.protectedPersonalData,
        })),
      ],
      apartments.map((apartment) => apartment.number),
    );
  }

  private async matchesIn(
    words: RegisterWords,
    items: readonly CheckedItem[],
  ): Promise<RegisterWordMatch[][]> {
    const texts = items.map((item) =>
      item.filter((text): text is string => text !== null && text !== ""),
    );
    // Each text is cut for its addresses and numbers once, for the lookup and
    // for the matches alike.
    const written = texts.map((item) =>
      item.map((text) => ({
        text,
        emails: emailAddressesIn(text),
        phones: phoneNumbersIn(text),
      })),
    );
    const contacts = await this.contactsIn(written.flat());
    return written.map((item) =>
      item.flatMap((written) => [
        ...findRegisterWords(written.text, words),
        ...contactMatches(written, contacts),
      ]),
    );
  }

  /**
   * The email addresses and phone numbers in these texts that the register
   * holds, each with whether only persons with protected personal data hold
   * it. Keyed by the address or number as normalized.
   */
  private async contactsIn(
    texts: readonly WrittenContacts[],
  ): Promise<ReadonlyMap<string, boolean>> {
    const emails = new Set<string>();
    const phones = new Set<string>();
    for (const text of texts) {
      for (const email of text.emails) {
        emails.add(normalizeEmail(email));
      }
      for (const phone of text.phones) {
        const normalized = normalizePhone(phone);
        if (normalized !== "") {
          phones.add(normalized);
        }
      }
    }
    if (emails.size === 0 && phones.size === 0) {
      return new Map();
    }

    const byIndex = async (
      field: "person.email" | "person.phone",
      values: ReadonlySet<string>,
    ): Promise<Map<string, string>> => {
      const indexes = new Map<string, string>();
      for (const value of values) {
        const index = await this.encryption.computeIndex(field, value);
        if (index !== null) {
          indexes.set(index, value);
        }
      }
      return indexes;
    };
    const emailIndexes = await byIndex("person.email", emails);
    const phoneIndexes = await byIndex("person.phone", phones);

    /*
     * A text can hold thousands of digit groups, so the hashes are asked for
     * in batches: one query naming them all would pass the database's limit
     * on bound values, and none may be left out, since a contact detail that
     * is not looked up is not withheld.
     */
    const holders: {
      emailIndex: string | null;
      phoneIndex: string | null;
      protectedPersonalData: boolean;
    }[] = [];
    const emailHashes = [...emailIndexes.keys()];
    const phoneHashes = [...phoneIndexes.keys()];
    for (
      let at = 0;
      at < Math.max(emailHashes.length, phoneHashes.length);
      at += INDEXES_PER_QUERY
    ) {
      holders.push(
        ...(await this.prisma.person.findMany({
          where: {
            OR: [
              {
                emailIndex: {
                  in: emailHashes.slice(at, at + INDEXES_PER_QUERY),
                },
              },
              {
                phoneIndex: {
                  in: phoneHashes.slice(at, at + INDEXES_PER_QUERY),
                },
              },
            ],
          },
          select: {
            emailIndex: true,
            phoneIndex: true,
            protectedPersonalData: true,
          },
        })),
      );
    }

    const found = new Map<string, boolean>();
    const hold = (value: string | undefined, isProtected: boolean): void => {
      if (value !== undefined) {
        found.set(value, (found.get(value) ?? true) && isProtected);
      }
    };
    for (const holder of holders) {
      const email =
        holder.emailIndex === null
          ? undefined
          : emailIndexes.get(holder.emailIndex);
      const phone =
        holder.phoneIndex === null
          ? undefined
          : phoneIndexes.get(holder.phoneIndex);
      hold(email, holder.protectedPersonalData);
      hold(phone, holder.protectedPersonalData);
    }
    return found;
  }
}

/** The email addresses and phone numbers one text is written with. */
interface WrittenContacts {
  readonly emails: readonly string[];
  readonly phones: readonly string[];
}

/** The most blind indexes of each kind one query to the register names. */
const INDEXES_PER_QUERY = 1000;

/** The email addresses and phone numbers in one text the register holds. */
function contactMatches(
  text: WrittenContacts,
  contacts: ReadonlyMap<string, boolean>,
): RegisterWordMatch[] {
  if (contacts.size === 0) {
    return [];
  }
  const matches: RegisterWordMatch[] = [];
  for (const email of text.emails) {
    const protectedOnly = contacts.get(normalizeEmail(email));
    if (protectedOnly !== undefined) {
      matches.push({ words: email, protectedOnly });
    }
  }
  for (const phone of text.phones) {
    const protectedOnly = contacts.get(normalizePhone(phone));
    if (protectedOnly !== undefined) {
      matches.push({ words: phone, protectedOnly });
    }
  }
  return matches;
}

/**
 * What an editor shows of one item's matches, or null when the item passes.
 *
 * A word is shown once however often it was found, and never when it is the
 * name of nobody but persons with protected personal data.
 */
export function withheldFromDevices(
  matches: readonly RegisterWordMatch[],
): WithheldFromDevices | null {
  if (matches.length === 0) {
    return null;
  }
  const shown = new Map<string, string>();
  let unshownWords = false;
  for (const match of matches) {
    if (match.protectedOnly) {
      unshownWords = true;
    } else if (!shown.has(match.words.toLowerCase())) {
      shown.set(match.words.toLowerCase(), match.words);
    }
  }
  return { words: [...shown.values()], unshownWords };
}
