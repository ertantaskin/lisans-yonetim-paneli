'use client';
import * as React from 'react';
import { Check, Copy, KeyRound, TriangleAlert } from 'lucide-react';
import { issueCodeForSite } from '../new/actions';
import { Button } from '../../../components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';
import { useConfirm } from '../../../components/ui/confirm';
import { useAnnouncer } from '../../../components/a11y/announcer';

/**
 * "Yeni Bağlan Kodu Üret" (§14) — site detayında KALICI kurtarma/yeniden bağlama yolu.
 *
 * NEDEN: bağlan kodu tek-seferlik ve 15 dk ömürlüdür. Sihirbaz dışında kod üretmenin panelde
 * hiçbir yolu yoktu → kod süresi dolduğunda, eklenti yeniden kurulduğunda ya da sihirbazda kod
 * adımı patladığında (site kaydı açık, domain rezerve) mağaza panele BİR DAHA bağlanamıyordu.
 *
 * Uç idempotent güvenlidir: her çağrı kimlik bilgilerini yeniden üretir (rekey) ve önceki
 * tüketilmemiş kodları geçersiz kılar → aynı anda tek aktif kod. Bu YIKICI bir işlem olduğu için
 * (eski kod ve mevcut eklenti kimliği geçersizleşir) önce onay istenir.
 */
export function IssueConnectCode({ siteId, domain }: { siteId: string; domain: string }) {
  const [pending, start] = React.useTransition();
  const [code, setCode] = React.useState<{ code: string; expiresAt: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const announce = useAnnouncer();
  const { confirm, dialog } = useConfirm();

  const issue = async () => {
    const ok = await confirm({
      title: `${domain} için yeni bağlan kodu üretilsin mi?`,
      description:
        'Sitenin kimlik bilgileri YENİDEN üretilir: daha önce verilmiş ve henüz kullanılmamış kodlar geçersiz olur. Mağaza, yeni kodla tekrar bağlanana kadar panele istek gönderemez.',
      tone: 'danger',
      confirmLabel: 'Yeni kod üret',
    });
    if (!ok) return;
    setError(null);
    setCode(null);
    setCopied(false);
    start(async () => {
      const res = await issueCodeForSite(siteId);
      if (res.ok && res.code && res.expiresAt) {
        setCode({ code: res.code, expiresAt: res.expiresAt });
        announce('Yeni bağlan kodu üretildi');
      } else {
        // Dürüstlük: başarısızlık sessiz geçmez — gerçek sebep gösterilir ve duyurulur.
        const message = res.error ?? 'Bağlan kodu üretilemedi';
        setError(message);
        announce(message, { assertive: true });
      }
    });
  };

  const copy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Pano erişimi yoksa sessiz geç — kod zaten ekranda görünüyor (seçilebilir).
    }
  };

  return (
    <div className="space-y-3">
      {dialog}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" onClick={() => void issue()} disabled={pending}>
          <KeyRound />
          {pending ? 'Üretiliyor…' : 'Yeni Bağlan Kodu Üret'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Eklenti yeniden kurulduğunda ya da kodun süresi dolduğunda (15 dk) kullanın.
        </p>
      </div>

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Kod üretilemedi</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {code && (
        <div className="rounded-lg border border-border bg-muted/40 p-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <code className="select-all break-all font-mono text-lg font-semibold tracking-wide text-foreground">
              {code.code}
            </code>
            <Button type="button" variant="outline" size="sm" onClick={copy}>
              {copied ? <Check /> : <Copy />}
              {copied ? 'Kopyalandı' : 'Kopyala'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Son kullanma:{' '}
            <span className="font-medium text-foreground">
              {new Date(code.expiresAt).toLocaleString('tr-TR')}
            </span>{' '}
            · WordPress&apos;te <strong>Ayarlar &rsaquo; Teslimat Eklentisi &rsaquo; Panele Bağlan</strong>{' '}
            ekranına yapıştırın. Kod yalnız bir kez kullanılabilir.
          </p>
        </div>
      )}
    </div>
  );
}
