import { Message, Citation } from "@workspace/api-client-react";
import { User, FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";

  const renderContentWithCitations = (content: string, citations: Citation[]) => {
    if (!citations || citations.length === 0) return content;

    // Simple regex to find [1], [2], etc.
    const parts = content.split(/(\[\d+\])/g);
    
    return parts.map((part, i) => {
      const match = part.match(/\[(\d+)\]/);
      if (match) {
        const index = parseInt(match[1], 10) - 1;
        const citation = citations[index];
        if (citation) {
          const url = `${import.meta.env.BASE_URL}api/documents/${citation.documentId}/view?page=${citation.pageNumber}`;
          return (
            <a 
              key={i} 
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center w-5 h-5 ml-1 text-[10px] font-medium bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors align-text-top leading-none"
              title={`${citation.documentTitle}, Page ${citation.pageNumber}`}
            >
              {match[1]}
            </a>
          );
        }
      }
      return <span key={i}>{part}</span>;
    });
  };

  return (
    <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-sm bg-white border border-gray-200 shadow-sm flex items-center justify-center shrink-0 mt-1">
          <img 
            src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg" 
            alt="Sturtz" 
            className="h-3 object-contain" 
          />
        </div>
      )}
      
      <div className={`flex flex-col gap-2 max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div 
          className={`px-5 py-3.5 rounded-lg text-sm shadow-sm leading-relaxed ${
            isUser 
              ? "bg-primary text-primary-foreground font-medium" 
              : "bg-white border border-gray-200 text-gray-800"
          }`}
        >
          <div className="whitespace-pre-wrap">
            {isUser ? message.content : renderContentWithCitations(message.content, message.citations)}
          </div>
        </div>

        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-2 w-full border border-gray-200 rounded-md bg-gray-50/50 overflow-hidden">
            <div className="px-3 py-2 border-b border-gray-200 bg-gray-100/50 flex items-center gap-2 text-xs font-medium text-gray-700">
              <FileText className="h-3 w-3" />
              Sources
            </div>
            <div className="divide-y divide-gray-100">
              {message.citations.map((citation, idx) => {
                const url = `${import.meta.env.BASE_URL}api/documents/${citation.documentId}/view?page=${citation.pageNumber}`;
                return (
                  <div key={idx} className="p-3 text-xs flex items-start gap-3 hover:bg-white transition-colors">
                    <Badge variant="outline" className="shrink-0 bg-white font-mono text-[10px] w-6 h-6 p-0 flex items-center justify-center">
                      {idx + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-gray-900 truncate">
                        {citation.documentTitle}
                      </div>
                      <div className="text-gray-500 mt-0.5">
                        Page {citation.pageNumber}
                      </div>
                      {citation.snippet && (
                        <div className="text-gray-500 mt-1.5 italic border-l-2 border-gray-200 pl-2 line-clamp-2 text-[11px]">
                          "{citation.snippet}"
                        </div>
                      )}
                    </div>
                    <a 
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 inline-flex items-center gap-1 text-primary hover:text-blue-700 font-medium bg-blue-50 hover:bg-blue-100 px-2 py-1 rounded transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      View
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-blue-100 text-primary flex items-center justify-center shrink-0 mt-1 border border-blue-200">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
