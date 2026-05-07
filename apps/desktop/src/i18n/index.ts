import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

import enUS from "./locales/en-US";
import zhCN from "./locales/zh-CN";

export const SUPPORTED_LOCALES = ["en-US", "zh-CN"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<Locale, string> = {
  "en-US": "EN",
  "zh-CN": "中",
};

// Register the same payload under the bare language code as well as the
// region-tagged code. `LanguageDetector` may surface `"en"` or `"zh"` from
// `navigator.language` depending on the OS / browser; without these aliases
// `t(...)` falls back to the literal key name. Cheap belt + suspenders.
const resources = {
  "en-US": { translation: enUS },
  en: { translation: enUS },
  "zh-CN": { translation: zhCN },
  zh: { translation: zhCN },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: "en-US",
    supportedLngs: ["en-US", "en", "zh-CN", "zh"],
    nonExplicitSupportedLngs: true,
    load: "currentOnly",
    detection: {
      order: ["localStorage", "navigator", "htmlTag"],
      caches: ["localStorage"],
      lookupLocalStorage: "videtor.locale",
    },
    interpolation: {
      escapeValue: false, // React already escapes
    },
    react: {
      // We bundle resources synchronously, so suspense isn't needed and only
      // causes flashes-of-blank-UI without an outer <Suspense> boundary.
      useSuspense: false,
    },
    returnNull: false,
    // Flip to true while debugging missing-key issues — i18next then logs each
    // lookup to the browser console, which makes it obvious when a locale or
    // namespace isn't loading.
    debug: false,
  });

export default i18n;
