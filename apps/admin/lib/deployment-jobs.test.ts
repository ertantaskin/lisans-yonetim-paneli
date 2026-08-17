import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS_WINDOW, pickJobsByTarget, targetQuery } from './deployment-jobs';

/**
 * `/releases` YAYIN İŞLERİ PENCERESİ — DAVRANIŞ KİLİDİ.
 *
 * Dağıtım, eklenti yayını ve yedek işleri AYNI kuyrukta durur. Süzgeç ARTIK SUNUCUDA
 * (`?target=plugin`), ama bu istemci yardımcısı savunma-derinliği olarak KALDI: eski bir
 * API imajına denk gelen admin dağıtımı yanlış hedefi göstermesin. Asıl güvence değişmedi:
 * liste boş dönebilir AMA bunun "hiç yayın yok" mu yoksa "pencere doldu" mu olduğunu
 * bayrak ayırt eder — sessiz kırpma yok.
 */
const row = (target: string, id: string) => ({ id, target });

/**
 * SORGU ÜRETİMİ — sunucu-taraflı süzgecin GERÇEKTEN istendiğini kilitler. Parametre
 * düşerse (ör. biri URL'i elle birleştirirken) hata sessizdir: ekran yine dolu görünür,
 * yalnız eski pencere-dolması arızası geri gelir. Bu yüzden dize düzeyinde doğrulanır.
 */
describe('targetQuery', () => {
  it('tek hedef + limit üretir', () => {
    expect(targetQuery(['plugin'], 20)).toBe('?target=plugin&limit=20');
  });

  it('çoklu hedefi virgülle birleştirir', () => {
    expect(targetQuery(['api', 'admin'])).toBe('?target=api%2Cadmin');
  });

  it('boşluklu hedefi (api admin) kodlar — ham birleştirme bozuk URL üretirdi', () => {
    expect(targetQuery(['api admin'])).toBe('?target=api+admin');
  });

  it('hedef yoksa ve limit yoksa BOŞ dize döner (uç eski davranışına düşer)', () => {
    expect(targetQuery([])).toBe('');
  });

  it('yalnız limit verilebilir (hedef süzgeci olmadan pencere büyütme)', () => {
    expect(targetQuery([], 150)).toBe('?limit=150');
  });
});

describe('pickJobsByTarget', () => {
  it('yalnız istenen hedefi döndürür ve `take` kadar kırpar', () => {
    const rows = [
      row('plugin', 'p1'),
      row('backup', 'b1'),
      row('plugin', 'p2'),
      row('api admin', 'd1'),
      row('plugin', 'p3'),
    ];
    const res = pickJobsByTarget(rows, 'plugin', 2);
    expect(res.jobs.map((r) => r.id)).toEqual(['p1', 'p2']);
    // Kaynak sıra API'den gelir (created_at desc) → burada YENİDEN sıralanmaz.
    expect(res.windowSaturated).toBe(false);
  });

  it('pencere dolmadıysa boş sonuç GERÇEKTEN "hiç yayın yok" demektir', () => {
    const res = pickJobsByTarget([row('backup', 'b1')], 'plugin', 5);
    expect(res.jobs).toEqual([]);
    expect(res.windowSaturated).toBe(false);
  });

  it('pencere dolduysa boş sonuç "yayın yok" DEĞİL, "kırpıldı" demektir', () => {
    // Asıl arıza senaryosu: 50 satırın tamamı gecelik yedek → tek bir plugin satırı yok.
    const rows = Array.from({ length: DEPLOYMENTS_WINDOW }, (_, i) => row('backup', `b${i}`));
    const res = pickJobsByTarget(rows, 'plugin', 5);
    expect(res.jobs).toEqual([]);
    expect(res.windowSaturated).toBe(true);
  });

  it('pencere dolu ama sonuç varken de kırpma bayrağı kalkar (liste EKSİK olabilir)', () => {
    const rows = [
      row('plugin', 'p1'),
      ...Array.from({ length: DEPLOYMENTS_WINDOW - 1 }, (_, i) => row('backup', `b${i}`)),
    ];
    const res = pickJobsByTarget(rows, 'plugin', 5);
    expect(res.jobs.map((r) => r.id)).toEqual(['p1']);
    expect(res.windowSaturated).toBe(true);
  });

  it('dizi olmayan gövdede (sürüm sapması) çökmez', () => {
    const res = pickJobsByTarget(undefined as unknown as Array<{ target: string }>, 'plugin', 5);
    expect(res.jobs).toEqual([]);
    expect(res.windowSaturated).toBe(false);
  });
});
