import { getRequestConfig } from "next-intl/server";

export const locales = ["en", "el", "ru"] as const;
export type Locale = (typeof locales)[number];

// Phase 1: UI ships in English only (doc 02 §A5). Locale routing is deliberately
// absent; el/ru message files exist so later phases only flip this value.
export const defaultLocale: Locale = "en";

export default getRequestConfig(async () => {
  const locale = defaultLocale;
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
    timeZone: "Asia/Nicosia",
  };
});
