import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';

/** Anthropic Messages API sürüm başlığı. */
const ANTHROPIC_VERSION = '2023-06-01';
/** Varsayılan model — en yetenekli (öneri/rapor kalitesi). AI_MODEL ile geçersiz kılınır. */
const DEFAULT_MODEL = 'claude-opus-4-8';
/** AI çağrısı zaman aşımı — asılı kalması sistemi bekletmesin (best-effort). */
const AI_TIMEOUT_MS = 60_000;

/**
 * AI kapalıyken (env-gated) atılır → uç 503 döner. Çağıran katman bunu YAKALAYIP
 * AI'sız akışa düşebilir (§15 "AI çökerse sistem AI'sız çalışır").
 */
export class AiUnavailableException extends HttpException {
  constructor(msg = 'AI özelliği kapalı (AI_ENABLED=true + ANTHROPIC_API_KEY gerekli).') {
    super(msg, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

/**
 * AiService — AI-destekli operasyon çekirdeği (§15). Anthropic Messages API'ye HAM fetch
 * ile bağlanır (SDK bağımlılığı YOK → Docker frozen-lockfile derlemesi güvenli). Env-gated,
 * VARSAYILAN KAPALI: AI_ENABLED=true VE ANTHROPIC_API_KEY set değilse tüm çağrılar 503.
 *
 * İlke (§15): "AI önerir, insan onaylar" — bu servis yalnız METİN üretir; hiçbir eylem
 * (mail gönderimi, DB yazımı) yapmaz. Payload'lar çağıran katmanda MASKELENİP gönderilir.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);

  /** AI aktif mi: AI_ENABLED=true VE ANTHROPIC_API_KEY dolu. Varsayılan KAPALI. */
  enabled(): boolean {
    return process.env.AI_ENABLED === 'true' && !!process.env.ANTHROPIC_API_KEY;
  }

  /** Kullanılacak model (AI_MODEL veya varsayılan). */
  model(): string {
    const m = process.env.AI_MODEL?.trim();
    return m && m.length > 0 ? m : DEFAULT_MODEL;
  }

  /**
   * Messages API'ye tek-tur çağrı. `system` rol talimatı, `user` (MASKELİ) içerik.
   * AI kapalıysa AiUnavailableException; hata/refusal'da fırlatır (çağıran yakalar).
   * `adaptive` true ise adaptive thinking açılır (karmaşık akıl yürütme için).
   */
  async complete(input: {
    system: string;
    user: string;
    maxTokens?: number;
    adaptive?: boolean;
  }): Promise<string> {
    if (!this.enabled()) throw new AiUnavailableException();
    const apiKey = process.env.ANTHROPIC_API_KEY!;
    const base = (process.env.AI_BASE_URL?.replace(/\/+$/, '') || 'https://api.anthropic.com').trim();

    const body: Record<string, unknown> = {
      model: this.model(),
      max_tokens: input.maxTokens ?? 2048,
      system: input.system,
      messages: [{ role: 'user', content: input.user }],
    };
    if (input.adaptive) body.thinking = { type: 'adaptive' };

    let res: Response;
    try {
      res = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
    } catch (err) {
      this.logger.warn(`AI erişilemedi: ${(err as Error).message}`);
      throw new HttpException(`AI erişilemedi: ${(err as Error).message}`, HttpStatus.BAD_GATEWAY);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new HttpException(`AI hata ${res.status}: ${text.slice(0, 300)}`, HttpStatus.BAD_GATEWAY);
    }

    const data = (await res.json()) as {
      stop_reason?: string;
      content?: Array<{ type: string; text?: string }>;
    };
    // Güvenlik sınıflandırıcı reddi (§ refusal) — sistem AI'sız devam etsin diye fırlat.
    if (data.stop_reason === 'refusal') {
      throw new HttpException('AI isteği reddetti (refusal).', HttpStatus.UNPROCESSABLE_ENTITY);
    }
    const text = (data.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
      .trim();
    if (!text) throw new HttpException('AI boş yanıt döndürdü.', HttpStatus.BAD_GATEWAY);
    return text;
  }

  /**
   * `complete` + JSON ayrıştırma. Modelin ```json çiti / açıklama sarması soyulur;
   * ilk `{`/`[` ile son `}`/`]` arası ayrıştırılır. Geçersizse 502.
   */
  async completeJson<T>(input: { system: string; user: string; maxTokens?: number }): Promise<T> {
    const raw = await this.complete(input);
    const cleaned = raw
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/, '')
      .trim();
    const firstObj = cleaned.indexOf('{');
    const firstArr = cleaned.indexOf('[');
    const start =
      firstObj === -1 ? firstArr : firstArr === -1 ? firstObj : Math.min(firstObj, firstArr);
    const end = Math.max(cleaned.lastIndexOf('}'), cleaned.lastIndexOf(']'));
    const jsonStr = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    try {
      return JSON.parse(jsonStr) as T;
    } catch {
      throw new HttpException('AI geçersiz JSON döndürdü.', HttpStatus.BAD_GATEWAY);
    }
  }
}
