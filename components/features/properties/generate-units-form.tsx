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

  const [block, setBlock] = useState("A");
  const [floorFrom, setFloorFrom] = useState("1");
  const [floorTo, setFloorTo] = useState("5");
  const [perFloor, setPerFloor] = useState("4");
  const [basePrice, setBasePrice] = useState("");
  const [pricePerFloor, setPricePerFloor] = useState("");

  const spec = {
    block,
    floorFrom: Number(floorFrom),
    floorTo: Number(floorTo),
    perFloor: Number(perFloor),
    basePrice: basePrice ? Number(basePrice) : null,
    pricePerFloor: pricePerFloor ? Number(pricePerFloor) : null,
  };
  const valid =
    Number.isInteger(spec.floorFrom) &&
    Number.isInteger(spec.floorTo) &&
    Number.isInteger(spec.perFloor) &&
    spec.floorTo >= spec.floorFrom &&
    spec.perFloor > 0;
  const count = valid ? generatedCount(spec) : 0;
  const tooMany = count > MAX_GENERATED_UNITS;
  const preview = valid && count > 0 && !tooMany ? generateUnits(spec) : [];
  const first = preview[0];
  const last = preview[preview.length - 1];

  return (
    <form
      action={formAction}
      className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4"
    >
      <input type="hidden" name="project_id" value={projectId} />
      <h3 className="text-base font-semibold text-text-1">Generate a block</h3>
      <p className="-mt-1 text-xs text-text-3">
        Floors repeat and layouts repeat — describe the pattern once. Every unit inherits the
        project exactly as a single added unit does.
      </p>

      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="gen-block">Block</Label>
          <Input
            id="gen-block"
            name="block"
            value={block}
            onChange={(e) => setBlock(e.target.value)}
            placeholder="A"
          />
        </div>
        <div className="flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-1.5">
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
        <div className="flex flex-col gap-1.5">
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
          <Select name="property_type" defaultValue="apartment">
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
        <div className="flex flex-col gap-1.5">
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
            That is {count} units — the limit is {MAX_GENERATED_UNITS} per run. Narrow the floor
            range.
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
          <span className="text-text-3">Set a floor range to see what will be created.</span>
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
          {pending ? "Generating…" : count > 0 ? `Generate ${count} units` : "Generate units"}
        </Button>
      </div>
    </form>
  );
}
