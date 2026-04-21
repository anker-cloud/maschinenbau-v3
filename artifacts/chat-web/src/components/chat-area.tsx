import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { 
  useGetConversation,
  useCreateConversation,
  getGetConversationQueryKey,
  getListConversationsQueryKey,
  Message,
  Citation,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Send } from "lucide-react";
import { MessageBubble } from "./message-bubble";
import { toast } from "sonner";

const OPTIMISTIC_USER_ID = "optimistic-user";

type StreamEvent =
  | { type: "user_message"; userMessage: Message }
  | { type: "delta"; text: string }
  | { type: "done"; assistantMessage: Message }
  | { type: "error"; error: string };

async function* readSSE(response: Response): AsyncGenerator<StreamEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const raw = line.slice(6).trim();
      if (!raw) continue;
      try {
        yield JSON.parse(raw) as StreamEvent;
      } catch {
        // skip malformed
      }
    }
  }
}

export function ChatArea({ conversationId }: { conversationId?: string }) {
  const { t } = useTranslation();
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const scrollRef = useRef<HTMLDivElement>(null);

  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [streamingCitations, setStreamingCitations] = useState<Citation[]>([]);
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<Message | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const { data: conversation, isLoading } = useGetConversation(
    conversationId || "",
    { query: { enabled: !!conversationId } }
  );

  const createMutation = useCreateConversation({
    mutation: {
      onError: () => {
        setIsStreaming(false);
        setStreamingContent("");
        setOptimisticUserMessage(null);
        toast.error(t("chat.createFailed"));
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
  }, [conversation?.messages, streamingContent, isStreaming]);

  const doStream = useCallback(async (convId: string, content: string) => {
    const controller = new AbortController();
    abortRef.current = controller;

    const url = `${import.meta.env.BASE_URL}api/conversations/${convId}/messages`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
        },
        body: JSON.stringify({ content }),
        credentials: "include",
        signal: controller.signal,
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setIsStreaming(false);
      setStreamingContent("");
      setOptimisticUserMessage(null);
      toast.error(t("chat.sendFailed"));
      return;
    }

    if (!response.ok) {
      setIsStreaming(false);
      setStreamingContent("");
      setOptimisticUserMessage(null);
      toast.error(t("chat.sendFailed"));
      return;
    }

    try {
      for await (const event of readSSE(response)) {
        if (event.type === "delta") {
          setStreamingContent((prev) => prev + event.text);
        } else if (event.type === "done") {
          setIsStreaming(false);
          setStreamingContent("");
          setStreamingCitations([]);
          setOptimisticUserMessage(null);
          queryClient.invalidateQueries({ queryKey: getGetConversationQueryKey(convId) });
        }
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setIsStreaming(false);
      setStreamingContent("");
      setOptimisticUserMessage(null);
      toast.error(t("chat.receiveFailed"));
    }
  }, [queryClient]);

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!input.trim() || isStreaming || createMutation.isPending) return;

    const userMessageContent = input;
    setInput("");
    setIsStreaming(true);
    setStreamingContent("");
    setStreamingCitations([]);
    setOptimisticUserMessage({
      id: OPTIMISTIC_USER_ID,
      role: "user",
      content: userMessageContent,
      citations: [],
      createdAt: new Date().toISOString(),
    });

    if (!conversationId) {
      let newConvId: string;
      try {
        const conv = await createMutation.mutateAsync({
          data: { title: userMessageContent.substring(0, 60) + (userMessageContent.length > 60 ? "..." : "") }
        });
        newConvId = conv.id;
        queryClient.invalidateQueries({ queryKey: getListConversationsQueryKey() });
        setLocation(`/chat/${newConvId}`);
      } catch {
        return;
      }
      await doStream(newConvId, userMessageContent);
    } else {
      await doStream(conversationId, userMessageContent);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const isPending = createMutation.isPending || isStreaming;

  const displayMessages = conversation?.messages || [];

  const streamingMessage: Message | null = isStreaming && streamingContent
    ? {
        id: "streaming",
        role: "assistant",
        content: streamingContent,
        citations: streamingCitations,
        createdAt: new Date().toISOString(),
      }
    : null;

  return (
    <div className="flex flex-col h-full bg-background relative">
      {isLoading && conversationId ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : !conversationId && displayMessages.length === 0 && !isStreaming ? (
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-6 ring-1 ring-primary/20">
            <img src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" className="h-8 opacity-60 brightness-0 invert" alt="Logo" />
          </div>
          <h2 className="text-2xl font-semibold text-foreground tracking-tight">{t("chat.heading")}</h2>
          <p className="text-muted-foreground max-w-md mt-2 leading-relaxed">
            {t("chat.subheading")}
          </p>
        </div>
      ) : (
        <ScrollArea className="flex-1 p-4 md:p-6" viewportRef={scrollRef}>
          <div className="max-w-3xl mx-auto space-y-6 pb-6">
            {displayMessages.map((msg) => (
              <MessageBubble key={msg.id} message={msg} conversationId={conversationId} />
            ))}

            {optimisticUserMessage && (
              <MessageBubble key={OPTIMISTIC_USER_ID} message={optimisticUserMessage} />
            )}

            {streamingMessage && (
              <MessageBubble message={streamingMessage} isStreaming />
            )}

            {isStreaming && !streamingContent && (
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-lg bg-card border border-border flex items-center justify-center shrink-0">
                  <img src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" alt="Sturtz" className="h-3 brightness-0 invert opacity-70" />
                </div>
                <div className="bg-card border border-border rounded-lg px-4 py-3 text-muted-foreground text-sm flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                  {t("chat.thinking")}
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      <div className="p-4 bg-background border-t border-border">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("chat.placeholder")}
            className="min-h-[60px] max-h-[200px] pr-12 resize-none bg-card border-border focus-visible:ring-primary shadow-sm"
            disabled={isPending}
          />
          <Button 
            type="submit" 
            size="icon" 
            disabled={!input.trim() || isPending}
            className="absolute bottom-3 right-3 h-8 w-8 rounded-lg bg-primary hover:bg-primary/90 shadow-sm"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </form>
        <div className="text-center mt-2">
          <span className="text-[10px] text-muted-foreground/60">{t("chat.disclaimer")}</span>
        </div>
      </div>
    </div>
  );
}
