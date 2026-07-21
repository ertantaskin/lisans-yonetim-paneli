import { NextResponse } from 'next/server';
import { getActor } from '@/lib/session';

/**
 * Müşteri risk skoru proxy (§13, advisory). RiskBadge bir CLIENT bileşen olduğundan
 * ADMIN_TOKEN'ı doğrudan çağıramaz (token yalnız sunucuda kalmalı). Bu route handler
 * isteği sunucu-taraflı iletir — token tarayıcıya ASLA sızmaz. Erişim, uygulamanın
 * geri kalanıyla aynı oturum gate'i (middleware) altındadır. YALNIZ GÖRÜNTÜ: skor +
 * faktör kırılımı döner, hiçbir otomatik askı/blok tetiklemez. API erişilemezse
 * "duruk" (score/band = null) döner — rozet kibarca "risk verisi yok" gösterir (graceful).
 */
const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? '';

interface RiskFactor {
  key: string;
  label: string;
  contribution: number;
  detail: string;
}
interface CustomerRisk {
  email: string;
  score: number | null; // 0..100, null = hesaplanamadı (duruk)
  band: 'low' | 'medium' | 'high' | null;
  factors: RiskFactor[];
  generatedAt: string | null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ email: string }> }) {
  const { email: raw } = await params;
  const email = decodeURIComponent(raw);
  const inert: CustomerRisk = { email, score: null, band: null, factors: [], generatedAt: null };
  try {
    const res = await fetch(
      `${API_URL}/v1/admin/customers/${encodeURIComponent(email)}/risk`,
      {
        headers: { 'x-admin-token': ADMIN_TOKEN, 'x-admin-actor': await getActor() },
        cache: 'no-store',
      },
    );
    // API'ye ulaşılamaz/hata → duruk risk döndür (rozet kibarca boş durumu gösterir).
    if (!res.ok) return NextResponse.json(inert);
    return NextResponse.json(await res.json());
  } catch {
    return NextResponse.json(inert);
  }
}
