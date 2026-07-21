import { NextResponse } from 'next/server';
import { getActor } from '@/lib/session';

/**
 * AI destek triyajı proxy (§15). Bir değişim/garanti talebini AI kategorize eder +
 * müşteriye TASLAK cevap üretir; insan onaylar/gönderir (OTOMATİK GÖNDERİM YOK). Yanıt
 * gövdesi + status olduğu gibi iletilir — AI kapalıysa API 503, geçersiz id'de 400 döner.
 * Token yalnız sunucuda kalır — client'a ASLA sızmaz.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const res = await fetch(`${API_URL}/v1/admin/ai/support/${encodeURIComponent(id)}/suggest`, {
      method: 'POST',
      headers: { 'x-admin-token': ADMIN_TOKEN, 'x-admin-actor': await getActor() },
      cache: 'no-store',
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
