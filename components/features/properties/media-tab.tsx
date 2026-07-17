"use client";

import Image from "next/image";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { ArrowDown, ArrowUp, Star, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  deleteMedia,
  deleteMediaBulk,
  moveMedia,
  setMediaCover,
  uploadPropertyMedia,
  type MediaActionState,
} from "@/lib/actions/media";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { publicMediaUrl } from "@/lib/utils/storage";
import { cn } from "@/lib/utils";

export interface MediaItem {
  id: string;
  path_thumb: string | null;
  path_card: string | null;
  is_cover: boolean;
  sort_order: number;
  watermarked: boolean;
  width: number | null;
  height: number | null;
}

const initialState: MediaActionState = { error: null, savedAt: null };

export function MediaTab({
  propertyId,
  items,
  canUpload = true,
  canManage = true,
}: {
  propertyId: string;
  items: MediaItem[];
  /** insert rights: admin/LM, or the assigned agent */
  canUpload?: boolean;
  /** cover/reorder/delete rights: admin/LM only (property_media RLS) */
  canManage?: boolean;
}) {
  const [state, formAction, uploading] = useActionState(uploadPropertyMedia, initialState);
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fileInput = useRef<HTMLInputElement>(null);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Saved");
      if (fileInput.current) fileInput.current.value = "";
    }
  }, [state.savedAt]);

  const sorted = [...items].sort((a, b) => a.sort_order - b.sort_order);
  // drop selections for photos that no longer exist (deleted elsewhere / revalidated)
  const selectedIds = [...selected].filter((id) => items.some((i) => i.id === id));
  const allSelected = sorted.length > 0 && selectedIds.length === sorted.length;

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function deleteSelected() {
    if (selectedIds.length === 0) return;
    const label = selectedIds.length === 1 ? "this photo" : `these ${selectedIds.length} photos`;
    if (!confirm(`Delete ${label}? The originals are removed too.`)) return;
    startTransition(async () => {
      const { error, deleted } = await deleteMediaBulk(propertyId, selectedIds);
      if (error) toast.error(error);
      else toast.success(`Deleted ${deleted} photo${deleted === 1 ? "" : "s"}`);
      setSelected(new Set());
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {canUpload ? (
        <>
          <form action={formAction} className="flex flex-wrap items-center gap-3">
            <input type="hidden" name="property_id" value={propertyId} />
            <input
              ref={fileInput}
              type="file"
              name="files"
              accept="image/jpeg,image/png,image/webp"
              multiple
              className="text-sm text-text-2 file:mr-3 file:rounded-lg file:border file:border-border file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text-1"
            />
            <Button type="submit" disabled={uploading} size="sm">
              <Upload className="size-4" /> {uploading ? "Processing…" : "Upload"}
            </Button>
            {state.error ? (
              <p role="alert" className="text-sm text-danger">
                {state.error}
              </p>
            ) : null}
          </form>
          <p className="text-xs text-text-3">
            EXIF (incl. GPS) is stripped on upload; renditions 400/800/1600 WebP; originals stay in
            the private bucket. Watermark applies to public/partner listings when configured in
            Settings.
          </p>
        </>
      ) : (
        <p className="text-xs text-text-3">
          Photos are managed by the assigned agent, listing managers and admins.
        </p>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
          {canUpload ? "No photos yet — upload the first one." : "No photos yet."}
        </div>
      ) : (
        <>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm text-text-2">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(v) =>
                    setSelected(v === true ? new Set(sorted.map((i) => i.id)) : new Set())
                  }
                />
                Select all
              </label>
              {selectedIds.length > 0 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="text-danger"
                  disabled={isPending}
                  onClick={deleteSelected}
                >
                  <Trash2 className="size-4" />
                  {isPending ? "Deleting…" : `Delete selected (${selectedIds.length})`}
                </Button>
              ) : (
                <span className="text-xs text-text-3">
                  Tick photos to delete several at once.
                </span>
              )}
            </div>
          ) : null}

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {sorted.map((item, i) => {
              const isSelected = selectedIds.includes(item.id);
              return (
                <div
                  key={item.id}
                  className={cn(
                    "group relative overflow-hidden rounded-[10px] border bg-surface",
                    item.is_cover ? "border-accent-500 ring-1 ring-accent-500" : "border-border",
                    isSelected && "ring-2 ring-danger/60",
                  )}
                >
                  {item.path_card ? (
                    <Image
                      src={publicMediaUrl(item.path_card)}
                      alt=""
                      width={400}
                      height={280}
                      className="aspect-[4/3] w-full object-cover"
                      unoptimized
                    />
                  ) : null}
                  {canManage ? (
                    <span className="absolute left-2 top-2 rounded-[6px] bg-white/85 p-1 shadow-sm">
                      <Checkbox
                        checked={isSelected}
                        onCheckedChange={(v) => toggleOne(item.id, v === true)}
                        aria-label="Select photo"
                      />
                    </span>
                  ) : null}
                  {item.is_cover ? (
                    <span
                      className={cn(
                        "absolute top-2 rounded-full bg-accent-500 px-2 py-0.5 text-xs font-medium text-white",
                        canManage ? "left-11" : "left-2",
                      )}
                    >
                      Cover
                    </span>
                  ) : null}
                  {item.watermarked ? (
                    <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
                      WM
                    </span>
                  ) : null}
                  {canManage ? (
                    <div className="flex items-center justify-between gap-1 p-2">
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={isPending || i === 0}
                          onClick={() =>
                            startTransition(async () => {
                              const { error } = await moveMedia(propertyId, item.id, "up");
                              if (error) toast.error(error);
                            })
                          }
                          title="Move earlier"
                        >
                          <ArrowUp className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          disabled={isPending || i === sorted.length - 1}
                          onClick={() =>
                            startTransition(async () => {
                              const { error } = await moveMedia(propertyId, item.id, "down");
                              if (error) toast.error(error);
                            })
                          }
                          title="Move later"
                        >
                          <ArrowDown className="size-3.5" />
                        </Button>
                      </div>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className={cn("size-7", item.is_cover && "text-accent-500")}
                          disabled={isPending || item.is_cover}
                          onClick={() =>
                            startTransition(async () => {
                              const { error } = await setMediaCover(propertyId, item.id);
                              if (error) toast.error(error);
                            })
                          }
                          title="Set as cover"
                        >
                          <Star className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7 text-danger"
                          disabled={isPending}
                          onClick={() => {
                            if (confirm("Delete this photo? The original is removed too.")) {
                              startTransition(async () => {
                                const { error } = await deleteMedia(propertyId, item.id);
                                if (error) toast.error(error);
                              });
                            }
                          }}
                          title="Delete"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
