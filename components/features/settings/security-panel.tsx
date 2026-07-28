"use client";

import { useState, useTransition } from "react";
import { ShieldCheck, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import {
  confirmMfaEnrollment,
  startMfaEnrollment,
  unenrollMfa,
  type MfaStatus,
} from "@/lib/actions/mfa";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils/format";

type Enrollment = { factorId: string; qrCode: string; secret: string };

export function SecurityPanel({ status }: { status: MfaStatus }) {
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const enrolled = status.factors.length > 0;

  const begin = () => {
    setError(null);
    startTransition(async () => {
      const result = await startMfaEnrollment();
      if (result.error || !result.factorId || !result.qrCode || !result.secret) {
        setError(result.error ?? "Could not start enrolment.");
        return;
      }
      setEnrollment({
        factorId: result.factorId,
        qrCode: result.qrCode,
        secret: result.secret,
      });
    });
  };

  const confirm = () => {
    if (!enrollment) return;
    setError(null);
    startTransition(async () => {
      const result = await confirmMfaEnrollment(enrollment.factorId, code);
      if (result.error) {
        setError(result.error);
        return;
      }
      toast.success("Two-factor authentication is on");
      setEnrollment(null);
      setCode("");
    });
  };

  const remove = (factorId: string) => {
    startTransition(async () => {
      const result = await unenrollMfa(factorId);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success("Two-factor authentication removed");
      setConfirmRemove(null);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[10px] border border-border bg-surface p-5">
        <div className="flex items-start gap-3">
          {enrolled ? (
            <ShieldCheck className="mt-0.5 size-5 shrink-0 text-success" />
          ) : (
            <ShieldAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          )}
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-semibold text-text-1">
              Two-factor authentication {enrolled ? "is on" : "is off"}
            </h2>
            <p className="max-w-xl text-sm text-text-2">
              {enrolled
                ? "You'll be asked for a code from your authenticator app every time you sign in."
                : "A password alone protects every client's personal data, KYC scans and the commission evidence chain. Add a code from an authenticator app as a second step."}
            </p>
          </div>
        </div>

        {enrolled ? (
          <ul className="mt-4 flex flex-col gap-2 border-t border-border pt-4">
            {status.factors.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 text-sm">
                <span className="text-text-1">
                  {f.friendlyName ?? "Authenticator"}
                  <span className="ml-2 text-text-3">added {formatDate(f.createdAt)}</span>
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmRemove(f.id)}
                  disabled={pending}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-4 border-t border-border pt-4">
            <Button onClick={begin} disabled={pending}>
              {pending ? "Preparing…" : "Set up two-factor authentication"}
            </Button>
            {error && !enrollment ? (
              <p role="alert" className="mt-2 text-sm text-danger">
                {error}
              </p>
            ) : null}
          </div>
        )}
      </div>

      {/* Enrolment: scan, then prove the app produces the right code. */}
      <Dialog open={enrollment !== null} onOpenChange={(o) => !o && setEnrollment(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Set up two-factor authentication</DialogTitle>
          </DialogHeader>
          {enrollment ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-text-2">
                Scan this with your authenticator app, then enter the 6-digit code it shows.
              </p>
              <div className="flex justify-center rounded-lg border border-border bg-white p-3">
                {/*
                  Plain <img>, not next/image: Supabase returns the QR as an
                  inline `data:image/svg+xml` URL, which next/image rejects
                  outright (it threw straight into the error boundary). There is
                  nothing to optimise here — the bytes are already in the page.
                */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={enrollment.qrCode}
                  alt="Two-factor authentication QR code"
                  width={180}
                  height={180}
                />
              </div>
              <details className="text-sm">
                <summary className="cursor-pointer text-text-2">Can&apos;t scan the code?</summary>
                <p className="mt-2 break-all rounded-md bg-surface-2 p-2 font-mono text-xs text-text-1">
                  {enrollment.secret}
                </p>
              </details>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="mfa-enroll-code">6-digit code</Label>
                <Input
                  id="mfa-enroll-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value.trim())}
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="000000"
                  className="tracking-[0.4em]"
                />
              </div>
              {error ? (
                <p role="alert" className="text-sm text-danger">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => setEnrollment(null)} disabled={pending}>
                  Cancel
                </Button>
                <Button onClick={confirm} disabled={pending}>
                  {pending ? "Checking…" : "Turn on"}
                </Button>
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRemove !== null} onOpenChange={(o) => !o && setConfirmRemove(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Remove two-factor authentication?</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 text-sm">
            <p className="text-text-1">
              Your account will be protected by its password alone. This is recorded in the event
              log.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setConfirmRemove(null)} disabled={pending}>
                Cancel
              </Button>
              <Button onClick={() => confirmRemove && remove(confirmRemove)} disabled={pending}>
                {pending ? "Removing…" : "Remove"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
