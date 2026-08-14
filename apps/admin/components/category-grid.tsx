'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, FolderOpen, PackageX, Search } from 'lucide-react';
import { UNCATEGORIZED, type CategoryRow } from '../lib/categories';
import { includesTr } from '../lib/utils';
import { Input } from './ui/input';

/**
 * `/stock` giriş seviyesi: KATEGORİ kartları (kullanıcı: "panel ürünleri direkt görünüyor,
 * kategorize edelim; kart tarzı daha kullanışlı").
 *
 * TASARIM KARARLARI (ikinci tur geri bildirim: "daha sade/minimal olmalı, çok yer kaplıyor;
 * stoğu fazla olan üstte olsun; çok kategori olursa ne olacak?"):
 *  · Kart TEK SATIR bilgi taşır (ad + sayılar aynı blokta, 2 satır toplam ~64px) — eskiden
 *    ikon kutusu + açıklama + ayrı sayaç satırı ile ~110px idi.
 *  · Sıra sunucudan gelir (sabitlenmişler → stok çoktan aza → ad); istemci YENİDEN SIRALAMAZ,
 *    yoksa iki farklı sıralama tanımı olurdu.
 *  · **Çok kategori**: 8'i geçince süzme kutusu çıkar (Türkçe-duyarlı `includesTr`) ve ızgara
 *    4 kolona genişler. Sayfalama YOK — süzgeç, kategori sayısı arttıkça sayfalamadan daha
 *    hızlıdır (operatör adı biliyor, tıklayarak aramaz).
 *  · Açıklama kartta DEĞİL, `title` ipucunda: kartın yüksekliğini iki katına çıkarıyordu.
 */
export function CategoryGrid({ categories }: { categories: CategoryRow[] }) {
  const [filter, setFilter] = React.useState('');
  const showFilter = categories.length > 8;
  const rows = filter.trim()
    ? categories.filter((c) => includesTr(c.name, filter.trim()))
    : categories;

  return (
    <div className="space-y-2">
      {showFilter && (
        <div className="relative max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`${categories.length} kategori içinde süz…`}
            aria-label="Kategori süz"
            className="h-8 bg-muted/40 pl-8 text-xs"
          />
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-card px-3 py-6 text-center text-xs text-muted-foreground">
          “{filter}” ile eşleşen kategori yok.
        </p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((c) => {
            const uncategorized = c.id === UNCATEGORIZED;
            return (
              <Link
                key={c.id}
                href={`/stock?category=${encodeURIComponent(c.id)}`}
                title={
                  uncategorized
                    ? 'Kategori atanmamış ürünler'
                    : (c.description ?? `${c.name} — ${c.productCount} ürün`)
                }
                className="group flex items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
              >
                <FolderOpen
                  aria-hidden
                  className={
                    uncategorized ? 'size-4 shrink-0 text-muted-foreground/70' : 'size-4 shrink-0 text-muted-foreground'
                  }
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-foreground">
                    {c.name}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                    <span className="tabular-nums">{c.productCount} ürün</span>
                    <span aria-hidden className="text-border">·</span>
                    <span className="tabular-nums">
                      {c.availableStock.toLocaleString('tr-TR')} stok
                    </span>
                    {c.lowStockCount > 0 && (
                      <>
                        <span aria-hidden className="text-border">·</span>
                        <span className="inline-flex items-center gap-1 font-medium text-warning">
                          <PackageX aria-hidden className="size-3" />
                          {c.lowStockCount} düşük
                        </span>
                      </>
                    )}
                  </span>
                </span>
                <ArrowRight
                  aria-hidden
                  className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
                />
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
