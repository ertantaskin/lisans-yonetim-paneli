import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, Boxes, CalendarRange, FileText, Truck, User } from 'lucide-react';
import { ClaimStatusBadge } from '../../../../components/ui/badge';
import { StatStrip } from '../../../../components/ui/stat-tile';
import { ClaimDetail } from '../../../../components/claims/claim-detail';
import { fetchClaim } from '../../claims-queries';
import { claimStatusHint } from '../../../../lib/labels';
import { fmtDateTime } from '../../../../lib/utils';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const fmtDay = (ts: string | null): string => {
  if (!ts) return '—';
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'medium' });
};

/**
 * DEĞİŞİM FİŞİ DETAYI (§12) — "bu partiden şu anahtarlar bozuk, tedarikçiye bildirdim".
 *
 * Fişin İÇERİĞİ kesildiği andaki anlık görüntüdür (snapshot): ürün adı değişse, parti silinse
 * ya da sebep metni güncellense bile tedarikçiye gönderdiğiniz dosyayla panelde gördüğünüz
 * liste BİREBİR aynı kalır.
 */
export default async function ClaimDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) notFound();

  const data = await fetchClaim(id);
  if (!data) notFound();
  const { claim, items } = data;

  const resolved = claim.replacedCount + claim.creditedCount + claim.rejectedCount;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <Link
          href="/quarantine"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          <ArrowLeft className="size-4" aria-hidden /> Kusurlu Stok
        </Link>

        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground">
            <FileText className="size-5" aria-hidden />
          </span>
          <div className="min-w-0">
            <h1 className="font-mono text-2xl font-semibold tracking-tight text-foreground">
              {claim.code}
            </h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <ClaimStatusBadge status={claim.status} />
              <span className="inline-flex items-center gap-1.5">
                <Truck className="size-3.5" aria-hidden />
                {claim.supplierId ? (
                  <Link
                    href={`/suppliers/${claim.supplierId}`}
                    className="text-foreground underline-offset-4 hover:underline"
                  >
                    {claim.supplierName ?? 'Tedarikçi'}
                  </Link>
                ) : (
                  (claim.supplierName ?? 'Tedarikçi silinmiş')
                )}
              </span>
              {(claim.periodFrom || claim.periodTo) && (
                <span className="inline-flex items-center gap-1.5">
                  <CalendarRange className="size-3.5" aria-hidden />
                  {fmtDay(claim.periodFrom)} – {fmtDay(claim.periodTo)}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <User className="size-3.5" aria-hidden />
                {claim.createdBy}
              </span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <Boxes className="size-4 text-muted-foreground" aria-hidden /> Fiş özeti
        </h2>
        <StatStrip
          items={[
            { label: 'Kalem', value: claim.itemCount, hint: 'fişe alınan' },
            {
              label: 'Tedarikçi yanıtı bekleyen',
              value: claim.pendingCount,
              tone: claim.pendingCount > 0 ? 'warning' : 'default',
            },
            {
              label: 'Çözüldü',
              value: claim.replacedCount + claim.creditedCount,
              tone: resolved > 0 ? 'success' : 'default',
              hint: 'yenisi geldi / bedeli iade',
            },
            {
              label: 'Kabul edilmedi',
              value: claim.rejectedCount,
              tone: claim.rejectedCount > 0 ? 'danger' : 'default',
              hint: 'havuza geri döndü',
            },
            {
              label: 'Oluşturma',
              value: fmtDay(claim.createdAt),
              hint: claim.sentAt ? `gönderildi ${fmtDateTime(claim.sentAt)}` : 'henüz gönderilmedi',
            },
          ]}
        />
        {/* Durumun ANLAMI başlıkta rozetle birlikte durur; burada bir cümleyle açılır. */}
        <p className="text-xs text-muted-foreground">{claimStatusHint(claim.status)}</p>
        {claim.note && (
          <p className="text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">Not:</strong> {claim.note}
          </p>
        )}
        {claim.reference && (
          <p className="text-xs text-muted-foreground">
            <strong className="font-medium text-foreground">Tedarikçi referansı:</strong>{' '}
            {claim.reference}
          </p>
        )}
      </div>

      <ClaimDetail claim={claim} items={items} />
    </div>
  );
}
