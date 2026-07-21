import { NextResponse } from 'next/server';
import { getActor } from '@/lib/session';

/**
 * Maliyet raporu proxy (D12). Salt-okunur; yalnız TEDARİK maliyeti (satın alma emri) döner —
 * gelir/kâr panelde YOKTUR. ADMIN_TOKEN yalnız sunucuda kalır, client'a ASLA sızmaz.
 * API yanıt gövdesini (status dahil) olduğu gibi iletir.
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

export async function GET() {
  try {
    const res = await fetch(`${API_URL}/v1/admin/reports/costs`, {
      headers: { 'x-admin-token': ADMIN_TOKEN, 'x-admin-actor': await getActor() },
      cache: 'no-store',
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `Maliyet raporu alınamadı (${res.status})` },
        { status: res.status },
      );
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'API bağlantı hatası' }, { status: 502 });
  }
}
