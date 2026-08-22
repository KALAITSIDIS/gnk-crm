import {
  groupUnitsByPhase,
  statusSummary,
  type Availability as AvailabilityData,
  type AvailabilityGroup,
  type AvailabilityUnit,
} from "@/lib/services/share-links";

/**
 * The developer/partner-facing availability matrix (migration 0041).
 *
 * PUBLIC and unauthenticated, exactly like the proposal page beside it, and
 * built the same way: every value arrives from `resolve_share_link`'s
 * allowlist, and this component has no database access of its own, so it
 * cannot widen what is shown.
 *
 * Two deliberate differences from `proposal.tsx`. It is a TABLE, because the
 * question being answered is "what is left" across sixty rows and a stack of
 * cards cannot be scanned. And it shows `status` — the one field 0023 keeps
 * from buyers and 0041 opens to this audience, because "40 available · 12 sold"
 * is the entire product.
 *
 * The status tones mirror `components/features/shared/status-badge.tsx` so the
 * visual language matches the staff app, but the map is LOCAL rather than
 * imported: that component's labels are English-only and this page is read in
 * three languages.
 */

const COPY = {
  en: {
    from: "Availability prepared by",
    contact: "Your contact",
    expires: "This availability page is live until",
    unit: "Unit",
    beds: "Beds",
    baths: "Baths",
    area: "Area",
    floor: "Floor",
    price: "Price",
    status: "Status",
    poa: "On application",
    delivery: "Delivery",
    of: "of",
    availableIn: "available",
    directUnits: "Units",
    livePrices: "Prices are live and change as the desk updates them.",
    pinnedPrices: "Prices are those of price list version",
    effective: "effective",
    unpriced: "unit is not in that price list and shows no price",
    unpricedPlural: "units are not in that price list and show no price",
    none: "There are no units to show for this project at the moment.",
    statuses: {
      available: "Available",
      reserved: "Reserved",
      under_offer: "Under offer",
      sold: "Sold",
      rented: "Rented",
      withdrawn: "Withdrawn",
    } as Record<string, string>,
  },
  el: {
    from: "Διαθεσιμότητα από",
    contact: "Επικοινωνία",
    expires: "Η σελίδα διαθεσιμότητας ισχύει έως",
    unit: "Μονάδα",
    beds: "Υπνοδ.",
    baths: "Μπάνια",
    area: "Εμβαδόν",
    floor: "Όροφος",
    price: "Τιμή",
    status: "Κατάσταση",
    poa: "Κατόπιν αιτήματος",
    delivery: "Παράδοση",
    of: "από",
    availableIn: "διαθέσιμες",
    directUnits: "Μονάδες",
    livePrices: "Οι τιμές είναι ζωντανές και αλλάζουν με κάθε ενημέρωση.",
    pinnedPrices: "Οι τιμές είναι του τιμοκαταλόγου έκδοση",
    effective: "με ισχύ από",
    unpriced: "μονάδα δεν περιλαμβάνεται στον τιμοκατάλογο και δεν έχει τιμή",
    unpricedPlural: "μονάδες δεν περιλαμβάνονται στον τιμοκατάλογο και δεν έχουν τιμή",
    none: "Δεν υπάρχουν μονάδες προς εμφάνιση για αυτό το έργο αυτή τη στιγμή.",
    statuses: {
      available: "Διαθέσιμη",
      reserved: "Κρατημένη",
      under_offer: "Υπό προσφορά",
      sold: "Πωλήθηκε",
      rented: "Ενοικιάστηκε",
      withdrawn: "Αποσύρθηκε",
    } as Record<string, string>,
  },
  ru: {
    from: "Наличие подготовлено",
    contact: "Ваш контакт",
    expires: "Страница наличия действительна до",
    unit: "Юнит",
    beds: "Спален",
    baths: "Санузлов",
    area: "Площадь",
    floor: "Этаж",
    price: "Цена",
    status: "Статус",
    poa: "По запросу",
    delivery: "Сдача",
    of: "из",
    availableIn: "свободно",
    directUnits: "Юниты",
    livePrices: "Цены актуальные и меняются по мере обновления.",
    pinnedPrices: "Цены из прайс-листа версии",
    effective: "действует с",
    unpriced: "юнит отсутствует в этом прайс-листе и показан без цены",
    unpricedPlural: "юнита отсутствуют в этом прайс-листе и показаны без цены",
    none: "Для этого проекта пока нет юнитов для показа.",
    statuses: {
      available: "Свободен",
      reserved: "Забронирован",
      under_offer: "Есть предложение",
      sold: "Продан",
      rented: "Сдан",
      withdrawn: "Снят",
    } as Record<string, string>,
  },
} as const;

/** Tones mirror the staff StatusBadge; unknown statuses fall back to neutral. */
const TONES: Record<string, { dot: string; text: string }> = {
  available: { dot: "bg-success", text: "text-success" },
  reserved: { dot: "bg-warning", text: "text-warning" },
  under_offer: { dot: "bg-warning", text: "text-warning" },
  sold: { dot: "bg-brand-500", text: "text-brand-700" },
  rented: { dot: "bg-brand-500", text: "text-brand-700" },
  withdrawn: { dot: "bg-text-3", text: "text-text-2" },
};

function money(amount: number | null, currency: string, locale: string): string | null {
  if (amount === null) return null;
  return new Intl.NumberFormat(locale === "en" ? "de-DE" : locale, {
    style: "currency",
    currency: currency || "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * Off-plan delivery is quoted as a month, not a day. Forced to UTC because a
 * bare `new Date("2028-03-01")` is UTC midnight and would render as February in
 * any timezone behind it — a wrong handover month on a developer's desk.
 */
function monthYear(date: string | null, locale: string): string | null {
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m) return null;
  return new Date(Date.UTC(y, m - 1, d || 1)).toLocaleDateString(
    locale === "en" ? "en-GB" : locale,
    { month: "long", year: "numeric", timeZone: "UTC" },
  );
}

function StatusCell({ status, label }: { status: string; label: string }) {
  const tone = TONES[status] ?? TONES.withdrawn;
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${tone.text}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${tone.dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}

function unitLabel(unit: AvailabilityUnit): string {
  const composed = [unit.block, unit.unit_number].filter(Boolean).join("");
  return composed || unit.reference;
}

function UnitsTable({
  units,
  currency,
  locale,
}: {
  units: AvailabilityUnit[];
  currency: string;
  locale: keyof typeof COPY;
}) {
  const t = COPY[locale];

  return (
    /* The matrix is wider than a phone. It scrolls inside its own box rather
       than making the whole page scroll sideways. */
    <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
      <table className="w-full min-w-[34rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-text-3">
            <th scope="col" className="px-3 py-2 font-medium">
              {t.unit}
            </th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
              {t.beds}
            </th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
              {t.baths}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t.area}
            </th>
            <th scope="col" className="hidden px-3 py-2 text-right font-medium sm:table-cell">
              {t.floor}
            </th>
            <th scope="col" className="px-3 py-2 text-right font-medium">
              {t.price}
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              {t.status}
            </th>
          </tr>
        </thead>
        <tbody>
          {units.map((unit) => {
            const price = money(unit.price, currency, locale);
            return (
              <tr key={unit.reference} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium text-text-1">{unitLabel(unit)}</span>
                  <span className="block font-mono text-xs text-text-3">{unit.reference}</span>
                </td>
                <td className="hidden px-3 py-2 text-right text-text-2 sm:table-cell">
                  {unit.bedrooms ?? "—"}
                </td>
                <td className="hidden px-3 py-2 text-right text-text-2 sm:table-cell">
                  {unit.bathrooms ?? "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right text-text-2">
                  {unit.covered_area_sqm !== null ? `${unit.covered_area_sqm} m²` : "—"}
                  {unit.veranda_sqm ? (
                    <span className="block text-xs text-text-3">+{unit.veranda_sqm} m²</span>
                  ) : null}
                </td>
                <td className="hidden px-3 py-2 text-right text-text-2 sm:table-cell">
                  {unit.floor_number ?? "—"}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right font-medium text-text-1">
                  {price ?? <span className="font-normal text-text-3">{t.poa}</span>}
                </td>
                <td className="px-3 py-2">
                  <StatusCell
                    status={unit.status}
                    label={t.statuses[unit.status] ?? unit.status.replace(/_/g, " ")}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PhaseSection({
  group,
  currency,
  locale,
}: {
  group: AvailabilityGroup;
  currency: string;
  locale: keyof typeof COPY;
}) {
  const t = COPY[locale];
  const delivery = monthYear(group.phase?.delivery_date ?? null, locale);

  return (
    <section className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-base font-semibold text-text-1">
          {group.phase ? group.phase.title || group.phase.reference : t.directUnits}
          {group.phase?.title ? (
            <span className="ml-2 font-mono text-xs font-normal text-text-3">
              {group.phase.reference}
            </span>
          ) : null}
        </h2>
        <p className="text-sm text-text-2">
          {group.availableCount} {t.of} {group.units.length} {t.availableIn}
          {/* A phase's delivery date is its OWN — that is why phases exist, and
              why it belongs on the heading rather than only on the project. */}
          {delivery ? ` · ${t.delivery} ${delivery}` : ""}
        </p>
      </div>
      <UnitsTable units={group.units} currency={currency} locale={locale} />
    </section>
  );
}

export function Availability({ availability }: { availability: AvailabilityData }) {
  const locale = (
    availability.locale in COPY ? availability.locale : "en"
  ) as keyof typeof COPY;
  const t = COPY[locale];

  const groups = groupUnitsByPhase(availability);
  const summary = statusSummary(availability.units);
  const project = availability.project;
  const place = [project.area, project.district].filter(Boolean).join(", ");
  const projectDelivery = monthYear(project.delivery_date, locale);
  const priceListDate = availability.price_list
    ? monthYear(availability.price_list.effective_date, locale)
    : null;
  const expires = new Date(availability.expires_at).toLocaleDateString(
    locale === "en" ? "en-GB" : locale,
    { day: "numeric", month: "long", year: "numeric" },
  );

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-6">
      <header className="flex flex-col gap-1">
        {availability.org?.name ? (
          <p className="text-xs uppercase tracking-wide text-text-3">
            {t.from} {availability.org.name}
          </p>
        ) : null}
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h1 className="text-xl font-semibold text-text-1">
            {availability.title || project.title || project.reference}
          </h1>
          <span className="font-mono text-xs text-text-3">{project.reference}</span>
        </div>
        {place ? <p className="text-sm text-text-2">{place}</p> : null}
        {projectDelivery ? (
          <p className="text-sm text-text-2">
            {t.delivery} {projectDelivery}
          </p>
        ) : null}
        {availability.message ? (
          <p className="mt-1 whitespace-pre-line text-sm text-text-2">{availability.message}</p>
        ) : null}
      </header>

      {/* The headline. This is the sentence the link exists to say. */}
      {summary.length > 0 ? (
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {summary.map((s) => (
            <li key={s.status}>
              <StatusCell
                status={s.status}
                label={`${s.count} ${(t.statuses[s.status] ?? s.status.replace(/_/g, " ")).toLowerCase()}`}
              />
            </li>
          ))}
        </ul>
      ) : null}

      {project.short_description ? (
        <p className="text-sm text-text-2">{project.short_description}</p>
      ) : null}

      {availability.units.length === 0 ? (
        <p className="rounded-[10px] border border-border bg-surface p-4 text-sm text-text-2">
          {t.none}
        </p>
      ) : (
        groups.map((group) => (
          <PhaseSection
            key={group.phase?.reference ?? "direct"}
            group={group}
            currency={project.currency}
            locale={locale}
          />
        ))
      )}

      {/* Which prices these are, said out loud. A pinned version does NOT fall
          back to live numbers for units it omits, so the shortfall is named
          rather than left to look like a data error. */}
      <p className="text-xs text-text-3">
        {availability.price_source === "price_list" && availability.price_list
          ? `${t.pinnedPrices} ${availability.price_list.version}${
              priceListDate ? `, ${t.effective} ${priceListDate}` : ""
            }.`
          : t.livePrices}
        {availability.price_source === "price_list" && availability.unpriced_count > 0
          ? ` ${availability.unpriced_count} ${
              availability.unpriced_count === 1 ? t.unpriced : t.unpricedPlural
            }.`
          : ""}
      </p>

      {availability.agent ? (
        <section className="rounded-[10px] border border-border bg-surface p-4">
          <h2 className="text-xs uppercase tracking-wide text-text-3">{t.contact}</h2>
          <p className="mt-1 text-sm font-medium text-text-1">{availability.agent.name}</p>
          <p className="text-sm text-text-2">
            <a className="hover:underline" href={`mailto:${availability.agent.email}`}>
              {availability.agent.email}
            </a>
          </p>
          {availability.agent.phone ? (
            <p className="text-sm text-text-2">
              <a className="hover:underline" href={`tel:${availability.agent.phone}`}>
                {availability.agent.phone}
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
