import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { SettingsView } from '../../components/settings-view';
import { getSystemStatus, type SystemStatus } from './queries';

export const dynamic = 'force-dynamic';

/**
 * Ayarlar / Sistem durumu — SALT-OKUNUR (§14/§16). env yansıması yalnız
 * "yapılandırıldı/kapalı"; sır değerleri asla gösterilmez.
 */
export default async function SettingsPage() {
  let data: SystemStatus | null = null;
  let error: string | null = null;
  try {
    data = await getSystemStatus();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Ayarlar"
        description="Sistem durumu ve ortam yapılandırması — salt-okunur (sır gösterilmez)."
      />
      {error || !data ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">Durum yüklenemedi: {error ?? 'Veri yok'}</p>
        </Card>
      ) : (
        <SettingsView data={data} />
      )}
    </div>
  );
}
