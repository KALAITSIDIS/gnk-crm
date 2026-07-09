import { getTranslations } from "next-intl/server";

export default async function LoginPage() {
  const t = await getTranslations("auth");

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2">
      <div className="w-full max-w-sm rounded-[10px] border border-border bg-surface p-8 shadow-sm">
        <h1 className="text-xl font-semibold text-text-1">{t("login")}</h1>
        <p className="mt-2 text-sm text-text-2">
          Authentication is wired in Sprint 0 (T0.2/T0.5) once Supabase is connected.
        </p>
      </div>
    </div>
  );
}
