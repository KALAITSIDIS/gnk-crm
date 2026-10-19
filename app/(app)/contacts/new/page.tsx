import { CreateContactForm } from "@/components/features/contacts/create-form";
import type { Metadata } from "next";

/** The browser tab's name (A08): "New contact · GN REOS" through the root layout's title template — a generic word, never a name. */
export const metadata: Metadata = { title: "New contact" };

export default function NewContactPage() {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-semibold text-text-1">Add contact</h1>
        <p className="text-sm text-text-2">
          Phones are normalized to E.164 (CY default) — duplicates are blocked live.
        </p>
      </div>
      <CreateContactForm />
    </div>
  );
}
