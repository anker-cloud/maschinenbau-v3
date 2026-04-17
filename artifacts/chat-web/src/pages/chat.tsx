import { useState, useRef, useEffect } from "react";
import { useLocation, useParams } from "wouter";
import { 
  useListConversations, 
  useCreateConversation, 
  useGetConversation,
  useSendMessage,
  getGetConversationQueryKey,
  getListConversationsQueryKey,
  Message
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Send, Plus, Trash2, MessageSquare, Menu } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";

import { ChatSidebar } from "@/components/chat-sidebar";
import { ChatArea } from "@/components/chat-area";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";

export default function Chat() {
  const { id } = useParams();
  const [, setLocation] = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-full w-full overflow-hidden bg-white">
      {/* Desktop Sidebar */}
      <div className="hidden md:flex w-72 flex-col border-r border-border bg-gray-50/50">
        <ChatSidebar activeId={id} />
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col h-full overflow-hidden relative">
        {/* Mobile Header Overlay */}
        <div className="md:hidden absolute top-4 left-4 z-10">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="outline" size="icon" className="h-10 w-10 bg-white/80 backdrop-blur-sm shadow-sm border-gray-200">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-72 border-r-0">
              <ChatSidebar activeId={id} onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>
        </div>

        <ChatArea conversationId={id} />
      </div>
    </div>
  );
}
