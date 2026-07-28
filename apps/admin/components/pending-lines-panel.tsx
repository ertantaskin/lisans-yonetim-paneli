'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Link2, PlayCircle, TriangleAlert } from 'lucide-react';
import { resolvePendingLinesAction, type ResolvePendingSummary } from '../app/stock/actions';
import type { PendingLinesSummary } from '../lib/api';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/**
 * Bekleyen (eşlemesiz) satırlar paneli (§3).
 *
 * Kullanıcının bildirdiği sorun: mağaza ürününü SONRADAN eşlediğinde, o ürün için daha önce gelmiş
 * siparişler "eşlenmemiş" olarak bekliyordu ve "Kalanları Ata" hiçbir şey yapmıyordu — çünkü
 * teslimat motoru satırları `product_id` üzerinden tarar, eşlemesiz satırda o alan NULL'dır.
 *
 * Bu panel iki soruyu tek ekranda yanıtlar:
 *   1. Hangi mağaza ürünleri yüzünden kaç sipariş satırı bekliyor?
 *   2. Hangileri ARTIK eşlendi (mappedNow) → tek tıkla geriye dönük çözülebilir?
 *
 * "Eşlemeyi Uygula" YENİ EŞLEME OLUŞTURMAZ — yalnız operatörün elle kurduğu mevcut eşlemeyi eski
 * satırlara uygular (otomatik eşleştirme yoktur; güvenlik kuralı).
 */
export function PendingLinesPanel({ summary }: { summary: PendingLinesSummary | null }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<ResolvePendingSummary | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  if (!summary || summary.groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Eşleme beklediği için takılmış sipariş satırı yok. (Bir mağaza ürünü panelde eşli değilse,
        o ürünün siparişleri yanlış lisans teslim edilmesin diye burada bekletilir.)
      </p>
    );
  }

  const run = async (
    key: string,
    input: Parameters<typeof resolvePendingLinesAction>[0],
  ) => {
    setBusy(key);
    setError(null);
    setResult(null);
    const r = await resolvePendingLinesAction(input);
    setBusy(null);
    if (r.ok && r.result) {
      setResult(r.result);
      router.refresh();
    } else {
      setError(r.error ?? 'Bekleyen satırlar çözülemedi');
    }
  };

  const t = summary.totals;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>
          <strong className="text-foreground tabular-nums">{t.lineCount}</strong> satır ·{' '}
          <strong className="text-foreground tabular-nums">{t.orderCount}</strong> sipariş bekliyor
        </span>
        {t.resolvableLines > 0 && (
          <span className="text-success">
            <strong className="tabular-nums">{t.resolvableLines}</strong> satır artık eşlenmiş —
            uygulanmayı bekliyor
          </span>
        )}
      </div>

      {t.resolvableLines > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-success/40 bg-success/5 px-3 py-2">
          <CheckCircle2 className="size-4 shrink-0 text-success" aria-hidden />
          <span className="flex-1 text-sm">
            Eşlemesi tamamlanmış {t.resolvableGroups} mağaza ürünü için bekleyen satırlar tek tıkla
            teslimata alınabilir.
          </span>
          <Button size="sm" disabled={busy !== null} onClick={() => run('__all__', {})}>
            <PlayCircle /> {busy === '__all__' ? 'Uygulanıyor…' : 'Tümünü Uygula'}
          </Button>
        </div>
      )}

      {result && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
          {result.linked} satır bağlandı · {result.delivered} teslim edildi ·{' '}
          {result.stillPending} satır stok bekliyor
          {result.noMapping > 0 ? ` · ${result.noMapping} satır hâlâ eşlemesiz` : ''}
          {result.truncated ? ' · (sınıra takıldı, tekrar çalıştırın)' : ''}
        </p>
      )}
      {error && (
        <p className="flex items-center gap-1.5 text-sm text-destructive">
          <TriangleAlert className="size-4" aria-hidden /> {error}
        </p>
      )}

      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Mağaza ürünü</TableHead>
              <TableHead>Site</TableHead>
              <TableHead className="text-right">Satır</TableHead>
              <TableHead className="text-right">Adet</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead className="text-right">Aksiyon</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {summary.groups.map((g) => {
              const key = `${g.siteId}:${g.remoteProductId ?? ''}:${g.remoteVariationId ?? ''}`;
              return (
                <TableRow key={key}>
                  <TableCell>
                    <div className="font-medium text-foreground">
                      {g.remoteName ?? (g.remoteProductId ? `#${g.remoteProductId}` : 'Bilinmiyor')}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {g.remoteProductId ? `#${g.remoteProductId}` : 'mağaza kimliği yok'}
                      {g.remoteVariationId ? ` · varyasyon ${g.remoteVariationId}` : ''}
                    </div>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{g.siteDomain}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.lineCount}</TableCell>
                  <TableCell className="text-right tabular-nums">{g.totalQty}</TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <Badge variant={g.mappedNow ? 'success' : 'warning'}>
                        {g.mappedNow ? 'eşlendi — uygulanmadı' : 'eşleme bekliyor'}
                      </Badge>
                      {g.heldCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {g.heldCount} satır incelemede
                        </span>
                      )}
                      <span className="text-xs text-muted-foreground">{g.hint}</span>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {g.mappedNow ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() =>
                          run(key, {
                            siteId: g.siteId,
                            ...(g.remoteProductId ? { remoteProductId: g.remoteProductId } : {}),
                            remoteVariationId: g.remoteVariationId,
                          })
                        }
                      >
                        <PlayCircle /> {busy === key ? 'Uygulanıyor…' : 'Eşlemeyi Uygula'}
                      </Button>
                    ) : g.remoteProductId ? (
                      <Button size="sm" variant="ghost" asChild>
                        <Link href={`/mappings?site=${encodeURIComponent(g.siteId)}`}>
                          <Link2 /> Eşle
                        </Link>
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
