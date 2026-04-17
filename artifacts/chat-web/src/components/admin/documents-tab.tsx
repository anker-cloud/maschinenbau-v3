import { useState, useCallback, useRef } from "react";
import { 
  useListDocuments, 
  useDeleteDocument, 
  useUploadDocument,
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

function formatBytes(bytes: number) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export function DocumentsTab() {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [documentTitle, setDocumentTitle] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isUploading, setIsUploading] = useState(false);

  const { data: documents, isLoading } = useListDocuments({
    query: {
      refetchInterval: (query) => {
        const hasPending = query.state.data?.some(d => 
          d.status === DocumentStatus.pending || d.status === DocumentStatus.ingesting
        );
        return hasPending ? 5000 : false;
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

  const handleFileSelect = (file: File) => {
    if (file.size > 100 * 1024 * 1024) {
      toast.error("File exceeds 100MB limit");
      return;
    }
    const extMatch = file.name.match(/\.(pdf|docx|txt)$/i);
    if (!extMatch) {
      toast.error("Only .pdf, .docx, and .txt files are supported");
      return;
    }
    
    setSelectedFile(file);
    // Remove extension for title
    setDocumentTitle(file.name.replace(/\.[^/.]+$/, ""));
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFileSelect(e.dataTransfer.files[0]);
    }
  };

  const handleUpload = async () => {
    if (!selectedFile || !documentTitle) return;
    
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      const formData = new FormData();
      formData.append("title", documentTitle);
      formData.append("file", selectedFile);
      
      // Using manual fetch to track progress since standard fetch doesn't support upload progress
      // Alternatively, we simulate progress visually since XHR is needed for real progress
      const progressInterval = setInterval(() => {
        setUploadProgress(prev => {
          if (prev >= 90) return prev;
          return prev + 10;
        });
      }, 500);

      // Using the base URL with trailing slash from environment
      const baseUrl = import.meta.env.BASE_URL.replace(/\/$/, "");
      const res = await fetch(`${baseUrl}/api/admin/documents/upload`, {
        method: "POST",
        body: formData,
      });

      clearInterval(progressInterval);
      
      if (!res.ok) {
        throw new Error("Upload failed");
      }
      
      setUploadProgress(100);
      
      setTimeout(() => {
        toast.success("Document uploaded successfully");
        setSelectedFile(null);
        setDocumentTitle("");
        setUploadProgress(0);
        setIsUploading(false);
        queryClient.invalidateQueries({ queryKey: getListDocumentsQueryKey() });
        if (fileInputRef.current) fileInputRef.current.value = '';
      }, 500);
      
    } catch (err) {
      console.error(err);
      toast.error("Upload failed");
      setIsUploading(false);
      setUploadProgress(0);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case DocumentStatus.ready:
        return <Badge variant="secondary" className="bg-green-100 text-green-700 hover:bg-green-100">Ready</Badge>;
      case DocumentStatus.pending:
      case DocumentStatus.ingesting:
        return <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Processing</Badge>;
      case DocumentStatus.failed:
        return <Badge variant="destructive">Failed</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-white p-6 rounded-lg border border-gray-200 shadow-sm">
        <h2 className="text-lg font-medium text-gray-900 mb-4">Upload Document</h2>
        
        {!selectedFile ? (
          <div 
            className={`border-2 border-dashed rounded-lg p-10 text-center transition-colors cursor-pointer ${
              isDragging ? "border-primary bg-blue-50" : "border-gray-300 hover:border-primary hover:bg-gray-50"
            }`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className={`h-10 w-10 mx-auto mb-4 ${isDragging ? "text-primary" : "text-gray-400"}`} />
            <p className="text-sm font-medium text-gray-900 mb-1">Click or drag file to this area to upload</p>
            <p className="text-xs text-gray-500">Supports .pdf, .docx, .txt (Max 100MB)</p>
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              accept=".pdf,.docx,.txt" 
              onChange={(e) => {
                if (e.target.files?.[0]) handleFileSelect(e.target.files[0]);
              }}
            />
          </div>
        ) : (
          <div className="space-y-4 bg-gray-50 p-4 rounded-lg border border-gray-200">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white rounded flex items-center justify-center border border-gray-200 text-primary">
                  <FileText className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-900">{selectedFile.name}</p>
                  <p className="text-xs text-gray-500">{formatBytes(selectedFile.size)}</p>
                </div>
              </div>
              {!isUploading && (
                <Button variant="ghost" size="sm" onClick={() => setSelectedFile(null)} className="h-8 w-8 p-0 text-gray-500 hover:text-red-600">
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="title">Document Title</Label>
              <Input 
                id="title" 
                value={documentTitle} 
                onChange={(e) => setDocumentTitle(e.target.value)} 
                placeholder="E.g. Sturtz Manual v2"
                disabled={isUploading}
              />
            </div>
            
            {isUploading && (
              <div className="space-y-2 pt-2">
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Uploading...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <Progress value={uploadProgress} className="h-2" />
              </div>
            )}
            
            <div className="flex justify-end pt-2">
              <Button 
                onClick={handleUpload} 
                disabled={isUploading || !documentTitle.trim()}
                className="bg-primary hover:bg-blue-600"
              >
                {isUploading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Upload to Knowledge Base
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <div className="p-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Knowledge Base</h2>
        </div>
        
        {isLoading ? (
          <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
        ) : (
          <table className="w-full text-sm text-left">
            <thead className="bg-gray-50 text-gray-700 font-medium border-b border-gray-200">
              <tr>
                <th className="px-6 py-3">Document Title</th>
                <th className="px-6 py-3">Size</th>
                <th className="px-6 py-3">Status</th>
                <th className="px-6 py-3">Uploaded</th>
                <th className="px-6 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {documents?.map((doc) => (
                <tr key={doc.id} className="hover:bg-gray-50/50 transition-colors">
                  <td className="px-6 py-4">
                    <div className="font-medium text-gray-900">{doc.title}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{doc.filename}</div>
                  </td>
                  <td className="px-6 py-4 text-gray-500">{formatBytes(doc.size)}</td>
                  <td className="px-6 py-4">
                    {getStatusBadge(doc.status)}
                  </td>
                  <td className="px-6 py-4 text-gray-500">
                    {format(new Date(doc.createdAt), "MMM d, yyyy")}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 text-gray-500 hover:text-primary hover:bg-blue-50"
                        title="Re-ingest"
                        onClick={() => reingestMutation.mutate({ id: doc.id })}
                        disabled={reingestMutation.isPending && reingestMutation.variables?.id === doc.id}
                      >
                        <RefreshCw className={`h-4 w-4 ${reingestMutation.isPending && reingestMutation.variables?.id === doc.id ? "animate-spin" : ""}`} />
                      </Button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 text-gray-500 hover:text-red-600 hover:bg-red-50"
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
                  <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                    <div className="flex flex-col items-center justify-center">
                      <AlertCircle className="h-8 w-8 text-gray-300 mb-2" />
                      <p>No documents found</p>
                      <p className="text-xs mt-1">Upload a document to start building the knowledge base</p>
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
