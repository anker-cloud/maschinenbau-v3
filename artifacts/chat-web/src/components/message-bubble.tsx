import { Message, Citation } from "@workspace/api-client-react";
import { User, FileText, ExternalLink, Copy, Check } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeSanitize from "rehype-sanitize";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Children, cloneElement, isValidElement, useCallback, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";

function citationUrl(citation: Citation): string {
  return `${import.meta.env.BASE_URL}api/documents/${citation.documentId}/view?page=${citation.pageNumber}`;
}

type CitationTitleFn = (documentTitle: string, pageNumber: number) => string;

function renderCitationsInText(text: string, citations: Citation[], citationTitle: CitationTitleFn): ReactNode[] {
  if (!citations || citations.length === 0) return [text];
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[(\d+)\]$/);
    if (match) {
      const index = parseInt(match[1], 10) - 1;
      const citation = citations[index];
      if (citation) {
        const url = citationUrl(citation);
        return (
          <a
            key={i}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-citation-num={match[1]}
            className="inline-flex items-center justify-center w-5 h-5 ml-1 text-[10px] font-medium bg-primary/20 text-primary rounded hover:bg-primary/30 transition-colors align-text-top leading-none no-underline"
            title={citationTitle(citation.documentTitle, citation.pageNumber)}
          >
            {match[1]}
          </a>
        );
      }
    }
    return part;
  });
}

function withCitations(children: ReactNode, citations: Citation[], citationTitle: CitationTitleFn): ReactNode {
  if (!citations || citations.length === 0) return children;
  return Children.map(children, (child, i) => {
    if (typeof child === "string") {
      return <span key={i}>{renderCitationsInText(child, citations, citationTitle)}</span>;
    }
    if (isValidElement<{ children?: ReactNode }>(child)) {
      const inner = child.props.children;
      if (inner === undefined || inner === null) return child;
      return cloneElement(child, { ...child.props, children: withCitations(inner, citations, citationTitle) });
    }
    return child;
  });
}

function buildHtmlForCopy(proseEl: HTMLElement): string {
  const clone = proseEl.cloneNode(true) as HTMLElement;
  clone.querySelectorAll<HTMLAnchorElement>("a[data-citation-num]").forEach((a) => {
    const num = a.getAttribute("data-citation-num") ?? a.textContent ?? "";
    const href = a.getAttribute("href") ?? "";
    const absHref = href.startsWith("http") ? href : `${window.location.origin}${href.startsWith("/") ? "" : "/"}${href}`;
    const replacement = document.createElement("a");
    replacement.setAttribute("href", absHref);
    replacement.textContent = `[${num}]`;
    a.replaceWith(replacement);
  });
  clone.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
    const href = a.getAttribute("href") ?? "";
    if (href && !href.startsWith("http") && !href.startsWith("mailto:")) {
      const absHref = `${window.location.origin}${href.startsWith("/") ? "" : "/"}${href}`;
      a.setAttribute("href", absHref);
    }
  });
  clone.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("class");
    el.removeAttribute("style");
  });
  return clone.innerHTML;
}

function buildMarkdownForCopy(content: string, citations: Citation[], sourcesLabel: string, pageLabel: (n: number) => string): string {
  let md = content;
  if (citations.length > 0) {
    md += `\n\n${sourcesLabel}:\n`;
    citations.forEach((c, i) => {
      const href = citationUrl(c);
      const absHref = `${window.location.origin}${href.startsWith("/") ? "" : "/"}${href}`;
      md += `[${i + 1}] ${c.documentTitle}, ${pageLabel(c.pageNumber)} — ${absHref}\n`;
    });
  }
  return md;
}

export function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const { t } = useTranslation();
  const isUser = message.role === "user";
  const citations = message.citations ?? [];
  const proseRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const citationTitle = useCallback<CitationTitleFn>(
    (documentTitle, pageNumber) => t("message.citationTitle", { documentTitle, pageNumber }),
    [t]
  );

  const handleCopy = async () => {
    const markdown = buildMarkdownForCopy(
      message.content,
      citations,
      t("message.sources"),
      (n) => t("message.page", { pageNumber: n })
    );
    const html = proseRef.current ? buildHtmlForCopy(proseRef.current) : "";

    try {
      if (
        typeof navigator !== "undefined" &&
        navigator.clipboard &&
        typeof window !== "undefined" &&
        typeof window.ClipboardItem !== "undefined" &&
        typeof navigator.clipboard.write === "function" &&
        html
      ) {
        const item = new window.ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([markdown], { type: "text/plain" }),
        });
        await navigator.clipboard.write([item]);
      } else {
        await navigator.clipboard.writeText(markdown);
      }
      setCopied(true);
      toast.success(t("message.copiedToast"));
      setTimeout(() => setCopied(false), 2000);
    } catch {
      try {
        await navigator.clipboard.writeText(markdown);
        setCopied(true);
        toast.success(t("message.copiedToast"));
        setTimeout(() => setCopied(false), 2000);
      } catch {
        toast.error(t("message.copyFailed"));
      }
    }
  };

  return (
    <div className={`flex gap-4 ${isUser ? "justify-end" : "justify-start"}`}>
      {!isUser && (
        <div className="w-8 h-8 rounded-lg bg-card border border-border shadow-sm flex items-center justify-center shrink-0 mt-1">
          <img
            src="https://stuertz.com/wp-content/uploads/sites/2/2024/05/stuertz-logo.svg"
            alt="Sturtz"
            className="h-3 object-contain brightness-0 invert opacity-80"
          />
        </div>
      )}

      <div className={`group/message flex flex-col gap-2 max-w-[85%] ${isUser ? "items-end" : "items-start"}`}>
        <div
          className={`px-5 py-3.5 rounded-xl text-sm shadow-sm leading-relaxed ${
            isUser
              ? "bg-primary text-primary-foreground font-medium"
              : "bg-card border border-border text-foreground"
          }`}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap">{message.content}</div>
          ) : (
            <div
              ref={proseRef}
              className="prose prose-sm max-w-none text-foreground
                prose-p:my-2 prose-p:leading-relaxed
                prose-headings:font-semibold prose-headings:text-foreground prose-headings:mt-3 prose-headings:mb-2
                prose-h1:text-base prose-h2:text-base prose-h3:text-sm prose-h4:text-sm
                prose-ul:my-2 prose-ol:my-2 prose-li:my-0.5
                prose-strong:text-foreground prose-strong:font-semibold
                prose-code:text-[0.85em] prose-code:bg-muted prose-code:text-foreground prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:font-mono prose-code:before:content-none prose-code:after:content-none
                prose-pre:bg-[#0f172a] prose-pre:text-gray-100 prose-pre:rounded-lg prose-pre:my-2 prose-pre:p-3 prose-pre:text-xs
                prose-a:text-primary prose-a:no-underline hover:prose-a:underline
                prose-table:my-2 prose-table:text-xs prose-th:border prose-th:border-border prose-th:bg-muted prose-th:px-2 prose-th:py-1 prose-th:text-left
                prose-td:border prose-td:border-border prose-td:px-2 prose-td:py-1
                prose-blockquote:border-l-2 prose-blockquote:border-primary/40 prose-blockquote:pl-3 prose-blockquote:italic prose-blockquote:text-muted-foreground prose-blockquote:my-2
                first:[&>*]:mt-0 last:[&>*]:mb-0"
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeSanitize]}
                components={{
                  p: ({ children }) => <p>{withCitations(children, citations, citationTitle)}</p>,
                  li: ({ children }) => <li>{withCitations(children, citations, citationTitle)}</li>,
                  td: ({ children }) => <td>{withCitations(children, citations, citationTitle)}</td>,
                  th: ({ children }) => <th>{withCitations(children, citations, citationTitle)}</th>,
                  h1: ({ children }) => <h1>{withCitations(children, citations, citationTitle)}</h1>,
                  h2: ({ children }) => <h2>{withCitations(children, citations, citationTitle)}</h2>,
                  h3: ({ children }) => <h3>{withCitations(children, citations, citationTitle)}</h3>,
                  h4: ({ children }) => <h4>{withCitations(children, citations, citationTitle)}</h4>,
                  a: ({ href, children }) => (
                    <a href={href} target="_blank" rel="noopener noreferrer">
                      {children}
                    </a>
                  ),
                  pre: ({ children }) => <>{children}</>,
                  code: ({ className, children, ...props }) => {
                    const match = /language-(\w+)/.exec(className || "");
                    const content = String(children ?? "").replace(/\n$/, "");
                    if (match) {
                      return (
                        <SyntaxHighlighter
                          language={match[1]}
                          style={vscDarkPlus}
                          PreTag="pre"
                          customStyle={{
                            margin: "0.5rem 0",
                            padding: "0.75rem",
                            borderRadius: "0.5rem",
                            fontSize: "0.75rem",
                            background: "#0f172a",
                          }}
                          codeTagProps={{
                            style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
                          }}
                        >
                          {content}
                        </SyntaxHighlighter>
                      );
                    }
                    return (
                      <code className={className} {...props}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {message.content}
              </ReactMarkdown>
              {isStreaming && (
                <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 animate-pulse align-middle" />
              )}
            </div>
          )}
        </div>

        {!isUser && !isStreaming && (
          <button
            type="button"
            onClick={handleCopy}
            aria-label={copied ? t("message.copied") : t("message.copy")}
            title={copied ? t("message.copied") : t("message.copy")}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground px-1.5 py-1 -mt-1 rounded-lg hover:bg-muted transition-all opacity-100 md:opacity-0 md:group-hover/message:opacity-100 md:focus:opacity-100 md:focus-within:opacity-100"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3" />
                {t("message.copied")}
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                {t("message.copy")}
              </>
            )}
          </button>
        )}

        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-2 w-full border border-border rounded-xl bg-muted/30 overflow-hidden">
            <div className="px-3 py-2 border-b border-border bg-muted/50 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <FileText className="h-3 w-3" />
              {t("message.sources")}
            </div>
            <div className="divide-y divide-border">
              {message.citations.map((citation, idx) => {
                const url = citationUrl(citation);
                return (
                  <div key={idx} className="p-3 text-xs flex items-start gap-3 hover:bg-muted/40 transition-colors">
                    <Badge variant="outline" className="shrink-0 bg-card border-border font-mono text-[10px] w-6 h-6 p-0 flex items-center justify-center text-primary">
                      {idx + 1}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {citation.documentTitle}
                      </div>
                      <div className="text-muted-foreground mt-0.5">
                        {t("message.page", { pageNumber: citation.pageNumber })}
                      </div>
                      {citation.snippet && (
                        <div className="text-muted-foreground mt-1.5 italic border-l-2 border-primary/30 pl-2 line-clamp-2 text-[11px]">
                          "{citation.snippet}"
                        </div>
                      )}
                    </div>
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium bg-primary/10 hover:bg-primary/20 px-2 py-1 rounded-lg transition-colors"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {t("message.view")}
                    </a>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {isUser && (
        <div className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center shrink-0 mt-1 border border-primary/25">
          <User className="h-4 w-4" />
        </div>
      )}
    </div>
  );
}
