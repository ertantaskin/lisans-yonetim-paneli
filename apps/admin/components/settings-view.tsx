import {
  ShieldCheck,
  ShieldOff,
  Send,
  Globe,
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
  const { authEnabled, telegramConfigured, env, sites, sitesError, runtime } = data;

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

      {/* Kanal / site durumu */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="size-4 text-muted-foreground" /> Kanal durumu
          </CardTitle>
          <CardDescription>Bağlı site sayıları ve test modu (sandbox) dağılımı.</CardDescription>
        </CardHeader>
        <CardContent>
          {sitesError || !sites ? (
            <p className="text-sm text-muted-foreground">
              Site özeti alınamadı{sitesError ? `: ${sitesError}` : ''}.
            </p>
          ) : (
            <dl className="grid grid-cols-3 gap-4 text-center">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Toplam
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">
                  {sites.total}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Canlı
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-success">
                  {sites.live}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sandbox
                </dt>
                <dd className="mt-1 text-2xl font-semibold tabular-nums text-warning">
                  {sites.sandbox}
                </dd>
              </div>
            </dl>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
