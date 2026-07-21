import { PageHeader } from '../../components/ui';
import { AiPanel } from './ai-panel';

export const dynamic = 'force-dynamic';

/**
 * AI Operasyon (§15). AI ÖNERİR, insan onaylar — bu ekranın hiçbir eylemi otomatik
 * yürütmez (mail göndermez, DB yazmaz); yalnız salt-okunur öneri/rapor/taslak üretir.
 * Owner şartı YOK — her admin erişebilir. Veri client-taraflı /api/ai/* proxy'lerinden
 * çekilir (ADMIN_TOKEN yalnız Next sunucusunda kalır).
 */
export default function AiPage() {
  return (
    <div>
      <PageHeader
        title="AI Operasyon"
        desc="Doğal dilde rapor, günlük anomali özeti ve destek triyajı — AI önerir, insan onaylar (§15)."
      />
      <AiPanel />
    </div>
  );
}
