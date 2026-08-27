import type { Resources } from "@openbrf/i18n";

// Makes t() keys type-checked against the canonical en.json schema.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: Resources;
  }
}
