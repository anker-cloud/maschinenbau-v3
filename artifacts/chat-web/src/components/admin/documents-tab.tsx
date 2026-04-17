import { useState, useCallback, useRef } from "react";
import { 
  useListDocuments, 
  useDeleteDocument,
  useReingestDocument,
  getListDocumentsQueryKey,
  DocumentStatus
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Trash2, Upload, FileText, AlertCircle, RefreshCw, Loader2, X } from "lucide-react";
import { Progress } from "@/components/ui/progress";

const ALLOWED_EXTS = [".pdf", ".docx", ".doc", ".txt", ".md", ".html", ".htm", ".pptx", ".ppt"];
const MAX_BYTES = 100 * 1024 * 1024;

function formatBytes(bytes: number) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function stemName(filename: string) {
  return filename.replace(/\.[^/.]+$/, "");
}

interface QueuedFile {
  file: File;
  title: string;
}

export function DocumentsTab() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadState, setUploadState] = useState<{ current: number; total: number; progress: number } | null>(null);

  const { data: documents, isLoading } = useListDocuments({
    query: {
      refetchInterval: (query) => {
        const hasPending = query.state.data?.some(d =>
          d.status === DocumentStatus.pending || d.status === DocumentStatus.ingesting
        );
        return hasPending ? 2000 : false;
      }
    }
  });

  const deleteMutation = useDeleteDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast.success("Document deleted");
      },
      onError: () => {
        toast.error("Failed to delete document");
      }
    }
  });

  const reingestMutation = useReingestDocument({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        toast.success("Document re-ingestion started");
      },
      onError: () => {
        toast.error("Failed to re-ingest document");
      }
    }
  });

  const addFiles = (incoming: FileList | File[]) => {
    const files = Array.from(incoming);
    const valid: QueuedFile[] = [];
    for (const file of files) {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        toast.error(`${file.name}: unsupported format`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        toast.error(`${file.name}: exceeds 100 MB limit`);
        continue;
      }
      valid.push({ file, title: stemName(file.name) });
    }
    if (valid.length) setQueue(prev => [...prev, ...valid]);
  };

  const removeFromQueue = (idx: number) => {
    setQueue(prev => prev.filter((_, i) => i !== idx));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const updateTitle = (idx: number, value: string) => {
    setQueue(prev => prev.map((item, i) => i === idx ? { ...item, title: value } : item));
  };

  const handleUploadAll = async () => {
    if (!queue.length) return;
    setIsUploading(true);
    const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
    let succeeded = 0;
    let failed = 0;

    for (let i = 0; i < queue.length; i++) {
      const { file, title } = queue[i];
      setUploadState({ current: i + 1, total: queue.length, progress: 0 });

      const ticker = setInterval(() => {
        setUploadState(prev => prev ? { ...prev, progress: Math.min(prev.progress + 10, 90) } : prev);
      }, 400);

      try {
        const formData = new FormData();
        formData.append("title", title);
        formData.append("file", file);

        const res = await fetch(`${baseUrl}/api/admin/documents/upload`, {
          method: "POST",
          body: formData,
        });
        clearInterval(ticker);

        if (!res.ok) throw new Error("Upload failed");
        setUploadState(prev => prev ? { ...prev, progress: 100 } : prev);
        await new Promise(r => setTimeout(r, 300));
        succeeded++;
      } catch {
        clearInterval(ticker);
        failed++;
        toast.error(`Failed to upload "${title}"`);
      }
    }

    queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
    if (succeeded > 0) toast.success(`${succeeded} document${succeeded > 1 ? "s" : ""} uploaded`);
    setQueue([]);
    setUploadState(null);
    setIsUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const getStatusCell = (doc: { status: string; ingestProgress: number; ingestTotalPages: number }) => {
    const { status, ingestProgress, ingestTotalPages } = doc;
    if (status === DocumentStatus.ready) {
      return (
        <Badge variant="secondary" className="bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20">Ready</Badge>
      );
    }
    if (status === DocumentStatus.failed) {
      return <Badge variant="destructive">Failed</Badge>;
    }
    if (status === DocumentStatus.pending || status === DocumentStatus.ingesting) {
      if (ingestTotalPages === 0) {
        return (
          <div className="space-y-1.5 min-w-[140px]">
            <Badge variant="secondary" className="bg-primary/20 text-primary hover:bg-primary/20 flex items-center gap-1 w-fit">
              <Loader2 className="w-3 h-3 animate-spin" /> Initializing…
            </Badge>
          </div>
        );
      }
      if (ingestProgress < ingestTotalPages) {
        const pct = Math.round((ingestProgress / ingestTotalPages) * 100);
        return (
          <div className="space-y-1.5 min-w-[160px]">
            <div className="flex items-center justify-between text-xs text-primary">
              <span className="flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Extracting pages
              </span>
              <span className="font-medium tabular-nums">{ingestProgress} / {ingestTotalPages}</span>
            </div>
            <Progress value={pct} className="h-1.5" />
          </div>
        );
      }
      return (
        <div className="space-y-1.5 min-w-[160px]">
          <div className="flex items-center justify-between text-xs text-primary">
            <span className="flex items-center gap-1">
              <Loader2 className="w-3 h-3 animate-spin" /> Building index
            </span>
            <span className="font-medium tabular-nums">{ingestTotalPages} pages</span>
          </div>
          <Progress value={100} className="h-1.5 [&>div]:animate-pulse" />
        </div>
      );
    }
    return <Badge variant="outline">{status}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="bg-card p-6 rounded-xl border border-border shadow-sm">
        <h2 className="text-lg font-medium text-foreground mb-4">Upload Documents</h2>

        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors cursor-pointer ${
            isDragging ? "border-primary bg-primary/5" : "border-border hover:border-primary hover:bg-primary/5"
          }`}
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={(e) => { e.preventDefault(); setIsDragging(false); }}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
          }}
          onClick={() => !isUploading && fileInputRef.current?.click()}
        >
          <Upload className={`h-10 w-10 mx-auto mb-4 ${isDragging ? "text-primary" : "text-muted-foreground"}`} />
          <p className="text-sm font-medium text-foreground mb-1">
            Click or drag files here to upload
          </p>
          <p className="text-xs text-muted-foreground">
            Supports PDF, DOCX, TXT, MD, HTML, PPTX &mdash; up to 100 MB each &mdash; multiple files at once
          </p>
          <input
            type="file"
            ref={fileInputRef}
            className="hidden"
            accept={ALLOWED_EXTS.join(",")}
            multiple
            onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); }}
          />
        </div>

        {queue.length > 0 && (
          <div className="mt-4 space-y-3">
            {queue.map((item, idx) => (
              <div key={idx} className="flex items-center gap-3 bg-muted/40 p-3 rounded-lg border border-border">
                <div className="w-8 h-8 bg-card rounded-md flex items-center justify-center border border-border text-primary shrink-0">
                  <FileText className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0 grid grid-cols-2 gap-2 items-center">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground truncate">{item.file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatBytes(item.file.size)}</p>
                  </div>
                  <Input
                    value={item.title}
                    onChange={(e) => updateTitle(idx, e.target.value)}
                    placeholder="Document title"
                    disabled={isUploading}
                    className="h-8 text-sm"
                  />
                </div>
                {!isUploading && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeFromQueue(idx)}
                    className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}

            {isUploading && uploadState && (
              <div className="space-y-1.5 px-1">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading {uploadState.current} of {uploadState.total}…</span>
                  <span>{uploadState.progress}%</span>
                </div>
                <Progress value={uploadState.progress} className="h-2" />
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                {queue.length} file{queue.length > 1 ? "s" : ""} queued
              </p>
              <Button
                onClick={handleUploadAll}
                disabled={isUploading || queue.some(f => !f.title.trim())}
                className="bg-primary hover:bg-primary/90 text-primary-foreground"
              >
                {isUploading ? (
                  <><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…</>
                ) : (
                  <><Upload className="mr-2 h-4 w-4" /> Upload {queue.length > 1 ? `All ${queue.length}` : ""} to Knowledge Base</>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <div className="p-4 border-b border-border">
          <h2 className="text-lg font-medium text-foreground">Knowledge Base</h2>
        </div>

        {isLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
              <tr>
                <th className="px-6 py-3">Document Title</th>
                <th className="px-6 py-3">Size</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Uploaded</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {documents?.map((doc) => (
                <tr key={doc.id} className="hover:bg-muted/40 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-medium text-foreground">{doc.title}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{doc.filename}</div>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">{formatBytes(doc.size)}</td>
                  <td className="px-6 py-4">{getStatusCell(doc)}</td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {format(new Date(doc.createdAt), "MMM d, yyyy")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-muted-foreground hover:text-primary hover:bg-primary/10"
                        title="Re-ingest"
                        onClick={() => reingestMutation.mutate({ id: doc.id })}
                        disabled={reingestMutation.isPending && reingestMutation.variables?.id === doc.id}
                      >
                        <RefreshCw className={`h-4 w-4 ${reingestMutation.isPending && reingestMutation.variables?.id === doc.id ? "animate-spin" : ""}`} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        title="Delete"
                        onClick={() => {
                          if (confirm(`Are you sure you want to delete "${doc.title}"?`)) {
                            deleteMutation.mutate({ id: doc.id });
                          }
                        }}
                        disabled={deleteMutation.isPending && deleteMutation.variables?.id === doc.id}
                      >
                        {deleteMutation.isPending && deleteMutation.variables?.id === doc.id ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Trash2 className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {(!documents || documents.length === 0) && (
                <tr>
                  <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                    <div className="flex flex-col items-center justify-center">
                      <AlertCircle className="h-8 w-8 text-muted-foreground/40 mb-2" />
                      <p>No documents found</p>
                      <p className="text-xs mt-1">Upload documents to start building the knowledge base</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
