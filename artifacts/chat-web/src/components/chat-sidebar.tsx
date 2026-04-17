import { useLocation } from "wouter";
import { 
  useListConversations, 
  useDeleteConversation,
  getListConversationsQueryKey
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Trash2, MessageSquare, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

export function ChatSidebar({ activeId, onNavigate }: { activeId?: string, onNavigate?: () => void }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  
  const { data: conversations, isLoading } = useListConversations();
  
  const deleteMutation = useDeleteConversation({
    mutation: {
      onSuccess: (_, variables) => {
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        toast.success("Conversation deleted");
        if (activeId === variables.id) {
          setLocation("/");
        }
      },
      onError: () => {
        toast.error("Failed to delete conversation");
      }
    }
  });

  const handleNewChat = () => {
    setLocation("/");
    onNavigate?.();
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-border">
        <Button 
          onClick={handleNewChat} 
          className="w-full justify-start gap-2 h-10 bg-white text-gray-900 border border-gray-200 hover:bg-gray-50 hover:text-primary shadow-sm"
          variant="outline"
        >
          <Plus className="h-4 w-4" />
          New Conversation
        </Button>
      </div>
      
      <ScrollArea className="flex-1">
        <div className="p-2 space-y-1">
          {isLoading ? (
            <div className="flex justify-center p-4">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : conversations?.length === 0 ? (
            <div className="text-center p-4 text-sm text-muted-foreground">
              No conversations yet
            </div>
          ) : (
            conversations?.map((conv) => (
              <div 
                key={conv.id}
                className={`group flex items-center justify-between p-2 rounded-md cursor-pointer transition-colors ${
                  activeId === conv.id 
                    ? "bg-blue-50 text-primary" 
                    : "hover:bg-gray-100 text-gray-700"
                }`}
                onClick={() => {
                  setLocation(`/chat/${conv.id}`);
                  onNavigate?.();
                }}
              >
                <div className="flex items-center gap-3 overflow-hidden">
                  <MessageSquare className={`h-4 w-4 shrink-0 ${activeId === conv.id ? "text-primary" : "text-gray-400"}`} />
                  <div className="flex flex-col overflow-hidden">
                    <span className="text-sm font-medium truncate">{conv.title || "New Chat"}</span>
                    <span className="text-[10px] text-gray-400 truncate">
                      {formatDistanceToNow(new Date(conv.createdAt), { addSuffix: true })}
                    </span>
                  </div>
                </div>
                
                <Button
                  variant="ghost"
                  size="icon"
                  className={`h-7 w-7 opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-600 transition-opacity ${deleteMutation.isPending && deleteMutation.variables?.id === conv.id ? "opacity-100" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm("Delete this conversation?")) {
                      deleteMutation.mutate({ id: conv.id });
                    }
                  }}
                  disabled={deleteMutation.isPending}
                >
                  {deleteMutation.isPending && deleteMutation.variables?.id === conv.id ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Trash2 className="h-3 w-3" />
                  )}
                </Button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
