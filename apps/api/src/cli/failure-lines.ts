import { pluginInstallFailureValues } from "@openbrf/shared";
import type { TFunction } from "i18next";

import { installFailureLabelKey } from "../plugins/plugin-labels";
import type { PluginRecord } from "../plugins/plugin-registry.service";

/**
 * Why the last install failed, as the admin screen says it, and what was
 * thrown. A row that failed before failures carried a code has only the
 * second, and prints it as the reason exactly as it always did.
 */
export function failureLines(record: PluginRecord, t: TFunction): string[] {
  if (record.failure === null) {
    return record.lastError === null
      ? []
      : [`  last error   ${record.lastError}`];
  }
  const sentence = t(installFailureLabelKey(record.failure.reason), {
    ...pluginInstallFailureValues(record.failure.detail),
    reason: record.failure.reason,
  });
  return record.lastError === null
    ? [`  last error   ${sentence}`]
    : [`  last error   ${sentence}`, `  cause        ${record.lastError}`];
}
