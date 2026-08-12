import { describe, expect, it, vi } from 'vitest';
import { MailConfigGuardService, isDevMailSink } from './mail-config.guard';

/**
 * SESSİZ MAİL ARIZASI guard'ı (denetim bulgusu): üretimde SMTP hedefi bir dev yakalayıcıysa
 * (mailpit/localhost) mailler müşteriye ULAŞMAZ ama her kayıt 'gönderildi' görünür. Guard bunu
 * açılışta GÜRÜLTÜLÜ hâle getirir — ama sistemi KIRMAZ (fail-closed değil, alarm).
 */

function makeConfig(values: Record<string, string | undefined>) {
  return { get: (k: string) => values[k] } as never;
}
function makeNotifications() {
  return { create: vi.fn().mockResolvedValue({}) } as never;
}

describe('isDevMailSink', () => {
  it('dev yakalayıcıları tanır (büyük/küçük harf + boşluk duyarsız)', () => {
    for (const h of ['mailpit', 'MailPit', ' mailpit ', 'localhost', '127.0.0.1', '::1', 'mailhog']) {
      expect(isDevMailSink(h)).toBe(true);
    }
  });

  it('gerçek relay adreslerini dev sink SAYMAZ', () => {
    for (const h of ['smtp.gmail.com', 'email-smtp.eu-central-1.amazonaws.com', 'mail.example.com']) {
      expect(isDevMailSink(h)).toBe(false);
    }
  });

  it('tanımsız/boş host dev sink DEĞİLDİR (yanlış alarm üretme)', () => {
    // Boş host zaten getOrThrow ile boot'ta patlar; guard burada yanlış-pozitif üretmemeli.
    expect(isDevMailSink(undefined)).toBe(false);
    expect(isDevMailSink('')).toBe(false);
  });
});

describe('MailConfigGuardService.onModuleInit', () => {
  it('ÜRETİMDE dev yakalayıcı → kritik bildirim üretir', async () => {
    const notifications = makeNotifications();
    const svc = new MailConfigGuardService(
      makeConfig({ NODE_ENV: 'production', SMTP_HOST: 'mailpit' }),
      notifications,
    );
    await svc.onModuleInit();
    const create = (notifications as unknown as { create: ReturnType<typeof vi.fn> }).create;
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]![0]).toMatchObject({ type: 'mail_config', severity: 'critical' });
  });

  it('ÜRETİMDE gerçek relay → sessiz (bildirim YOK)', async () => {
    const notifications = makeNotifications();
    const svc = new MailConfigGuardService(
      makeConfig({ NODE_ENV: 'production', SMTP_HOST: 'smtp.sendgrid.net' }),
      notifications,
    );
    await svc.onModuleInit();
    expect((notifications as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('DEV ortamında mailpit normaldir → uyarı YOK (gürültü yapma)', async () => {
    const notifications = makeNotifications();
    const svc = new MailConfigGuardService(
      makeConfig({ NODE_ENV: 'development', SMTP_HOST: 'mailpit' }),
      notifications,
    );
    await svc.onModuleInit();
    expect((notifications as unknown as { create: ReturnType<typeof vi.fn> }).create).not.toHaveBeenCalled();
  });

  it('bildirim yazımı patlarsa boot DEVAM eder (alarm, kapı değil)', async () => {
    const notifications = { create: vi.fn().mockRejectedValue(new Error('db down')) } as never;
    const svc = new MailConfigGuardService(
      makeConfig({ NODE_ENV: 'production', SMTP_HOST: 'mailpit' }),
      notifications,
    );
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });
});
