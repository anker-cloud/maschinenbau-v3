import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useLogout, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { KeyRound, LogOut, Pencil, Settings, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChangePasswordDialog } from "@/components/change-password-dialog";
import { EditProfileDialog } from "@/components/edit-profile-dialog";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [changePasswordOpen, setChangePasswordOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        setLocation("/login");
      },
    },
  });

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background text-foreground">
      <header className="flex-none h-14 border-b border-border bg-card flex items-center justify-between px-4 z-10 relative">
        <Link href="/" className="flex items-center gap-2">
          <img 
            src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" 
            alt="Sturtz Logo" 
            className="h-8 brightness-0 invert"
          />
          <div className="w-px h-6 bg-border mx-2" />
          <span className="font-semibold text-sm tracking-wide text-foreground/70">Support</span>
        </Link>

        <div className="flex items-center gap-4">
          {user?.role === "admin" && (
            <Link href="/admin" className="text-sm font-medium text-muted-foreground hover:text-primary flex items-center gap-1 transition-colors">
              <Settings className="w-4 h-4" />
              Admin
            </Link>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="account-menu-trigger"
                className="flex items-center gap-2 text-sm rounded-lg px-2 py-1 hover:bg-muted transition-colors"
              >
                <div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center">
                  <UserIcon className="w-4 h-4" />
                </div>
                <div className="flex flex-col items-start">
                  <span className="font-medium leading-none text-foreground">{user?.name}</span>
                  <span className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                    {user?.role === "admin" ? (
                      <Badge variant="secondary" className="h-4 text-[10px] px-1 py-0 bg-primary/20 text-primary hover:bg-primary/20">Admin</Badge>
                    ) : (
                      <Badge variant="outline" className="h-4 text-[10px] px-1 py-0">User</Badge>
                    )}
                  </span>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <DropdownMenuItem
                data-testid="edit-profile-menu-item"
                onSelect={(event) => {
                  event.preventDefault();
                  setEditProfileOpen(true);
                }}
              >
                <Pencil className="w-4 h-4 mr-2" />
                Edit profile
              </DropdownMenuItem>
              <DropdownMenuItem
                data-testid="change-password-menu-item"
                onSelect={(event) => {
                  event.preventDefault();
                  setChangePasswordOpen(true);
                }}
              >
                <KeyRound className="w-4 h-4 mr-2" />
                Change password
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={logoutMutation.isPending}
                onSelect={(event) => {
                  event.preventDefault();
                  logoutMutation.mutate();
                }}
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>

      <ChangePasswordDialog
        open={changePasswordOpen}
        onOpenChange={setChangePasswordOpen}
      />
      <EditProfileDialog
        open={editProfileOpen}
        onOpenChange={setEditProfileOpen}
      />
    </div>
  );
}
