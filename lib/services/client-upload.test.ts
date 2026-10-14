import { describe, expect, it, vi } from "vitest";
import { BRANDING_MAX_BYTES, UPLOAD_REQUEST_BUDGET_BYTES } from "@/lib/constants/upload";
import { photoUploadUnconfirmedText, submitUpload, uploadOneByOne } from "./client-upload";

type State = { error: string | null; savedAt: number | null };
const initialState: State = { error: null, savedAt: null };
const options = { initialState, tooLargeAdvice: "ADVICE", unconfirmedText: "UNCONFIRMED" };

const fileOf = (bytes: number, name = "deed.pdf", type = "application/pdf") =>
  new File([new Uint8Array(bytes)], name, { type });
const formWith = (file: File) => {
  const form = new FormData();
  form.set("property_id", "00000000-0000-4000-8000-000000000001");
  form.set("file", file);
  return form;
};

/**
 * One submit path for every upload form (documents ×3, branding): the size
 * gate BEFORE anything is sent, and a request that never comes back turned
 * into a message — never a throw, which under useActionState lands on the
 * error boundary (T-upload-size-honest).
 */
describe("submitUpload", () => {
  it("a file over the budget is refused and the action is never called", async () => {
    const action = vi.fn(async () => ({ error: null, savedAt: 1 }));
    const outcome = await submitUpload(formWith(fileOf(UPLOAD_REQUEST_BUDGET_BYTES + 1, "plans.pdf")), action, options);
    expect(action).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("refused");
    expect(outcome.kind !== "saved" && outcome.text).toMatch(/plans\.pdf.*3\.4 MB.*3\.3 MB.*ADVICE/);
  });

  it("the caller's lower limit is the one enforced (branding)", async () => {
    const action = vi.fn(async () => ({ error: null, savedAt: 1 }));
    const outcome = await submitUpload(formWith(fileOf(BRANDING_MAX_BYTES + 1, "logo.png", "image/png")), action, {
      ...options,
      limit: BRANDING_MAX_BYTES,
    });
    expect(action).not.toHaveBeenCalled();
    expect(outcome.kind).toBe("refused");
  });

  it("a file within the budget is sent as the form holds it, with the initial state", async () => {
    const action = vi.fn<(prev: State, form: FormData) => Promise<State>>(async () => ({
      error: null,
      savedAt: 7,
    }));
    const form = formWith(fileOf(UPLOAD_REQUEST_BUDGET_BYTES));
    expect(await submitUpload(form, action, options)).toEqual({ kind: "saved" });
    expect(action).toHaveBeenCalledWith(initialState, form);
  });

  it("a request that never comes back (platform 413 page, network) is an UNKNOWN outcome — never a throw", async () => {
    const action = vi.fn(async (): Promise<State> => {
      throw new Error("An unexpected response was received from the server.");
    });
    await expect(submitUpload(formWith(fileOf(10)), action, options)).resolves.toEqual({
      kind: "unconfirmed",
      text: "UNCONFIRMED",
    });
  });

  it("the server's own refusal is passed on in its words", async () => {
    const action = vi.fn(async () => ({ error: "PDF, JPG or PNG only", savedAt: null }));
    expect(await submitUpload(formWith(fileOf(10)), action, options)).toEqual({
      kind: "error",
      text: "PDF, JPG or PNG only",
    });
  });

  it("an answer that says neither saved nor refused is not taken as a success", async () => {
    const action = vi.fn(async () => ({ error: null, savedAt: null }));
    expect(await submitUpload(formWith(fileOf(10)), action, options)).toEqual({
      kind: "unconfirmed",
      text: "UNCONFIRMED",
    });
  });

  it("with no file chosen, the server answers (its 'Choose a file' is the message)", async () => {
    const action = vi.fn(async () => ({ error: "Choose a file to upload", savedAt: null }));
    const form = new FormData();
    form.set("file", new File([], "", { type: "application/octet-stream" }));
    expect(await submitUpload(form, action, options)).toEqual({ kind: "error", text: "Choose a file to upload" });
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe("uploadOneByOne — the media tab's photo loop", () => {
  const photos = (...names: string[]) => names.map((n) => fileOf(1000, n, "image/jpeg"));
  const prepare = async (f: File) => f;

  it("sends ONE file per request, in order, and reports 1-based progress", async () => {
    const sent: string[] = [];
    const progress: string[] = [];
    const result = await uploadOneByOne(photos("a.jpg", "b.jpg", "c.jpg"), {
      prepare,
      send: async (file) => {
        sent.push(file.name);
        return { error: null };
      },
      onProgress: (at, total) => progress.push(`${at}/${total}`),
    });
    expect(sent).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
    expect(result).toEqual({ done: 3, failed: null, unconfirmed: false });
  });

  it("a send that REJECTS stops the run with an unknown outcome naming the photo — it never throws", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockRejectedValueOnce(new Error("An unexpected response was received from the server."));
    const result = await uploadOneByOne(photos("a.jpg", "b.jpg", "c.jpg"), { prepare, send });
    expect(send).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ done: 1, failed: photoUploadUnconfirmedText("b.jpg"), unconfirmed: true });
    expect(photoUploadUnconfirmedText("b.jpg")).toMatch(/could not confirm whether b\.jpg was saved/i);
  });

  it("a photo that cannot be prepared (too large, unreadable) stops the run and is never sent", async () => {
    const send = vi.fn(async () => ({ error: null }));
    const result = await uploadOneByOne(photos("a.jpg", "huge.jpg"), {
      prepare: async (f) => {
        if (f.name === "huge.jpg") throw new Error("huge.jpg is still 3.6 MB after resizing");
        return f;
      },
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ done: 1, failed: "huge.jpg is still 3.6 MB after resizing", unconfirmed: false });
  });

  it("the server's refusal stops the run in its own words", async () => {
    const result = await uploadOneByOne(photos("a.jpg", "b.jpg"), {
      prepare,
      send: async () => ({ error: "Upload not allowed — this property isn't assigned to you." }),
    });
    expect(result).toEqual({
      done: 0,
      failed: "Upload not allowed — this property isn't assigned to you.",
      unconfirmed: false,
    });
  });

  it("a saved photo with a warning counts as saved, and the warning is passed on", async () => {
    const warnings: string[] = [];
    const result = await uploadOneByOne(photos("a.jpg"), {
      prepare,
      send: async () => ({ error: null, warning: "Saved, but its timeline line was not written." }),
      onWarning: (w) => warnings.push(w),
    });
    expect(warnings).toEqual(["Saved, but its timeline line was not written."]);
    expect(result).toEqual({ done: 1, failed: null, unconfirmed: false });
  });
});
