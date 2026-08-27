import { defaultNS, resources } from "@openbrf/i18n";
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

void i18n.use(initReactI18next).init({
  resources,
  defaultNS,
  lng: "sv",
  fallbackLng: "en",
  interpolation: {
    // React already escapes rendered values.
    escapeValue: false,
  },
});

export default i18n;
