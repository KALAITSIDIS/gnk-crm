"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CheckCircle2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { SignaturePad } from "@/components/features/viewings/signature-pad";
import { SlipDownloadButton } from "@/components/features/viewings/slip-download";
import { signViewingSlip, type SlipActionState } from "@/lib/actions/viewing-slips";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const initialState: SlipActionState = { error: null, savedAt: null };

export function SignSlip({
  viewingId,
  defaultSignerName,
  gdprLine,
}: {
  viewingId: string;
  defaultSignerName: string;
  gdprLine: string;
}) {
  const [state, formAction, pending] = useActionState(signViewingSlip, initialState);
  const [signature, setSignature] = useState("");
  const [signerName, setSignerName] = useState(defaultSignerName);
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const lastToasted = useRef<number | null>(null);

  useEffect(() => {
    if (state.savedAt && state.savedAt !== lastToasted.current) {
      lastToasted.current = state.savedAt;
      toast.success("Slip signed");
    }
  }, [state.savedAt]);

  const captureLocation = () => {
    if (!navigator.geolocation) {
      toast.error("Geolocation is not available on this device");
      return;
    }
    setGeoBusy(true);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setGeo({ lat: p.coords.latitude, lng: p.coords.longitude });
        setGeoBusy(false);
      },
      () => {
        toast.error("Couldn't get location");
        setGeoBusy(false);
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  if (state.savedAt) {
    return (
      <div className="flex flex-col items-center gap-4 rounded-[10px] border border-success/30 bg-success/10 p-6 text-center">
        <CheckCircle2 className="size-10 text-success" />
        <div>
          <p className="font-semibold text-text-1">Slip signed</p>
          <p className="text-sm text-text-2">The confirmation slip has been recorded.</p>
        </div>
        <SlipDownloadButton viewingId={viewingId} />
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="viewing_id" value={viewingId} />
      <input type="hidden" name="signature_data" value={signature} />
      <input type="hidden" name="lat" value={geo?.lat ?? ""} />
      <input type="hidden" name="lng" value={geo?.lng ?? ""} />

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="signer_name">Attendee name</Label>
        <Input
          id="signer_name"
          name="signer_name"
          value={signerName}
          onChange={(e) => setSignerName(e.target.value)}
          required
        />
      </div>

      <p className="rounded-[10px] bg-surface-2 p-3 text-xs leading-relaxed text-text-2">
        {gdprLine}
      </p>

      {/* the canvas carries its own aria-label ("Signature area — draw your
          signature here"), so this visible instruction names the REGION rather
          than competing with it (A11Y-1) */}
      <div
        role="group"
        aria-labelledby="sign-below-label"
        className="flex flex-col gap-1.5"
      >
        <Label id="sign-below-label">Sign below</Label>
        <SignaturePad onChange={setSignature} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" disabled={geoBusy} onClick={captureLocation}>
          <MapPin className="size-4" />
          {geo ? "Location captured" : geoBusy ? "Locating…" : "Attach location (optional)"}
        </Button>
        {geo ? (
          <span className="text-xs tabular-nums text-text-3">
            {geo.lat.toFixed(5)}, {geo.lng.toFixed(5)}
          </span>
        ) : null}
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending || !signature || signerName.trim().length < 2}>
        {pending ? "Recording…" : "Confirm & sign"}
      </Button>
    </form>
  );
}
