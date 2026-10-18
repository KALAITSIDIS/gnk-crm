import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { BackToListLink } from "@/components/features/properties/back-to-list-link";
import { kindLabel, type Lineage } from "@/lib/services/property-lineage";

/**
 * Properties › project › phase › this record (review 2026-10-18, A05).
 *
 * A unit's page had one way out — "← Properties", the bare list — and a phase's
 * never linked back to its project. The trail is the record's REAL ancestry,
 * read from `parent_id` and `kind` (lib/queries/property-lineage.ts); a reference
 * like PAF0002-P1-A101 is never parsed for it. Where the data disagrees with
 * the model — a parent of the wrong kind, one this reader cannot see, a read
 * that failed, a hierarchy deeper than project › phase › unit — the trail says
 * so in a warning in its place, and shows only what was actually read.
 *
 * Server-safe: no state of its own. The first crumb is the one client piece,
 * because the list view a person left lives in their tab (back-to-list-link).
 * Wraps rather than widening the page at phone width; a long reference
 * truncates, its full text in the tooltip.
 */

interface Crumb {
  id: string;
  reference: string;
  kind: string;
  title?: string | null;
  visibility?: string;
}

function Separator() {
  return (
    <span aria-hidden="true" className="text-text-3">
      ›
    </span>
  );
}

function RecordCrumb({ node }: { node: Crumb }) {
  return (
    <li className="flex min-w-0 items-center gap-1">
      <Separator />
      <Link
        href={`/properties/${node.id}`}
        title={node.title ? `${node.reference} — ${node.title}` : node.reference}
        className="inline-block max-w-[14rem] truncate align-bottom font-mono text-text-2 hover:text-brand-700 hover:underline"
      >
        {node.reference}
      </Link>
      <span className="text-xs text-text-3">
        {kindLabel(node.kind)}
        {node.visibility === "archived" ? " · archived" : ""}
      </span>
    </li>
  );
}

export function PropertyBreadcrumb({
  lineage,
  self,
  current,
}: {
  lineage: Lineage;
  /** the page's own record as a crumb — on its units page, whose last item is "Units" */
  self?: Crumb;
  /** the last item, the page itself */
  current: { label: string; mono?: boolean };
}) {
  return (
    <nav aria-label="Breadcrumb" className="mb-2">
      <ol className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
        <li>
          <BackToListLink />
        </li>
        {lineage.chain.map((node) => (
          <RecordCrumb key={node.id} node={node} />
        ))}
        {lineage.issue ? (
          <li className="flex min-w-0 items-center gap-1" data-lineage-issue={lineage.issue.code}>
            <Separator />
            <span
              role="note"
              className="inline-flex min-w-0 items-start gap-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-text-2"
            >
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-3 shrink-0 text-warning" />
              <span className="break-words">{lineage.issue.text}</span>
            </span>
          </li>
        ) : null}
        {self ? <RecordCrumb node={self} /> : null}
        <li aria-current="page" className="flex min-w-0 items-center gap-1">
          <Separator />
          <span
            className={
              current.mono
                ? "inline-block max-w-[16rem] truncate align-bottom font-mono font-medium text-text-1"
                : "font-medium text-text-1"
            }
          >
            {current.label}
          </span>
        </li>
      </ol>
    </nav>
  );
}
