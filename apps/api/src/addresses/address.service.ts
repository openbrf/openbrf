import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { floorOfApartmentNumber } from "@openbrf/shared";

import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import { DomainError } from "../http/domain-error";

export class AddressError extends DomainError {
  readonly status: number;

  constructor(
    message: string,
    readonly reason:
      "not-found" | "address-exists" | "has-apartments" | "apartment-in-use",
  ) {
    super(message);
    this.status =
      reason === "not-found" ? HttpStatus.NOT_FOUND : HttpStatus.CONFLICT;
  }
}

export interface AddressView {
  id: string;
  street: string;
  number: string;
  postalCode: string;
  city: string;
  sortOrder: number;
  apartmentCount: number;
}

export interface ApartmentView {
  id: string;
  /** Lantmateriet numbering. Always rendered in the mono face. */
  number: string;
  floor: number | null;
}

export interface AddressInput {
  street: string;
  number: string;
  postalCode: string;
  city: string;
}

export interface ApartmentRowInput {
  number: string;
  /** Derived from the number when omitted. */
  floor?: number | null;
}

/**
 * The housing cooperative's addresses and the apartments under them.
 *
 * A cooperative commonly owns several street addresses - one entrance each -
 * and the address book renders one board per address, so this is a list from
 * the start rather than a single field that grew a second one later. Every
 * apartment belongs to exactly one address.
 *
 * Nothing here can remove something the register depends on. An address with
 * apartments and an apartment with residencies, transfers, liens or member
 * register entries are all refused rather than cascaded: the statutory tier is
 * append-only, and a delete that cascaded into it would be an attempt to erase
 * a record the law requires the cooperative to keep.
 */
@Injectable()
export class AddressService {
  private readonly logger = new Logger(AddressService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(): Promise<AddressView[]> {
    const addresses = await this.prisma.address.findMany({
      orderBy: [{ sortOrder: "asc" }, { street: "asc" }, { number: "asc" }],
      include: { _count: { select: { apartments: true } } },
    });

    return addresses.map((address) => ({
      id: address.id,
      street: address.street,
      number: address.number,
      postalCode: address.postalCode,
      city: address.city,
      sortOrder: address.sortOrder,
      apartmentCount: address._count.apartments,
    }));
  }

  /**
   * Adds an address at the end of the house tabs.
   *
   * Created through createMany with skipDuplicates so the duplicate check is
   * the database's unique constraint on street and number rather than a read
   * followed by a write, which two boards adding the same entrance at the same
   * moment would both pass.
   */
  async create(input: AddressInput): Promise<AddressView> {
    const highest = await this.prisma.address.findFirst({
      orderBy: { sortOrder: "desc" },
      select: { sortOrder: true },
    });

    const created = await this.prisma.address.createMany({
      data: [{ ...input, sortOrder: (highest?.sortOrder ?? -1) + 1 }],
      skipDuplicates: true,
    });

    if (created.count === 0) {
      throw new AddressError(
        `${input.street} ${input.number} is already an address of this housing cooperative.`,
        "address-exists",
      );
    }

    this.logger.log(`Added address ${input.street} ${input.number}`);
    return this.requireView(input.street, input.number);
  }

  async update(id: string, input: AddressInput): Promise<AddressView> {
    await this.requireAddress(id);

    const clashing = await this.prisma.address.findFirst({
      where: {
        street: input.street,
        number: input.number,
        id: { not: id },
      },
      select: { id: true },
    });
    if (clashing !== null) {
      throw new AddressError(
        `${input.street} ${input.number} is already an address of this housing cooperative.`,
        "address-exists",
      );
    }

    try {
      await this.prisma.address.update({ where: { id }, data: input });
    } catch (cause) {
      /*
       * The read above narrows the window; the unique constraint closes it. Two
       * boards renaming two addresses to the same entrance at the same moment
       * both pass the read, and the second write raises P2002. Without this the
       * caller gets a 500 for a conflict the client already knows how to show,
       * which is the opposite of what `create` deliberately does by letting the
       * database decide.
       */
      if (
        cause instanceof Prisma.PrismaClientKnownRequestError &&
        cause.code === "P2002"
      ) {
        throw new AddressError(
          `${input.street} ${input.number} is already an address of this housing cooperative.`,
          "address-exists",
        );
      }
      throw cause;
    }
    return this.requireView(input.street, input.number);
  }

  /**
   * Removes an address that has no apartments.
   *
   * Refused while apartments remain rather than cascading: an apartment is the
   * unit the member and apartment registers hang off, so removing a whole
   * entrance's worth of them from a settings screen has to be a deliberate act
   * on each one.
   */
  async remove(id: string): Promise<void> {
    const address = await this.prisma.address.findUnique({
      where: { id },
      include: { _count: { select: { apartments: true } } },
    });
    if (address === null) {
      throw new AddressError("No such address.", "not-found");
    }
    if (address._count.apartments > 0) {
      throw new AddressError(
        `${address.street} ${address.number} still has ${address._count.apartments} apartments. Remove them first.`,
        "has-apartments",
      );
    }

    await this.prisma.address.delete({ where: { id } });
    this.logger.log(`Removed address ${address.street} ${address.number}`);
  }

  async listApartments(addressId: string): Promise<ApartmentView[]> {
    await this.requireAddress(addressId);

    const apartments = await this.prisma.apartment.findMany({
      where: { addressId },
      orderBy: { number: "asc" },
      select: { id: true, number: true, floor: true },
    });
    return apartments;
  }

  /**
   * Adds apartments to one address.
   *
   * Takes the rows the board committed rather than the generator's parameters.
   * The wizard generates a table in the browser and lets it be edited before
   * anything is written, because no real building is perfectly rectangular and
   * this table becomes the backbone of a statutory register.
   *
   * The floor is derived from the number when the caller does not state one, by
   * the same rule the browser used, and stays null for a number that does not
   * follow the Lantmateriet convention rather than being guessed.
   *
   * Existing numbers are skipped rather than rejected, so committing the table
   * twice - a double click, a retried request - adds each apartment once.
   */
  async addApartments(
    addressId: string,
    rows: readonly ApartmentRowInput[],
  ): Promise<{ created: number; skipped: number }> {
    await this.requireAddress(addressId);

    const data = rows.map((row) => ({
      addressId,
      number: row.number,
      floor: row.floor ?? floorOfApartmentNumber(row.number),
    }));

    const result = await this.prisma.apartment.createMany({
      data,
      skipDuplicates: true,
    });

    this.logger.log(`Added ${result.count} apartments to address ${addressId}`);
    return { created: result.count, skipped: data.length - result.count };
  }

  /**
   * Removes one apartment, if nothing in the register refers to it.
   *
   * The checks are explicit rather than left to the foreign keys so the answer
   * says which record stands in the way. The member register entries matter
   * most: those rows cannot be deleted at all, by anyone, so an apartment they
   * name is permanent.
   */
  async removeApartment(id: string): Promise<void> {
    const apartment = await this.prisma.apartment.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            residencies: true,
            memberRegisterEntries: true,
            transfers: true,
            lienNotes: true,
          },
        },
      },
    });
    if (apartment === null) {
      throw new AddressError("No such apartment.", "not-found");
    }

    const counts = apartment._count;
    const referenced =
      counts.residencies +
      counts.memberRegisterEntries +
      counts.transfers +
      counts.lienNotes;

    if (referenced > 0) {
      throw new AddressError(
        `Apartment ${apartment.number} appears in the register and cannot be removed.`,
        "apartment-in-use",
      );
    }

    await this.prisma.apartment.delete({ where: { id } });
    this.logger.log(`Removed apartment ${apartment.number}`);
  }

  private async requireAddress(id: string): Promise<void> {
    const address = await this.prisma.address.findUnique({
      where: { id },
      select: { id: true },
    });
    if (address === null) {
      throw new AddressError("No such address.", "not-found");
    }
  }

  /** Reads back an address by its natural key, after a write. */
  private async requireView(
    street: string,
    number: string,
  ): Promise<AddressView> {
    const address = await this.prisma.address.findUnique({
      where: { street_number: { street, number } },
      include: { _count: { select: { apartments: true } } },
    });
    if (address === null) {
      throw new AddressError("No such address.", "not-found");
    }

    return {
      id: address.id,
      street: address.street,
      number: address.number,
      postalCode: address.postalCode,
      city: address.city,
      sortOrder: address.sortOrder,
      apartmentCount: address._count.apartments,
    };
  }
}
