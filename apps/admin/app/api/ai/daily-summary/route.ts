import { NextResponse } from 'next/server';
import { apiRaw } from '@/lib/api';
import { getActor } from '@/lib/session';

/**
 * Günlük operasyon özeti proxy (§15). Metrikler her zaman döner; AI açıksa yanıta Türkçe
 * anomali paragrafı eklenir (aksi halde paragraph=null). apiRaw ile token + trace-id (§16)
 * merkezî iletilir (ADMIN_TOKEN yalnız sunucuda kalır); yanıt gövdesi (status dahil) olduğu gibi.
 */
export async function GET() {
  try {
    const res = await apiRaw('GET', '/v1/admin/ai/daily-summary', { actor: await getActor() });
    if (!res.ok) {
      return NextResponse.json({ error: `AI özeti alınamadı (${res.status})` }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json({ error: 'API bağlantı hatası' }, { status: 502 });
  }
}
