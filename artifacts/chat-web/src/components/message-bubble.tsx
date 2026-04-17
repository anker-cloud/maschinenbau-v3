import { Message, Citation } from "@workspace/api-client-react";
import { User, FileText, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";

function renderCitationsInText(text: string, citations: Citation[]): ReactNode[] {
  if (!citations || citations.length === 0) return [text];
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
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
            className="inline-flex items-center justify-center w-5 h-5 ml-1 text-[10px] font-medium bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors align-text-top leading-none no-underline"
            title={`${citation.documentTitle}, Page ${citation.pageNumber}`}
          >
            {match[1]}
          </a>
        );
      }
    }
    return part;
  });
}

function withCitations(children: ReactNode, citations: Citation[]): ReactNode {
  if (!citations || citations.length === 0) return children;
  return Children.map(children, (child, i) => {
    if (typeof child === "string") {
      return <span key={i}>{renderCitationsInText(child, citations)}</span>;
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      const inner = child.props.children;
      if (inner === undefined || inner === null) return child;
      return cloneElement(child, { ...child.props, children: withCitations(inner, citations) });
    }
    return child;
  });
}

export function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  const citations = message.citations ?? [];

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
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <div
              className="prose prose-sm max-w-none text-gray-800
                prose-p:my-2 prose-p:leading-relaxed
                prose-headings:font-semibold prose-headings:text-gray-900 prose-headings:mt-3 prose-headings:mb-2
                prose-h1:text-base prose-h2:text-base prose-h3:text-sm prose-h4:text-sm
                prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                prose-strong:text-gray-900 prose-strong:font-semibold
                prose-code:text-[0.85em] prose-code:bg-gray-100 prose-code:text-gray-800 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                prose-pre:bg-gray-900 prose-pre:text-gray-100 prose-pre:rounded prose-pre:my-2 prose-pre:p-3 prose-pre:text-xs
                prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                prose-table:my-2 prose-table:text-xs prose-th:border prose-th:border-gray-200 prose-th:bg-gray-50 prose-th:px-2 prose-th:py-1 prose-th:text-left
                prose-td:border prose-td:border-gray-200 prose-td:px-2 prose-td:py-1
                prose-blockquote:border-l-2 prose-blockquote:border-gray-200 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-gray-600 prose-blockquote:my-2
                first:[&>*]:mt-0 last:[&>*]:mb-0"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={{
                  p: ({ children }) => <p>{withCitations(children, citations)}</p>,
                  li: ({ children }) => <li>{withCitations(children, citations)}</li>,
                  td: ({ children }) => <td>{withCitations(children, citations)}</td>,
                  th: ({ children }) => <th>{withCitations(children, citations)}</th>,
                  h1: ({ children }) => <h1>{withCitations(children, citations)}</h1>,
                  h2: ({ children }) => <h2>{withCitations(children, citations)}</h2>,
                  h3: ({ children }) => <h3>{withCitations(children, citations)}</h3>,
                  h4: ({ children }) => <h4>{withCitations(children, citations)}</h4>,
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            </div>
          )}
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
