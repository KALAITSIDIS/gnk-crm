import {
  withheldCount,
  type Proposal as ProposalData,
  type ProposalProperty,
} from "@/lib/services/share-links";
import { publicMediaUrl } from "@/lib/utils/storage";

/**
 * The buyer-facing proposal (IMPROVEMENTS B3). Mobile-first: this is read on a
 * phone, forwarded in WhatsApp, and opened by someone who has never seen this
 * product and will not be logging in.
 *
 * Every value here arrives from `resolve_share_link`'s allowlist. This component
 * has no database access of its own, so it cannot widen what is shown.
 */

const COPY = {
  en: {
    from: "Selection prepared for you by",
    contact: "Your contact",
    expires: "This selection is available until",
    withheld: "property in this selection is no longer available",
    withheldPlural: "properties in this selection are no longer available",
    beds: "bed",
    baths: "bath",
    parking: "parking",
    built: "built",
    plot: "plot",
    poa: "Price on application",
    perMonth: "/month",
    none: "There is nothing to show in this selection at the moment.",
  },
  el: {
    from: "Επιλογή που ετοιμάστηκε για εσάς από",
    contact: "Επικοινωνία",
    expires: "Η επιλογή είναι διαθέσιμη έως",
    withheld: "ακίνητο αυτής της επιλογής δεν είναι πλέον διαθέσιμο",
    withheldPlural: "ακίνητα αυτής της επιλογής δεν είναι πλέον διαθέσιμα",
    beds: "υπνοδ.",
    baths: "μπάνια",
    parking: "στάθμευση",
    built: "έτος",
    plot: "οικόπεδο",
    poa: "Τιμή κατόπιν αιτήματος",
    perMonth: "/μήνα",
    none: "Δεν υπάρχει κάτι να εμφανιστεί σε αυτήν την επιλογή αυτή τη στιγμή.",
  },
  ru: {
    from: "Подборка подготовлена для вас",
    contact: "Ваш контакт",
    expires: "Подборка доступна до",
    withheld: "объект из этой подборки больше не доступен",
    withheldPlural: "объекта из этой подборки больше не доступны",
    beds: "спал.",
    baths: "санузл.",
    parking: "парковка",
    built: "год",
    plot: "участок",
    poa: "Цена по запросу",
    perMonth: "/месяц",
    none: "В этой подборке пока нечего показать.",
  },
} as const;

function money(amount: number | null, currency: string, locale: string): string | null {
  if (amount === null) return null;
  return new Intl.NumberFormat(locale === "en" ? "de-DE" : locale, {
    style: "currency",
    currency: currency || "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
}

function PropertyCard({
  property,
  locale,
}: {
  property: ProposalProperty;
  locale: keyof typeof COPY;
}) {
  const t = COPY[locale];
  const cover = property.media[0];
  const price =
    property.transaction_type === "rent"
      ? money(property.rent_price_month, property.currency, locale)
      : money(property.asking_price, property.currency, locale);
  const place = [property.area, property.district].filter(Boolean).join(", ");

  const facts = [
    property.bedrooms !== null ? `${property.bedrooms} ${t.beds}` : null,
    property.bathrooms !== null ? `${property.bathrooms} ${t.baths}` : null,
    property.covered_area_sqm !== null ? `${property.covered_area_sqm} m²` : null,
    property.plot_area_sqm !== null ? `${t.plot} ${property.plot_area_sqm} m²` : null,
    property.parking_spaces ? `${property.parking_spaces} ${t.parking}` : null,
    property.year_built ? `${t.built} ${property.year_built}` : null,
  ].filter((v): v is string => Boolean(v));

  return (
    <article className="overflow-hidden rounded-[10px] border border-border bg-surface">
      {cover?.card ? (
        /* eslint-disable-next-line @next/next/no-img-element -- the buyer page
           must render from the public media bucket without Next's optimizer,
           which would proxy every image through the app for an unauthenticated
           visitor. The CSP already allows the Supabase origin in img-src. */
        <img
          src={publicMediaUrl(cover.card)}
          alt={cover.alt ?? property.title ?? property.reference}
          className="aspect-[4/3] w-full object-cover"
          loading="lazy"
        />
      ) : null}

      <div className="flex flex-col gap-2 p-4">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-base font-semibold text-text-1">
            {property.title || property.reference}
          </h2>
          <span className="shrink-0 font-mono text-xs text-text-3">{property.reference}</span>
        </div>

        {place ? <p className="text-sm text-text-2">{place}</p> : null}

        <p className="text-lg font-semibold text-brand-700">
          {price ?? t.poa}
          {price && property.transaction_type === "rent" ? (
            <span className="text-sm font-normal text-text-2">{t.perMonth}</span>
          ) : null}
        </p>

        {facts.length > 0 ? (
          <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm text-text-2">
            {facts.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        ) : null}

        {property.short_description ? (
          <p className="text-sm text-text-2">{property.short_description}</p>
        ) : null}
        {property.public_description ? (
          <p className="whitespace-pre-line text-sm text-text-2">
            {property.public_description}
          </p>
        ) : null}

        {property.media.length > 1 ? (
          <div className="mt-1 grid grid-cols-3 gap-1">
            {property.media.slice(1, 7).map((m, i) =>
              m.card ? (
                /* eslint-disable-next-line @next/next/no-img-element -- see above */
                <img
                  key={m.card}
                  src={publicMediaUrl(m.card)}
                  alt={m.alt ?? `${property.reference} ${i + 2}`}
                  className="aspect-square w-full rounded object-cover"
                  loading="lazy"
                />
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function Proposal({ proposal }: { proposal: ProposalData }) {
  const locale = (
    proposal.locale in COPY ? proposal.locale : "en"
  ) as keyof typeof COPY;
  const t = COPY[locale];
  const withheld = withheldCount(proposal);
  const expires = new Date(proposal.expires_at).toLocaleDateString(
    locale === "en" ? "en-GB" : locale,
    { day: "numeric", month: "long", year: "numeric" },
  );

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-6">
      <header className="flex flex-col gap-1">
        {proposal.org?.name ? (
          <p className="text-xs uppercase tracking-wide text-text-3">
            {t.from} {proposal.org.name}
          </p>
        ) : null}
        {proposal.title ? (
          <h1 className="text-xl font-semibold text-text-1">{proposal.title}</h1>
        ) : null}
        {proposal.message ? (
          <p className="whitespace-pre-line text-sm text-text-2">{proposal.message}</p>
        ) : null}
      </header>

      {proposal.properties.length === 0 ? (
        <p className="rounded-[10px] border border-border bg-surface p-4 text-sm text-text-2">
          {t.none}
        </p>
      ) : (
        proposal.properties.map((p) => (
          <PropertyCard key={p.reference} property={p} locale={locale} />
        ))
      )}

      {/* Honest about the shortfall rather than silently showing fewer. */}
      {withheld > 0 ? (
        <p className="text-xs text-text-3">
          {withheld} {withheld === 1 ? t.withheld : t.withheldPlural}.
        </p>
      ) : null}

      {proposal.agent ? (
        <section className="rounded-[10px] border border-border bg-surface p-4">
          <h2 className="text-xs uppercase tracking-wide text-text-3">{t.contact}</h2>
          <p className="mt-1 text-sm font-medium text-text-1">{proposal.agent.name}</p>
          <p className="text-sm text-text-2">
            <a className="hover:underline" href={`mailto:${proposal.agent.email}`}>
              {proposal.agent.email}
            </a>
          </p>
          {proposal.agent.phone ? (
            <p className="text-sm text-text-2">
              <a className="hover:underline" href={`tel:${proposal.agent.phone}`}>
                {proposal.agent.phone}
              </a>
            </p>
          ) : null}
        </section>
      ) : null}

      <p className="pb-2 text-xs text-text-3">
        {t.expires} {expires}.
      </p>
    </main>
  );
}
