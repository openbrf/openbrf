import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import "./i18n";
import "./index.css";
import { ThemeModeProvider } from "./theme/theme-mode-context";
import { initializeThemeMode } from "./theme/theme-mode";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root element #root is missing in index.html");
}

// Applied before the first render so a viewer who chose dark never sees a
// light frame flash past.
initializeThemeMode();

createRoot(container).render(
  <StrictMode>
    <ThemeModeProvider>
      <App />
    </ThemeModeProvider>
  </StrictMode>,
);
