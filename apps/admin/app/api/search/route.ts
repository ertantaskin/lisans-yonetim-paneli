import { NextResponse, type NextRequest } from 'next/server';
import { apiGet } from '@/lib/api';

/**
 * Global arama proxy (§13, Ctrl+K). Komut paleti bir CLIENT bileşen olduğundan
 * ADMIN_TOKEN'ı doğrudan çağıramaz (token yalnız sunucuda kalmalı). Bu route handler
 * isteği sunucu-taraflı `apiGet` ile API'ye iletir — token tarayıcıya ASLA sızmaz.
 * Erişim, uygulamanın geri kalanıyla aynı oturum gate'i (middleware) altındadır.
 */
export interface SearchOrderHit {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
}
export interface SearchKeyHit {
  licenseItemId: string;
  productSku: string;
  orderId: string | null;
  masked: string;
}
export interface SearchResult {
  orders: SearchOrderHit[];
  keys: SearchKeyHit[];
}

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get('q') ?? '';
  if (q.trim().length < 2) {
    return NextResponse.json({ orders: [], keys: [] } satisfies SearchResult);
  }
  try {
    const data = await apiGet<SearchResult>(`/v1/admin/search?q=${encodeURIComponent(q)}`);
    return NextResponse.json(data);
  } catch {
    // Arama hatası paleti kırmamalı — boş sonuç döndür.
    return NextResponse.json({ orders: [], keys: [] } satisfies SearchResult);
  }
}
