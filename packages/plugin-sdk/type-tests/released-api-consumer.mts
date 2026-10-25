// A plugin's CI written against @openbrf/plugin-sdk 1.5.0, which an additive
// release keeps compiling. Its members of a group joined by extensions name no
// device routes, and it reads each refusal's website and register plugins.
import { extensionGroupRefusals } from "../src/index.ts";

export function groupRefusalLines(): string[] {
  const refusals = extensionGroupRefusals([
    { id: "host", permissions: ["site:blocks"], extends: [] },
    {
      id: "addon",
      permissions: ["addressBook:read"],
      extends: [{ plugin: "host" }],
    },
  ]);
  return [...refusals].map(
    ([id, refusal]) =>
      `${id}: ${refusal.website.join(", ")} / ${refusal.register.join(", ")}`,
  );
}
