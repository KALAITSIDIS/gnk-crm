"use client";

import Image from "next/image";
import { useActionState, useEffect, useRef, useTransition } from "react";
import { ArrowDown, ArrowUp, Star, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  deleteMedia,
  moveMedia,
  setMediaCover,
  uploadPropertyMedia,
  type MediaActionState,
} from "@/lib/actions/media";
import { Button } from "@/components/ui/button";
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

export function MediaTab({ propertyId, items }: { propertyId: string; items: MediaItem[] }) {
  const [state, formAction, uploading] = useActionState(uploadPropertyMedia, initialState);
  const [isPending, startTransition] = useTransition();
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

  return (
    <div className="flex flex-col gap-4">
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
        EXIF (incl. GPS) is stripped on upload; renditions 400/800/1600 WebP; originals stay in the
        private bucket. Watermark applies to public/partner listings when configured in Settings.
      </p>

      {sorted.length === 0 ? (
        <div className="rounded-[10px] border border-dashed border-border py-12 text-center text-sm text-text-3">
          No photos yet — upload the first one.
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {sorted.map((item, i) => (
            <div
              key={item.id}
              className={cn(
                "group relative overflow-hidden rounded-[10px] border bg-surface",
                item.is_cover ? "border-accent-500 ring-1 ring-accent-500" : "border-border",
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
              {item.is_cover ? (
                <span className="absolute left-2 top-2 rounded-full bg-accent-500 px-2 py-0.5 text-xs font-medium text-white">
                  Cover
                </span>
              ) : null}
              {item.watermarked ? (
                <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white">
                  WM
                </span>
              ) : null}
              <div className="flex items-center justify-between gap-1 p-2">
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={isPending || i === 0}
                    onClick={() => startTransition(() => moveMedia(propertyId, item.id, "up"))}
                    title="Move earlier"
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    disabled={isPending || i === sorted.length - 1}
                    onClick={() => startTransition(() => moveMedia(propertyId, item.id, "down"))}
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
                    onClick={() => startTransition(() => setMediaCover(propertyId, item.id))}
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
                        startTransition(() => deleteMedia(propertyId, item.id));
                      }
                    }}
                    title="Delete"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
