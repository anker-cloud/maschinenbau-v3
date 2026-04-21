import { useState, useMemo, useEffect } from "react";
import { useListFeedback, FeedbackListItemRating } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { ThumbsUp, ThumbsDown, Filter, MessageSquareOff, LucideIcon } from "lucide-react";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationPrevious,
  PaginationNext,
  PaginationEllipsis,
} from "@/components/ui/pagination";

const PAGE_SIZE = 10;

type RatingFilter = "all" | "like" | "dislike";

function buildPageNumbers(current: number, total: number): (number | "ellipsis")[] {
  if (total <= 7) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }
  const pages: (number | "ellipsis")[] = [];
  const radius = 2;
  const low = Math.max(2, current - radius);
  const high = Math.min(total - 1, current + radius);

  pages.push(1);
  if (low > 2) pages.push("ellipsis");
  for (let p = low; p <= high; p++) pages.push(p);
  if (high < total - 1) pages.push("ellipsis");
  pages.push(total);

  return pages;
}

interface StatCardProps {
  count: number;
  label: string;
  hint: string;
  Icon: LucideIcon;
  colorScheme: "green" | "red";
}

function StatCard({ count, label, hint, Icon, colorScheme }: StatCardProps) {
  const isGreen = colorScheme === "green";
  return (
    <div
      className={
        isGreen
          ? "bg-gradient-to-br from-emerald-50 to-green-100 dark:from-emerald-950/40 dark:to-green-900/30 border border-green-200 dark:border-green-800 rounded-2xl shadow-sm p-6 flex items-center gap-5"
          : "bg-gradient-to-br from-rose-50 to-red-100 dark:from-rose-950/40 dark:to-red-900/30 border border-red-200 dark:border-red-800 rounded-2xl shadow-sm p-6 flex items-center gap-5"
      }
    >
      <div
        className={
          isGreen
            ? "w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/50 flex items-center justify-center shrink-0"
            : "w-14 h-14 rounded-full bg-red-100 dark:bg-red-900/50 flex items-center justify-center shrink-0"
        }
      >
        <Icon
          className={
            isGreen
              ? "w-7 h-7 text-green-600 dark:text-green-400"
              : "w-7 h-7 text-red-600 dark:text-red-400"
          }
        />
      </div>
      <div>
        <div
          className={
            isGreen
              ? "text-5xl font-bold text-green-700 dark:text-green-300 leading-none"
              : "text-5xl font-bold text-red-700 dark:text-red-300 leading-none"
          }
        >
          {count}
        </div>
        <div
          className={
            isGreen
              ? "text-sm font-medium text-green-700 dark:text-green-400 mt-1"
              : "text-sm font-medium text-red-700 dark:text-red-400 mt-1"
          }
        >
          {label}
        </div>
        <div
          className={
            isGreen
              ? "text-xs text-green-600/70 dark:text-green-500/70 mt-0.5"
              : "text-xs text-red-600/70 dark:text-red-500/70 mt-0.5"
          }
        >
          {hint}
        </div>
      </div>
    </div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="bg-card border border-border rounded-2xl shadow-sm p-6 flex items-center gap-5">
      <div className="w-14 h-14 rounded-full bg-muted animate-pulse shrink-0" />
      <div className="flex flex-col gap-2">
        <div className="w-20 h-10 bg-muted animate-pulse rounded" />
        <div className="w-32 h-4 bg-muted/60 animate-pulse rounded" />
      </div>
    </div>
  );
}

function RatingBadge({ rating }: { rating: FeedbackListItemRating }) {
  if (rating === FeedbackListItemRating.like) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700 border border-green-200 dark:bg-green-950/50 dark:text-green-400 dark:border-green-800">
        <ThumbsUp className="w-3 h-3" /> Like
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 border border-red-200 dark:bg-red-950/50 dark:text-red-400 dark:border-red-800">
      <ThumbsDown className="w-3 h-3" /> Dislike
    </span>
  );
}

function TableSkeletonRows() {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i}>
          <td className="px-6 py-4"><div className="h-4 w-36 bg-muted rounded animate-pulse" /></td>
          <td className="px-6 py-4"><div className="h-4 w-14 bg-muted rounded animate-pulse" /></td>
          <td className="px-6 py-4"><div className="h-4 w-48 bg-muted rounded animate-pulse" /></td>
          <td className="px-6 py-4"><div className="h-4 w-28 bg-muted rounded animate-pulse" /></td>
          <td className="px-6 py-4"><div className="h-4 w-20 bg-muted rounded animate-pulse" /></td>
        </tr>
      ))}
    </>
  );
}

function TableHead() {
  const { t } = useTranslation();
  return (
    <thead className="bg-muted/50 border-b border-border">
      <tr>
        <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.feedbackUser")}
        </th>
        <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.feedbackRating")}
        </th>
        <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.feedbackMessage")}
        </th>
        <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.feedbackComment")}
        </th>
        <th className="px-6 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t("admin.feedbackDate")}
        </th>
      </tr>
    </thead>
  );
}

export function FeedbackTab() {
  const { t } = useTranslation();
  const { data: feedbackItems, isLoading } = useListFeedback();
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("all");
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [ratingFilter]);

  const { likeCount, dislikeCount } = useMemo(() => {
    let likes = 0;
    let dislikes = 0;
    for (const item of feedbackItems ?? []) {
      if (item.rating === FeedbackListItemRating.like) likes++;
      else dislikes++;
    }
    return { likeCount: likes, dislikeCount: dislikes };
  }, [feedbackItems]);

  const filtered = useMemo(() => {
    if (!feedbackItems) return [];
    if (ratingFilter === "all") return feedbackItems;
    return feedbackItems.filter((item) => item.rating === ratingFilter);
  }, [feedbackItems, ratingFilter]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const pageNumbers = useMemo(
    () => buildPageNumbers(page, totalPages),
    [page, totalPages],
  );

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        {isLoading ? (
          <>
            <StatCardSkeleton />
            <StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard
              count={likeCount}
              label={t("admin.feedbackLikes")}
              hint={t("admin.feedbackLikesHint")}
              Icon={ThumbsUp}
              colorScheme="green"
            />
            <StatCard
              count={dislikeCount}
              label={t("admin.feedbackDislikes")}
              hint={t("admin.feedbackDislikesHint")}
              Icon={ThumbsDown}
              colorScheme="red"
            />
          </>
        )}
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-muted-foreground" />
          <Select
            value={ratingFilter}
            onValueChange={(v) => setRatingFilter(v as RatingFilter)}
          >
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("admin.feedbackFilterAll")}</SelectItem>
              <SelectItem value="like">{t("admin.feedbackFilterLikes")}</SelectItem>
              <SelectItem value="dislike">{t("admin.feedbackFilterDislikes")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {!isLoading && (
          <span className="text-sm text-muted-foreground">
            {t("admin.feedbackResultCount", { count: filtered.length })}
          </span>
        )}
      </div>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <TableHead />
          <tbody className="divide-y divide-border">
            {isLoading ? (
              <TableSkeletonRows />
            ) : (
              <>
                {paged.map((item) => (
                  <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-primary/10 text-primary text-xs font-semibold flex items-center justify-center shrink-0">
                          {item.userEmail[0].toUpperCase()}
                        </div>
                        <span className="text-sm text-muted-foreground">
                          {item.userEmail}
                        </span>
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <RatingBadge rating={item.rating} />
                    </td>
                    <td className="px-6 py-4 max-w-xs">
                      <span className="text-xs text-muted-foreground/70 mr-1">Bot:</span>
                      <span className="text-sm text-foreground line-clamp-2">
                        {item.messageSnippet}
                      </span>
                    </td>
                    <td className="px-6 py-4 max-w-xs text-sm">
                      {item.comment ? (
                        <span className="text-muted-foreground italic">{item.comment}</span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-muted-foreground whitespace-nowrap">
                      {format(new Date(item.createdAt), "MMM d, yyyy")}
                    </td>
                  </tr>
                ))}

                {paged.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <MessageSquareOff className="w-8 h-8 text-muted-foreground/40 mx-auto mb-2" />
                      <p className="text-sm text-muted-foreground">
                        {ratingFilter !== "all"
                          ? t("admin.feedbackNoResults")
                          : t("admin.feedbackEmpty")}
                      </p>
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center">
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (page > 1) setPage((p) => p - 1);
                  }}
                  aria-disabled={page === 1}
                  className={page === 1 ? "pointer-events-none opacity-50" : ""}
                />
              </PaginationItem>

              {pageNumbers.map((entry, idx) =>
                entry === "ellipsis" ? (
                  <PaginationItem key={`ellipsis-${idx}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={entry}>
                    <PaginationLink
                      href="#"
                      isActive={page === entry}
                      onClick={(e) => {
                        e.preventDefault();
                        setPage(entry);
                      }}
                    >
                      {entry}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}

              <PaginationItem>
                <PaginationNext
                  href="#"
                  onClick={(e) => {
                    e.preventDefault();
                    if (page < totalPages) setPage((p) => p + 1);
                  }}
                  aria-disabled={page === totalPages}
                  className={page === totalPages ? "pointer-events-none opacity-50" : ""}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        </div>
      )}
    </div>
  );
}
