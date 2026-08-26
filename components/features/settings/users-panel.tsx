"use client";

import { useActionState, useState, useTransition } from "react";
import { ShieldAlert, Copy, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { MFA_REQUIRED } from "@/lib/constants/mfa";
import {
  inviteUser,
  setUserActive,
  setUserRole,
  type SettingsActionState,
} from "@/lib/actions/settings";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { INVITABLE_ROLES } from "@/lib/validators/settings";
import { cn } from "@/lib/utils";

export interface UserRow {
  id: string;
  fullName: string;
  email: string;
  role: string;
  isActive: boolean;
  isSelf: boolean;
  /** null = could not be determined (0028 RPC failed) — never render that as "no". */
  hasTwoFactor: boolean | null;
}

const initialState: SettingsActionState = {
  error: null,
  savedAt: null,
  tempPassword: null,
  invitedEmail: null,
};

function labelize(v: string) {
  return v.replace(/_/g, " ");
}

/**
 * Inner flow keyed by the parent: "Done" remounts it so the NEXT invite gets a
 * fresh form (useActionState keeps the credentials forever otherwise — the
 * dialog used to be stuck on the first invite's password until a full page
 * reload). An accidental Escape/overlay close does NOT reset, so the one-time
 * password survives until "Done" is pressed deliberately.
 */
function InviteFlow({ onDone }: { onDone: () => void }) {
  const [state, formAction, pending] = useActionState(inviteUser, initialState);

  if (state.tempPassword) {
    const credentials = `${state.invitedEmail ?? ""}\n${state.tempPassword}`;
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-text-2">
          Account created. Hand these credentials over — the password is shown{" "}
          <span className="font-semibold text-text-1">only once</span>:
        </p>
        <div className="rounded-lg bg-surface-2 p-3 font-mono text-sm text-text-1">
          <div className="text-xs text-text-3">{state.invitedEmail}</div>
          {state.tempPassword}
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard?.writeText(credentials).then(
                () => toast.success("Credentials copied"),
                () => toast.error("Copy manually"),
              );
            }}
          >
            <Copy className="size-4" /> Copy credentials
          </Button>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
        <p className="text-xs text-text-3">
          The user should change it after first login (self-service reset ships with the
          Phase 2 email integration).
        </p>
      </div>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      {/* The trigger for a decision taken on 2026-08-26, put where it fires.
          Mandatory 2FA was decided YES and left off, because enabling it needs
          the E2E auth setup and the RLS fixtures to enrol TOTP factors first —
          without that, 204 E2E tests and 3 of 4 RLS files go red. The operator
          asked for that harness work "before the next hire", and this dialog is
          the only moment anyone would notice. A note in an 1800-line backlog is
          how the last conditional decision got missed. */}
      {!MFA_REQUIRED ? (
        <p className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-text-2">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />
          <span>
            Two-factor authentication is <strong>not required</strong> yet — this person will be
            able to sign in with a password alone. Making it mandatory was agreed, and was left
            until before the next hire; see <code>lib/constants/mfa.ts</code>.
          </span>
        </p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inv-name">Full name</Label>
        <Input id="inv-name" name="full_name" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="inv-email">Email</Label>
        <Input id="inv-email" name="email" type="email" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="invite-role">Role</Label>
        <Select name="role" defaultValue="agent">
          <SelectTrigger id="invite-role">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVITABLE_ROLES.map((r) => (
              <SelectItem key={r} value={r} className="capitalize">
                {labelize(r)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-danger">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create account"}
      </Button>
    </form>
  );
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [flowKey, setFlowKey] = useState(0);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="size-4" /> Invite user
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Invite user</DialogTitle>
          </DialogHeader>
          <InviteFlow
            key={flowKey}
            onDone={() => {
              setOpen(false);
              setFlowKey((k) => k + 1);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function RoleSelect({ user }: { user: UserRow }) {
  const [pending, start] = useTransition();
  return (
    <Select
      defaultValue={user.role}
      disabled={user.isSelf || pending}
      onValueChange={(role) =>
        start(async () => {
          const { error } = await setUserRole(user.id, role);
          if (error) toast.error(error);
          else toast.success("Role updated");
        })
      }
    >
      {/* one of these per table row — without the user's name a screen reader
          just says "combobox, agent" with no idea whose role it is (A11Y-1) */}
      <SelectTrigger className="w-40 capitalize" aria-label={`Role for ${user.fullName}`}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {INVITABLE_ROLES.map((r) => (
          <SelectItem key={r} value={r} className="capitalize">
            {labelize(r)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ActiveToggle({ user }: { user: UserRow }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant={user.isActive ? "outline" : "default"}
      disabled={user.isSelf || pending}
      onClick={() =>
        start(async () => {
          const { error } = await setUserActive(user.id, !user.isActive);
          if (error) toast.error(error);
          else toast.success(user.isActive ? "User deactivated" : "User reactivated");
        })
      }
    >
      {pending ? "…" : user.isActive ? "Deactivate" : "Reactivate"}
    </Button>
  );
}

/**
 * Whether this colleague has a verified second factor (0028).
 *
 * An admin holds the same reach over client KYC and the evidence chain as any
 * other admin, so "who is protected" is an admin's business — but only ever as
 * one bit. The RPC returns no factor detail and neither does this.
 *
 * `null` means the lookup FAILED, and is rendered as "—", not as "no". A broken
 * query that reads as "nobody has 2FA" would be alarming-but-wrong; one that
 * read as "everybody does" would be the dangerous direction. Neither is honest,
 * so unknown says unknown.
 */
function TwoFactorBadge({ user }: { user: UserRow }) {
  if (user.hasTwoFactor === null) {
    return (
      <span className="text-xs text-text-3" title="Could not read 2FA status">
        —
      </span>
    );
  }
  return user.hasTwoFactor ? (
    <span className="rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">
      on
    </span>
  ) : (
    <span
      className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning"
      title="Password only — this account can be reached with a stolen password alone"
    >
      off
    </span>
  );
}

export function UsersPanel({ users }: { users: UserRow[] }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-text-2">{users.length} users</p>
        <InviteDialog />
      </div>
      <div className="overflow-x-auto rounded-[10px] border border-border bg-surface">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>2FA</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className={cn(!u.isActive && "opacity-60")}>
                <TableCell className="font-medium text-text-1">
                  {u.fullName}
                  {u.isSelf ? <span className="ml-1.5 text-xs text-text-3">(you)</span> : null}
                </TableCell>
                <TableCell className="text-text-2">{u.email}</TableCell>
                <TableCell>
                  <RoleSelect user={u} />
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-medium",
                      u.isActive ? "bg-success/10 text-success" : "bg-surface-2 text-text-3",
                    )}
                  >
                    {u.isActive ? "active" : "deactivated"}
                  </span>
                </TableCell>
                <TableCell>
                  <TwoFactorBadge user={u} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end">
                    <ActiveToggle user={u} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
