import { NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * AI destek triyajı proxy (§15). Bir değişim/garanti talebini AI kategorize eder +
 * müşteriye TASLAK cevap üretir; insan onaylar/gönderir (OTOMATİK GÖNDERİM YOK). Yanıt
 * gövdesi + status olduğu gibi iletilir — AI kapalıysa API 503, geçersiz id'de 400 döner.
 * apiRaw ile token + trace-id (§16) merkezî iletilir (ADMIN_TOKEN yalnız sunucuda kalır).
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await apiRaw('POST', `/v1/admin/ai/support/${encodeURIComponent(id)}/suggest`, {
      actor: await getActor(),
    });
    const text = await res.text();
    return new NextResponse(text, {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
    });
  } catch {
    return NextResponse.json({ error: 'API bağlantı hatası' }, { status: 502 });
  }
}
