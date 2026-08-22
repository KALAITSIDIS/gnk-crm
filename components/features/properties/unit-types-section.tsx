"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { LayoutTemplate, Plus, Stamp } from "lucide-react";
import { toast } from "sonner";
import { applyUnitType, createUnitType, type UnitActionState } from "@/lib/actions/units";
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
import { describeType, priceFromType, type UnitType } from "@/lib/services/unit-type";
import { formatMoney } from "@/lib/utils/format";

const initialState: UnitActionState = { error: null, savedAt: null };
const ALL_BLOCKS = "__all__";

/**
 * Unit type templates (migration 0039).
 *
 * A project sells four or five layouts repeated across every floor. Defining
 * one here and stamping it beats retyping beds, baths and area per block, then
 * pricing every unit by hand.
 *
 * The apply control says STAMP rather than "link" on purpose: it copies the
 * layout now and the unit is not bound to the type afterwards. Two units of one
 * layout legitimately diverge, so there is no drift panel for types and none is
 * implied.
 */
export function UnitTypesSection({
  projectId,
  types,
  blocks,
  unitCount,
  canManage,
}: {
  projectId: string;
  types: UnitType[];
  blocks: string[];
  unitCount: number;
  canManage: boolean;
}) {
  const [createState, createAction, creating] = useActionState(createUnitType, initialState);
  const [applyState, applyAction, applying] = useActionState(applyUnitType, initialState);
  const created = useRef<number | null>(null);
  const stamped = useRef<number | null>(null);

  useEffect(() => {
    if (createState.savedAt && createState.savedAt !== created.current) {
      created.current = createState.savedAt;
      toast.success("Unit type saved");
    }
  }, [createState.savedAt]);

  useEffect(() => {
    if (applyState.savedAt && applyState.savedAt !== stamped.current) {
      stamped.current = applyState.savedAt;
      toast.success("Layout applied to the units");
    }
  }, [applyState.savedAt]);

  const [typeId, setTypeId] = useState<string>("");
  const [block, setBlock] = useState<string>(ALL_BLOCKS);
  const chosen = types.find((t) => t.id === typeId) ?? null;

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface p-4">
      <div>
        <h3 className="text-base font-semibold text-text-1">Unit types</h3>
        <p className="mt-1 text-xs text-text-3">
          A layout defined once — beds, baths, area and a €/m² rate on covered area. Applying one
          copies it onto the units; they are not bound to it afterwards.
        </p>
      </div>

      {types.length === 0 ? (
        <p className="text-sm text-text-3">
          No types yet. Worth one only if this project repeats a few layouts across its floors.
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {types.map((t) => (
            <li key={t.id} className="flex flex-wrap items-baseline gap-x-3 py-2 text-sm">
              <LayoutTemplate className="size-4 shrink-0 self-center text-text-3" />
              <span className="font-mono font-medium text-text-1">{t.code}</span>
              <span className="text-text-2">{t.name ?? "—"}</span>
              <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-text-2">
                <span>
                  {t.bedrooms ?? "—"} bed · {t.bathrooms ?? "—"} bath
                </span>
                <span>
                  {t.covered_area_sqm ?? "—"} m²
                  {t.veranda_sqm ? ` + ${t.veranda_sqm} veranda` : ""}
                </span>
                <span className="font-medium text-text-1">
                  {priceFromType(t) === null ? "no rate" : formatMoney(priceFromType(t))}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}

      {canManage && types.length > 0 && unitCount > 0 ? (
        <form action={applyAction} className="flex flex-col gap-3 border-t border-border/60 pt-3">
          <input type="hidden" name="project_id" value={projectId} />
          <input type="hidden" name="unit_type_id" value={typeId} />
          <input type="hidden" name="block" value={block === ALL_BLOCKS ? "" : block} />
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-apply">Apply a type</Label>
              <Select value={typeId} onValueChange={setTypeId}>
                <SelectTrigger id="ut-apply">
                  <SelectValue placeholder="Choose a layout…" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      {describeType(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-scope">To</Label>
              <Select value={block} onValueChange={setBlock}>
                <SelectTrigger id="ut-scope">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BLOCKS}>All units ({unitCount})</SelectItem>
                  {blocks.map((b) => (
                    <SelectItem key={b} value={b}>
                      Block {b}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="submit" size="sm" disabled={applying || !typeId}>
                <Stamp className="size-4" /> {applying ? "Applying…" : "Stamp onto units"}
              </Button>
            </div>
          </div>
          {chosen ? (
            <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-text-2">
              Overwrites beds, baths, area and veranda on every unit in scope.{" "}
              {priceFromType(chosen) === null
                ? "This type has no €/m² rate, so existing prices are left alone."
                : `Prices become ${formatMoney(priceFromType(chosen))}.`}
            </p>
          ) : null}
          {applyState.error ? (
            <p role="alert" className="text-sm text-danger">
              {applyState.error}
            </p>
          ) : null}
        </form>
      ) : null}

      {canManage ? (
        <form action={createAction} className="flex flex-col gap-3 border-t border-border/60 pt-3">
          <input type="hidden" name="project_id" value={projectId} />
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-code">Code *</Label>
              <Input id="ut-code" name="code" placeholder="A1" maxLength={10} required />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ut-name">Name</Label>
              <Input id="ut-name" name="name" placeholder="Two-bed corner" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-beds">Beds</Label>
              <Input id="ut-beds" name="bedrooms" type="number" min="0" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-baths">Baths</Label>
              <Input id="ut-baths" name="bathrooms" type="number" min="0" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-area">Covered m²</Label>
              <Input id="ut-area" name="covered_area_sqm" type="number" min="0" step="0.01" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ut-veranda">Veranda m²</Label>
              <Input id="ut-veranda" name="veranda_sqm" type="number" min="0" step="0.01" />
            </div>
            <div className="flex flex-col gap-1.5 sm:col-span-2">
              <Label htmlFor="ut-rate">€ / m² (covered)</Label>
              <Input id="ut-rate" name="price_per_sqm" type="number" min="0" step="1" />
              <p className="text-xs text-text-3">
                Veranda is recorded but not priced — how it is charged varies by project.
              </p>
            </div>
          </div>
          {createState.error ? (
            <p role="alert" className="text-sm text-danger">
              {createState.error}
            </p>
          ) : null}
          <div>
            <Button type="submit" size="sm" variant="outline" disabled={creating}>
              <Plus className="size-4" /> {creating ? "Saving…" : "Add type"}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
