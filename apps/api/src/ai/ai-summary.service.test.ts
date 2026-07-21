import { afterEach, describe, expect, it } from 'vitest';
import { AiService } from './ai.service';
import { AiSummaryService } from './ai-summary.service';
import type { Database } from '../db/db.module';

/**
 * AiSummaryService env-gate BİRİM testi (§15 "AI çökerse/kapalıysa sistem AI'sız çalışır").
 *
 * PG GEREKMEZ (mask.test.ts / ai-support.service.test.ts deseni): db ve AiService sahte
 * verilir. Doğrulanan sözleşme: metrikler HER ZAMAN döner; AI KAPALIYKEN dailySummary
 * 503 ATMAZ, paragraph=null + metrikleri teslim eder; AI açık ama çağrı patlarsa yine
 * GRACEFUL (paragraph=null, metrikler var). Ayrıca AiService.enabled() env'e göre çalışır.
 */

/** collectMetrics'in okuduğu tek satırı (snake_case kolonlar) taklit eden sahte metrik. */
const METRIC_ROW = {
  today_orders: 3,
  open_replacements: 1,
  security_events_24h: 2,
  failed_outbox: 4,
  available_stock: 7,
};

/** db.execute yalnız [row] döndürür — collectMetrics rows[0]'ı okur. Gerçek PG YOK. */
function fakeDb(): Database {
  return { execute: async () => [METRIC_ROW] } as unknown as Database;
}

/** enabled()/complete() davranışını testte kontrol eden sahte AiService (+ çağrı sayacı). */
function fakeAi(opts: { enabled: boolean; complete?: () => Promise<string> }): {
  ai: AiService;
  state: { completeCalls: number };
} {
  const state = { completeCalls: 0 };
  const ai = {
    enabled: () => opts.enabled,
    complete: async () => {
      state.completeCalls += 1;
      if (!opts.complete) throw new Error('complete stub tanımlı değil');
      return opts.complete();
    },
  } as unknown as AiService;
  return { ai, state };
}

/** dailySummary'nin her zaman döndürmesi gereken metrik projeksiyonu (camelCase). */
const EXPECTED_METRICS = {
  todayOrders: 3,
  openReplacements: 1,
  securityEvents24h: 2,
  failedOutbox: 4,
  availableStock: 7,
};

describe('AiSummaryService.dailySummary — AI env-gate (graceful)', () => {
  it('AI KAPALI → 503 ATMAZ; paragraph=null + metrikler döner; complete ÇAĞRILMAZ', async () => {
    const { ai, state } = fakeAi({ enabled: false });
    const service = new AiSummaryService(fakeDb(), ai);

    const result = await service.dailySummary();

    expect(result.aiEnabled).toBe(false);
    expect(result.paragraph).toBeNull();
    expect(result.metrics).toEqual(EXPECTED_METRICS);
    // AI kapalıyken model hiç çağrılmamalı (boşuna maliyet/istek yok).
    expect(state.completeCalls).toBe(0);
  });

  it('AI AÇIK ama complete PATLAR → graceful: paragraph=null, metrikler yine döner', async () => {
    const { ai, state } = fakeAi({
      enabled: true,
      complete: () => Promise.reject(new Error('AI erişilemedi')),
    });
    const service = new AiSummaryService(fakeDb(), ai);

    // Hata YUTULUR — dailySummary reject etmemeli.
    const result = await service.dailySummary();

    expect(result.aiEnabled).toBe(true);
    expect(result.paragraph).toBeNull();
    expect(result.metrics).toEqual(EXPECTED_METRICS);
    expect(state.completeCalls).toBe(1);
  });

  it('AI AÇIK ve complete METİN döner → paragraph doldurulur', async () => {
    const { ai, state } = fakeAi({
      enabled: true,
      complete: () => Promise.resolve('Her şey normal görünüyor.'),
    });
    const service = new AiSummaryService(fakeDb(), ai);

    const result = await service.dailySummary();

    expect(result.aiEnabled).toBe(true);
    expect(result.paragraph).toBe('Her şey normal görünüyor.');
    expect(result.metrics).toEqual(EXPECTED_METRICS);
    expect(state.completeCalls).toBe(1);
  });
});

describe('AiService.enabled() — env-gate (varsayılan KAPALI)', () => {
  const KEYS = ['AI_ENABLED', 'ANTHROPIC_API_KEY'] as const;
  const saved: Record<string, string | undefined> = {};
  for (const k of KEYS) saved[k] = process.env[k];

  afterEach(() => {
    // Env'i her testten sonra eski haline getir (başka testlere sızmasın).
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('AI_ENABLED yok → false (güvenli varsayılan)', () => {
    delete process.env.AI_ENABLED;
    delete process.env.ANTHROPIC_API_KEY;
    expect(new AiService().enabled()).toBe(false);
  });

  it("AI_ENABLED='true' ama ANTHROPIC_API_KEY yok → false", () => {
    process.env.AI_ENABLED = 'true';
    delete process.env.ANTHROPIC_API_KEY;
    expect(new AiService().enabled()).toBe(false);
  });

  it("AI_ENABLED='true' + ANTHROPIC_API_KEY dolu → true", () => {
    process.env.AI_ENABLED = 'true';
    process.env.ANTHROPIC_API_KEY = 'sk-test-anahtar';
    expect(new AiService().enabled()).toBe(true);
  });

  it("AI_ENABLED='1' (yalnız 'true' kabul) → false", () => {
    process.env.AI_ENABLED = '1';
    process.env.ANTHROPIC_API_KEY = 'sk-test-anahtar';
    expect(new AiService().enabled()).toBe(false);
  });
});
