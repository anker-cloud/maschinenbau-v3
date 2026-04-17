import { useState, useRef, useEffect } from "react";
import { useLocation } from "wouter";
import { 
  useGetConversation,
  useSendMessage,
  useCreateConversation,
  getGetConversationQueryKey,
  getListConversationsQueryKey,
  Message
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Send } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import { toast } from "sonner";

export function ChatArea({ conversationId }: { conversationId?: string }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);
  
  const [input, setInput] = useState("");
  const [optimisticMessages, setOptimisticMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  const { data: conversation, isLoading } = useGetConversation(
    conversationId || "", 
    { query: { enabled: !!conversationId } }
  );

  const createMutation = useCreateConversation({
    mutation: {
      onSuccess: (data) => {
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        // After creating, send the first message to this new conversation
        sendMessageMutation.mutate({
          id: data.id,
          data: { content: input }
        });
        setInput("");
        setLocation(`/chat/${data.id}`);
      },
      onError: () => {
        setIsTyping(false);
        setOptimisticMessages([]);
        toast.error("Failed to create conversation");
      }
    }
  });

  const sendMessageMutation = useSendMessage({
    mutation: {
      onSuccess: (data, variables) => {
        setIsTyping(false);
        setOptimisticMessages([]);
        queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(variables.id) });
      },
      onError: () => {
        setIsTyping(false);
        setOptimisticMessages([]);
        toast.error("Failed to send message");
      }
    }
  });

  const scrollToBottom = () => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  };

  useEffect(() => {
    scrollToBottom();
  }, [conversation?.messages, optimisticMessages, isTyping]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isTyping) return;

    const userMessageContent = input;
    
    // Set optimistic UI
    const tempMessage: Message = {
      id: "temp-" + Date.now(),
      role: "user",
      content: userMessageContent,
      citations: [],
      createdAt: new Date().toISOString()
    };
    
    setOptimisticMessages([tempMessage]);
    setIsTyping(true);

    if (!conversationId) {
      // Create new conversation first
      createMutation.mutate({
        data: { title: userMessageContent.substring(0, 60) + (userMessageContent.length > 60 ? "..." : "") }
      });
    } else {
      // Send to existing
      sendMessageMutation.mutate({
        id: conversationId,
        data: { content: userMessageContent }
      });
      setInput("");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isPending = createMutation.isPending || sendMessageMutation.isPending;

  // Determine what messages to show
  const displayMessages = conversation?.messages || [];
  const allMessages = [...displayMessages, ...optimisticMessages];

  return (
    <div className="flex flex-col h-full bg-white relative">
      {isLoading && conversationId ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !conversationId && allMessages.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mb-6">
            <img src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" className="h-8 opacity-50 grayscale" alt="Logo" />
          </div>
          <h2 className="text-2xl font-semibold text-gray-900 tracking-tight">Sturtz Technical Support</h2>
          <p className="text-gray-500 max-w-md mt-2 leading-relaxed">
            Ask questions about machinery, maintenance procedures, or parts manuals. The assistant will provide citations to specific document pages.
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 p-4 md:p-6" viewportRef={scrollRef}>
          <div className="max-w-3xl mx-auto space-y-6 pb-6">
            {allMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} />
            ))}
            
            {isTyping && (
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-sm bg-gray-100 border border-gray-200 flex items-center justify-center shrink-0">
                  <img src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" alt="Sturtz" className="h-3 grayscale" />
                </div>
                <div className="bg-gray-50 border border-gray-100 rounded-lg px-4 py-3 text-gray-500 text-sm flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Assistant is thinking...
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      <div className="p-4 bg-white border-t border-border/50">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a technical question..."
            className="min-h-[60px] max-h-[200px] pr-12 resize-none bg-gray-50 border-gray-200 focus-visible:ring-primary shadow-sm"
            disabled={isPending}
          />
          <Button 
            type="submit" 
            size="icon" 
            disabled={!input.trim() || isPending}
            className="absolute bottom-3 right-3 h-8 w-8 rounded-sm bg-primary hover:bg-blue-600 shadow-sm"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
        <div className="text-center mt-2">
          <span className="text-[10px] text-gray-400">Information generated may be inaccurate. Verify with official documentation.</span>
        </div>
      </div>
    </div>
  );
}
