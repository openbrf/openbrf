import { Body, Controller, Get, Put } from "@nestjs/common";
import { z } from "zod";

import { RequireCapability } from "../authorization/require-capability.decorator";
import {
  type AssociationFactsView,
  AssociationFactsService,
} from "./association-facts.service";

/**
 * The board's own screen for the facts a broker asks for.
 *
 * Writing needs site:manage, declared on the class: the facts exist for the
 * association's website, and publishing in the cooperative's name is what the
 * board does. Reading over HTTP needs it too, and that is not an oversight.
 * There is no public read endpoint for the facts and there must not be one -
 * the only way they leave this instance is as the rendered broker page, which
 * is what keeps "the page shows exactly the recorded facts and nothing beside
 * them" a property of one renderer rather than a promise about every caller of
 * a JSON API.
 *
 * A separate class from the public site controller for the reason the pages
 * controllers are separate: the website is @Public() in the strongest sense,
 * and a class carrying both would make that a per-route detail.
 */

/**
 * Nullable rather than merely optional, and the two mean different things.
 *
 * An absent field is one the request does not touch. A null is the board
 * clearing a fact off the page, which has to be expressible: a fee policy that
 * no longer holds must be removable, not only editable.
 */
const textFact = z.string().max(4000).nullable().optional();
const flagFact = z.boolean().nullable().optional();

const factsSchema = z.object({
  propertyDesignation: textFact,
  /*
   * A bound rather than a statement about architecture. The oldest housing
   * stock a Swedish cooperative holds is mediaeval in a handful of towns, and
   * the upper end leaves room for a building that is not finished yet.
   */
  buildYear: z.number().int().min(1000).max(2200).nullable().optional(),
  landLeasehold: flagFact,
  landLeaseholdNote: textFact,
  feePolicy: textFact,
  feeIncludes: textFact,
  transferFeePolicy: textFact,
  pledgeFeePolicy: textFact,
  legalPersonOwners: flagFact,
  legalPersonOwnersNote: textFact,
  parking: textFact,
  storage: textFact,
  renovations: textFact,
});

@Controller("api/site/facts")
@RequireCapability("site:manage")
export class AssociationFactsController {
  constructor(private readonly facts: AssociationFactsService) {}

  @Get()
  async read(): Promise<AssociationFactsView> {
    return this.facts.read();
  }

  @Put()
  async save(@Body() body: unknown): Promise<AssociationFactsView> {
    return this.facts.save(factsSchema.parse(body));
  }
}
