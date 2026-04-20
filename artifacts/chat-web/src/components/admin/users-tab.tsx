import { useMemo, useState } from "react";
import { useListUsers, useDeleteUser, useCreateUser, useUpdateUser, getListUsersQueryKey, CreateUserBodyRole } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, UserPlus, Loader2, Pencil } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";

type CreateUserFormValues = {
  name: string;
  email: string;
  password: string;
  role: CreateUserBodyRole;
};

type EditUserFormValues = {
  name: string;
  email: string;
};

interface EditableUser {
  id: string;
  name: string;
  email: string;
}

export function UsersTab() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { data: users, isLoading } = useListUsers();

  const createUserSchema = useMemo(() => z.object({
    name: z.string().min(1, t('users.name') + " is required"),
    email: z.string().email(t('users.email') + " is invalid"),
    password: z.string().min(6, t('users.password') + " must be at least 6 characters"),
    role: z.enum([CreateUserBodyRole.admin, CreateUserBodyRole.user]),
  }), [t]);

  const editUserSchema = useMemo(() => z.object({
    name: z.string().min(1, t('users.name') + " is required"),
    email: z.string().email(t('users.email') + " is invalid"),
  }), [t]);

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<EditableUser | null>(null);

  const deleteMutation = useDeleteUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success(t('users.deleted'));
      },
      onError: () => {
        toast.error(t('users.deleteFailed'));
      }
    }
  });

  const createMutation = useCreateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success(t('users.created'));
        setIsCreateModalOpen(false);
        createForm.reset();
      },
      onError: () => {
        toast.error(t('users.createFailed'));
      }
    }
  });

  const updateMutation = useUpdateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success(t('users.updated'));
        setEditingUser(null);
      },
      onError: (err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 409) {
          editForm.setError("email", { message: t('users.emailInUse') });
        } else {
          toast.error(t('users.updateFailed'));
        }
      }
    }
  });

  const createForm = useForm<CreateUserFormValues>({
    resolver: zodResolver(createUserSchema),
    defaultValues: {
      name: "",
      email: "",
      password: "",
      role: CreateUserBodyRole.user,
    },
  });

  const editForm = useForm<EditUserFormValues>({
    resolver: zodResolver(editUserSchema),
    defaultValues: { name: "", email: "" },
  });

  const onCreateSubmit = (data: CreateUserFormValues) => {
    createMutation.mutate({ data });
  };

  const openEditDialog = (user: EditableUser) => {
    setEditingUser(user);
    editForm.reset({ name: user.name, email: user.email });
  };

  const onEditSubmit = (data: EditUserFormValues) => {
    if (!editingUser) return;
    updateMutation.mutate({ id: editingUser.id, data });
  };

  const handleDelete = (id: string) => {
    if (id === currentUser?.id) {
      toast.error(t('users.cannotDeleteSelf'));
      return;
    }
    if (confirm("Are you sure you want to delete this user?")) {
      deleteMutation.mutate({ id });
    }
  };

  if (isLoading) {
    return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center bg-card p-4 rounded-xl border border-border shadow-sm">
        <div>
          <h2 className="text-lg font-medium text-foreground">{t('users.heading')}</h2>
          <p className="text-sm text-muted-foreground">{t('users.description')}</p>
        </div>

        <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-primary/90 text-primary-foreground">
              <UserPlus className="h-4 w-4 mr-2" />
              {t('users.addUser')}
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>{t('users.createTitle')}</DialogTitle>
            </DialogHeader>
            <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">{t('users.name')}</Label>
                <Input id="create-name" {...createForm.register("name")} placeholder={t('users.namePlaceholder')} />
                {createForm.formState.errors.name && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.name.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-email">{t('users.email')}</Label>
                <Input id="create-email" type="email" {...createForm.register("email")} placeholder={t('users.emailPlaceholder')} />
                {createForm.formState.errors.email && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.email.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-password">{t('users.password')}</Label>
                <Input id="create-password" type="password" {...createForm.register("password")} />
                {createForm.formState.errors.password && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.password.message}</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="create-role">{t('users.role')}</Label>
                <Select
                  onValueChange={(value) => createForm.setValue("role", value as CreateUserBodyRole)}
                  defaultValue={createForm.getValues("role")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={t('users.rolePlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CreateUserBodyRole.user}>{t('users.roleUser')}</SelectItem>
                    <SelectItem value={CreateUserBodyRole.admin}>{t('users.roleAdmin')}</SelectItem>
                  </SelectContent>
                </Select>
                {createForm.formState.errors.role && (
                  <p className="text-sm text-destructive">{createForm.formState.errors.role.message}</p>
                )}
              </div>

              <div className="pt-4 flex justify-end">
                <Button type="submit" disabled={createMutation.isPending} className="w-full sm:w-auto">
                  {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {t('users.createButton')}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Dialog open={!!editingUser} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>{t('users.editTitle')}</DialogTitle>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">{t('users.name')}</Label>
              <Input id="edit-name" {...editForm.register("name")} placeholder={t('users.namePlaceholder')} />
              {editForm.formState.errors.name && (
                <p className="text-sm text-destructive">{editForm.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-email">{t('users.email')}</Label>
              <Input id="edit-email" type="email" {...editForm.register("email")} placeholder={t('users.emailPlaceholder')} />
              {editForm.formState.errors.email && (
                <p className="text-sm text-destructive">{editForm.formState.errors.email.message}</p>
              )}
            </div>

            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                {t('users.cancel')}
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('users.saveChanges')}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="bg-card rounded-xl border border-border shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-muted text-muted-foreground font-medium border-b border-border">
            <tr>
              <th className="px-6 py-3">{t('users.colName')}</th>
              <th className="px-6 py-3">{t('users.colEmail')}</th>
              <th className="px-6 py-3">{t('users.colRole')}</th>
              <th className="px-6 py-3">{t('users.colCreated')}</th>
              <th className="px-6 py-3 text-right">{t('users.colActions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users?.map((user) => (
              <tr key={user.id} className="hover:bg-muted/40 transition-colors">
                <td className="px-6 py-4 font-medium text-foreground">{user.name}</td>
                <td className="px-6 py-4 text-muted-foreground">{user.email}</td>
                <td className="px-6 py-4">
                  {user.role === "admin" ? (
                    <Badge variant="secondary" className="bg-primary/20 text-primary hover:bg-primary/20">{t('users.roleAdmin')}</Badge>
                  ) : (
                    <Badge variant="outline" className="text-muted-foreground">{t('users.roleUser')}</Badge>
                  )}
                </td>
                <td className="px-6 py-4 text-muted-foreground">
                  {format(new Date(user.createdAt), "MMM d, yyyy")}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-primary hover:bg-primary/10"
                      title="Edit user"
                      onClick={() => openEditDialog({ id: user.id, name: user.name, email: user.email })}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                      title="Delete user"
                      onClick={() => handleDelete(user.id)}
                      disabled={user.id === currentUser?.id || deleteMutation.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {(!users || users.length === 0) && (
              <tr>
                <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                  {t('users.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
