import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages } from "next-intl/server";
import "./globals.css";
import { cn } from "@/lib/utils";

// latin + greek + cyrillic so EL/RU data renders correctly (doc 06)
const inter = Inter({
  subsets: ["latin", "greek", "cyrillic"],
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "GN Real Estate OS",
  description: "Internal real estate CRM — Kalaitsidis Capital",
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
        <NextIntlClientProvider messages={messages}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
