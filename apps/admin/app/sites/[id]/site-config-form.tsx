'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { CheckCircle2, CircleCheck, CircleX, Plug, Save, TriangleAlert } from 'lucide-react';
import {
  testConnectionAction,
  updateSiteAction,
  type TestConnectionState,
  type UpdateSiteState,
} from '../actions';
import { Input, checkboxClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';
import { Field, FormSection, FieldRow } from '../../../components/ui/field';

const initial: UpdateSiteState = { ok: false };

/**
 * Mağaza sipariş bağlantısı ÖRNEK şablonları (yalnız yardım metni — hiçbir yere gönderilmez).
 * WooCommerce'te sipariş ekranının yolu mağazanın HPOS ayarına göre DEĞİŞİR; operatör hangi
 * biçimi kopyalayacağını görsün diye ikisi de gösterilir. JSX içinde satır bölünmesi/kaçış
 * karmaşası olmasın diye düz string sabit tutulur.
 */
const TEMPLATE_EXAMPLE_HPOS =
  'https://magaza.com/wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}';
const TEMPLATE_EXAMPLE_CLASSIC = 'https://magaza.com/wp-admin/post.php?post={orderId}&action=edit';

/** Yardım metnindeki örnek/yer tutucu kod parçaları — uzun URL taşmasın diye break-all. */
const codeClass = 'break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80';

/**
 * Site 'Yapılandırma' düzenleme formu (§5/§14): günlük satış kotası + sandbox + gönderen
 * e-posta. updateSiteAction → PATCH /v1/admin/sites/:id (audit'e düşer). Yalnız bu üç alan
 * düzenlenir; status (askıya al/aktifleştir) ayrı aksiyondadır. SIR gösterilmez.
 */
export function SiteConfigForm({
  siteId,
  salesDailyQuota,
  sandbox,
  senderEmail,
  webhookUrl,
  adminOrderUrlTemplate,
  adminOrderUrlTemplateManual,
  dynamicQuotaEnabled,
  reviewMultiplier,
}: {
  siteId: string;
  salesDailyQuota: number | null;
  sandbox: boolean;
  senderEmail: string | null;
  webhookUrl: string | null;
  /** Mağaza admin sipariş bağlantısı şablonu — SALT YÖNLENDİRME (otomatik bağlantı yok). */
  adminOrderUrlTemplate: string | null;
  /**
   * Şablonun KAYNAĞI (0026): true = operatör bu formdan ELLE girdi (mağazanın bildirdiği
   * değer yok sayılır). Opsiyonel — eski API sürümü alanı döndürmezse "mağaza bildirebilir"
   * kabul edilir (savunmacı varsayılan: false).
   */
  adminOrderUrlTemplateManual?: boolean;
  dynamicQuotaEnabled: boolean;
  reviewMultiplier: number;
}) {
  const [state, action, pending] = useActionState(updateSiteAction, initial);

  // Şablonun kaynağını operatöre DÜRÜSTÇE söyle: alan boşken bağlantı hiç görünmez, doluyken
  // değerin nereden geldiği (elle mi, mağazadan mı) davranışı belirler — elle girilen değeri
  // katalog senkronu ezmez, mağazadan gelen değeri sonraki senkron güncelleyebilir.
  const templateFilled = Boolean(adminOrderUrlTemplate?.trim());
  const templateManual = adminOrderUrlTemplateManual ?? false;
  const templateSourceNote = !templateFilled
    ? 'Şu an boş: sipariş ekranında "Mağaza panelinde aç" bağlantısı gösterilmiyor. Eklenti panele bağlıysa mağaza bildirdiğinde kendiliğinden dolar.'
    : templateManual
      ? 'Şu an elle girildi — mağazanın bildirdiği değer yok sayılıyor. Mağazadan yeniden öğrenilsin isterseniz alanı temizleyip kaydedin.'
      : 'Şu an mağazanın bildirdiği değer kullanılıyor. Bu formu kaydederseniz değer "elle girildi" sayılır ve mağaza bir daha üzerine yazamaz; mağazanın güncellemesini istiyorsanız alanı boşaltıp kaydedin.';

  // Bağlantı sağlık testi (onboarding): plain-arg action → useTransition + local state
  // (site-status-toggle deseniyle aynı). Sonuç check-check inline gösterilir; SIR yok.
  const [testing, startTest] = React.useTransition();
  const [test, setTest] = React.useState<TestConnectionState | null>(null);
  const runTest = () => {
    setTest(null);
    startTest(async () => {
      setTest(await testConnectionAction(siteId));
    });
  };

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-6">
        <input type="hidden" name="siteId" value={siteId} />

        {/*
          DÜRÜSTLÜK DÜZELTMELERİ (denetim bulguları):
          [7] Bu bölüm yalnız DİNAMİK kotayı anlatıyordu ("reddedilmez"). SERT tavanın
              (salesDailyQuota) sonucu hiçbir kullanıcı metninde yazmıyordu: aşımda
              orders.service.ts:375 `SalesQuotaExceededException` → ÖDENMİŞ sipariş 429 ile
              REDDEDİLİR (tx rollback, sipariş satırı oluşmaz). İki kotanın zıt davranışı
              artık yan yana yazılı.
          [a] "(taban 20)" evrensel bir taban ima ediyordu. GERÇEK (orders.service.ts:1199-1202):
              DYNAMIC_MIN_FLOOR=20 YALNIZ son 30 günde 20'den az meşru siparişi olan siteye
              uygulanır; yeterli geçmişi olan sitede eşik ceil(ortalama × çarpan) olur ve 1'e
              kadar düşebilir.
          [b] "teslim edilebilecek en fazla sipariş" YANLIŞ kelimeydi: todayCount
              (orders.service.ts:1166-1170) bugün OLUŞTURULMUŞ TÜM siparişleri sayar — statü
              süzgeci YOK (eşlenmemiş/incelemedeki/iade edilmiş dahil). Yani hiç teslimat
              yapılmadan kota dolabilir.
        */}
        <FormSection
          title="Satış kotası"
          description="İki ayrı mekanizma: sert tavan siparişi REDDEDER, dinamik eşik yalnız İncelemeye alır."
        >
          <FieldRow>
            <Field
              label="Günlük satış kotası (sert tavan)"
              htmlFor="sc-quota"
              hint="Bir günde bu siteden KABUL EDİLECEK en fazla sipariş. Boş = limitsiz. Aşıldığında sipariş incelemeye alınmaz, doğrudan REDDEDİLİR (mağaza 429 alır) — müşteri ödemiş olsa bile panele hiç kaydedilmez, gün sonunda sıfırlanır. Sayaç o gün oluşturulan TÜM siparişleri sayar (eşlenmemiş, incelemedeki ve iade edilenler dahil), yalnız teslim edilenleri değil."
            >
              <Input
                id="sc-quota"
                name="salesDailyQuota"
                type="number"
                min={1}
                step={1}
                defaultValue={salesDailyQuota ?? ''}
                placeholder="limitsiz"
                className="w-full"
              />
            </Field>
            <Field
              label="İnceleme eşiği çarpanı"
              htmlFor="sc-review-multiplier"
              hint="Dinamik kota: son 30 günün günlük ortalamasının kaç katına kadar otomatik teslim edilsin (üstü incelemeye alınır). Ortalama yalnız teslim edilmiş, incelemeye alınmamış geçmiş siparişlerden hesaplanır."
            >
              <Input
                id="sc-review-multiplier"
                name="reviewMultiplier"
                type="number"
                min={1}
                step={1}
                defaultValue={reviewMultiplier}
                className="w-full"
              />
            </Field>
          </FieldRow>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="sc-dynamic-quota"
              className="flex items-center gap-2 text-sm font-medium text-foreground"
            >
              <input
                id="sc-dynamic-quota"
                name="dynamicQuotaEnabled"
                type="checkbox"
                defaultChecked={dynamicQuotaEnabled}
                className={checkboxClass}
              />
              Dinamik satış kotası
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Açıkken sert tavana <em>ek olarak</em> 30 günlük ortalamaya göre bir eşik daha
              uygulanır: <strong>eşik aşılırsa sipariş reddedilmez</strong>, kabul edilip{' '}
              <strong>İnceleme Kuyruğu</strong>na alınır (siz onaylayana kadar teslimat yapılmaz).
              Eşik = ortalama günlük satış × yukarıdaki çarpan. <strong>20&apos;lik taban yalnız
              yeni/az geçmişli sitelerde</strong> geçerlidir (son 30 günde 20&apos;den az teslim
              edilmiş sipariş); yeterli geçmiş biriktiğinde eşik tamamen ortalamaya göre hesaplanır
              ve 1&apos;e kadar inebilir.
            </p>
          </div>
        </FormSection>

        <FormSection
          title="Entegrasyon"
          description="Teslimat e-postası ve mağaza entegrasyonuna geri bildirim ayarları."
        >
          <FieldRow>
            {/*
              ÖLÜ ALAN — metin gerçeği söylemeli (denetim bulgusu). `senderEmail` kaydediliyor
              ama HİÇBİR mail yolunda okunmuyor: gönderen HER ZAMAN `MAIL_FROM`'dur
              (mail.service `createMailTransport` + mail.processor). "Teslimat maillerinde
              görünen gönderen" demek, operatörün buraya adres yazıp gönderenin değiştiğini
              SANMASINA yol açıyordu. Aynı düzeltme site-oluşturma sihirbazında da yapıldı.
            */}
            <Field
              label="Gönderen e-posta"
              htmlFor="sc-sender"
              hint="Kayda geçer ancak ŞU AN mail gönderimini etkilemez — gönderen adresi sunucu ayarındaki MAIL_FROM'dur."
            >
              <Input
                id="sc-sender"
                name="senderEmail"
                type="email"
                defaultValue={senderEmail ?? ''}
                placeholder="varsayılan gönderen"
                className="w-full"
              />
            </Field>
            <Field
              label="Geri kanal webhook URL"
              htmlFor="sc-webhook"
              hint="Panel sipariş durumunu bu adrese bildirir (mağaza eklentisi / entegrasyonu)."
            >
              <Input
                id="sc-webhook"
                name="webhookUrl"
                type="url"
                defaultValue={webhookUrl ?? ''}
                placeholder="webhook devre dışı"
                className="w-full"
              />
            </Field>
          </FieldRow>
          <Field
            label="Mağaza sipariş bağlantısı (şablon)"
            htmlFor="sc-order-url"
            hint={
              <>
                Sipariş ekranındaki <strong>“Mağaza panelinde aç”</strong> bağlantısını üretir.{' '}
                <strong>Boş bırakılırsa bağlantı hiç gösterilmez</strong> — panel doğru adresi
                tahmin etmez; siparişin mağaza yönetimindeki yolunu yalnız mağazanın kendisi
                bilir (HPOS açık/kapalı, alt dizine kurulum, özel yönetim yolu). Eklenti panele
                bağlıysa alan mağazanın bildirdiği değerle kendiliğinden dolar; elle girerseniz
                mağazanın bildirdiği değer yok sayılır. Panel bu adrese <strong>bağlanmaz</strong>,
                veri çekmez — yalnız yeni sekmede açar. <code className={codeClass}>
                  {'{orderId}'}
                </code>{' '}
                yer tutucusu zorunludur.
                <span className="mt-1.5 block">
                  Örnek (HPOS): <code className={codeClass}>{TEMPLATE_EXAMPLE_HPOS}</code>
                  <br />
                  Örnek (klasik): <code className={codeClass}>{TEMPLATE_EXAMPLE_CLASSIC}</code>
                </span>
                <span className="mt-1.5 block text-foreground/80">{templateSourceNote}</span>
              </>
            }
          >
            <Input
              id="sc-order-url"
              name="adminOrderUrlTemplate"
              type="url"
              defaultValue={adminOrderUrlTemplate ?? ''}
              placeholder="https://magazam.com/wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}"
              className="w-full"
            />
          </Field>
        </FormSection>

        {/*
          DÜRÜSTLÜK DÜZELTMESİ (denetim bulgusu): burada "sandbox açıkken siparişler GERÇEK
          TESLİMAT ÜRETMEZ" yazıyordu — YANLIŞ ve tehlikeliydi. `sandbox` alanı API'de YALNIZ
          mail yolunda okunur (mail.service.ts / mail.processor.ts: alıcıyı gönderen adrese
          çevirir + konuya '[TEST MODU]' ekler). `orders.service.ts` sandbox'a HİÇ bakmaz →
          sipariş oluşturma, atama, stok tüketimi ve getDeliveries aynen çalışır. Operatör
          canlı siteyi "test moduna alıp" deneme siparişi geçerse GERÇEK stok yanar ve müşteri
          çalışan anahtarı mağazasının sipariş ekranında görür. Metin artık ne yaptığını değil
          NE YAPMADIĞINI da söylüyor (15 satır aşağıdaki açıklama zaten doğruydu).
        */}
        <FormSection
          title="Test modu"
          description="Sandbox YALNIZ teslimat e-postalarını yönlendirir; siparişin kendisi normal işlenir."
        >
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="sc-sandbox"
              className="flex items-center gap-2 text-sm font-medium text-foreground"
            >
              <input
                id="sc-sandbox"
                name="sandbox"
                type="checkbox"
                defaultChecked={sandbox}
                className={checkboxClass}
              />
              Sandbox (test modu)
            </label>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Açıkken teslimat mailleri gerçek müşteriye gitmez: alıcı panelin gönderen adresine
              çevrilir ve konuya <strong>[TEST MODU]</strong> öneki eklenir.
            </p>
            <p className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-xs leading-relaxed text-warning">
              <strong>Dikkat — siparişi durdurmaz.</strong> Sandbox açıkken de sipariş normal
              işlenir: <strong>gerçek stok tüketilir</strong>, <strong>gerçek lisans atanır</strong>{' '}
              ve müşteri o lisansı mağazanın &quot;Siparişlerim&quot; ekranında{' '}
              <strong>çözülmüş hâlde görebilir</strong>. Yalnız mail yolu test edilir. Canlı bir
              mağazada deneme siparişi geçmek için güvenli <strong>değildir</strong>; bunun için
              ayrı bir test sitesi kullanın.
            </p>
          </div>
        </FormSection>

        <Button type="submit" disabled={pending}>
          <Save /> {pending ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
      </form>

      {state.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Kaydedilemedi</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </div>
        </Alert>
      )}

      {state.ok && state.saved && (
        <Alert variant="success">
          <CheckCircle2 />
          <div className="min-w-0 flex-1">
            <AlertTitle>Yapılandırma kaydedildi</AlertTitle>
          </div>
        </Alert>
      )}

      {/* Bağlantı sağlık testi (onboarding): site kaydı + durum + HMAC secret + (varsa)
          webhook erişilebilirliği. Sonuç check-check yeşil/kırmızı satır olarak inline. */}
      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={runTest} disabled={testing}>
            <Plug />
            {testing ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Site kaydı, HMAC secret ve (varsa) webhook erişilebilirliğini doğrular.
          </p>
        </div>

        {test?.error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert className="size-4" /> {test.error}
          </p>
        )}

        {test?.tested && test.checks && (
          <div className="mt-3 space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              {test.healthy ? 'Bağlantı sağlıklı' : 'Bağlantıda sorun var'}
            </p>
            <ul className="space-y-1">
              {test.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  {c.ok ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{c.name}</span>
                    <span className="text-muted-foreground"> — {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
