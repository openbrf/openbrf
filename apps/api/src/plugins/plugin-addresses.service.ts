import { Injectable } from "@nestjs/common";
import type { PluginAddress } from "@openbrf/plugin-sdk";

import { PrismaService } from "../database/prisma.service";

/**
 * The association's addresses, as a plugin holding addresses:read reads them
 * (ADR 0032).
 *
 * A fact about the building and nothing more. The select names the street and
 * the number, so an apartment, a residency or anybody living at an address
 * cannot reach a plugin through here however the mapping is later changed: that
 * is addressBook:read, a permission on the register.
 */
@Injectable()
export class PluginAddressesService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every address, in the order of the address book's house tabs. */
  async list(): Promise<PluginAddress[]> {
    return this.prisma.address.findMany({
      orderBy: [{ sortOrder: "asc" }, { street: "asc" }, { number: "asc" }],
      select: { id: true, street: true, number: true },
    });
  }
}
