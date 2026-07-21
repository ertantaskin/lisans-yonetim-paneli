import { NextResponse } from 'next/server';
import { getActor } from '@/lib/session';

/**
 * AI durum proxy (§15). AiPanel bir CLIENT bileşen olduğundan ADMIN_TOKEN'ı doğrudan
 * çağıramaz (token yalnız sunucuda kalmalı). Bu route handler isteği sunucu-taraflı
 * iletir — token tarayıcıya ASLA sızmaz. Erişim, uygulamanın geri kalanıyla aynı
 * oturum gate'i (middleware) altındadır. SIR DÖNMEZ (yalnız açık/kapalı + model adı).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/v1/admin/ai/status`, {
      headers: { 'x-admin-token': ADMIN_TOKEN, 'x-admin-actor': await getActor() },
      cache: 'no-store',
    });
    // API'ye ulaşılamazsa "kapalı" varsay — panel sarı uyarı bandını gösterir (graceful).
    if (!res.ok) return NextResponse.json({ enabled: false, model: null });
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ enabled: false, model: null });
  }
}
