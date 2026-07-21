import { NextResponse } from 'next/server';
import { getActor } from '@/lib/session';

/**
 * Günlük operasyon özeti proxy (§15). Metrikler her zaman döner; AI açıksa yanıta Türkçe
 * anomali paragrafı eklenir (aksi halde paragraph=null). Token yalnız sunucuda kalır —
 * client'a ASLA sızmaz. API yanıt gövdesini (status dahil) olduğu gibi iletir.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/v1/admin/ai/daily-summary`, {
      headers: { 'x-admin-token': ADMIN_TOKEN, 'x-admin-actor': await getActor() },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json({ error: `AI özeti alınamadı (${res.status})` }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'API bağlantı hatası' }, { status: 502 });
  }
}
