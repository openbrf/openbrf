import type { ActionContext, ActionDefinition } from "@openbrf/plugin-sdk";
import type { z } from "zod";

/**
 * One definition, with its schemas and its handler typed together.
 *
 * The registry takes `ActionDefinition<unknown, unknown>`, and a handler that
 * takes a parsed input is not assignable to one that takes unknown, because a
 * function parameter is contravariant. So the widening happens here, once,
 * behind a signature that ties each handler to the schema whose value it is
 * actually handed. The alternative is a cast at every call site, each one a
 * place where a handler could be bound to another action's schema and the
 * compiler would have been told not to mind.
 */
export function typedAction<Input extends z.ZodType, Output extends z.ZodType>(
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
