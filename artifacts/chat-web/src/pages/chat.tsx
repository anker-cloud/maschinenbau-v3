import { useState } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Menu } from "lucide-react";

import { ChatSidebar } from "@/components/chat-sidebar";
import { ChatArea } from "@/components/chat-area";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

export default function Chat() {
  const { id } = useParams();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex w-72 flex-col border-r border-border bg-sidebar">
        <ChatSidebar activeId={id} />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Mobile Header Overlay */}
        <div className="md:hidden absolute top-4 left-4 z-10">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="h-10 w-10 bg-card/80 backdrop-blur-sm shadow-sm border-border">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72 border-r-0 bg-sidebar">
              <ChatSidebar activeId={id} onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>

        <ChatArea conversationId={id} />
      </div>
    </div>
  );
}
