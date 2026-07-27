'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, ApiError } from '../../lib/api';

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
  if (file.size > 5 * 1024 * 1024) {
    return { ok: false, message: 'Zip 5 MB sınırını aşıyor.' };
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
