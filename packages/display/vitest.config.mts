import { defineConfig } from "vite-plus";

// Node by default; the renderer's suite asks for jsdom in its first line.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"],
  },
});
