import { NextResponse, type NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * Kayıtlı görünümler proxy'si (§14). Menü bir CLIENT bileşen olduğundan ADMIN_TOKEN'ı
 * doğrudan çağıramaz (token yalnız sunucuda kalmalı). Ayrıca list/create/delete ACTOR
 * bazlıdır: her istekte oturumdaki admin'i `x-admin-actor` başlığıyla iletmemiz gerekir
 * (`apiGet` actor göndermediğinden fallback 'panel:admin' → filtre bozulur). Bu yüzden
 * apiRaw'ı actor ile çağırırız — token + trace-id (§16) merkezî iletilir, yanıt status/gövdesi
 * korunur. Token tarayıcıya ASLA sızmaz; erişim uygulamanın geri kalanıyla aynı oturum gate'i altındadır.
 */
/** Sunucu-taraflı authed fetch: oturum actor'ı + token + trace-id ile API'ye iletir. */
async function apiFetch(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<Response> {
  return apiRaw(method, path, { body, actor: await getActor() });
}

/** Bu admin'in ?page= ile verilen sayfaya ait kayıtlı görünümleri. */
export async function GET(req: NextRequest) {
  const page = req.nextUrl.searchParams.get('page') ?? '';
  if (page.trim().length === 0) return NextResponse.json([]);
  try {
    const res = await apiFetch('GET', `/v1/admin/saved-views?page=${encodeURIComponent(page)}`);
    if (!res.ok) return NextResponse.json([]);
    return NextResponse.json(await res.json());
  } catch {
    // Görünüm listesi hatası tabloyu kırmamalı — boş liste döndür.
    return NextResponse.json([]);
  }
}

/** Mevcut filtre/arama durumunu adlandırıp kaydeder. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { page?: unknown; name?: unknown; query?: unknown }
    | null;
  if (!body) return new NextResponse('bad request', { status: 400 });
  const res = await apiFetch('POST', '/v1/admin/saved-views', {
    page: body.page,
    name: body.name,
    query: body.query,
  });
  if (!res.ok) {
    return new NextResponse(await res.text().catch(() => 'error'), { status: res.status });
  }
  return NextResponse.json(await res.json());
}

/** Görünümü siler — ?id= ile. API tarafı yalnız isteği yapan actor'a ait satırı siler. */
export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (id.trim().length === 0) return new NextResponse('bad request', { status: 400 });
  const res = await apiFetch('DELETE', `/v1/admin/saved-views/${encodeURIComponent(id)}`);
  if (!res.ok) {
    return new NextResponse(await res.text().catch(() => 'error'), { status: res.status });
  }
  return NextResponse.json(await res.json());
}
