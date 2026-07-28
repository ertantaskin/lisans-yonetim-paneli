import { NextResponse, type NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * Bildirim "okundu" işaretleme proxy'si (§17) — üst bardaki çan dropdown'ından çağrılır.
 * ADMIN_TOKEN sunucuda kalır. Gövde: { ids?: string[] } veya { all?: true }.
 */
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  let payload: { ids?: string[]; all?: boolean } = {};
  try {
    const raw = (await req.json()) as { ids?: unknown; all?: unknown };
    if (Array.isArray(raw.ids)) {
      payload.ids = raw.ids.filter((x): x is string => typeof x === 'string').slice(0, 200);
    }
    if (raw.all === true) payload = { all: true };
  } catch {
    payload = {};
  }
  if (!payload.all && !payload.ids?.length) {
    return NextResponse.json({ marked: 0 }, { status: 400 });
  }

  try {
    const res = await apiRaw('POST', '/v1/admin/notifications/read', {
      body: payload,
      actor: await getActor(),
    });
    const body = await res.text();
    return new NextResponse(body, {
      status: res.status,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  } catch {
    return NextResponse.json({ marked: 0 }, { status: 502 });
  }
}
