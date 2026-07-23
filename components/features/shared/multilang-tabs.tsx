"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/**
 * MultilangTabs (doc 06): EN/EL/RU tab wrapper for jsonb {en,el,ru} text
 * fields with a per-tab filled indicator. Renders three named form fields:
 * `${name}_en`, `${name}_el`, `${name}_ru`.
 */

const LOCALES = ["en", "el", "ru"] as const;
const LOCALE_LABELS: Record<(typeof LOCALES)[number], string> = {
  en: "EN",
  el: "EL",
  ru: "RU",
};

export interface MultilangValue {
  en?: string;
  el?: string;
  ru?: string;
}

export function MultilangTabs({
  name,
  label,
  defaultValue,
  multiline = false,
  rows = 5,
}: {
  name: string;
  label: string;
  defaultValue: MultilangValue;
  multiline?: boolean;
  rows?: number;
}) {
  const [filled, setFilled] = useState<Record<string, boolean>>({
    en: Boolean(defaultValue.en),
    el: Boolean(defaultValue.el),
    ru: Boolean(defaultValue.ru),
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {/* One visible label over THREE inputs (en/el/ru), so it labels a group
            rather than a control; each locale input carries its own accessible
            name below so a screen reader says which language it is editing.
            (A11Y-1) */}
        <Label id={`${name}-label`}>{label}</Label>
      </div>
      <Tabs defaultValue="en" role="group" aria-labelledby={`${name}-label`}>
        <TabsList className="h-8">
          {LOCALES.map((locale) => (
            <TabsTrigger key={locale} value={locale} className="gap-1.5 px-3 text-xs">
              {LOCALE_LABELS[locale]}
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  filled[locale] ? "bg-success" : "bg-text-3/40",
                )}
              />
            </TabsTrigger>
          ))}
        </TabsList>
        {LOCALES.map((locale) => (
          // forceMount keeps every locale's input in the DOM so the form always
          // submits all three — without it, switching tabs unmounts the others
          // and saving silently wipes their values (caught in T1.3 verification).
          <TabsContent
            key={locale}
            value={locale}
            forceMount
            className="mt-2 data-[state=inactive]:hidden"
          >
            {multiline ? (
              <Textarea
                id={`${name}_${locale}`}
                name={`${name}_${locale}`}
                aria-label={`${label} (${LOCALE_LABELS[locale]})`}
                defaultValue={defaultValue[locale] ?? ""}
                rows={rows}
                onChange={(e) =>
                  setFilled((f) => ({ ...f, [locale]: e.target.value.trim().length > 0 }))
                }
              />
            ) : (
              <Input
                id={`${name}_${locale}`}
                name={`${name}_${locale}`}
                aria-label={`${label} (${LOCALE_LABELS[locale]})`}
                defaultValue={defaultValue[locale] ?? ""}
                onChange={(e) =>
                  setFilled((f) => ({ ...f, [locale]: e.target.value.trim().length > 0 }))
                }
              />
            )}
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
