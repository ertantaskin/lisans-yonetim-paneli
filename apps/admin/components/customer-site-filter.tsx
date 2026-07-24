'use client';
import { useRouter } from 'next/navigation';
import { Combobox } from './ui/combobox';
import type { SiteOption } from '../app/customers/queries';

/**
 * Müşteriler ekranı site süzgeci (site → müşteri hiyerarşisi). Aranabilir Combobox;
 * seçilince `/customers?site=<id>`e gider (sunucu o siteye kapsanmış listeyi döndürür).
 * "Tüm siteler" → süzgeci temizler.
 */
export function CustomerSiteFilter({
  sites,
  current,
}: {
  sites: SiteOption[];
  current?: string;
}) {
  const router = useRouter();
  return (
    <Combobox
      ariaLabel="Site süzgeci"
      allowClear
      clearLabel="Tüm siteler"
      placeholder="Tüm siteler"
      defaultValue={current ?? ''}
      items={sites.map((s) => ({ value: s.id, label: s.domain }))}
      searchPlaceholder="Site alan adı ara…"
      emptyText="Site bulunamadı"
      className="w-full sm:w-64"
      onValueChange={(v) => router.push(v ? `/customers?site=${encodeURIComponent(v)}` : '/customers')}
    />
  );
}
