"use client";

import { useActionState, useState, useTransition } from "react";
import { Copy, UserPlus } from "lucide-react";
import { toast } from "sonner";
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
}

const initialState: SettingsActionState = { error: null, savedAt: null, tempPassword: null };

function labelize(v: string) {
  return v.replace(/_/g, " ");
}

function InviteDialog() {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(inviteUser, initialState);

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
          {state.tempPassword ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm text-text-2">
                Account created. Hand these credentials over — the password is shown{" "}
                <span className="font-semibold text-text-1">only once</span>:
              </p>
              <div className="rounded-lg bg-surface-2 p-3 font-mono text-sm text-text-1">
                {state.tempPassword}
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  navigator.clipboard?.writeText(state.tempPassword ?? "").then(
                    () => toast.success("Password copied"),
                    () => toast.error("Copy manually"),
                  );
                }}
              >
                <Copy className="size-4" /> Copy password
              </Button>
              <p className="text-xs text-text-3">
                The user should change it after first login (self-service reset ships with the
                Phase 2 email integration).
              </p>
            </div>
          ) : (
            <form action={formAction} className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-name">Full name</Label>
                <Input id="inv-name" name="full_name" required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="inv-email">Email</Label>
                <Input id="inv-email" name="email" type="email" required />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Role</Label>
                <Select name="role" defaultValue="agent">
                  <SelectTrigger>
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
          )}
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
      <SelectTrigger className="w-40 capitalize">
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
