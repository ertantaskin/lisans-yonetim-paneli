import {
  ShieldCheck,
  ShieldOff,
  Send,
  FlaskConical,
  Server,
  KeyRound,
  Check,
  Minus,
  type LucideIcon,
} from 'lucide-react';
import type { SystemStatus } from '../app/settings/queries';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from './ui/card';
import { StatTile } from './ui/stat-tile';
import { Badge } from './ui/badge';

/**
 * Ayarlar / sistem durumu görünümü — SALT-OKUNUR. Hiçbir sır değeri göstermez;
 * env yalnız "yapılandırıldı / kapalı" rozetiyle yansıtılır (§14/§16).
 */

function StateBadge({ on, onLabel, offLabel }: { on: boolean; onLabel: string; offLabel: string }) {
  return on ? (
    <Badge variant="success">
      <Check /> {onLabel}
    </Badge>
  ) : (
    <Badge variant="outline">
      <Minus /> {offLabel}
    </Badge>
  );
}

export function SettingsView({ data }: { data: SystemStatus }) {
  const { authEnabled, telegramConfigured, env, sites, runtime } = data;

  // Üst özet: kritik durum kartları.
  const authIcon: LucideIcon = authEnabled ? ShieldCheck : ShieldOff;

  return (
    <div className="space-y-6">
      {/* Özet kartlar */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Oturum kapısı"
          value={authEnabled ? 'Açık' : 'Kapalı'}
          hint={authEnabled ? 'Çoklu-admin auth etkin' : 'SESSION_SECRET set değil'}
          icon={authIcon}
          tone={authEnabled ? 'success' : 'warning'}
        />
        <StatTile
          label="Telegram bildirimi"
          value={telegramConfigured ? 'Açık' : 'Kapalı'}
          hint={telegramConfigured ? 'Bot + sohbet yapılandırıldı' : 'Yapılandırılmadı'}
          icon={Send}
          tone={telegramConfigured ? 'success' : 'neutral'}
        />
        <StatTile
          label="Sandbox site"
          value={sites ? sites.sandbox : '—'}
          hint={sites ? `${sites.live} canlı · ${sites.total} toplam` : 'API erişilemedi'}
          icon={FlaskConical}
          tone={sites && sites.sandbox > 0 ? 'warning' : 'neutral'}
        />
        <StatTile
          label="Uygulama sürümü"
          value={`v${runtime.version}`}
          hint={`Node ${runtime.node} · ${runtime.env}`}
          icon={Server}
        />
      </div>

      {/* env yansımaları (yalnız yapılandırıldı/kapalı — SIR YOK) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" /> Ortam yapılandırması
          </CardTitle>
          <CardDescription>
            Sunucu-taraflı yansıma. Güvenlik gereği sır değerleri gösterilmez — yalnız tanımlı
            olup olmadığı.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border">
            {env.map((flag) => (
              <li key={flag.label} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <div className="font-mono text-sm text-foreground">{flag.label}</div>
                  <div className="truncate text-xs text-muted-foreground">{flag.hint}</div>
                </div>
                <StateBadge on={flag.configured} onLabel="yapılandırıldı" offLabel="kapalı" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
