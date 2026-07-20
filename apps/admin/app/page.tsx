import type { HealthResponse } from '@jetlisans/shared';

// Faz 0 iniş ekranı — API sağlık bağlantısını doğrular. Faz 1'de yerini
// "Bekleyen Teslimatlar" ana ekranı alır (§13).
async function getHealth(): Promise<HealthResponse | null> {
  const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
  try {
    const res = await fetch(`${base}/v1/health`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as HealthResponse;
  } catch {
    return null;
  }
}

function Pill({ ok, label }: { ok: boolean; label: string }) {
  const cls = ok
    ? 'bg-[color-mix(in_srgb,var(--color-success)_15%,transparent)] text-success'
    : 'bg-[color-mix(in_srgb,var(--color-danger)_15%,transparent)] text-danger';
  return (
    <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm ${cls}`}>
      <span className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}

export default async function Home() {
  const health = await getHealth();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <span className="inline-block rounded-full bg-accent-soft px-3 py-1 text-sm font-medium text-accent">
          Faz 0 · iskelet ayakta
        </span>
        <h1 className="text-3xl font-semibold text-ink">Jetlisans</h1>
        <p className="text-ink/70">Merkezi lisans dağıtım paneli — admin arayüzü.</p>
      </header>

      <section className="rounded-[var(--radius-card)] border border-ink/10 bg-surface-raised p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-medium text-ink">API bağlantısı</h2>
        {health ? (
          <div className="flex flex-wrap items-center gap-3">
            <Pill
              ok={health.checks.db}
              label={`PostgreSQL ${health.checks.db ? 'bağlı' : 'yok'}`}
            />
            <Pill
              ok={health.checks.redis}
              label={`Redis ${health.checks.redis ? 'bağlı' : 'yok'}`}
            />
            <span className="ml-auto text-sm text-ink/50">v{health.version}</span>
          </div>
        ) : (
          <Pill ok={false} label="API'ye ulaşılamıyor (docker compose up?)" />
        )}
      </section>

      <footer className="text-sm text-ink/40">
        Sıradaki: Faz 1 · atomik atama + kısmi teslimat + WP eklentisi.
      </footer>
    </main>
  );
}
