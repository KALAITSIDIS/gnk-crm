"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Rows3 } from "lucide-react";
import { toast } from "sonner";
import { generateProjectUnits, type UnitActionState } from "@/lib/actions/units";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { PROPERTY_TYPES } from "@/lib/validators/properties";
import {
  generatedCount,
  generateUnits,
  generateVillaUnits,
  villaCount,
  MAX_GENERATED_UNITS,
} from "@/lib/services/unit-generator";
import { formatMoney } from "@/lib/utils/format";

const initialState: UnitActionState = { error: null, savedAt: null };

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Describe a block once instead of filling a dialog sixty times (BACKLOG
 * proposal, follow-on to finding 5).
 *
 * THE LIVE PREVIEW IS THE POINT. A generator that writes sixty rows on a guess
 * is worse than typing them: a wrong numbering scheme or price rule produces
 * sixty plausible-looking rows that somebody has to find and fix by hand.
 * Showing the exact count, the first and last reference and the price range
 * turns "trust me" into "look at it".
 *
 * It shares `generateUnits` with the server action, so what the preview shows
 * is what the action writes — a second implementation for display could
 * disagree with the one that inserts, which is the worst possible bug here.
 */
export function GenerateUnitsForm({
  projectId,
  projectReference,
}: {
  projectId: string;
  projectReference: string;
}) {
  const [state, formAction, pending] = useActionState(generateProjectUnits, initialState);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Units generated");
    }
  }, [state.savedAt]);

  // Villas do not stack, so they get their own fields and their own generator
  // — see unit-generator.ts. The floor group stays the default and keeps its
  // ids, because the e2e drives this form by #gen-block and friends.
  const [layout, setLayout] = useState<"floors" | "villas">("floors");
  const isVillas = layout === "villas";

  const [block, setBlock] = useState("A");
  const [floorFrom, setFloorFrom] = useState("1");
  const [floorTo, setFloorTo] = useState("5");
  const [perFloor, setPerFloor] = useState("4");
  const [basePrice, setBasePrice] = useState("");
  const [pricePerFloor, setPricePerFloor] = useState("");
  const [villaCountRaw, setVillaCountRaw] = useState("6");
  const [villaPrefix, setVillaPrefix] = useState("V");
  const [pricePerVilla, setPricePerVilla] = useState("");
  // blank = 1. A second run must be able to CONTINUE the numbering (V07…),
  // otherwise it collides with the first and the pre-check refuses it — the
  // action accepted start_number all along, no form exposed it (2026-09-02).
  const [villaStart, setVillaStart] = useState("");

  const floorSpec = {
    block,
    floorFrom: Number(floorFrom),
    floorTo: Number(floorTo),
    perFloor: Number(perFloor),
    basePrice: basePrice ? Number(basePrice) : null,
    pricePerFloor: pricePerFloor ? Number(pricePerFloor) : null,
  };
  const villaSpec = {
    prefix: villaPrefix,
    count: Number(villaCountRaw),
    startNumber: villaStart.trim() === "" ? undefined : Number(villaStart),
    basePrice: basePrice ? Number(basePrice) : null,
    pricePerVilla: pricePerVilla ? Number(pricePerVilla) : null,
  };
  const valid = isVillas
    ? Number.isInteger(villaSpec.count) &&
      villaSpec.count > 0 &&
      (villaSpec.startNumber === undefined ||
        (Number.isInteger(villaSpec.startNumber) && villaSpec.startNumber >= 0))
    : Number.isInteger(floorSpec.floorFrom) &&
      Number.isInteger(floorSpec.floorTo) &&
      Number.isInteger(floorSpec.perFloor) &&
      floorSpec.floorTo >= floorSpec.floorFrom &&
      floorSpec.perFloor > 0;
  const count = valid ? (isVillas ? villaCount(villaSpec) : generatedCount(floorSpec)) : 0;
  const tooMany = count > MAX_GENERATED_UNITS;
  // THE SAME function the action calls — a second implementation for display
  // could disagree with the one that inserts, which is the worst bug here.
  const preview =
    valid && count > 0 && !tooMany
      ? isVillas
        ? generateVillaUnits(villaSpec)
        : generateUnits(floorSpec)
      : [];
  const first = preview[0];
  const last = preview[preview.length - 1];

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4"
    >
      <input type="hidden" name="project_id" value={projectId} />
      {/* the discriminator the action parses — Object.fromEntries only sees
          what is in the DOM, so this must be a real input */}
      <input type="hidden" name="layout" value={layout} />
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-text-1">
          {isVillas ? "Generate the villas" : "Generate a block"}
        </h3>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["floors", "villas"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() => setLayout(mode)}
              aria-pressed={layout === mode}
              className={
                layout === mode
                  ? "rounded-[6px] bg-accent-500 px-2 py-1 font-medium text-white"
                  : "rounded-[6px] px-2 py-1 text-text-2 hover:bg-surface-2"
              }
            >
              {mode === "floors" ? "Floors" : "Villas"}
            </button>
          ))}
        </div>
      </div>
      <p className="-mt-1 text-xs text-text-3">
        {isVillas
          ? "Villas do not stack — describe how many and how they are numbered. Every villa inherits the project exactly as a single added unit does."
          : "Floors repeat and layouts repeat — describe the pattern once. Every unit inherits the project exactly as a single added unit does."}
      </p>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {isVillas ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gen-villa-count">How many villas</Label>
              <Input
                id="gen-villa-count"
                name="villa_count"
                type="number"
                min="1"
                value={villaCountRaw}
                onChange={(e) => setVillaCountRaw(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gen-villa-prefix">Numbering</Label>
              <Input
                id="gen-villa-prefix"
                name="villa_prefix"
                value={villaPrefix}
                onChange={(e) => setVillaPrefix(e.target.value)}
                placeholder="V"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gen-villa-start">Start at</Label>
              <Input
                id="gen-villa-start"
                name="start_number"
                type="number"
                min="0"
                value={villaStart}
                onChange={(e) => setVillaStart(e.target.value)}
                placeholder="1"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gen-plot">Plot m² each</Label>
              <Input id="gen-plot" name="plot_area_sqm" type="number" min="0" step="0.01" />
            </div>
          </>
        ) : null}
        <div className={isVillas ? "hidden" : "flex flex-col gap-1.5"}>
          <Label htmlFor="gen-block">Block</Label>
          <Input
            id="gen-block"
            name="block"
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            placeholder="A"
          />
        </div>
        <div className={isVillas ? "hidden" : "flex flex-col gap-1.5"}>
          <Label htmlFor="gen-floor-from">Floors from</Label>
          <Input
            id="gen-floor-from"
            name="floor_from"
            type="number"
            min="0"
            value={floorFrom}
            onChange={(e) => setFloorFrom(e.target.value)}
          />
        </div>
        <div className={isVillas ? "hidden" : "flex flex-col gap-1.5"}>
          <Label htmlFor="gen-floor-to">Floors to</Label>
          <Input
            id="gen-floor-to"
            name="floor_to"
            type="number"
            min="0"
            value={floorTo}
            onChange={(e) => setFloorTo(e.target.value)}
          />
        </div>
        <div className={isVillas ? "hidden" : "flex flex-col gap-1.5"}>
          <Label htmlFor="gen-per-floor">Units per floor</Label>
          <Input
            id="gen-per-floor"
            name="per_floor"
            type="number"
            min="1"
            value={perFloor}
            onChange={(e) => setPerFloor(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-type">Type</Label>
          <Select key={layout} name="property_type" defaultValue={isVillas ? "villa" : "apartment"}>
            <SelectTrigger id="gen-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROPERTY_TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {labelize(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-beds">Beds each</Label>
          <Input id="gen-beds" name="bedrooms" type="number" min="0" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-baths">Baths each</Label>
          <Input id="gen-baths" name="bathrooms" type="number" min="0" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-area">m² each</Label>
          <Input id="gen-area" name="covered_area_sqm" type="number" min="0" step="0.01" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-base-price">Base price €</Label>
          <Input
            id="gen-base-price"
            name="base_price"
            type="number"
            min="0"
            step="0.01"
            value={basePrice}
            onChange={(e) => setBasePrice(e.target.value)}
          />
        </div>
        {isVillas ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="gen-villa-step">+ € per villa</Label>
            <Input
              id="gen-villa-step"
              name="price_per_villa"
              type="number"
              min="0"
              step="0.01"
              value={pricePerVilla}
              onChange={(e) => setPricePerVilla(e.target.value)}
            />
          </div>
        ) : null}
        <div className={isVillas ? "hidden" : "flex flex-col gap-1.5"}>
          <Label htmlFor="gen-price-step">+ € per floor</Label>
          <Input
            id="gen-price-step"
            name="price_per_floor"
            type="number"
            min="0"
            step="0.01"
            value={pricePerFloor}
            onChange={(e) => setPricePerFloor(e.target.value)}
          />
        </div>
      </div>

      <div
        data-testid="generate-preview"
        className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-text-2"
      >
        {tooMany ? (
          <span className="text-danger">
            That is {count} units — the limit is {MAX_GENERATED_UNITS} per run.{" "}
            {isVillas ? "Generate them in batches." : "Narrow the floor range."}
          </span>
        ) : first && last ? (
          <>
            Creates <span className="font-semibold text-text-1">{count}</span> units,{" "}
            <span className="font-mono text-text-1">
              {projectReference}-{first.label}
            </span>{" "}
            through{" "}
            <span className="font-mono text-text-1">
              {projectReference}-{last.label}
            </span>
            {first.asking_price !== null && last.asking_price !== null ? (
              <>
                {" · "}
                {formatMoney(first.asking_price)} to {formatMoney(last.asking_price)}
              </>
            ) : null}
          </>
        ) : (
          <span className="text-text-3">
            {isVillas
              ? "Set how many villas to see what will be created."
              : "Set a floor range to see what will be created."}
          </span>
        )}
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <div>
        <Button type="submit" size="sm" disabled={pending || tooMany || count === 0}>
          <Rows3 className="size-4" />
          {pending
            ? "Generating…"
            : count > 0
              ? `Generate ${count} ${isVillas ? "villas" : "units"}`
              : "Generate units"}
        </Button>
      </div>
    </form>
  );
}
