import { ScrollText } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { fetchAuditAction, type AuditPageData } from './actions';
import { AuditTable } from './audit-table';

export const dynamic = 'force-dynamic';

/**
 * DENETİM İZİ (§8) — "kim, neyi, ne zaman yaptı".
 *
 * `audit_log` yıllardır yazılıyordu (her reveal/revoke/import/… bir satır) ama panelde onu
 * gösteren hiçbir yüzey yoktu; sorular ancak veritabanına ELLE bağlanarak yanıtlanıyordu.
 * Ekran SALT-OKUNUR: denetim izi append-only'dir, panelden düzenlenemez/silinemez.
 *
 * KAPSAM (metin gerçeğe uyduruldu): YÖNETİCİ GİRİŞLERİ BURADA DEĞİLDİR. `audit_action` PG
 * enum'unda bir 'login' değeri var ama onu YAZAN tek satır kod yok — giriş/başarısız giriş
 * `security_events`'e düşer (`admin-users.service`), yani `/security` ekranında görünür.
 * Bu yüzden hem açıklamadan hem süzgeç listesinden çıkarıldı: seçilebilen ama DAİMA boş liste
 * döndüren bir filtre, operatöre "kayıt yok" diye yanlış bir cevap verir.
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
        description="Panelde ve mağaza eklentisinde yapılan işlemlerin değiştirilemez kaydı: lisans görüntüleme, iptal/değişim, stok girişi ve site ayarı. Aktör, hedef, tarih ve iz kimliğiyle süzülür. Yönetici giriş denemeleri burada değil, Güvenlik ekranındadır."
      />
      <AuditTable initial={initial} />
    </div>
  );
}
