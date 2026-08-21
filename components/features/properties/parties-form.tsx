"use client";

import { EntityPicker } from "@/components/features/shared/entity-picker";
import { SectionForm } from "@/components/features/properties/section-form";
import type { EntityOption } from "@/lib/actions/entity-search";
import { DEVELOPER_KINDS } from "@/lib/validators/properties";

/**
 * Who a property belongs to (BACKLOG audit findings 1, 2 and 12).
 *
 * Three links that all existed as columns since 0001 and that no screen wrote:
 * the private owner, the developer behind a project, and the agent responsible.
 *
 * The agent one is not cosmetic. `properties_update` and `property_media_insert`
 * (0002) admit an agent only when `assigned_agent_id` is theirs, so until this
 * form existed, every property an admin or listing manager created was
 * permanently uneditable by every agent — and the save's own error told them so
 * without offering a cure. Admin + listing manager only, enforced in the action.
 *
 * Owner and developer are deliberately NOT mutually exclusive: a developer still
 * owns the units it has not sold, and on a resale the seller is the owner with
 * no developer at all.
 */
export function PartiesForm({
  propertyId,
  kind,
  owner,
  developer,
  agent,
  readOnly,
}: {
  propertyId: string;
  kind: string;
  owner: EntityOption | null;
  developer: EntityOption | null;
  agent: EntityOption | null;
  /** true unless the viewer is an admin or listing manager */
  readOnly: boolean;
}) {
  const showDeveloper = (DEVELOPER_KINDS as readonly string[]).includes(kind);

  return (
    <SectionForm
      propertyId={propertyId}
      section="parties"
      readOnly={readOnly}
      readOnlyNote="Read-only — only admins and listing managers can change who a property belongs to."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <EntityPicker
          name="owner_contact_id"
          kind="contact"
          label="Owner"
          initial={owner}
          placeholder="Search owners…"
          contactTypes={["owner", "seller", "landlord"]}
          hint="Owners, sellers and landlords only."
        />

        {showDeveloper ? (
          <EntityPicker
            name="developer_contact_id"
            kind="contact"
            label="Developer"
            initial={developer}
            placeholder="Search developers…"
            contactTypes={["developer"]}
            hint="Contacts tagged as developers."
          />
        ) : null}

        <EntityPicker
          name="assigned_agent_id"
          kind="agent"
          label="Assigned agent"
          initial={agent}
          placeholder="Search agents…"
          hint="Grants this agent edit and photo-upload rights on this property."
        />
      </div>
    </SectionForm>
  );
}
