import { defineConfig, devices } from '@playwright/test';

/**
 * Jetlisans admin duman testleri (§16 "e2e Playwright").
 *
 * Ayrık standalone paket — pnpm workspace glob'u (apps/*, packages/*) e2e/'yi kapsamaz,
 * bu yüzden kendi node_modules'ı vardır ve monorepo build'ine dahil değildir.
 * CI/manuel artifact olarak çalışır; hiçbir servise deploy edilmez.
 *
 * BASE_URL env'i ile hedef panel seçilir; verilmezse canlı VPS'e gider.
 */
const baseURL = process.env.BASE_URL ?? 'https://admin.167-233-108-12.sslip.io';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  retries: 1,
  reporter: 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
