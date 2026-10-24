import { Injectable } from "@nestjs/common";

import { ActionRegistryService } from "./action-registry.service";
import type { CoreActionDefinition } from "./core-action";

/**
 * How a core feature registers its actions.
 *
 * The only way core code reaches `register`, so that a core owner is never
 * spelled by hand: an owner written out at a call site is an owner that can be
 * written differently at the next one, and `unregisterOwner` would then have
 * nothing to match. The module's own name goes in once, here.
 */
@Injectable()
export class CoreActionRegistrar {
  constructor(private readonly registry: ActionRegistryService) {}

  register(module: string, definitions: readonly CoreActionDefinition[]): void {
    for (const definition of definitions) {
      this.registry.register(definition, { kind: "core", module });
    }
  }
}
