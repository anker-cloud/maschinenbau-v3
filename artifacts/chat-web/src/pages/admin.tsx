import { useLocation, useSearch } from "wouter";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersTab } from "@/components/admin/users-tab";
import { DocumentsTab } from "@/components/admin/documents-tab";
import { Settings } from "lucide-react";

const VALID_TABS = ["users", "documents"] as const;
type TabValue = (typeof VALID_TABS)[number];

function isValidTab(v: string | null): v is TabValue {
  return VALID_TABS.includes(v as TabValue);
}

export default function AdminDashboard() {
  const [location, navigate] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const tabParam = params.get("tab");
  const activeTab: TabValue = isValidTab(tabParam) ? tabParam : "users";

  function handleTabChange(value: string) {
    navigate(`${location}?tab=${value}`, { replace: true });
  }

  return (
    <div className="flex flex-col h-full w-full bg-background overflow-hidden">
      <div className="flex-none bg-card border-b border-border px-6 py-6">
        <div className="max-w-5xl mx-auto flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-muted text-muted-foreground flex items-center justify-center border border-border">
            <Settings className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-foreground tracking-tight">Administration</h1>
            <p className="text-sm text-muted-foreground">Manage users and knowledge base documents</p>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="max-w-5xl mx-auto">
          <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
            <TabsList className="grid w-[400px] grid-cols-2 mb-6">
              <TabsTrigger value="users">Users</TabsTrigger>
              <TabsTrigger value="documents">Documents</TabsTrigger>
            </TabsList>

            <TabsContent value="users" className="mt-0 outline-none">
              <UsersTab />
            </TabsContent>

            <TabsContent value="documents" className="mt-0 outline-none">
              <DocumentsTab />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
