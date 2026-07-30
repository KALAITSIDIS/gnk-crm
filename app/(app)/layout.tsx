import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { LogoutButton } from "@/components/features/shared/logout-button";
import { SidebarNav } from "@/components/features/shared/sidebar-nav";
import { MobileNav } from "@/components/features/shared/mobile-nav";
import { GlobalSearch } from "@/components/features/shared/global-search";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

export default async function AppLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const t = await getTranslations("app");
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div className="flex min-h-screen w-full">
      <aside className="hidden w-[248px] shrink-0 flex-col bg-brand-950 md:flex">
        <div className="flex h-14 items-center px-6">
          <span className="text-sm font-semibold tracking-wide text-white">{t("name")}</span>
        </div>
        <SidebarNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center gap-4 border-b border-border bg-surface px-4 md:px-6">
          <MobileNav appName={t("name")} />
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden text-sm text-text-2 sm:block">{user?.email}</span>
            {/* per-user security lives outside /settings, which is admin-only */}
            <Button variant="ghost" size="icon" asChild title="Security">
              <Link href="/security">
                <ShieldCheck className="size-4" />
              </Link>
            </Button>
            {/* B8: purges the offline page cache before signing out */}
            <LogoutButton />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1440px] flex-1 p-6">
          <TooltipProvider>{children}</TooltipProvider>
        </main>
      </div>
      <Toaster position="bottom-right" />
    </div>
  );
}
