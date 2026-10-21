import { Injectable, type OnModuleInit } from "@nestjs/common";

import { BrokerUpdateRequestService } from "../broker-update-requests/broker-update-request.service";
import { AssociationFactsService } from "./association-facts.service";

/**
 * Makes a confirmation of the facts the answer to brokers' open update
 * requests.
 *
 * Registered here, in the module that owns the facts, rather than by the
 * update request module: that module is imported by this one for the form,
 * and reaching back for the facts service would make the two depend on each
 * other in a circle. The hook runs inside the confirmation's transaction
 * (AssociationFactsService.onConfirmed), so the date on the page and the
 * state of the queue move together or not at all.
 */
@Injectable()
export class BrokerUpdateRequestAnswers implements OnModuleInit {
  constructor(
    private readonly facts: AssociationFactsService,
    private readonly requests: BrokerUpdateRequestService,
  ) {}

  onModuleInit(): void {
    this.facts.onConfirmed(async (tx, event) => {
      await this.requests.answerOpen(tx, event);
    });
  }
}
