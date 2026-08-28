import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { z } from "zod";

import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type MoveInResult,
  type MoveOutResult,
  MoveService,
} from "./move.service";

/** ISO calendar date. A register date is never guessed from free text. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const transferSchema = z.object({
  transferredOn: isoDate,
  price: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, "must be a decimal amount")
    .nullish(),
  agreementReference: z.string().max(300).nullish(),
});

const moveInSchema = z.object({
  personId: z.string().min(1),
  apartmentId: z.string().min(1),
  role: z.enum(["MEMBER", "RESIDENT"]),
  movedInOn: isoDate,
  transfer: transferSchema
    .extend({ fromPersonId: z.string().min(1).nullish() })
    .optional(),
});

const moveOutSchema = z.object({
  residencyId: z.string().min(1),
  movedOutOn: isoDate,
  transfer: transferSchema.extend({ toPersonId: z.string().min(1) }).optional(),
});

/**
 * The move flows.
 *
 * Both routes need the right to write the address book as well as the right to
 * read it, because both write the statutory member register as a side effect
 * and that write cannot be undone. Residents hold neither.
 */
@Controller("api/moves")
@RequireCapability("addressBook:read", "addressBook:write")
export class MoveController {
  constructor(private readonly moves: MoveService) {}

  @Post("move-in")
  async moveIn(@Body() body: unknown): Promise<MoveInResult> {
    const input = moveInSchema.parse(body);
    return this.moves.moveIn({
      personId: input.personId,
      apartmentId: input.apartmentId,
      role: input.role,
      movedInOn: input.movedInOn,
      transfer:
        input.transfer === undefined
          ? undefined
          : {
              transferredOn: input.transfer.transferredOn,
              price: input.transfer.price,
              agreementReference: input.transfer.agreementReference,
              fromPersonId: input.transfer.fromPersonId,
            },
    });
  }

  @Post("move-out")
  @HttpCode(200)
  async moveOut(@Body() body: unknown): Promise<MoveOutResult> {
    const input = moveOutSchema.parse(body);
    return this.moves.moveOut({
      residencyId: input.residencyId,
      movedOutOn: input.movedOutOn,
      transfer:
        input.transfer === undefined
          ? undefined
          : {
              transferredOn: input.transfer.transferredOn,
              price: input.transfer.price,
              agreementReference: input.transfer.agreementReference,
              toPersonId: input.transfer.toPersonId,
            },
    });
  }
}
