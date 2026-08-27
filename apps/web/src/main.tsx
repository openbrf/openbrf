import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./i18n";
import "./index.css";
import { router } from "./routes/router";
import { initializeThemeMode } from "./theme/theme-mode";
import { ThemeModeProvider } from "./theme/theme-mode-context";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element #root is missing in index.html");
}

// Applied before the first render so a viewer who chose dark never sees a light
// frame flash past.
initializeThemeMode();

createRoot(container).render(
  <StrictMode>
    <ThemeModeProvider>
      <RouterProvider router={router} />
    </ThemeModeProvider>
  </StrictMode>,
);
