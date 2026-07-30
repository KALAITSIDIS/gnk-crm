import { ShareLinksClient } from "@/components/features/share-links/share-links-client";
import { getCurrentProfile } from "@/lib/services/auth";
import { createClient } from "@/lib/supabase/server";
import { unwrapRows } from "@/lib/supabase/unwrap";

export const dynamic = "force-dynamic";

/**
 * Buyer proposal links (IMPROVEMENTS B3). Mint a tokenised, expiring, no-login
 * page for a shortlist of properties, and retire it on demand.
 *
 * Doc 01 §4 forbids buyer logins ever — this is the sanctioned alternative, so
 * the agent-facing half is deliberately small: create, watch, revoke.
 */
export default async function ShareLinksPage() {
  const supabase = await createClient();
  await getCurrentProfile(supabase);

  const [linksRes, propertiesRes] = await Promise.all([
    // RLS scopes both to the caller's org.
    supabase
      .from("share_links")
      .select(
        "id, title, locale, expires_at, revoked_at, view_count, last_opened_at, created_at, contact_id, share_link_properties(property_id), contacts(display_name)",
      )
      .order("created_at", { ascending: false })
      .limit(100),
    // The curation pool. Archived listings are excluded: `resolve_share_link`
    // drops them from the payload anyway, so offering them would let an agent
    // build a proposal that silently renders short.
    supabase
      .from("properties")
      .select("id, reference, title, asking_price, currency, property_type, visibility")
      .neq("visibility", "archived")
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  // Failures throw to the boundary — an empty list must mean empty, not broken.
  const links = unwrapRows(linksRes, "share links");
  const properties = unwrapRows(propertiesRes, "properties");

  return (
    <ShareLinksClient
      links={links.map((l) => ({
        id: l.id,
        title: l.title,
        locale: l.locale,
        expiresAt: l.expires_at,
        revokedAt: l.revoked_at,
        viewCount: l.view_count,
        lastOpenedAt: l.last_opened_at,
        propertyCount: (l.share_link_properties as { property_id: string }[] | null)?.length ?? 0,
        contactName:
          (l.contacts as { display_name: string | null } | null)?.display_name ?? null,
      }))}
      properties={properties.map((p) => ({
        id: p.id,
        reference: p.reference,
        title: (p.title as Record<string, string> | null)?.en ?? null,
        askingPrice: p.asking_price,
        currency: p.currency,
        propertyType: p.property_type,
      }))}
    />
  );
}
