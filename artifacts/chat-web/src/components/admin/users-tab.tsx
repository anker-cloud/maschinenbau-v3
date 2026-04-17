import { useState } from "react";
import { useListUsers, useDeleteUser, useCreateUser, useUpdateUser, getListUsersQueryKey, CreateUserBodyRole } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
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

const createUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum([CreateUserBodyRole.admin, CreateUserBodyRole.user]),
});

const editUserSchema = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
});

type CreateUserFormValues = z.infer<typeof createUserSchema>;
type EditUserFormValues = z.infer<typeof editUserSchema>;

interface EditableUser {
  id: string;
  name: string;
  email: string;
}

export function UsersTab() {
  const { user: currentUser } = useAuth();
  const queryClient = useQueryClient();
  const { data: users, isLoading } = useListUsers();
  
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<EditableUser | null>(null);

  const deleteMutation = useDeleteUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success("User deleted successfully");
      },
      onError: () => {
        toast.error("Failed to delete user");
      }
    }
  });

  const createMutation = useCreateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success("User created successfully");
        setIsCreateModalOpen(false);
        createForm.reset();
      },
      onError: () => {
        toast.error("Failed to create user");
      }
    }
  });

  const updateMutation = useUpdateUser({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        toast.success("User updated successfully");
        setEditingUser(null);
      },
      onError: (err: unknown) => {
        const status = (err as { response?: { status?: number } })?.response?.status;
        if (status === 409) {
          editForm.setError("email", { message: "This email is already in use" });
        } else {
          toast.error("Failed to update user");
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
      toast.error("You cannot delete your own account");
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
      <div className="flex justify-between items-center bg-white p-4 rounded-lg border border-gray-200 shadow-sm">
        <div>
          <h2 className="text-lg font-medium text-gray-900">User Management</h2>
          <p className="text-sm text-gray-500">Manage access to the technical support portal.</p>
        </div>
        
        <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
          <DialogTrigger asChild>
            <Button className="bg-primary hover:bg-blue-600">
              <UserPlus className="h-4 w-4 mr-2" />
              Add User
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-[425px]">
            <DialogHeader>
              <DialogTitle>Create New User</DialogTitle>
            </DialogHeader>
            <form onSubmit={createForm.handleSubmit(onCreateSubmit)} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="create-name">Full Name</Label>
                <Input id="create-name" {...createForm.register("name")} placeholder="John Doe" />
                {createForm.formState.errors.name && (
                  <p className="text-sm text-red-500">{createForm.formState.errors.name.message}</p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="create-email">Email</Label>
                <Input id="create-email" type="email" {...createForm.register("email")} placeholder="john@stuertz.com" />
                {createForm.formState.errors.email && (
                  <p className="text-sm text-red-500">{createForm.formState.errors.email.message}</p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="create-password">Password</Label>
                <Input id="create-password" type="password" {...createForm.register("password")} />
                {createForm.formState.errors.password && (
                  <p className="text-sm text-red-500">{createForm.formState.errors.password.message}</p>
                )}
              </div>
              
              <div className="space-y-2">
                <Label htmlFor="create-role">Role</Label>
                <Select 
                  onValueChange={(value) => createForm.setValue("role", value as CreateUserBodyRole)}
                  defaultValue={createForm.getValues("role")}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={CreateUserBodyRole.user}>User</SelectItem>
                    <SelectItem value={CreateUserBodyRole.admin}>Admin</SelectItem>
                  </SelectContent>
                </Select>
                {createForm.formState.errors.role && (
                  <p className="text-sm text-red-500">{createForm.formState.errors.role.message}</p>
                )}
              </div>
              
              <div className="pt-4 flex justify-end">
                <Button type="submit" disabled={createMutation.isPending} className="w-full sm:w-auto">
                  {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Create User
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => { if (!open) setEditingUser(null); }}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <form onSubmit={editForm.handleSubmit(onEditSubmit)} className="space-y-4 mt-4">
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full Name</Label>
              <Input id="edit-name" {...editForm.register("name")} placeholder="John Doe" />
              {editForm.formState.errors.name && (
                <p className="text-sm text-red-500">{editForm.formState.errors.name.message}</p>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-email">Email</Label>
              <Input id="edit-email" type="email" {...editForm.register("email")} placeholder="john@stuertz.com" />
              {editForm.formState.errors.email && (
                <p className="text-sm text-red-500">{editForm.formState.errors.email.message}</p>
              )}
            </div>

            <div className="pt-4 flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setEditingUser(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={updateMutation.isPending}>
                {updateMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Changes
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <div className="bg-white rounded-lg border border-gray-200 shadow-sm overflow-hidden">
        <table className="w-full text-sm text-left">
          <thead className="bg-gray-50 text-gray-700 font-medium border-b border-gray-200">
            <tr>
              <th className="px-6 py-3">Name</th>
              <th className="px-6 py-3">Email</th>
              <th className="px-6 py-3">Role</th>
              <th className="px-6 py-3">Created</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users?.map((user) => (
              <tr key={user.id} className="hover:bg-gray-50/50 transition-colors">
                <td className="px-6 py-4 font-medium text-gray-900">{user.name}</td>
                <td className="px-6 py-4 text-gray-500">{user.email}</td>
                <td className="px-6 py-4">
                  {user.role === "admin" ? (
                    <Badge variant="secondary" className="bg-blue-100 text-blue-700 hover:bg-blue-100">Admin</Badge>
                  ) : (
                    <Badge variant="outline" className="text-gray-600">User</Badge>
                  )}
                </td>
                <td className="px-6 py-4 text-gray-500">
                  {format(new Date(user.createdAt), "MMM d, yyyy")}
                </td>
                <td className="px-6 py-4 text-right">
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-gray-400 hover:text-primary hover:bg-blue-50"
                      title="Edit user"
                      onClick={() => openEditDialog({ id: user.id, name: user.name, email: user.email })}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button 
                      variant="ghost" 
                      size="sm" 
                      className="text-gray-400 hover:text-red-600 hover:bg-red-50"
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
                <td colSpan={5} className="px-6 py-8 text-center text-gray-500">
                  No users found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
