import { validateCimdMetadata } from "@better-auth/cimd";
import { describe, expect, it } from "vitest";

import { CIMD_METADATA_RULES } from "./auth-options";
import { MetadataFetchError } from "./cimd-fetch";
import {
  cimdMetadataFetch,
  refusingUnacceptableRedirects,
} from "./cimd-redirects";

/**
 * A client's metadata document meets the consent screen's redirect rule before
 * it is registered, so a member never says yes to an address the screen then
 * refuses to send the code to.
 */

const CLIENT_ID = "https://apps.exempel.se/brf-klient.json";

function document(redirectUris: unknown): Record<string, unknown> {
  return {
    client_id: CLIENT_ID,
    client_name: "Klient",
    redirect_uris: redirectUris,
  };
}

/** The rule around a transport that answers with this, whatever is asked. */
function answering(
  body: string,
  init: ResponseInit = { headers: { "content-type": "application/json" } },
) {
  return refusingUnacceptableRedirects(() =>
    Promise.resolve(new Response(body, init)),
  );
}

async function refusal(call: Promise<Response>): Promise<unknown> {
  try {
    await call;
  } catch (cause) {
    return cause;
  }
  throw new Error("The document was handed on.");
}

describe("a metadata document's redirect addresses", () => {
  it.each([
    "https://brf.localhost/cb",
    "https://brf.localhost./cb",
    "https://127.0.0.2/cb",
  ])("refuses a document naming %s, which the plugin alone takes", async (uri) => {
    // The plugin counts every name under localhost as loopback and skips its
    // origin check for it; the screen refuses https on this machine.
    expect(
      validateCimdMetadata(CLIENT_ID, document([uri]), CIMD_METADATA_RULES)
        .valid,
    ).toBe(true);

    const cause = await refusal(
      answering(JSON.stringify(document(["https://apps.exempel.se/cb", uri])))(
        CLIENT_ID,
      ),
    );

    expect(cause).toBeInstanceOf(MetadataFetchError);
    expect((cause as MetadataFetchError).code).toBe("redirect-uri-refused");
  });

  it("refuses an entry that is not an address at all", async () => {
    const cause = await refusal(
      answering(JSON.stringify(document([42])))(CLIENT_ID),
    );

    expect((cause as MetadataFetchError).code).toBe("redirect-uri-refused");
  });

  it("hands on a document whose every address the screen takes, unchanged", async () => {
    const body = JSON.stringify(
      document([
        "https://apps.exempel.se/cb",
        "http://127.0.0.1:8123/cb",
        "se.exempel.app:/callback",
      ]),
    );

    const response = await answering(body)(CLIENT_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.text()).toBe(body);
  });

  it.each([
    ["not JSON", "<html></html>", 200],
    ["not a 200", JSON.stringify(document(["https://brf.localhost/cb"])), 404],
    ["a key set, which names no address", JSON.stringify({ keys: [] }), 200],
  ])("leaves %s to the plugin", async (_name, body, status) => {
    const response = await answering(body, { status })(CLIENT_ID);

    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
  });

  it("runs behind the guarded transport in what the auth options hand over", async () => {
    // A URL the transport refuses before any lookup, so this holds without a
    // connection: the exported fetch is the guarded one, wrapped.
    const cause = await refusal(cimdMetadataFetch("https://localhost/c"));

    expect((cause as MetadataFetchError).code).toBe("url-not-allowed");
  });
});
