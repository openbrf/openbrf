import { describe, expect, it } from "vitest";

import { isApiRequest } from "./serve-single-page-app";

/**
 * The wildcard route this decides for is the last thing a request meets, so a
 * wrong answer is silent: an API path gets the client's index.html with a 200
 * instead of the JSON 404 an integration reads, and a client route gets a JSON
 * body instead of the screen.
 */
describe("isApiRequest", () => {
  it("claims the API paths", () => {
    expect(isApiRequest("/health")).toBe(true);
    expect(isApiRequest("/api")).toBe(true);
    expect(isApiRequest("/api/address-book")).toBe(true);
  });

  it("claims them with a query string as well", () => {
    // The request URL carries the query string, so a decision made on the whole
    // of it answers differently for the same path.
    expect(isApiRequest("/health?probe=1")).toBe(true);
    expect(isApiRequest("/api?x=1")).toBe(true);
    expect(isApiRequest("/api/address-book?search=Berg")).toBe(true);
    expect(isApiRequest("/api#fragment")).toBe(true);
  });

  it("leaves the client's own routes to the client", () => {
    expect(isApiRequest("/")).toBe(false);
    expect(isApiRequest("/settings")).toBe(false);
    expect(isApiRequest("/settings?panel=email")).toBe(false);
  });

  it("does not claim a path that merely begins with the same letters", () => {
    expect(isApiRequest("/apiary")).toBe(false);
    expect(isApiRequest("/healthcheck")).toBe(false);
  });
});
