import Link from 'next/link';
import { ArrowRight, Globe, ShoppingCart, Users } from 'lucide-react';
import type { CustomerSiteSummary } from '../app/customers/queries';
import { siteTypeLabel } from '../lib/labels';
import { Badge } from './ui/badge';

/**
 * `/customers` giriş seviyesi: MAĞAZA kartları (site → müşteri hiyerarşisi).
 *
 * NEDEN KART, NEDEN TABLO DEĞİL: bu ekran bir veri listesi değil, bir NAVİGASYON adımı —
 * operatör buradan bir mağazanın içine girer. Kart, tıklama hedefini büyütür ve mağaza
 * başına üç sayıyı (müşteri / sipariş / son sipariş) tek bakışta verir. Mağaza sayısı
 * arttığında üstteki arama zaten hiyerarşiyi atlamayı sağlıyor.
 *
 * SIFIR MÜŞTERİLİ MAĞAZA GİZLENMEZ: yeni bağlanmış bir mağaza listede görünmezse operatör
 * "bağlantı kurulmadı mı?" diye arar — sıfır, yokluk değil bilgidir (API'de de LEFT JOIN).
 */
export function CustomerSiteGrid({ sites }: { sites: CustomerSiteSummary[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
      {sites.map((s) => (
        <Link
          key={s.siteId}
          href={`/customers?site=${encodeURIComponent(s.siteId)}`}
          className="group flex flex-col gap-3 rounded-xl border border-border bg-card p-4 shadow-xs outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                <Globe className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-foreground" title={s.domain}>
                  {s.domain}
                </p>
                <p className="text-xs text-muted-foreground">{siteTypeLabel(s.type)}</p>
              </div>
            </div>
            <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none" />
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-3.5" />
              <strong className="text-sm font-semibold tabular-nums text-foreground">
                {s.customerCount.toLocaleString('tr-TR')}
              </strong>
              müşteri
            </span>
            <span className="inline-flex items-center gap-1.5">
              <ShoppingCart className="size-3.5" />
              <strong className="text-sm font-semibold tabular-nums text-foreground">
                {s.orderCount.toLocaleString('tr-TR')}
              </strong>
              sipariş
            </span>
            {s.lastOrderAt ? (
              <span className="tabular-nums">
                son sipariş{' '}
                {new Date(s.lastOrderAt).toLocaleDateString('tr-TR', { dateStyle: 'short' })}
              </span>
            ) : (
              <Badge variant="outline">Henüz sipariş yok</Badge>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
