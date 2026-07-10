import { CreateContactForm } from "@/components/features/contacts/create-form";

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
