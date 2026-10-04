import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import type { Env } from "../config/env";
import { registerSecurityHeaders } from "./security-headers";

function server(env: Partial<Env>) {
  const app = Fastify();
  registerSecurityHeaders(app, {
    NODE_ENV: "production",
    APP_URL: "https://brf.example",
    ...env,
  } as Env);
  app.get("/api/health", () => ({ ok: true }));
  app.get("/framed-elsewhere", (_request, reply) =>
    reply.header("x-frame-options", "DENY").send("x"),
  );
  return app;
}

describe("the headers every response carries", () => {
  it("keeps an answer from being framed by another site or sniffed", async () => {
    const response = await server({}).inject({ url: "/api/health" });

    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("same-origin");
    expect(response.headers["strict-transport-security"]).toBe(
      "max-age=31536000",
    );
  });

  it("leaves a route's own choice as it is", async () => {
    const response = await server({}).inject({ url: "/framed-elsewhere" });

    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  it("sends no HSTS for an instance served over plain http", async () => {
    const response = await server({
      NODE_ENV: "development",
      APP_URL: "http://localhost:5173",
    }).inject({ url: "/api/health" });

    expect(response.headers["strict-transport-security"]).toBeUndefined();
  });
});
