import { getTranslations } from "next-intl/server";

export default async function DashboardPage() {
  const t = await getTranslations("dashboard");

  return (
    <div>
      <h1 className="text-xl font-semibold text-text-1">{t("title")}</h1>
      <p className="mt-2 text-sm text-text-2">
        Shell scaffold (T0.1). Dashboards are built in Sprint 5 (T5.3).
      </p>
    </div>
  );
}
