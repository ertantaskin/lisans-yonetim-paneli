'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Link2, PlayCircle, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription } from './ui/alert';
import { resolvePendingLinesAction, type ResolvePendingSummary } from '../app/stock/actions';
import type { PendingLinesSummary } from '../lib/api';
import { cn } from '../lib/utils';
import { useAnnouncer } from './a11y/announcer';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/**
 * API satır satır `details[]` döndürür (pending-lines.service → ResolveDetail: her satırın NEDEN
 * çözülemediğini Türkçe anlatır) ama paylaşılan `ResolvePendingSummary` tipi (app/stock/actions)
 * bu alanı henüz taşımıyor → savunmacı oku: yoksa null, ekran yine çalışır.
 */
function firstDetailMessage(r: ResolvePendingSummary): string | null {
  const details = (r as ResolvePendingSummary & { details?: Array<{ message?: unknown }> }).details;
  if (!Array.isArray(details) || details.length === 0) return null;
  const message = details[0]?.message;
  return typeof message === 'string' && message.trim() ? message : null;
}

/**
 * Sonucun TONU + tek cümlelik dürüst özeti.
 *
 * NEDEN: eskiden sonuç her durumda NÖTR bir kutuda "0 satır bağlandı · 0 teslim edildi" diye
 * gösteriliyordu — operatör "çalıştı" sanıyordu. Sipariş detayındaki dürüst davranışla hizalandı:
 * hiçbir satır bağlanmadıysa bu bir BAŞARI değildir, sebebiyle birlikte UYARI olarak gösterilir.
 */
function describeResult(r: ResolvePendingSummary): { ok: boolean; headline: string } {
  if (r.scanned === 0) {
    return {
      ok: false,
      headline:
        'Taranacak bekleyen satır bulunamadı — liste bu arada değişmiş olabilir (satır başka bir işlemle çözülmüş, teslim edilmiş ya da iptal edilmiş olabilir).',
    };
  }
  if (r.linked === 0) {
    if (r.noMapping > 0) {
      return {
        ok: false,
        headline: `${r.noMapping} satır hâlâ eşlemesiz — bu mağaza ürünü için aktif eşleme yok. Önce Ürün Eşleştirme ekranından panel ürününü seçin (otomatik eşleştirme yapılmaz).`,
      };
    }
    return {
      ok: false,
      headline:
        firstDetailMessage(r) ??
        'Hiçbir satır ürüne bağlanamadı — satırlar bu arada çözülmüş, teslim edilmiş ya da iptal edilmiş olabilir.',
    };
  }
  return {
    ok: true,
    headline: `${r.linked} satır ürüne bağlandı · ${r.delivered} teslim edildi · ${r.stillPending} satır stok bekliyor.`,
  };
}

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
  const announce = useAnnouncer();
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
      // Sonuç ekran okuyucuya da duyurulur: başarısız/etkisiz tur "sessiz" geçmesin.
      const { ok, headline } = describeResult(r.result);
      announce(headline, { assertive: !ok });
      router.refresh();
    } else {
      const message = r.error ?? 'Bekleyen satırlar çözülemedi';
      setError(message);
      announce(message, { assertive: true });
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

      {/* Dürüstlük bandı: sunucu grup listesini üst sınırda kırptıysa tablo "hepsi bu kadar"
          DEMEMELİ — görünmeyen bekleyen satırlar için operatör aksiyon almaz. (Aynı desen
          /quarantine ve /support ekranlarında var.) */}
      {summary.truncated === true && (
        // Alert primitifi (eskiden elle kurulmuş kutu): tint matematiği, yarıçap ve gövde
        // rengi tek kaynaktan gelsin — elle yazılan kopyada gövde `text-warning` ile AA'nın
        // altına düşebiliyordu ve `rounded-md` yeni yüzey dilinden sapıyordu.
        <Alert variant="warning" className="gap-2 p-3">
          <TriangleAlert aria-hidden />
          <AlertDescription>
            Liste sunucu üst sınırına takıldı — <strong>bu tablo tamamı değildir</strong>. Daha
            fazla bekleyen satır olabilir; “Tümünü Uygula”dan sonra sayfayı yenileyip tekrar bakın.
          </AlertDescription>
        </Alert>
      )}

      {t.resolvableLines > 0 && (
        // Alert primitifi — yukarıdaki uyarı bandıyla aynı yüzey dili (tint/yarıçap/gövde rengi).
        // `items-center` + `flex-wrap` korunuyor çünkü bu bandın sağında bir eylem düğmesi var.
        <Alert variant="success" className="flex-wrap items-center gap-2 p-3">
          <CheckCircle2 aria-hidden />
          <AlertDescription className="flex-1">
            Eşlemesi tamamlanmış {t.resolvableGroups} mağaza ürünü için bekleyen satırlar tek tıkla
            teslimata alınabilir.
          </AlertDescription>
          <Button size="sm" disabled={busy !== null} onClick={() => run('__all__', {})}>
            <PlayCircle /> {busy === '__all__' ? 'Uygulanıyor…' : 'Tümünü Uygula'}
          </Button>
        </Alert>
      )}

      {/* Sonuç + hata TEK canlı bölgede: inline metin tek başına ekran okuyucuya duyurulmaz. */}
      <div role="status" aria-live="polite" className="empty:hidden">
        {result &&
          (() => {
            const { ok, headline } = describeResult(result);
            const Icon = ok ? CheckCircle2 : TriangleAlert;
            return (
              <div
                className={cn(
                  'flex gap-2 rounded-md border px-3 py-2 text-sm',
                  ok
                    ? 'border-success/40 bg-success/5'
                    : 'border-warning/40 bg-warning/10 text-foreground',
                )}
              >
                <Icon
                  className={cn('mt-0.5 size-4 shrink-0', ok ? 'text-success' : 'text-warning')}
                  aria-hidden
                />
                <div className="min-w-0">
                  <p>{headline}</p>
                  {/* Ham sayaçlar ikinci satırda: başlık "ne oldu"yu, bu satır kırılımı verir. */}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {result.scanned} satır tarandı · {result.linked} bağlandı ·{' '}
                    {result.delivered} teslim edildi · {result.stillPending} stok bekliyor
                    {result.noMapping > 0 ? ` · ${result.noMapping} eşlemesiz` : ''}
                    {result.skipped > 0 ? ` · ${result.skipped} atlandı` : ''}
                    {result.truncated ? ' · tarama sınırına takıldı, tekrar çalıştırın' : ''}
                  </p>
                </div>
              </div>
            );
          })()}
        {error && (
          <p className="flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert className="size-4" aria-hidden /> {error}
          </p>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-xs">
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
                  <TableCell className="text-muted-foreground">{g.siteDomain}</TableCell>
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
