'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, ApiError } from '../../lib/api';
// Yükleme tavanı TEK KAYNAKTAN gelir (./zip-limit): aynı sabit hem bu sunucu action'ının
// reddetme eşiği hem de publish-form.tsx'teki ipucu metnidir. Buradaki yerel kopyalar
// (MAX_ZIP_BYTES/MAX_ZIP_LABEL/formatBytes) kaldırıldı — iki yerde tutulunca sınır
// değiştiğinde forma yazılı metin geride kalıyor ve kullanıcıya yanlış vaat ediyordu.
// NOT: sabit buradan EXPORT EDİLEMEZ ('use server' modülü yalnız async fonksiyon export
// edebilir — bkz. commit 9b81c9b), bu yüzden nötr modülde durur.
import { MAX_ZIP_BYTES, MAX_ZIP_LABEL, formatBytes } from './zip-limit';

export interface PublishState {
  ok: boolean;
  message: string;
}

/**
 * Yeni eklenti sürümü yayınla (POST /v1/admin/updates/plugin). Yüklenen .zip sunucuda
 * base64'e çevrilip API'ye iletilir; ADMIN_TOKEN yalnız Next sunucusunda kalır. Aynı
 * sürüm varsa API upsert yapar. Zip kökü 'wpteslimat/' olmalı (WP doğru klasöre açsın).
 */
export async function publishRelease(_prev: PublishState, formData: FormData): Promise<PublishState> {
  const version = String(formData.get('version') ?? '').trim();
  const changelog = String(formData.get('changelog') ?? '').trim();
  const file = formData.get('zip');

  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
    return { ok: false, message: 'Sürüm SemVer olmalı (ör. 0.2.0).' };
  }
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, message: 'Bir .zip dosyası seçin.' };
  }
  if (!file.name.toLowerCase().endsWith('.zip')) {
    return { ok: false, message: 'Dosya .zip olmalı.' };
  }
  if (file.size > MAX_ZIP_BYTES) {
    return {
      ok: false,
      message:
        `Zip çok büyük: ${formatBytes(file.size)}. En çok ${MAX_ZIP_LABEL} yükleyebilirsiniz ` +
        `(paket API'ye base64 olarak iletildiği için gövde sınırı bu değere denk gelir). ` +
        `scripts/release-plugin.sh ile üretilen paketi kullanın; o zip ~100 KB'tır.`,
    };
  }

  const zipB64 = Buffer.from(await file.arrayBuffer()).toString('base64');
  try {
    await apiPost('/v1/admin/updates/plugin', {
      version,
      changelog: changelog || undefined,
      zipB64,
    });
  } catch (e) {
    return { ok: false, message: e instanceof ApiError ? e.message : 'Yayın başarısız' };
  }
  revalidatePath('/releases');
  return { ok: true, message: `v${version} yayınlandı — müşteri siteleri güncelleyebilir.` };
}
