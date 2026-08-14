import { Logger } from '@nestjs/common';
import type { JobSchedulerTemplateOptions, Queue, RepeatOptions } from 'bullmq';

/**
 * "BU KUYRUKTA TAM OLARAK BİR ZAMANLAYICI VAR" — upsert + YETİM TEMİZLİĞİ.
 *
 * NEDEN VAR (canlıda ÖLÇÜLDÜ, statik analizle görünmez): süpürme işleri bir dönem
 * `queue.add(name, data, { repeat })` ile kuruluyordu; BullMQ bunları repeat ZSET'ine
 * içerikten türetilmiş bir HASH anahtarıyla yazar. Sonradan kararlı kimlikli
 * `upsertJobScheduler`'a geçildi — ama eski hash anahtarlı kayıtlar Redis'te KALDI ve
 * Redis dağıtımlar arasında kalıcı olduğu için silinmediler. Sonuç: prod'da dört kuyruğun
 * (`expiry`, `low-stock`, `reconcile`, `daily-digest`) İKİŞER aktif zamanlayıcısı vardı →
 * her süpürme iki kat sık koşuyor, **günlük özet aynı dakikada İKİ KEZ** gönderiliyordu
 * (çift Telegram alarmı + çift bildirim satırı). Kod "yetim schedule kalmaz" diyordu;
 * bu YALNIZ ileride yapılacak değişiklikler için doğruydu, geçmişten kalanlar için değil.
 *
 * Bu yardımcı sözleşmeyi çalışma anında ZORLAR: upsert'ten sonra kuyruktaki DİĞER tüm
 * zamanlayıcıları siler. Bu kuyruklarda tasarım gereği tek bir tekrarlı iş vardır, dolayısıyla
 * "beklenen kimlik dışındaki her şey yetimdir" güvenli bir kuraldır. Boot'ta koştuğu için
 * kendi kendini onarır: ileride bir schedulerId yeniden adlandırılsa bile eskisi temizlenir.
 *
 * Temizlik BEST-EFFORT: silme hatası boot'u DÜŞÜRMEZ (yetim zamanlayıcı, çalışmayan bir
 * API'den iyidir) ama `warn` ile GÖRÜNÜR loglanır — sessiz kalırsa aynı sınıf hata yine
 * fark edilmeden yaşar.
 */
export async function upsertSoleJobScheduler(
  queue: Queue,
  schedulerId: string,
  repeat: Omit<RepeatOptions, 'key'>,
  template: { name: string; data?: unknown; opts?: JobSchedulerTemplateOptions },
  logger: Logger,
): Promise<void> {
  await queue.upsertJobScheduler(schedulerId, repeat, {
    name: template.name,
    data: template.data,
    opts: template.opts,
  });

  try {
    // 0..999: bu kuyruklarda beklenen zamanlayıcı sayısı 1'dir; yüksek tavan yalnız
    // "kaç tane birikmiş" sorusunun cevabını kaçırmamak için.
    const schedulers = await queue.getJobSchedulers(0, 999);
    for (const s of schedulers) {
      const key = s?.key;
      if (!key || key === schedulerId) continue;
      await queue.removeJobScheduler(key);
      logger.warn(
        `Yetim tekrarlı zamanlayıcı silindi: kuyruk=${queue.name} key=${key} ` +
          `(beklenen tek kimlik: ${schedulerId}). Eski queue.add(repeat) kaydından kalmış olabilir.`,
      );
    }
  } catch (err) {
    logger.warn(`Yetim zamanlayıcı temizliği başarısız (kuyruk=${queue.name}): ${String(err)}`);
  }
}
