import { Link, useLocation } from "wouter";
import { useLogout, getGetCurrentUserQueryKey } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { LogOut, Settings, User as UserIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();

  const logoutMutation = useLogout({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        setLocation("/login");
      },
    },
  });

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-white text-foreground">
      <header className="flex-none h-14 border-b border-border bg-white flex items-center justify-between px-4 z-10 relative">
        <Link href="/" className="flex items-center gap-2">
          <img 
            src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" 
            alt="Sturtz Logo" 
            className="h-8"
          />
          <div className="w-px h-6 bg-border mx-2" />
          <span className="font-semibold text-sm tracking-wide text-gray-700">Support</span>
        </Link>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-sm border-r border-border pr-4">
            <div className="w-8 h-8 rounded-full bg-blue-50 text-primary flex items-center justify-center">
              <UserIcon className="w-4 h-4" />
            </div>
            <div className="flex flex-col">
              <span className="font-medium leading-none">{user?.name}</span>
              <span className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                {user?.role === "admin" ? (
                  <Badge variant="secondary" className="h-4 text-[10px] px-1 py-0 bg-blue-100 text-blue-700 hover:bg-blue-100">Admin</Badge>
                ) : (
                  <Badge variant="outline" className="h-4 text-[10px] px-1 py-0">User</Badge>
                )}
              </span>
            </div>
          </div>

          {user?.role === "admin" && (
            <Link href="/admin" className="text-sm font-medium text-gray-600 hover:text-primary flex items-center gap-1 transition-colors">
              <Settings className="w-4 h-4" />
              Admin
            </Link>
          )}

          <Button 
            variant="ghost" 
            size="sm" 
            onClick={() => logoutMutation.mutate()}
            disabled={logoutMutation.isPending}
            className="text-gray-500 hover:text-gray-900"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Sign out
          </Button>
        </div>
      </header>
      
      <main className="flex-1 flex overflow-hidden">
        {children}
      </main>
    </div>
  );
}
