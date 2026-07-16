import Link from "next/link";

/**
 * Shared dashboard card chrome (T5.3; deduplicated in the 2026-07-16 audit).
 * `icon`/`count` are the agent-dashboard extras — admin cards omit them.
 * `count` is the EXACT match count from the query (`count: "exact"`), not the
 * length of the limit-capped list, so "23" can badge a list showing 10.
 */
export function Card({
  title,
  icon,
  count,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[10px] border border-border bg-surface p-4 sm:p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-1">
        {icon}
        {title}
        {count !== undefined ? (
          <span className="ml-auto rounded-full bg-surface-2 px-2 py-0.5 text-xs tabular-nums text-text-2">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  );
}

/** Empty state with the doc 05 "primary action" link (omit href for none). */
export function CardEmpty({
  text,
  href,
  action,
}: {
  text: string;
  href?: string;
  action?: string;
}) {
  return (
    <p className="text-sm text-text-3">
      {text}
      {href && action ? (
        <>
          {" "}
          <Link href={href} className="font-medium text-brand-700 hover:underline">
            {action} →
          </Link>
        </>
      ) : null}
    </p>
  );
}
