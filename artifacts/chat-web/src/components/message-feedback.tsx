import { useState } from "react";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import {
  useSubmitMessageFeedback,
  type CreateMessageFeedbackBodyRating,
} from "@workspace/api-client-react";

interface MessageFeedbackProps {
  messageId: string;
  conversationId: string;
}

type Rating = CreateMessageFeedbackBodyRating | null;

export function MessageFeedback({ messageId, conversationId }: MessageFeedbackProps) {
  const { t } = useTranslation();
  const [rating, setRating] = useState<Rating>(null);
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [comment, setComment] = useState("");

  const mutation = useSubmitMessageFeedback();

  const submitFeedback = async (selectedRating: CreateMessageFeedbackBodyRating, feedbackComment?: string) => {
    try {
      await mutation.mutateAsync({
        conversationId,
        messageId,
        data: { rating: selectedRating, comment: feedbackComment },
      });
      setRating(selectedRating);
      toast.success(t("message.feedbackThanks"));
    } catch {
      toast.error(t("message.feedbackError"));
    }
  };

  const handleLike = () => {
    if (showCommentBox) setShowCommentBox(false);
    submitFeedback("like");
  };

  const handleDislike = () => {
    setShowCommentBox((prev) => !prev);
  };

  const handleSubmitComment = () => {
    setShowCommentBox(false);
    submitFeedback("dislike", comment);
  };

  return (
    <div className="flex items-start gap-1">
      <button
        type="button"
        onClick={handleLike}
        aria-label={t("message.like")}
        title={t("message.like")}
        disabled={mutation.isPending}
        className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-1 -mt-1 rounded-lg transition-all ${
          rating === "like"
            ? "text-green-500 hover:bg-muted"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        }`}
      >
        <ThumbsUp className="h-3 w-3" />
      </button>

      <button
        type="button"
        onClick={handleDislike}
        aria-label={t("message.dislike")}
        title={t("message.dislike")}
        disabled={mutation.isPending}
        className={`inline-flex items-center gap-1 text-[11px] px-1.5 py-1 -mt-1 rounded-lg transition-all ${
          rating === "dislike"
            ? "text-red-500 hover:bg-muted"
            : "text-muted-foreground hover:text-foreground hover:bg-muted"
        }`}
      >
        <ThumbsDown className="h-3 w-3" />
      </button>

      {showCommentBox && (
        <div className="flex flex-col gap-1.5 ml-1">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={t("message.feedbackComment")}
            rows={2}
            className="text-xs rounded-lg border border-border bg-card px-2 py-1.5 resize-none text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary min-w-[200px]"
          />
          <button
            type="button"
            onClick={handleSubmitComment}
            disabled={mutation.isPending}
            className="self-end text-[11px] px-2.5 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {t("message.feedbackSubmit")}
          </button>
        </div>
      )}
    </div>
  );
}
