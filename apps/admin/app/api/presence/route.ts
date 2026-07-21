import { NextResponse, type NextRequest } from 'next/server';
import { apiPost } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * Operatör presence proxy (§14). presence-indicator bir CLIENT bileşen olduğundan
 * ADMIN_TOKEN'ı doğrudan çağıramaz (token yalnız sunucuda kalmalı). Bu route handler
 * actor'ı oturumdan (getActor) enjekte edip heartbeat'i sunucu-taraflı API'ye iletir —
 * token tarayıcıya ASLA sızmaz. Erişim, uygulamanın geri kalanıyla aynı oturum gate'i
 * (middleware) altındadır. Best-effort: hata UI'yı kırmamalı.
 */
export async function POST(req: NextRequest) {
  let resource = '';
  try {
    const body = (await req.json()) as { resource?: unknown };
    resource = typeof body.resource === 'string' ? body.resource : '';
  } catch {
    resource = '';
  }

  const actor = await getActor();
  if (!resource) return NextResponse.json({ present: [], self: actor });

  try {
    const data = await apiPost<{ present: string[] }>(
      '/v1/admin/presence/heartbeat',
      { resource, actor },
      actor,
    );
    return NextResponse.json({ present: data.present, self: actor });
  } catch {
    return NextResponse.json({ present: [], self: actor });
  }
}
