'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { UserPlus } from 'lucide-react';
import { createAdminAction, type CreateAdminState } from '@/app/admins/actions';
import { Input, Label, selectClass } from './ui/input';
import { Button } from './ui/button';

const initial: CreateAdminState = {};

export function CreateAdminForm() {
  const [state, action, pending] = useActionState(createAdminAction, initial);
  const formRef = React.useRef<HTMLFormElement>(null);

  React.useEffect(() => {
    if (state.ok) formRef.current?.reset();
  }, [state]);

  return (
    <form ref={formRef} action={action} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label htmlFor="a-name">Ad</Label>
        <Input id="a-name" name="name" required placeholder="Ad Soyad" autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="a-email">E-posta</Label>
        <Input
          id="a-email"
          name="email"
          type="email"
          required
          placeholder="admin@ornek.com"
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="a-username">Kullanıcı adı (opsiyonel)</Label>
        <Input id="a-username" name="username" placeholder="admin2" autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="a-role">Rol</Label>
        <select id="a-role" name="role" className={`w-full ${selectClass}`}>
          <option value="admin">admin</option>
          <option value="owner">owner</option>
        </select>
      </div>
      <div className="space-y-1.5 sm:col-span-2">
        <Label htmlFor="a-pw">Parola (en az 8 karakter)</Label>
        <Input
          id="a-pw"
          name="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="••••••••"
        />
      </div>
      <div className="flex items-center gap-3 sm:col-span-2">
        <Button type="submit" disabled={pending}>
          <UserPlus /> {pending ? 'Ekleniyor…' : 'Admin Ekle'}
        </Button>
        <p role="alert" aria-live="polite" className="text-sm">
          {state.error && <span className="text-destructive">{state.error}</span>}
          {state.ok && <span className="text-success">Admin eklendi.</span>}
        </p>
      </div>
    </form>
  );
}
