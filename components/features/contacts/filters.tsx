"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CONTACT_LANGUAGES,
  CONTACT_TYPES,
  LEAD_SOURCES,
  TEMPERATURES,
} from "@/lib/validators/contacts";

const ALL = "__all__";

function labelize(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export function ContactsFilters({ agents }: { agents: { id: string; full_name: string }[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const setParams = useCallback(
    (updates: Record<string, string | undefined>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === undefined || value === "" || value === ALL) params.delete(key);
        else params.set(key, value);
      }
      params.delete("page");
      router.replace(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams],
  );

  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, []);
  const onSearchChange = (value: string) => {
    setSearch(value);
    if (debounce.current) clearTimeout(debounce.current);
    debounce.current = setTimeout(() => setParams({ q: value || undefined }), 300);
  };

  const hasFilters = ["q", "type", "temperature", "source", "agent", "nationality", "language"].some(
    (k) => searchParams.has(k),
  );
  const selectClass = "h-9 w-auto min-w-28 text-[13px]";

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative w-full max-w-xs">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-text-3" />
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder="Search name, phone, email…"
          className="h-9 pl-8 text-[13px]"
        />
      </div>

      <Select value={searchParams.get("type") ?? ALL} onValueChange={(v) => setParams({ type: v })}>
        <SelectTrigger className={selectClass}>
          <SelectValue placeholder="Type" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All types</SelectItem>
          {CONTACT_TYPES.map((t) => (
            <SelectItem key={t} value={t}>
              {labelize(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("temperature") ?? ALL}
        onValueChange={(v) => setParams({ temperature: v })}
      >
        <SelectTrigger className={selectClass}>
          <SelectValue placeholder="Temperature" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any temp</SelectItem>
          {TEMPERATURES.map((t) => (
            <SelectItem key={t} value={t}>
              {labelize(t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("source") ?? ALL}
        onValueChange={(v) => setParams({ source: v })}
      >
        <SelectTrigger className={selectClass}>
          <SelectValue placeholder="Source" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any source</SelectItem>
          {LEAD_SOURCES.map((s) => (
            <SelectItem key={s} value={s}>
              {labelize(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("agent") ?? ALL}
        onValueChange={(v) => setParams({ agent: v })}
      >
        <SelectTrigger className={selectClass}>
          <SelectValue placeholder="Agent" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any agent</SelectItem>
          {agents.map((a) => (
            <SelectItem key={a.id} value={a.id}>
              {a.full_name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={searchParams.get("language") ?? ALL}
        onValueChange={(v) => setParams({ language: v })}
      >
        <SelectTrigger className={selectClass}>
          <SelectValue placeholder="Language" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>Any language</SelectItem>
          {CONTACT_LANGUAGES.map((l) => (
            <SelectItem key={l} value={l}>
              {l.toUpperCase()}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Input
        placeholder="Nationality"
        defaultValue={searchParams.get("nationality") ?? ""}
        onBlur={(e) => setParams({ nationality: e.target.value || undefined })}
        className="h-9 w-28 text-[13px]"
      />

      {hasFilters ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setSearch("");
            router.replace(pathname);
          }}
          className="h-9 text-text-2"
        >
          <X className="size-4" /> Clear
        </Button>
      ) : null}
    </div>
  );
}
