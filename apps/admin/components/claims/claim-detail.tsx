'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Ban, CheckCircle2, Download, FileText, Send, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { updateClaimAction, updateClaimItemsAction } from '../../app/quarantine/claims-actions';
import type { ClaimItemRow, ClaimRow } from '../../app/quarantine/claims-queries';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge, ClaimOutcomeBadge, ClaimStatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { useConfirm } from '../ui/confirm';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { claimOutcomeLabel, defectKindLabel } from '../../lib/labels';
import { downloadCsv, downloadText, stamp, toCsv, toTextList, type CsvColumn } from '../../lib/csv';
import { fmtDateTime } from '../../lib/utils';

/**
 * RAPOR KOLONLARI — tedarikçiye giden dosya.
 *
 * KİŞİSEL VERİ YOK (KVKK): müşteri e-postası / sipariş no BU DOSYADA BULUNMAZ. Karantina
 * ekranındaki "Tedarikçi bildirimi" varyantının aynı kuralı — hem işe yaramaz hem düz lisans
 * anahtarıyla aynı satırda birleşmesi risktir. Fiş zaten SNAPSHOT'tan üretilir: kaynak kayıt
 * sonradan değişse de dosya aynı kalır.
 */
const CSV_COLUMNS: CsvColumn<ClaimItemRow>[] = [
  { header: 'Ürün', value: (r) => r.productName ?? '' },
  { header: 'SKU', value: (r) => r.sku ?? '' },
  { header: 'Lisans/Hesap değeri', value: (r) => r.keySnapshot ?? '' },
  { header: 'Parti', value: (r) => r.batchLabel ?? '' },
  { header: 'Kusur kaynağı', value: (r) => (r.defectKind ? defectKindLabel(r.defectKind) : '') },
  { header: 'Sebep', value: (r) => r.reason ?? '' },
  { header: 'Karantina tarihi', value: (r) => (r.quarantinedAt ? fmtDateTime(r.quarantinedAt) : '') },
  { header: 'Sonuç', value: (r) => claimOutcomeLabel(r.outcome) },
];

const textLine = (r: ClaimItemRow, i: number): string =>
  `${i + 1}. ${r.productName ?? '—'}${r.sku ? ` (${r.sku})` : ''} — ${r.keySnapshot ?? '—'}` +
  `${r.batchLabel ? ` — Parti: ${r.batchLabel}` : ''}` +
  `${r.defectKind ? ` — ${defectKindLabel(r.defectKind)}` : ''}` +
  `${r.reason ? ` — Sebep: ${r.reason}` : ''}`;

/** Fiş detayı: üst şerit + indirme + durum düğmeleri + kalem sonucu işaretleme. */
export function ClaimDetail({ claim, items }: { claim: ClaimRow; items: ClaimItemRow[] }) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const canMarkOutcome = claim.status === 'sent' || claim.status === 'closed';
  const selectableIds = React.useMemo(() => items.map((i) => i.id), [items]);
  const allSelected = selectableIds.length > 0 && selected.size === selectableIds.length;

  const download = (format: 'csv' | 'txt') => {
    const base = `degisim-fisi_${claim.code}_${stamp()}`;
    if (format === 'csv') {
      downloadCsv(`${base}.csv`, toCsv(items, CSV_COLUMNS));
    } else {
      // `toTextList` başlığı SATIR DİZİSİ alır (her satır ayrı) — tek string vermek tipi bozar.
      const header = [
        `Değişim Fişi ${claim.code}`,
        `Tedarikçi: ${claim.supplierName ?? '—'}`,
        `${items.length} anahtar · oluşturma ${fmtDateTime(claim.createdAt)}`,
        claim.note ? `Not: ${claim.note}` : '',
        '─'.repeat(52),
      ].filter(Boolean);
      downloadText(`${base}.txt`, toTextList(items, textLine, header));
    }
    toast.success('Rapor indirildi.');
  };

  const setStatus = async (status: 'sent' | 'closed' | 'canceled') => {
    const copy =
      status === 'sent'
        ? {
            title: 'Fiş gönderildi olarak işaretlensin mi?',
            description:
              'Dosyayı tedarikçiye ilettiyseniz bunu işaretleyin. Sonrasında fiş iptal edilemez, yalnız kapatılabilir; kalem sonuçlarını da bundan sonra girebilirsiniz.',
            confirmLabel: 'Gönderildi',
            tone: 'default' as const,
          }
        : status === 'closed'
          ? {
              title: 'Fiş kapatılsın mı?',
              description: 'Tedarikçiyle süreç bitti demektir. Kalem sonuçları düzenlenebilir kalır.',
              confirmLabel: 'Kapat',
              tone: 'default' as const,
            }
          : {
              title: 'Fiş iptal edilsin mi?',
              description:
                'Fiş yanlış kesildiyse kullanın: kalemleri silinir ve anahtarlar bildirilmeyi bekleyen havuza GERİ DÖNER.',
              confirmLabel: 'İptal et',
              tone: 'danger' as const,
            };

    const ok = await confirm({
      title: copy.title,
      description: copy.description,
      details: [`${claim.code} · ${claim.supplierName ?? '—'} · ${items.length} anahtar`],
      confirmLabel: copy.confirmLabel,
      tone: copy.tone,
    });
    if (!ok) return;

    setBusy(true);
    try {
      const res = await updateClaimAction({ id: claim.id, status });
      if (res.ok) {
        toast.success('Fiş güncellendi.');
        router.refresh();
      } else {
        toast.error(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  const markOutcome = async (outcome: 'replaced' | 'credited' | 'rejected' | 'pending') => {
    const ids = [...selected];
    if (ids.length === 0) return;

    const res = await confirm({
      title: `${ids.length} kalem "${claimOutcomeLabel(outcome)}" olarak işaretlensin mi?`,
      description:
        outcome === 'rejected'
          ? 'Tedarikçi bu anahtarları kabul etmedi. Bekleyen havuza GERİ DÖNERLER ve yeniden fişlenebilirler.'
          : outcome === 'pending'
            ? 'Sonuç işareti kaldırılır; kalemler yeniden cevap bekliyor sayılır.'
            : 'Bu anahtarlar için süreç kapanır; havuza geri dönmezler.',
      tone: outcome === 'rejected' ? 'danger' : 'default',
      confirmLabel: 'İşaretle',
      reason: {
        label: 'Not (isteğe bağlı)',
        placeholder: 'ör. tedarikçi 3 anahtarı seri no uyuşmazlığı gerekçesiyle reddetti',
        inputType: 'textarea',
      },
    });
    if (!res) return;

    setBusy(true);
    try {
      const out = await updateClaimItemsAction({
        claimId: claim.id,
        itemIds: ids,
        outcome,
        note: res.reason,
      });
      if (out.ok) {
        toast.success(`${out.affected} kalem güncellendi.`);
        setSelected(new Set());
        router.refresh();
      } else {
        toast.error(out.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* ── Aksiyon çubuğu ── */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => download('txt')}>
          <Download /> Metin (.txt)
        </Button>
        <Button variant="outline" size="sm" onClick={() => download('csv')}>
          <Download /> Excel (.csv)
        </Button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {claim.status === 'draft' && (
          <>
            <Button size="sm" onClick={() => void setStatus('sent')} disabled={busy}>
              <Send /> Gönderildi olarak işaretle
            </Button>
            <Button
              variant="danger-outline"
              size="sm"
              onClick={() => void setStatus('canceled')}
              disabled={busy}
            >
              <Ban /> Fişi iptal et
            </Button>
          </>
        )}
        {claim.status === 'sent' && (
          <Button size="sm" onClick={() => void setStatus('closed')} disabled={busy}>
            <CheckCircle2 /> Fişi kapat
          </Button>
        )}
      </div>

      {claim.status === 'draft' && (
        <Alert variant="info">
          <AlertDescription>
            Bu fiş <strong>taslak</strong>. Raporu indirip tedarikçiye ilettikten sonra
            &quot;Gönderildi olarak işaretle&quot; deyin — kalem sonuçlarını ancak o zaman
            girebilirsiniz. Yanlış kestiyseniz iptal edin, anahtarlar havuza geri döner.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Kalemler ── */}
      <Card>
        <CardHeader>
          <CardTitle icon={FileText}>Fişteki anahtarlar</CardTitle>
          <CardDescription>
            Bu satırlar fiş kesildiği andaki <strong>anlık görüntüdür</strong> — kaynak kayıt
            sonradan değişse bile rapor değişmez. Tedarikçinin yanıtını satırları işaretleyip
            girin; <strong>reddedilenler</strong> bildirilmeyi bekleyen havuza geri döner.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {canMarkOutcome && selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium text-foreground">
                {selected.size} kalem seçili
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void markOutcome('replaced')}
                disabled={busy}
              >
                <CheckCircle2 /> Yenisi geldi
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void markOutcome('credited')}
                disabled={busy}
              >
                Bedeli iade edildi
              </Button>
              <Button
                variant="danger-outline"
                size="sm"
                onClick={() => void markOutcome('rejected')}
                disabled={busy}
              >
                <Ban /> Reddedildi
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void markOutcome('pending')}
                disabled={busy}
              >
                <Undo2 /> Sonucu geri al
              </Button>
            </div>
          )}

          <div className="rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {canMarkOutcome && (
                    <TableHead className="w-9">
                      <Checkbox
                        aria-label="Tümünü seç"
                        checked={allSelected}
                        indeterminate={selected.size > 0 && !allSelected}
                        onChange={(e) =>
                          setSelected(e.target.checked ? new Set(selectableIds) : new Set())
                        }
                      />
                    </TableHead>
                  )}
                  <TableHead>Ürün</TableHead>
                  <TableHead>Lisans / hesap</TableHead>
                  <TableHead>Parti</TableHead>
                  <TableHead>Kusur</TableHead>
                  <TableHead>Sonuç</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={canMarkOutcome ? 6 : 5}>
                      <p className="py-6 text-center text-sm text-muted-foreground">
                        Bu fişte kalem yok (iptal edilmiş olabilir — kalemler havuza döndü).
                      </p>
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((i) => (
                    <TableRow key={i.id} data-state={selected.has(i.id) ? 'selected' : undefined}>
                      {canMarkOutcome && (
                        <TableCell className="w-9">
                          <Checkbox
                            aria-label="Kalemi seç"
                            checked={selected.has(i.id)}
                            onChange={(e) =>
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(i.id);
                                else next.delete(i.id);
                                return next;
                              })
                            }
                          />
                        </TableCell>
                      )}
                      <TableCell>
                        <div className="text-sm text-foreground">{i.productName ?? '—'}</div>
                        {i.sku && (
                          <div className="font-mono text-xs text-muted-foreground">{i.sku}</div>
                        )}
                      </TableCell>
                      <TableCell className="max-w-56">
                        <div className="truncate font-mono text-xs" title={i.keySnapshot ?? ''}>
                          {i.keySnapshot ?? '—'}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {i.batchLabel ?? '—'}
                      </TableCell>
                      <TableCell className="max-w-48">
                        {i.defectKind && <Badge variant="outline">{defectKindLabel(i.defectKind)}</Badge>}
                        {i.reason && (
                          <div className="truncate text-xs text-muted-foreground" title={i.reason}>
                            {i.reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <ClaimOutcomeBadge outcome={i.outcome} />
                        {i.outcomeNote && (
                          <div className="mt-0.5 max-w-48 truncate text-xs text-muted-foreground" title={i.outcomeNote}>
                            {i.outcomeNote}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {dialog}
    </div>
  );
}

/** Üst şerit — sunucu bileşeninde kullanılır (istemci durumu gerekmez). */
export function ClaimHeaderBadge({ status }: { status: string }) {
  return <ClaimStatusBadge status={status} />;
}
