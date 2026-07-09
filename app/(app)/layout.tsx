import { getTranslations } from "next-intl/server";
import { Search } from "lucide-react";
import { SidebarNav } from "@/components/features/shared/sidebar-nav";

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const t = await getTranslations("app");

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-[248px] shrink-0 flex-col bg-brand-950 md:flex">
        <div className="flex h-14 items-center px-6">
          <span className="text-sm font-semibold tracking-wide text-white">{t("name")}</span>
        </div>
        <SidebarNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-6">
          <div className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 text-sm text-text-3">
            <Search className="size-4" />
            <span>Search properties, contacts…</span>
            <kbd className="ml-auto rounded border border-border bg-surface px-1.5 text-xs">⌘K</kbd>
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
