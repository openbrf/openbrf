import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from "@nestjs/common";
import {
  HIGHEST_FLOOR,
  LOWEST_FLOOR,
  MAX_APARTMENTS_PER_FLOOR,
} from "@openbrf/shared";
import { z } from "zod";

import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  AddressService,
  type AddressView,
  type ApartmentView,
} from "./address.service";

const addressSchema = z.object({
  street: z.string().min(1).max(200),
  number: z.string().min(1).max(20),
  // Five digits, with or without the space Swedish postal codes are written
  // with. Stored as typed: it is printed on statutory extracts.
  postalCode: z
    .string()
    .regex(/^\d{3} ?\d{2}$/, "must be five digits, optionally spaced"),
  city: z.string().min(1).max(100),
});

/**
 * How many apartments one request may commit.
 *
 * Generous enough for the largest Swedish housing cooperative's single entrance
 * and small enough that a malformed request cannot ask the database for an
 * unbounded write. The generator's own bound is tighter: 99 apartments per
 * landing across the floors the four-digit form can express.
 */
const MAX_APARTMENTS_PER_REQUEST = MAX_APARTMENTS_PER_FLOOR * 20;

const apartmentRowsSchema = z.object({
  apartments: z
    .array(
      z.object({
        // Free text rather than four digits: an older cooperative may number
        // its apartments 1, 2, 3, and the register has to be able to hold what
        // the cooperative actually uses. The floor is what follows the
        // Lantmateriet convention, and is left unset when the number does not.
        number: z.string().min(1).max(20),
        floor: z.coerce
          .number()
          .int()
          .min(LOWEST_FLOOR)
          .max(HIGHEST_FLOOR)
          .nullish(),
      }),
    )
    .min(1)
    .max(MAX_APARTMENTS_PER_REQUEST),
});

/**
 * The housing cooperative's addresses and apartments.
 *
 * Reading needs addressBook:read and writing addressBook:write, which the board
 * holds as well as an admin: adding an apartment is register maintenance rather
 * than reconfiguring the instance. The setup wizard reaches these as an admin,
 * who holds both.
 *
 * Capabilities are declared per route rather than on the class because the two
 * halves differ; a route added later without a decorator is refused by the
 * global guard rather than being open.
 */
@Controller("api/addresses")
export class AddressController {
  constructor(private readonly addresses: AddressService) {}

  @Get()
  @RequireCapability("addressBook:read")
  async list(): Promise<AddressView[]> {
    return this.addresses.list();
  }

  @Post()
  @RequireCapability("addressBook:write")
  async create(@Body() body: unknown): Promise<AddressView> {
    return this.addresses.create(addressSchema.parse(body));
  }

  @Put(":id")
  @RequireCapability("addressBook:write")
  async update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<AddressView> {
    return this.addresses.update(id, addressSchema.parse(body));
  }

  @Delete(":id")
  @RequireCapability("addressBook:write")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.addresses.remove(id);
  }

  @Get(":id/apartments")
  @RequireCapability("addressBook:read")
  async listApartments(@Param("id") id: string): Promise<ApartmentView[]> {
    return this.addresses.listApartments(id);
  }

  @Post(":id/apartments")
  @RequireCapability("addressBook:write")
  async addApartments(
    @Param("id") id: string,
    @Body() body: unknown,
  ): Promise<{ created: number; skipped: number }> {
    const { apartments } = apartmentRowsSchema.parse(body);
    return this.addresses.addApartments(id, apartments);
  }
}

/**
 * Removing a single apartment.
 *
 * Its own controller because the route is addressed by apartment id rather than
 * nested under an address, and nesting it would invite a caller to pass an
 * address that does not own the apartment.
 */
@Controller("api/apartments")
export class ApartmentController {
  constructor(private readonly addresses: AddressService) {}

  @Delete(":id")
  @RequireCapability("addressBook:write")
  @HttpCode(204)
  async remove(@Param("id") id: string): Promise<void> {
    await this.addresses.removeApartment(id);
  }
}
