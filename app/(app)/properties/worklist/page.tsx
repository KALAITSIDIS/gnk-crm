import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { QualityWorklist } from "@/components/features/properties/quality-worklist";
import { Button } from "@/components/ui/button";
import { fetchQualityWorklist } from "@/lib/queries/quality-worklist";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Listing worklist (BACKLOG: *Quality-score worklist, S*).
 *
 * The quality score already knew, per property, exactly what was missing — and
 * threw it away after drawing one ring. This aggregates it so one category can
 * be cleared in a sitting.
 *
 * RLS-scoped like every other page: an agent sees the properties they can see,
 * so their worklist is their own. No admin gate — completing a listing is
 * ordinary work, not an admin function.
 */
export default async function PropertyWorklistPage() {
  const supabase = await createClient();
  const worklist = await fetchQualityWorklist(supabase);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2 mb-2 text-text-2">
          <Link href="/properties">
            <ArrowLeft className="size-4" /> Properties
          </Link>
        </Button>
        <h1 className="text-xl font-semibold text-text-1">Listing worklist</h1>
        <p className="mt-1 text-sm text-text-2">
          What the live listings are missing, grouped so one thing can be fixed across many at
          once. Ordered by the points an afternoon would recover, not by how common the gap is.
        </p>
      </div>
      <QualityWorklist worklist={worklist} />
    </div>
  );
}
