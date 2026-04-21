import { useListFeedback, FeedbackListItemRating } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { ThumbsUp, ThumbsDown } from "lucide-react";

function FeedbackTableHead() {
  const { t } = useTranslation();
  return (
    <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
      <tr>
        <th className="px-6 py-3">{t("admin.feedbackUser")}</th>
        <th className="px-6 py-3">{t("admin.feedbackRating")}</th>
        <th className="px-6 py-3">{t("admin.feedbackMessage")}</th>
        <th className="px-6 py-3">{t("admin.feedbackComment")}</th>
        <th className="px-6 py-3">{t("admin.feedbackDate")}</th>
      </tr>
    </thead>
  );
}

export function FeedbackTab() {
  const { t } = useTranslation();
  const { data: feedbackItems, isLoading } = useListFeedback();

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
          <div className="h-5 w-48 bg-muted rounded animate-pulse mb-1" />
          <div className="h-4 w-64 bg-muted/60 rounded animate-pulse" />
        </div>
        <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
          <table className="w-full text-sm text-left">
            <FeedbackTableHead />
            <tbody className="divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-6 py-4"><div className="h-4 w-32 bg-muted rounded animate-pulse" /></td>
                  <td className="px-6 py-4"><div className="h-4 w-12 bg-muted rounded animate-pulse" /></td>
                  <td className="px-6 py-4"><div className="h-4 w-48 bg-muted rounded animate-pulse" /></td>
                  <td className="px-6 py-4"><div className="h-4 w-24 bg-muted rounded animate-pulse" /></td>
                  <td className="px-6 py-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  const isLike = (rating: FeedbackListItemRating) => rating === FeedbackListItemRating.like;

  return (
    <div className="space-y-4">
      <div className="bg-card p-4 rounded-xl border border-border shadow-sm">
        <h2 className="text-lg font-medium text-foreground">{t("admin.feedback")}</h2>
        <p className="text-sm text-muted-foreground">{t("admin.feedbackSubtitle")}</p>
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <FeedbackTableHead />
          <tbody className="divide-y divide-border">
            {feedbackItems?.map((item) => (
              <tr
                key={item.id}
                className={
                  isLike(item.rating)
                    ? "bg-green-50 dark:bg-green-950/20 hover:bg-green-100 dark:hover:bg-green-950/30 transition-colors"
                    : "bg-red-50 dark:bg-red-950/20 hover:bg-red-100 dark:hover:bg-red-950/30 transition-colors"
                }
              >
                <td className="px-6 py-4 text-muted-foreground">{item.userEmail}</td>
                <td className="px-6 py-4">
                  {isLike(item.rating) ? (
                    <ThumbsUp className="h-4 w-4 text-green-600 dark:text-green-400" />
                  ) : (
                    <ThumbsDown className="h-4 w-4 text-red-600 dark:text-red-400" />
                  )}
                </td>
                <td className="px-6 py-4 text-foreground max-w-xs">
                  <span className="line-clamp-2">{item.messageSnippet}</span>
                </td>
                <td className="px-6 py-4 text-muted-foreground max-w-xs">
                  {item.comment ? (
                    <span className="line-clamp-2">{item.comment}</span>
                  ) : (
                    <span className="text-muted-foreground/50">—</span>
                  )}
                </td>
                <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
                  {format(new Date(item.createdAt), "MMM d, yyyy")}
                </td>
              </tr>
            ))}
            {(!feedbackItems || feedbackItems.length === 0) && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                  {t("admin.feedbackEmpty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
