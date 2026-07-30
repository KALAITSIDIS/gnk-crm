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
  title: "GN Real Estate OS",
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
