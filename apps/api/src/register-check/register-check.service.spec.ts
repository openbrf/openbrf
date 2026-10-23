import { describe, expect, it, vi } from "vite-plus/test";

import type { FieldEncryptionService } from "../crypto/field-encryption.service";
import type { PrismaService } from "../database/prisma.service";
import {
  RegisterCheckService,
  withheldFromDevices,
} from "./register-check.service";

/**
 * What the register check reads of the register, and what an editor is shown
 * of what it found (ADR 0032). The blind index lookups are held against a real
 * database in register-check.int-spec.ts.
 */

function serviceOver(register: {
  persons?: unknown[];
  entries?: unknown[];
  apartments?: unknown[];
}) {
  const findPersons = vi.fn(async () => register.persons ?? []);
  const prisma = {
    person: { findMany: findPersons },
    memberRegisterEntry: {
      findMany: vi.fn(async () => register.entries ?? []),
    },
    apartment: { findMany: vi.fn(async () => register.apartments ?? []) },
  } as unknown as PrismaService;
  const computeIndex = vi.fn(async (_field: string, value: string) => value);
  const encryption = { computeIndex } as unknown as FieldEncryptionService;
  return {
    service: new RegisterCheckService(prisma, encryption),
    findPersons,
    computeIndex,
  };
}

describe("RegisterCheckService", () => {
  it("finds a name only the member register still records", async () => {
    const { service } = serviceOver({
      persons: [
        { firstName: "Anna", lastName: "Berg", protectedPersonalData: false },
      ],
      entries: [
        {
          recordedFirstName: "Anna",
          recordedLastName: "Lindqvist",
          person: { protectedPersonalData: false },
        },
      ],
    });

    const [matches] = await service.matches([["Tack, Lindqvist!"]]);

    expect(matches).toEqual([{ words: "Lindqvist", protectedOnly: false }]);
  });

  it("looks nothing up when no text holds an address or a number", async () => {
    const { service, findPersons, computeIndex } = serviceOver({});

    await expect(
      service.matches([["Städdag på gården"], [null, ""]]),
    ).resolves.toEqual([[], []]);
    // Read once for the names, never for an email address or phone number.
    expect(findPersons).toHaveBeenCalledTimes(1);
    expect(computeIndex).not.toHaveBeenCalled();
  });
});

describe("withheldFromDevices", () => {
  it("is null for an item that passes", () => {
    expect(withheldFromDevices([])).toBeNull();
  });

  it("shows each word once, and no word of a person with protected personal data", () => {
    expect(
      withheldFromDevices([
        { words: "Svensson", protectedOnly: false },
        { words: "svensson", protectedOnly: false },
        { words: "Hemligsson", protectedOnly: true },
      ]),
    ).toEqual({ words: ["Svensson"], unshownWords: true });
  });
});
