import { NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * Maliyet raporu proxy (D12). Salt-okunur; yalnız TEDARİK maliyeti (satın alma emri) döner —
 * gelir/kâr panelde YOKTUR. apiRaw ile token + trace-id (§16) merkezî iletilir (ADMIN_TOKEN
 * yalnız sunucuda kalır); API yanıt gövdesini (status dahil) olduğu gibi iletir.
 */
export async function GET() {
  try {
    const res = await apiRaw('GET', '/v1/admin/reports/costs', { actor: await getActor() });
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
