import { Injectable, type OnModuleInit } from "@nestjs/common";
import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import { z } from "zod";

import { FACTS_ACTION_ERRORS } from "../actions/action-errors";
import { CoreActionRegistrar } from "../actions/action-registrar";
import { actorOf } from "../actions/actor-of";
import {
  type AssociationFactsInput,
  AssociationFactsService,
} from "./association-facts.service";

/**
 * The association's own facts, as actions.
 *
 * The broker information page is the one thing the board publishes that answers
 * a question somebody outside the house asked, and these two actions are the
 * whole of what a connected app may do with it: read what has been recorded,
 * and record it.
 *
 * It is the control case for the rule this slice adds. Thirteen fields about a
 * building - its designation, how it stands on its land, what the fee covers,
 * where a car goes, what has been renovated - and not one of them names a
 * person. So `personalData` is `[]`, and an action declaring nothing is exactly
 * what proves the new refusal at registration does not misfire: the gate
 * refuses `protected` on `mcp`, and an honest empty declaration passes it
 * without a special case.
 *
 * What the update does NOT offer is the same decision the pages made. There is
 * no `expectedRevision`, because the facts table carries no revision column for
 * a precondition to claim on and publishing one the service would discard is
 * worse than not offering one. The save is a partial: a field the input does
 * not name is untouched and an explicit null clears it, which is what the
 * service already means by the two and what lets a board take a fee policy that
 * no longer holds off the page rather than only edit it.
 *
 * A save that carries a Swedish personal identity number is refused, by the
 * same scanner the page editor runs, and the refusal names the field and the
 * offset and never the number. That is published as the one error the action
 * can raise.
 */

/** As much as one fact may hold. The service trims past it. */
const MAX_FACT = 4000;

/**
 * One free-text fact on the way in.
 *
 * Nullable and optional, and the two mean different things: absent is a field
 * the call does not touch, and null is the board taking the fact off the page.
 */
function textFact(description: string) {
  return z.string().max(MAX_FACT).nullable().optional().describe(description);
}

function flagFact(description: string) {
  return z.boolean().nullable().optional().describe(description);
}

/**
 * One fact on the way out.
 *
 * Nullable throughout, and null means the board has recorded nothing. There is
 * no placeholder and no empty string: the broker page omits an unrecorded fact
 * entirely, and a caller that is a model has to be able to tell "the
 * association has not said" from "the association says nothing applies".
 */
function recordedText(description: string) {
  return z.string().nullable().describe(description);
}

function recordedFlag(description: string) {
  return z.boolean().nullable().describe(description);
}

const factsSchema = z.strictObject({
  propertyDesignation: recordedText(
    "The property designation (fastighetsbeteckning) the association publishes on the broker page, or null while none is recorded.",
  ),
  buildYear: z
    .int()
    .nullable()
    .describe("The year the building was finished, or null."),
  siteLeasehold: recordedFlag(
    "Whether the buildings stand on leasehold land (tomtratt), or null while the board has not said.",
  ),
  siteLeaseholdNote: recordedText(
    "What the board says about the site leasehold, such as when the ground rent is next reviewed.",
  ),
  feePolicy: recordedText(
    "What the board says about the fee: when it was last changed and what is expected of it.",
  ),
  feeIncludes: recordedText("What the monthly fee covers."),
  transferFeePolicy: recordedText(
    "Who pays the transfer fee (overlatelseavgift) and what it is.",
  ),
  pledgeFeePolicy: recordedText(
    "Who pays the pledge fee (pantsattningsavgift) and what it is.",
  ),
  legalPersonOwners: recordedFlag(
    "Whether the association admits juridical persons as members, or null while the board has not said.",
  ),
  legalPersonOwnersNote: recordedText(
    "What the board says about juridical persons as members.",
  ),
  parking: recordedText("What the association offers in the way of parking."),
  storage: recordedText("What storage the apartments have."),
  renovations: recordedText(
    "The renovations the association has carried out or has decided on.",
  ),
  updatedAt: z
    .string()
    .nullable()
    .describe(
      "When the facts were last recorded, as an ISO instant, or null while the board has recorded nothing at all.",
    ),
});

const updateSchema = z.strictObject({
  propertyDesignation: textFact(
    "The property designation (fastighetsbeteckning). Null takes it off the page.",
  ),
  buildYear: z
    .int()
    .min(1000)
    .max(2200)
    .nullable()
    .optional()
    .describe(
      "The year the building was finished. A bound rather than a statement about architecture: the oldest Swedish housing stock is mediaeval, and the upper end leaves room for a building that is not finished yet.",
    ),
  siteLeasehold: flagFact(
    "Whether the buildings stand on leasehold land (tomtratt).",
  ),
  siteLeaseholdNote: textFact("What the board says about the site leasehold."),
  feePolicy: textFact("What the board says about the fee."),
  feeIncludes: textFact("What the monthly fee covers."),
  transferFeePolicy: textFact(
    "Who pays the transfer fee (overlatelseavgift) and what it is.",
  ),
  pledgeFeePolicy: textFact(
    "Who pays the pledge fee (pantsattningsavgift) and what it is.",
  ),
  legalPersonOwners: flagFact(
    "Whether the association admits juridical persons as members.",
  ),
  legalPersonOwnersNote: textFact(
    "What the board says about juridical persons as members.",
  ),
  parking: textFact("What the association offers in the way of parking."),
  storage: textFact("What storage the apartments have."),
  renovations: textFact(
    "The renovations the association has carried out or has decided on.",
  ),
});

/**
 * What both actions declare the same way.
 *
 * The three text keys are derived from the name rather than written out, so a
 * definition copied to make the next one cannot keep the previous one's title.
 * Not "ai": what the AI package may reach is a decision of its own and is not
 * made by the feature that owns the broker page.
 */
function shared(name: string) {
  return {
    name,
    titleKey: `actions.${name}.title`,
    descriptionKey: `actions.${name}.description`,
    group: "facts",
    groupTitleKey: "actions.group.facts.title",
    capability: "site:manage",
    openWorld: false,
    surfaces: ["ui", "mcp"],
    personalData: [],
    errors: FACTS_ACTION_ERRORS,
  } as const;
}

/**
 * One definition, with its schemas and its handler typed together.
 *
 * The registry takes `ActionDefinition<unknown, unknown>`, and a handler that
 * takes a parsed input is not assignable to one that takes unknown, because a
 * function parameter is contravariant. The widening happens here, once, behind
 * a signature that ties each handler to the schema whose value it is handed.
 */
function action<Input extends z.ZodType, Output extends z.ZodType>(
  definition: Omit<ActionDefinition, "input" | "output" | "handler"> & {
    readonly input: Input;
    readonly output: Output;
    readonly handler: (
      input: z.output<Input>,
      context: ActionContext,
    ) => Promise<z.output<Output>>;
  },
): ActionDefinition {
  return definition as unknown as ActionDefinition;
}

@Injectable()
export class AssociationFactsActionsRegistrar implements OnModuleInit {
  constructor(
    private readonly facts: AssociationFactsService,
    private readonly registrar: CoreActionRegistrar,
  ) {}

  onModuleInit(): void {
    this.registrar.register("site", [
      action({
        ...shared("association_facts_get"),
        effect: "read",
        idempotent: true,
        additive: false,
        needsConfirmation: false,
        input: z.strictObject({}),
        output: factsSchema,
        handler: async (_input, _context) => this.facts.read(),
      }),

      action({
        ...shared("association_facts_update"),
        effect: "write",
        // The same call twice writes the same facts and changes nothing the
        // second time, although both are recorded: an act is an act.
        idempotent: true,
        // It overwrites what the board wrote before.
        additive: false,
        needsConfirmation: false,
        input: updateSchema,
        output: factsSchema,
        handler: async (input, context) =>
          this.facts.save(input as AssociationFactsInput, actorOf(context)),
      }),
    ]);
  }
}
