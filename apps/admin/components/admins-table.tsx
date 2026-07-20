'use client';
import * as React from 'react';
import { Ban, CheckCircle2, KeyRound, Trash2 } from 'lucide-react';
import type { AdminUser } from '@/lib/api';
import { formatDate } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from './ui/table';
import {
  deleteAdminAction,
  resetAdminPasswordAction,
  toggleAdminAction,
} from '@/app/admins/actions';

export function AdminsTable({ admins }: { admins: AdminUser[] }) {
  // Parola sıfırlama: küçük prompt (nadir admin işlemi) → server action.
  const resetPassword = (id: string, name: string) => {
    const pw = window.prompt(`${name} için yeni parola (en az 8 karakter):`);
    if (pw == null) return;
    if (pw.length < 8) {
      window.alert('Parola en az 8 karakter olmalı.');
      return;
    }
    const fd = new FormData();
    fd.set('id', id);
    fd.set('password', pw);
    void resetAdminPasswordAction(fd);
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/40 hover:bg-muted/40">
            <TableHead>Ad</TableHead>
            <TableHead>E-posta</TableHead>
            <TableHead>Kullanıcı adı</TableHead>
            <TableHead>Rol</TableHead>
            <TableHead>Durum</TableHead>
            <TableHead>Son giriş</TableHead>
            <TableHead className="text-right">Aksiyonlar</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {admins.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={7} className="h-20 text-center text-muted-foreground">
                Henüz admin yok. Yukarıdan ekleyin.
              </TableCell>
            </TableRow>
          ) : (
            admins.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium text-foreground">{a.name}</TableCell>
                <TableCell className="text-muted-foreground">{a.email}</TableCell>
                <TableCell className="text-muted-foreground">{a.username ?? '—'}</TableCell>
                <TableCell>
                  <Badge variant={a.role === 'owner' ? 'accent' : 'outline'}>{a.role}</Badge>
                </TableCell>
                <TableCell>
                  {a.disabled ? (
                    <Badge variant="danger">pasif</Badge>
                  ) : (
                    <Badge variant="success">aktif</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {a.lastLoginAt ? formatDate(a.lastLoginAt) : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <form action={toggleAdminAction}>
                      <input type="hidden" name="id" value={a.id} />
                      <input type="hidden" name="disabled" value={String(!a.disabled)} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon-sm"
                        title={a.disabled ? 'Aktifleştir' : 'Pasifleştir'}
                        aria-label={a.disabled ? 'Aktifleştir' : 'Pasifleştir'}
                      >
                        {a.disabled ? <CheckCircle2 className="text-success" /> : <Ban />}
                      </Button>
                    </form>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title="Parola sıfırla"
                      aria-label="Parola sıfırla"
                      onClick={() => resetPassword(a.id, a.name)}
                    >
                      <KeyRound />
                    </Button>
                    <form
                      action={deleteAdminAction}
                      onSubmit={(e) => {
                        if (!window.confirm(`${a.name} silinsin mi?`)) e.preventDefault();
                      }}
                    >
                      <input type="hidden" name="id" value={a.id} />
                      <Button
                        type="submit"
                        variant="ghost"
                        size="icon-sm"
                        title="Sil"
                        aria-label="Sil"
                        className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 />
                      </Button>
                    </form>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
