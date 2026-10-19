import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/features/shared/pwa";
import { ZodConfig } from "@/components/features/shared/zod-config";
import { cn } from "@/lib/utils";
// server-side half of the same setting (the import above covers the browser)
import "@/lib/validators/zod-jitless";

// latin + greek + cyrillic so EL/RU data renders correctly (doc 06)
const inter = Inter({
  subsets: ["latin", "greek", "cyrillic"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  // A08: every page names itself in the tab — "Leads · GN REOS", "PAF0042 ·
  // GN REOS" — so a row of tabs, the history and a bookmark say which screen
  // each is. A page sets only its own words (a static `metadata`, or the
  // property pages' generateMetadata); the suffix is added here, once. A page
  // with no title of its own keeps the default. tests/unit/page-titles.test.ts
  // pins both halves.
  title: { default: "GN Real Estate OS", template: "%s · GN REOS" },
  description: "Internal real estate CRM — Kalaitsidis Capital",
  // B8: installable on an agent's phone. `apple-touch-icon` is a separate
  // mechanism from the manifest — iOS reads it and ignores manifest icons.
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "GN REOS", statusBarStyle: "black-translucent" },
  icons: { icon: "/icon-192.png", apple: "/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  themeColor: "#0B1F33",
  // The slip-signing screen is used one-handed outdoors; let it fill the notch
  // area rather than letterboxing.
  viewportFit: "cover",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    <html lang={locale} className={cn("h-full antialiased font-sans", inter.variable)}>
      <body className="min-h-full flex flex-col">
        <ZodConfig />
        <ServiceWorkerRegistrar />
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
