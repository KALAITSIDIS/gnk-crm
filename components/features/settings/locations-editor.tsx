"use client";

import { useState, useTransition } from "react";
import { Check, Plus } from "lucide-react";
import { toast } from "sonner";
import { addArea, renameArea } from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DistrictGroup {
  id: string;
  name: string;
  areas: { id: string; name: string }[];
}

function AreaLine({ area }: { area: { id: string; name: string } }) {
  const [name, setName] = useState(area.name);
  const [pending, start] = useTransition();
  const dirty = name.trim() !== area.name;

  return (
    <li className={cn("flex items-center gap-2 py-1", pending && "opacity-60")}>
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!dirty || pending) return;
          start(async () => {
            const { error } = await renameArea(area.id, name);
            if (error) toast.error(error);
            else toast.success("Area renamed");
          });
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 max-w-56" />
        {dirty ? (
          <Button
            type="submit"
            size="sm"
            variant="outline"
            className="h-8"
            disabled={pending}
            aria-label="Save name"
          >
            <Check className="size-4" />
          </Button>
        ) : null}
      </form>
    </li>
  );
}

function AddArea({ districtId }: { districtId: string }) {
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const submit = () =>
    start(async () => {
      const { error } = await addArea(districtId, name);
      if (error) toast.error(error);
      else {
        toast.success("Area added");
        setName("");
      }
    });
  return (
    <form
      className="mt-1 flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!pending && name.trim().length > 0) submit();
      }}
    >
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="New area…"
        className="h-8 max-w-56"
      />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="h-8"
        disabled={pending || name.trim().length === 0}
      >
        <Plus className="size-4" /> Add
      </Button>
    </form>
  );
}

export function LocationsEditor({ districts }: { districts: DistrictGroup[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {districts.map((d) => (
        <section key={d.id} className="rounded-[10px] border border-border bg-surface p-5">
          <h2 className="mb-2 text-sm font-semibold text-text-1">{d.name}</h2>
          {d.areas.length === 0 ? (
            <p className="text-sm text-text-3">No areas yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-border/60">
              {d.areas.map((a) => (
                <AreaLine key={a.id} area={a} />
              ))}
            </ul>
          )}
          <AddArea districtId={d.id} />
        </section>
      ))}
    </div>
  );
}
