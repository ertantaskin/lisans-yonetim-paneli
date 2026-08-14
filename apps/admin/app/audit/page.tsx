import { ScrollText } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { fetchAuditAction, type AuditPageData } from './actions';
import { AuditTable } from './audit-table';

export const dynamic = 'force-dynamic';

/**
 * DENETİM İZİ (§8) — "kim, neyi, ne zaman yaptı".
 *
 * `audit_log` yıllardır yazılıyordu (her reveal/revoke/import/login bir satır) ama panelde
 * onu gösteren hiçbir yüzey yoktu; sorular ancak veritabanına ELLE bağlanarak yanıtlanıyordu.
 * Ekran SALT-OKUNUR: denetim izi append-only'dir, panelden düzenlenemez/silinemez.
 *
 * İlk sayfa SUNUCUDA çekilir (SSR — operatör boş iskelet görmez). Başarısızsa istemciye
 * `null` geçilir; istemci kendi isteğini yapar ve hatayı GÖRÜNÜR biçimde bildirir (sayfayı
 * komple hata sınırına düşürmek, süzgeçleri de kullanılamaz hale getirirdi).
 */
export default async function AuditPage() {
  const res = await fetchAuditAction({});
  const initial: AuditPageData | null = res.ok ? res.page : null;

  return (
    <div>
      <PageHeader
        icon={ScrollText}
        title="Denetim İzi"
        description="Panelde ve mağaza eklentisinde yapılan işlemlerin değiştirilemez kaydı: lisans görüntüleme, iptal/değişim, stok girişi, site ayarı ve yönetici girişleri. Aktör, hedef, tarih ve iz kimliğiyle süzülür."
      />
      <AuditTable initial={initial} />
    </div>
  );
}
