import { NextResponse, type NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';

/**
 * Canlı akış proxy'si (§17). İstemci bileşenleri ADMIN_TOKEN'ı göremez → poll bu route
 * üzerinden geçer (token yalnız Next sunucusunda kalır; erişim middleware oturum gate'i altında).
 *
 * ETag geçişi: tarayıcının `if-none-match` başlığını API'ye AYNEN iletir ve API 304 dönerse
 * gövdesiz 304 geri verir. Panel gün boyu açık kalacağı için sakin saatlerde poll'lar
 * ~0 bayt gövdeye iner (yalnız başlık trafiği) — bu, "gereksiz yük yaratma" isteğinin
 * teknik karşılığıdır.
 */
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const limitRaw = Number.parseInt(req.nextUrl.searchParams.get('limit') ?? '15', 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 50) : 15;
  const inm = req.headers.get('if-none-match') ?? undefined;

  try {
    const res = await apiRaw('GET', `/v1/admin/live?limit=${limit}`, { ifNoneMatch: inm });

    if (res.status === 304) {
      return new NextResponse(null, {
        status: 304,
        headers: {
          etag: res.headers.get('etag') ?? '',
          'cache-control': 'no-store',
        },
      });
    }

    if (!res.ok) {
      return NextResponse.json({ error: 'unavailable' }, { status: 502 });
    }

    const body = await res.text();
    const etag = res.headers.get('etag');
    return new NextResponse(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        ...(etag ? { etag } : {}),
      },
    });
  } catch {
    // API kapalı/erişilemez — istemci sessizce yeniden dener (UI kırılmaz).
    return NextResponse.json({ error: 'unavailable' }, { status: 502 });
  }
}
