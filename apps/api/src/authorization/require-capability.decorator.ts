// The decorator lives in the plugin SDK, so a plugin's controller and the API read
// the same key. REQUIRED_CAPABILITIES is this module's old name for that key, kept as an alias.
export {
  REQUIRED_CAPABILITIES_KEY as REQUIRED_CAPABILITIES,
  RequireCapability,
} from "@openbrf/plugin-sdk";
