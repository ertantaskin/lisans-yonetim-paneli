'use client';
import * as React from 'react';
import Link from 'next/link';
import { RotateCcw, Settings2, ShieldCheck, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { disableTotpForUserAction, resetTotpAction } from './totp-actions';

export interface TotpAdminRow {
  id: string;
  name: string;
  email: string;
  /**
   * OPSİYONEL: api ve admin ayrı imajlar — sürüm sapmasında alan gelmeyebilir. `undefined`
   * "bilinmiyor" demektir; uydurma "kapalı" göstermeyiz (yanlış güvence).
   */
  totpEnabled?: boolean;
}

/**
 * Owner görünümü: kim ikinci faktörü açmış, kim açmamış + KURTARMA.
 *
 * Sıfırlama, cihazını kaybeden kullanıcı içindir: TOTP silinir VE `token_version` artar →
 * hesabın açık tüm oturumları düşer (parola sıfırlama deseniyle aynı). Kapatma ise daha
 * hafif: yalnız ikinci faktörü söker, oturumlara dokunmaz.
 *
 * KENDİ SATIRI İSTİSNASI: buradaki aksiyonlar BAŞKASI için tasarlanmıştır (parola sorulmaz).
 * Kendi hesabında API parola + geçerli kod ister → bu liste onları göndermediği için istek
 * 401'ler ve giriş kilidiyle AYNI sayaç artar (ayrıntı `app/admins/page.tsx` `selfId`
 * yorumunda). Bu yüzden operatör kendi satırında düğme değil, doğru aracın (`/admins/security`)
 * bağlantısını görür — "tıklanıp hata veren düğme hiç sunulmayandan kötüdür" kuralı.
 */
export function TotpAdminList({
  admins,
  selfId = null,
}: {
  admins: TotpAdminRow[];
  /** Oturumdaki adminin kimliği; auth kapalıyken null (kimlik kavramı yok → istisna uygulanmaz). */
  selfId?: string | null;
}) {
  const { confirm, dialog } = useConfirm();

  const reset = async (row: TotpAdminRow) => {
    const res = await confirm({
      title: `${row.name} için iki faktörlü doğrulama sıfırlansın mı?`,
      description:
        'Cihazını kaybeden kullanıcı için kurtarma yoludur. Kullanıcı yeniden kurulum yapana kadar girişi TEK faktöre döner.',
      details: [
        'Kayıtlı kurulum anahtarı silinir.',
        'Kullanıcının açık TÜM oturumları anında kapanır.',
        'Kullanıcı yeniden giriş yapıp kurulumu baştan yapmalıdır.',
      ],
      tone: 'danger',
      confirmLabel: 'Sıfırla',
    });
    if (!res) return;
    const fd = new FormData();
    fd.set('id', row.id);
    const out = await resetTotpAction(fd);
    if (out?.error) toast.error(`${row.name}: ${out.error}`);
    else toast.success(`${row.name}: iki faktörlü doğrulama sıfırlandı, oturumları kapandı.`);
  };

  const disable = async (row: TotpAdminRow) => {
    const res = await confirm({
      title: `${row.name} için iki faktörlü doğrulama kapatılsın mı?`,
      description: 'Giriş yeniden tek faktöre (yalnız parola) döner.',
      tone: 'danger',
      confirmLabel: 'Kapat',
    });
    if (!res) return;
    const fd = new FormData();
    fd.set('id', row.id);
    const out = await disableTotpForUserAction(fd);
    if (out?.error) toast.error(`${row.name}: ${out.error}`);
    else toast.success(`${row.name}: iki faktörlü doğrulama kapatıldı.`);
  };

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Yönetici</TableHead>
            <TableHead>Durum</TableHead>
            <TableHead className="text-right">İşlem</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {admins.map((row) => {
            const isSelf = selfId !== null && row.id === selfId;
            return (
            <TableRow key={row.id}>
              <TableCell>
                <div className="font-medium">
                  {row.name}
                  {isSelf && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">(siz)</span>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">{row.email}</div>
              </TableCell>
              <TableCell>
                {row.totpEnabled === undefined ? (
                  <Badge variant="outline">Bilinmiyor</Badge>
                ) : row.totpEnabled ? (
                  <Badge variant="success">
                    <ShieldCheck /> Açık
                  </Badge>
                ) : (
                  <Badge variant="warning">Kapalı</Badge>
                )}
              </TableCell>
              <TableCell className="text-right">
                {isSelf ? (
                  // Kendi hesabı: kurma/kapatma tek yerden — parola + kod isteyen kendi ekranı.
                  <Button asChild variant="outline" size="sm">
                    <Link href="/admins/security">
                      <Settings2 /> Kendi hesabımı ayarla
                    </Link>
                  </Button>
                ) : row.totpEnabled ? (
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => disable(row)}>
                      <ShieldOff /> Kapat
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => reset(row)}>
                      <RotateCcw /> Sıfırla
                    </Button>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    Kurulum yalnız kullanıcının kendisi tarafından yapılır
                  </span>
                )}
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {dialog}
    </>
  );
}
