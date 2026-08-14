'use client';
import * as React from 'react';
import { Ban, CheckCircle2, KeyRound, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { AdminUser } from '@/lib/api';
import { adminRoleLabel } from '@/lib/labels';
import { formatDate } from '@/lib/utils';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { useConfirm } from './ui/confirm';
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
  const { confirm, dialog } = useConfirm();

  /**
   * Parola sıfırlama. Eskiden `window.prompt` idi: parola DÜZ METİN görünüyordu, kısa
   * parola bir `alert()` ile reddediliyordu ve kutunun dili tarayıcıya aitti. Artık panelin
   * kendi modali + MASKELİ alan; 8 karakter altındayken onay düğmesi kilitli kalır.
   *
   * SONUÇ ARTIK GÖRÜNÜR (denetim bulgusu): action `await` edilir ve sonucu toast'a yazılır.
   * Bu işlemin tabloda hiçbir yan etkisi yok — başarısızlık görünmezse operatör yeni parolayı
   * kullanıcıya iletir ve giriş denemesi başarısız olana kadar kimse fark etmez.
   */
  const resetPassword = async (id: string, name: string) => {
    const res = await confirm({
      title: `${name} için parola sıfırlansın mı?`,
      description:
        'Kullanıcının mevcut oturumları kapanır ve yeni parolayla giriş yapması gerekir. Parolayı ona güvenli bir kanalla iletin.',
      confirmLabel: 'Parolayı değiştir',
      reason: {
        label: 'Yeni parola',
        inputType: 'password',
        required: true,
        minLength: 8,
        placeholder: 'en az 8 karakter',
        hint: 'En az 8 karakter. Panel parolayı saklamaz, yalnız hash’ini tutar.',
      },
    });
    if (!res) return;
    const fd = new FormData();
    fd.set('id', id);
    fd.set('password', res.reason);
    const out = await resetAdminPasswordAction(fd);
    if (out?.error) toast.error(`${name}: ${out.error}`);
    else toast.success(`${name} için parola değiştirildi — açık oturumları kapandı.`);
  };

  /** Silme onayı — form submit'i modal cevabına bağlanır. */
  const confirmDelete = async (name: string) =>
    Boolean(
      await confirm({
        title: `${name} silinsin mi?`,
        description:
          'Yönetici hesabı kaldırılır ve açık oturumları geçersizleşir. Bu işlem geri alınamaz.',
        tone: 'danger',
        confirmLabel: 'Sil',
      }),
    );

  return (
    // Kart sözleşmesi (rounded-xl + bg-card + shadow-xs) tek kaynaktan: elle yazılmış
    // rounded-lg/gölgesiz yüzey panelde ikinci bir tablo görünümü üretiyordu.
    <Card className="overflow-hidden">
      {dialog}
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
                  <Badge variant={a.role === 'owner' ? 'accent' : 'outline'}>{adminRoleLabel(a.role)}</Badge>
                </TableCell>
                <TableCell>
                  {a.disabled ? (
                    <Badge variant="neutral">Pasif</Badge>
                  ) : (
                    <Badge variant="success">Aktif</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs tabular-nums text-muted-foreground">
                  {a.lastLoginAt ? formatDate(a.lastLoginAt) : '—'}
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    {/* Sonuç bekleniyor: "son aktif yönetici pasifleştirilemez" (400) eskiden
                        SESSİZCE yutuluyordu → rozet değişmiyor, sebebi de yazmıyordu. */}
                    <form
                      action={async (fd) => {
                        const out = await toggleAdminAction(fd);
                        if (out?.error) toast.error(`${a.name}: ${out.error}`);
                      }}
                    >
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
                      onClick={() => void resetPassword(a.id, a.name)}
                    >
                      <KeyRound />
                    </Button>
                    <form
                      // Modal cevabı beklenir: "hayır"da hiçbir istek gitmez. Silme başarısız
                      // olursa (son aktif yönetici koruması) satır yerinde kalır — sebebi
                      // söylenmezse operatör "tıklamam işlemedi mi?" diye tekrar dener.
                      action={async (fd) => {
                        if (!(await confirmDelete(a.name))) return;
                        const out = await deleteAdminAction(fd);
                        if (out?.error) toast.error(`${a.name}: ${out.error}`);
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
    </Card>
  );
}
