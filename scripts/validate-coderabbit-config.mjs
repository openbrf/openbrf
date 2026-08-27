/**
 * Validates .coderabbit.yaml against CodeRabbit's published schema.
 *
 * Written after shipping a config that CodeRabbit rejected: it silently fell
 * back to default settings, so the review rules in the file did nothing until
 * someone noticed the warning on a pull request. The failure mode is quiet,
 * which is exactly the kind worth a check.
 *
 * The schema is fetched rather than vendored so it cannot go stale. If the
 * network is unavailable the check reports that and passes, because a
 * configuration file is not worth failing a build over an offline runner.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

// The URL in CodeRabbit's own docs redirects; this is where the file lives.
const SCHEMA_URL =
  "https://storage.googleapis.com/coderabbit_public_assets/schema.v2.json";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, ".coderabbit.yaml");

let config;
try {
  config = parse(readFileSync(configPath, "utf8"));
} catch (error) {
  console.error(`.coderabbit.yaml is not valid YAML:\n${String(error)}`);
  process.exit(1);
}

let schema;
try {
  const response = await fetch(SCHEMA_URL, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}`);
  }
  schema = await response.json();
} catch (error) {
  console.log(
    `Could not fetch the CodeRabbit schema (${String(error)}). ` +
      "YAML syntax is valid; skipping schema validation.",
  );
  process.exit(0);
}

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = ajv.compile(schema);

if (validate(config)) {
  console.log(".coderabbit.yaml is valid.");
  process.exit(0);
}

console.error(".coderabbit.yaml does not match the CodeRabbit schema:");
for (const error of validate.errors ?? []) {
  const where = error.instancePath === "" ? "(root)" : error.instancePath;
  console.error(`  ${where}: ${error.message ?? "invalid"}`);
}
process.exit(1);
