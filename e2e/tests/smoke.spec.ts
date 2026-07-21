import { test, expect, type Page } from '@playwright/test';

/**
 * Admin paneli duman testleri.
 *
 * Auth durumuna göre iki mod:
 *  - Auth KAPALI (SESSION_SECRET yok): rotalar doğrudan açılır, testler koşar.
 *  - Auth AÇIK: korumalı rota /login'e düşer. E2E_USER/E2E_PASS verilmişse giriş
 *    yapılır ve test devam eder; verilmemişse test graceful şekilde SKIP edilir
 *    (kırılgan/false-negative olmasın).
 *
 * Assertion'lar kırılgan seçicilerden kaçınır — görünür Türkçe metinle doğrular.
 */

const E2E_USER = process.env.E2E_USER;
const E2E_PASS = process.env.E2E_PASS;

/**
 * Hedef yola gider. Auth açıksa ve /login'e düşülürse:
 *  - kimlik bilgisi varsa giriş yapıp hedefe döner → 'ok',
 *  - yoksa → 'needs-auth' (çağıran test skip eder).
 * Auth kapalıysa doğrudan hedefe ulaşılır → 'ok'.
 */
async function gotoAuthed(page: Page, path: string): Promise<'ok' | 'needs-auth'> {
  await page.goto(path);

  if (!page.url().includes('/login')) return 'ok';

  // /login'e düştük → auth açık. Kimlik yoksa test atlanır.
  if (!E2E_USER || !E2E_PASS) return 'needs-auth';

  await page.locator('#identifier').fill(E2E_USER);
  await page.locator('#password').fill(E2E_PASS);
  await page.getByRole('button', { name: 'Giriş Yap' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'));
  return 'ok';
}

test('kök yol (/) → /pending yönlendirir', async ({ page }) => {
  const state = await gotoAuthed(page, '/');
  test.skip(state === 'needs-auth', 'Auth açık ama E2E_USER/E2E_PASS verilmedi');
  await expect(page).toHaveURL(/\/pending/);
});

test('/orders — "Siparişler" başlığı görünür', async ({ page }) => {
  const state = await gotoAuthed(page, '/orders');
  test.skip(state === 'needs-auth', 'Auth açık ama E2E_USER/E2E_PASS verilmedi');
  await expect(page.getByRole('heading', { name: 'Siparişler', level: 1 })).toBeVisible();
});

test('/pending — kabuk (sidebar) yüklenir', async ({ page }) => {
  const state = await gotoAuthed(page, '/pending');
  test.skip(state === 'needs-auth', 'Auth açık ama E2E_USER/E2E_PASS verilmedi');
  // Sayfa başlığı + kabuk marka metni ("Lisans Paneli" yalnız sidebar/kabukta render olur).
  await expect(page.getByRole('heading', { name: 'Bekleyen Teslimatlar', level: 1 })).toBeVisible();
  await expect(page.getByText('Lisans Paneli').first()).toBeVisible();
});
