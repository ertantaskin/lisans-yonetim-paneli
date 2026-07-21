import { NextResponse, type NextRequest } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * NL→Rapor proxy (§15). Türkçe soruyu API'ye iletir; API salt-okunur bir SELECT üretip
 * güvenle çalıştırır. Yanıt gövdesi (üretilen SQL + sonuç veya hata) ve status kodu
 * OLDUĞU GİBİ iletilir — AI kapalıysa API 503, geçersiz soruda 400 döner; UI kibarca
 * gösterir. apiRaw ile token + trace-id (§16) merkezî iletilir (ADMIN_TOKEN yalnız sunucuda kalır).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { question?: unknown } | null;
  if (!body || typeof body.question !== 'string') {
    return NextResponse.json({ error: 'Geçersiz istek: soru gerekli.' }, { status: 400 });
  }
  try {
    const res = await apiRaw('POST', '/v1/admin/ai/report', {
      body: { question: body.question },
      actor: await getActor(),
    });
    // Gövdeyi (SQL + sonuç/hata) ve status'ü olduğu gibi ilet — ok:false 200 içinde gelir.
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'API bağlantı hatası' }, { status: 502 });
  }
}
