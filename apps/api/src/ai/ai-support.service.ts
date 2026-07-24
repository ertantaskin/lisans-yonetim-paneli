import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
// Bu modül henüz index.ts barrel'ına eklenmedi (orkestratör ekler) → doğrudan dosyadan al.
import { replacementRequests } from '../db/schema/replacementRequests';
import { AiService } from './ai.service';

/** AI'nın ürettiği triyaj sonucu (§15). Yalnız ÖNERİ — hiçbir eylem yapılmaz. */
export interface SupportSuggestion {
  /** {garanti, calismyor, yanlis-urun, iade, diger} birinden. */
  category: string;
  /** {dusuk, orta, yuksek} birinden. */
  priority: string;
  /** Müşteriye kibar TÜRKÇE taslak cevap (imza yok). */
  draftReply: string;
}

/**
 * E-posta maskesi (§15 "ham e-posta modele gönderilmez"). Yalnız yerel-adın ilk
 * harfi + alan-adın ilk harfi + TLD kalır: 'aylin@xmail.com' → 'a***@x.com'.
 */
function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localMasked = `${local[0]}***`;
  const dot = domain.lastIndexOf('.');
  const domainMasked = dot > 0 ? `${domain[0]}.${domain.slice(dot + 1)}` : `${domain[0]}***`;
  return `${localMasked}@${domainMasked}`;
}

/**
 * Müşteri serbest-metnindeki (WP "Sorun Bildir" formu) olası sırları EN-İYİ-ÇABA redakte eder:
 * segment'li anahtar (XXXXX-XXXXX-…), uzun kesintisiz base32/hex/base64 token, e-posta ve
 * telefon. Triyaj yararı için metnin geri kalanı KORUNUR. Mükemmel DEĞİLDİR (best-effort) — amaç,
 * müşterinin yapıştırdığı lisans anahtarı/PII'nin harici modele düz-metin gitmesini AZALTMAK (§15).
 */
function scrubSecrets(reason: string): string {
  if (!reason) return reason;
  return reason
    // Segment'li anahtar: 3+ grup, tire ayraçlı, her grup 4+ alfasayısal (ör. XXXXX-XXXXX-XXXXX-XXXXX).
    .replace(/\b[A-Z0-9]{4,}(?:-[A-Z0-9]{4,}){2,}\b/gi, '[GIZLENDI]')
    // E-posta (sebep içine gömülü olabilir; bağlam e-postası ayrıca maskelenir).
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[GIZLENDI]')
    // Uzun kesintisiz alfasayısal dizi (16+): hex hash / base32 / base64 token / dashsız GUID.
    .replace(/\b[A-Z0-9]{16,}\b/gi, '[GIZLENDI]')
    // Telefon: uluslararası/yerel biçim (10+ karakter, ara ayraç toleranslı).
    .replace(/\+?\d[\d\s().-]{8,}\d/g, '[GIZLENDI]');
}

/**
 * AiSupportService — destek kuyruğundaki (replacement_requests) bir talebi AI ile
 * triyaj eder (§15 "AI önerir, insan onaylar"). MASKELİ bağlam kurar: müşterinin yazdığı sebep
 * (EN-İYİ-ÇABA sır-temizlemeden geçirilir) + durum + garanti bilgisi + tarih + MASKELİ e-posta
 * modele gider — ham e-posta ve lisans payload ASLA gönderilmez. Sonuç yalnız DÖNER; mail/DB yazımı YOK.
 */
@Injectable()
export class AiSupportService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly ai: AiService,
  ) {}

  /** Talebi getir (yoksa 404), maskeli bağlam kur, AI triyaj + taslak öner. */
  async suggest(id: string): Promise<SupportSuggestion> {
    const [row] = await this.db
      .select()
      .from(replacementRequests)
      .where(eq(replacementRequests.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Değişim talebi bulunamadı');

    // MASKELİ bağlam — ham e-posta maskelenir; müşteri serbest-metni (sebep) EN-İYİ-ÇABA
    // sır-temizlemeden geçer (yapıştırılmış anahtar/PII redakte); lisans payload GÖNDERİLMEZ (§15).
    const context = {
      musteri: maskEmail(row.customerEmail),
      sebep: scrubSecrets(row.reason),
      durum: row.status,
      garantiIcinde: row.withinWarranty,
      olusturulma: row.createdAt.toISOString(),
    };

    const system = [
      'Sen bir dijital lisans satış panelinin TÜRKÇE konuşan destek asistanısın.',
      'Sana MASKELENMİŞ bir müşteri değişim/garanti talebi verilir; e-posta maskelenmiştir ve',
      "müşterinin yazdığı 'sebep' metni en-iyi-çaba sır-temizlemeden geçmiştir (yine de artık bir",
      'anahtar/token görürsen cevabında ASLA tekrarlama). Görevin talebi sınıflandırmak ve',
      'müşteriye taslak cevap yazmaktır. YALNIZCA şu şemayla geçerli bir JSON döndür (başka metin yok):',
      '{"category": "...", "priority": "...", "draftReply": "..."}',
      'category şunlardan biri olmalı: garanti, calismyor, yanlis-urun, iade, diger.',
      'priority şunlardan biri olmalı: dusuk, orta, yuksek.',
      'draftReply müşteriye hitap eden kibar, net TÜRKÇE bir taslaktır; imza/kapanış ekleme.',
      'Kesin taahhüt (iade/değişim garantisi) verme; talebin incelendiğini nazikçe belirt.',
    ].join(' ');

    const user = [
      'Aşağıdaki maskeli talep bilgilerini değerlendir:',
      JSON.stringify(context, null, 2),
    ].join('\n');

    // AI kapalıysa AiService AiUnavailableException (503) fırlatır — UI yakalar.
    return this.ai.completeJson<SupportSuggestion>({ system, user });
  }
}
