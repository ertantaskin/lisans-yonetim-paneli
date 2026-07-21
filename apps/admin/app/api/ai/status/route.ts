import { NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * AI durum proxy (§15). AiPanel bir CLIENT bileşen olduğundan ADMIN_TOKEN'ı doğrudan
 * çağıramaz (token yalnız sunucuda kalmalı). Bu route handler isteği apiRaw ile sunucu-taraflı
 * iletir (token + trace-id §16 merkezî) — token tarayıcıya ASLA sızmaz. Erişim, uygulamanın
 * geri kalanıyla aynı oturum gate'i (middleware) altındadır. SIR DÖNMEZ (yalnız açık/kapalı + model adı).
 */
export async function GET() {
  try {
    const res = await apiRaw('GET', '/v1/admin/ai/status', { actor: await getActor() });
    // API'ye ulaşılamazsa "kapalı" varsay — panel sarı uyarı bandını gösterir (graceful).
    if (!res.ok) return NextResponse.json({ enabled: false, model: null });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ enabled: false, model: null });
  }
}
