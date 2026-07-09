import { getTranslations } from "next-intl/server";
import { LoginForm } from "@/components/features/shared/login-form";

export default async function LoginPage() {
  const t = await getTranslations("app");

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-2 p-4">
      <div className="w-full max-w-sm rounded-[10px] border border-border bg-surface p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold text-text-1">{t("name")}</h1>
          <p className="mt-1 text-sm text-text-2">{t("company")}</p>
        </div>
        <LoginForm />
      </div>
    </div>
  );
}
