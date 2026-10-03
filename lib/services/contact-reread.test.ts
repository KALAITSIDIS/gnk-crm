import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { fakeClient, type FakePage } from "@/lib/testing/fake-client";
import { CONTACT_CHECK_FAILED, CONTACT_UNAVAILABLE, contactLinkError } from "./contact-reread";

/**
 * contactLinkError — the re-read every contact-linking action runs before it
 * writes (T-contact-links-org-isolation). Pinned here directly because its
 * callers usually post ONE new id: a helper that let `some` id through instead
 * of `every`, read only the first, or reported a failed read as a missing
 * contact would pass every action test that posts a single id.
 */

const A = "c0c0c0c0-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "c0c0c0c0-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const seen = (id: string): FakePage => ({ data: { id }, error: null });
const unseen: FakePage = { data: null, error: null };
const failed: FakePage = { data: null, error: { message: "upstream request timeout" } };

function run(pages: FakePage[], ids: (string | null | undefined)[]) {
  const fake = fakeClient({ contacts: pages });
  return {
    fake,
    result: contactLinkError(fake.client as unknown as SupabaseClient<Database>, ids),
  };
}

describe("contactLinkError", () => {
  it("reads nothing and passes when no id is posted", async () => {
    const { fake, result } = run([], [null, undefined, ""]);
    expect(await result).toBeNull();
    expect(fake.argsOf("contacts", "eq")).toEqual([]);
  });

  it("passes when every posted id is visible, reading each by its id", async () => {
    const { fake, result } = run([seen(A), seen(B)], [A, B]);
    expect(await result).toBeNull();
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", A], ["id", B]]);
  });

  it("refuses when ANY posted id is not visible — the first or the second", async () => {
    expect(await run([seen(A), unseen], [A, B]).result).toBe(CONTACT_UNAVAILABLE);
    expect(await run([unseen, seen(B)], [A, B]).result).toBe(CONTACT_UNAVAILABLE);
  });

  it("reads a repeated id once", async () => {
    const { fake, result } = run([seen(A)], [A, A, null]);
    expect(await result).toBeNull();
    expect(fake.argsOf("contacts", "eq")).toEqual([["id", A]]);
  });

  it("reports a failed read as a failure, not as a missing contact", async () => {
    expect(await run([failed], [A]).result).toBe(CONTACT_CHECK_FAILED);
    expect(await run([seen(A), failed], [A, B]).result).toBe(CONTACT_CHECK_FAILED);
  });
});
