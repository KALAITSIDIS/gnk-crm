import { RegisterKeyDialog } from "@/components/features/keys/key-dialogs";
import {
  KeysRegister,
  type KeyRegisterRow,
} from "@/components/features/keys/keys-register";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDateTime } from "@/lib/utils/format";
import type { KeyStatus } from "@/lib/validators/keys";

export const dynamic = "force-dynamic";

export default async function KeysPage() {
  const supabase = await createClient();
  const profile = await getCurrentProfile(supabase);

  const [{ data: keyRows }, { data: movementRows }] = await Promise.all([
    supabase
      .from("property_keys")
      .select("id, key_code, description, status, current_holder_name, property_id, properties(reference)")
      .order("created_at", { ascending: false })
      .limit(300),
    supabase
      .from("key_movements")
      .select(
        `id, action, holder_name, note, occurred_at,
         property_keys(key_code, properties(reference)),
         actor:profiles!created_by(full_name)`,
      )
      .order("occurred_at", { ascending: false })
      .limit(30),
  ]);

  const keys: KeyRegisterRow[] = (keyRows ?? []).map((k) => ({
    id: k.id,
    keyCode: k.key_code,
    description: k.description,
    status: k.status as KeyStatus,
    holderName: k.current_holder_name,
    propertyId: k.property_id,
    propertyRef: (k.properties as { reference: string } | null)?.reference ?? "—",
  }));

  const movements = (movementRows ?? []).map((m) => {
    const key = m.property_keys as {
      key_code: string;
      properties: { reference: string } | null;
    } | null;
    return {
      id: m.id,
      action: m.action as string,
      holder: m.holder_name,
      note: m.note,
      at: m.occurred_at,
      keyCode: key?.key_code ?? "—",
      propertyRef: key?.properties?.reference ?? "—",
      actor: (m.actor as { full_name: string } | null)?.full_name ?? "—",
    };
  });

  const checkedOut = keys.filter((k) => k.status === "checked_out").length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-text-1">Keys</h1>
          <p className="text-sm text-text-2">
            {keys.length} registered · {checkedOut} out
          </p>
        </div>
        {profile.role === "admin" || profile.role === "listing_manager" ? (
          <RegisterKeyDialog />
        ) : null}
      </div>

      <KeysRegister keys={keys} />

      <section className="rounded-[10px] border border-border bg-surface p-5">
        <h2 className="mb-3 text-sm font-semibold text-text-1">Recent movements</h2>
        {movements.length === 0 ? (
          <p className="text-sm text-text-3">No movements yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {movements.map((m) => (
              <li key={m.id} className="flex items-baseline justify-between gap-4 py-2 text-sm">
                <span className="min-w-0 text-text-1">
                  <span className="font-mono text-xs font-semibold">{m.keyCode}</span>
                  <span className="mx-1.5 text-text-3">·</span>
                  {m.action === "checkout" ? `checked out to ${m.holder ?? "—"}` : null}
                  {m.action === "return" ? "returned to office" : null}
                  {m.action !== "checkout" && m.action !== "return"
                    ? m.action.replace("_", " ")
                    : null}
                  <span className="ml-1.5 text-xs text-text-3">
                    {m.propertyRef} · by {m.actor}
                  </span>
                  {m.note ? <span className="block text-xs text-text-3">{m.note}</span> : null}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-text-3">
                  {formatDateTime(m.at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
