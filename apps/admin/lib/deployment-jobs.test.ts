import { describe, expect, it } from 'vitest';
import { DEPLOYMENTS_WINDOW, pickJobsByTarget } from './deployment-jobs';

/**
 * `/releases` YAYIN İŞLERİ PENCERESİ — DAVRANIŞ KİLİDİ.
 *
 * Dağıtım, eklenti yayını ve yedek işleri AYNI kuyrukta durur; uç `target` süzgeci almaz
 * ve sabit 50 satır döndürür. Gecelik yedek cron'u her gün satır yazdığı için pencere
 * zamanla tamamen `backup` kayıtlarıyla dolar → ekran, gerçekten yapılmış yayınlar
 * dururken "Henüz yayın işi yok" derdi. Buradaki asıl güvence şu: liste boş dönebilir
 * AMA bunun "hiç yayın yok" mu yoksa "pencere doldu" mu olduğunu bayrak ayırt eder.
 */
const row = (target: string, id: string) => ({ id, target });

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
