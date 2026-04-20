import { useEffect, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useChangePassword } from "@workspace/api-client-react";
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
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ChangePasswordDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation();

  const schema = useMemo(() => z
    .object({
      currentPassword: z.string().min(1, t('password.required')),
      newPassword: z.string().min(8, t('password.minLength')),
      confirmPassword: z.string().min(1, t('password.confirmRequired')),
    })
    .refine((d) => d.newPassword === d.confirmPassword, {
      path: ["confirmPassword"],
      message: t('password.mismatch'),
    })
    .refine((d) => d.currentPassword !== d.newPassword, {
      path: ["newPassword"],
      message: t('password.sameAsCurrent'),
    }), [t]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  useEffect(() => {
    if (!open) form.reset();
  }, [open, form]);

  const mutation = useChangePassword({
    mutation: {
      onSuccess: () => {
        toast.success(t('password.success'));
        onOpenChange(false);
      },
      onError: (err: unknown) => {
        const data = (err as { data?: { error?: string } } | undefined)?.data;
        const message = data?.error ?? t('password.failed');
        if (/current password/i.test(message)) {
          form.setError("currentPassword", { message });
        } else {
          toast.error(message);
        }
      },
    },
  });

  const onSubmit = (data: FormValues) => {
    mutation.mutate({
      data: {
        currentPassword: data.currentPassword,
        newPassword: data.newPassword,
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle>{t('password.title')}</DialogTitle>
          <DialogDescription>
            {t('password.description')}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{t('password.current')}</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...form.register("currentPassword")}
            />
            {form.formState.errors.currentPassword && (
              <p className="text-sm text-red-500">
                {form.formState.errors.currentPassword.message}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword">{t('password.new')}</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...form.register("newPassword")}
            />
            {form.formState.errors.newPassword && (
              <p className="text-sm text-red-500">{form.formState.errors.newPassword.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">{t('password.confirm')}</Label>
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              {...form.register("confirmPassword")}
            />
            {form.formState.errors.confirmPassword && (
              <p className="text-sm text-red-500">
                {form.formState.errors.confirmPassword.message}
              </p>
            )}
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={mutation.isPending}
            >
              {t('password.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('password.submit')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
