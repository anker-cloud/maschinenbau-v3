import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { CheckCircle, Loader2, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useUpdateProfile, getGetCurrentUserQueryKey, checkEmailAvailability } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type FormValues = {
  name: string;
  email: string;
};

type EmailStatus = "idle" | "checking" | "available" | "taken";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EditProfileDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [emailStatus, setEmailStatus] = useState<EmailStatus>("idle");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const schema = useMemo(() => z.object({
    name: z.string().min(1, t('profile.nameRequired')),
    email: z.string().email(t('profile.emailInvalid')),
  }), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: user?.name ?? "", email: user?.email ?? "" },
  });

  const watchedEmail = useWatch({ control: form.control, name: "email" });

  useEffect(() => {
    if (open) {
      form.reset({ name: user?.name ?? "", email: user?.email ?? "" });
      setEmailStatus("idle");
    }
  }, [open, user, form]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const normalizedCurrent = (user?.email ?? "").toLowerCase().trim();
    const normalizedWatched = (watchedEmail ?? "").toLowerCase().trim();

    if (!normalizedWatched || !normalizedWatched.includes("@")) {
      setEmailStatus("idle");
      return;
    }

    if (normalizedWatched === normalizedCurrent) {
      setEmailStatus("idle");
      return;
    }

    setEmailStatus("checking");

    const controller = new AbortController();

    debounceRef.current = setTimeout(async () => {
      try {
        const result = await checkEmailAvailability(
          { email: normalizedWatched },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setEmailStatus(result.available ? "available" : "taken");
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setEmailStatus("idle");
        }
      }
    }, 500);

    return () => {
      controller.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [watchedEmail, user?.email]);

  const mutation = useUpdateProfile({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetCurrentUserQueryKey() });
        toast.success(t('profile.updated'));
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const data = (err as { data?: { error?: string } } | undefined)?.data;
        const message = data?.error ?? t('profile.updateFailed');
        if (/email already in use/i.test(message)) {
          form.setError("email", { message });
          setEmailStatus("taken");
        } else {
          toast.error(message);
        }
      },
    },
  });

  const onSubmit = (data: FormValues) => {
    if (emailStatus === "taken") return;
    const updates: { name?: string; email?: string } = {};
    if (data.name !== user?.name) updates.name = data.name;
    if (data.email !== user?.email) updates.email = data.email;
    if (Object.keys(updates).length === 0) {
      onOpenChange(false);
      return;
    }
    mutation.mutate({ data: updates });
  };

  const emailChanged = watchedEmail !== user?.email;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('profile.title')}</DialogTitle>
          <DialogDescription>{t('profile.description')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="profile-name">{t('profile.name')}</Label>
            <Input
              id="profile-name"
              type="text"
              autoComplete="name"
              {...form.register("name")}
            />
            {form.formState.errors.name && (
              <p className="text-sm text-red-500">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="profile-email">{t('profile.email')}</Label>
            <Input
              id="profile-email"
              type="email"
              autoComplete="email"
              {...form.register("email")}
            />
            {form.formState.errors.email ? (
              <p className="text-sm text-red-500">{form.formState.errors.email.message}</p>
            ) : emailChanged && emailStatus !== "idle" ? (
              <p className={`text-sm flex items-center gap-1 ${emailStatus === "taken" ? "text-red-500" : emailStatus === "available" ? "text-green-600" : "text-gray-400"}`}>
                {emailStatus === "checking" && <Loader2 className="h-3 w-3 animate-spin" />}
                {emailStatus === "available" && <CheckCircle className="h-3 w-3" />}
                {emailStatus === "taken" && <XCircle className="h-3 w-3" />}
                {emailStatus === "checking" && t('profile.checkingEmail')}
                {emailStatus === "available" && t('profile.emailAvailable')}
                {emailStatus === "taken" && t('profile.emailTaken')}
              </p>
            ) : null}
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {t('profile.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={mutation.isPending || emailStatus === "taken" || emailStatus === "checking"}
            >
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('profile.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
