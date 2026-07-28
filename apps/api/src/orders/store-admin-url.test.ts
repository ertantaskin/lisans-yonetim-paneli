import { describe, expect, it } from 'vitest';
import { buildStoreAdminUrl } from './store-admin-url';

/**
 * Mağaza admin sipariş linki (§17) — SALT LİNK üretimi.
 *
 * KONUM NOTU (denetim F5): bu dosya eskiden `apps/api/test/store-admin-url.test.ts` altındaydı
 * ve vitest config'inin include deseni (`src/**\/*.test.ts`) onu HİÇ TOPLAMIYORDU → test yeşil
 * görünüyordu ama koşmuyordu. Birim testleri kaynak dosyanın yanında durur (entegrasyon/yarış
 * testleri ayrı config'lerdedir).
 *
 * Regresyon kaynağı (sahada yaşandı): origin `sites.webhook_url`'den türetiliyordu; webhook_url
 * makineden-makineye bir adres olduğu için İÇ hostname içerebiliyor
 * (`http://wordpress/wp-json/wpteslimat/v1/webhook`, Docker servis adı) → operatöre
 * `http://wordpress/wp-admin/...` gibi ÇÖZÜLEMEYEN link üretiliyordu.
 * Kural: yanlış link vermektense HİÇ link verme (null → UI linki gizler).
 *
 * S4 (bu dalga): tip-tabanlı VARSAYILAN yol tahmini (woocommerce → HPOS `admin.php?page=wc-orders`)
 * KALDIRILDI — HPOS kapalı mağaza + alt-dizin kurulumunda yanlış link üretiyordu. Link YALNIZ
 * `sites.admin_order_url_template` doluyken üretilir.
 */
describe('buildStoreAdminUrl', () => {
  const ORDER_ID = '24';

  it('iç/çözülemeyen hostname içeren ŞABLON → null (yanlış yönlendirme üretilmez)', () => {
    // Docker servis adı gibi çıplak (noktasız) hostname — yalnız iç ağda çözülür.
    const rel = '/wp-admin/post.php?post={orderId}&action=edit';
    expect(buildStoreAdminUrl({ type: 'woocommerce', domain: 'wordpress', adminOrderUrlTemplate: rel }, ORDER_ID)).toBeNull();
    expect(buildStoreAdminUrl({ type: 'woocommerce', domain: 'localhost', adminOrderUrlTemplate: rel }, ORDER_ID)).toBeNull();
    expect(
      buildStoreAdminUrl({ type: 'woocommerce', domain: 'http://wordpress/', adminOrderUrlTemplate: rel }, ORDER_ID),
    ).toBeNull();
    expect(buildStoreAdminUrl({ type: 'woocommerce', domain: '127.0.0.1:8080', adminOrderUrlTemplate: rel }, ORDER_ID)).toBeNull();
    expect(buildStoreAdminUrl({ type: 'woocommerce', domain: 'magaza.local', adminOrderUrlTemplate: rel }, ORDER_ID)).toBeNull();
    expect(
      buildStoreAdminUrl({ type: 'woocommerce', domain: 'magaza.internal', adminOrderUrlTemplate: rel }, ORDER_ID),
    ).toBeNull();
  });

  it('iç hostname içeren MUTLAK şablon da link üretmez', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'http://wordpress/wp-admin/post.php?post={orderId}&action=edit',
        },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  it('mutlak şablon → aynen kullanılır ({orderId} yerine sipariş no)', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate:
            'https://magaza.example.com/wp-admin/post.php?post={orderId}&action=edit',
        },
        ORDER_ID,
      ),
    ).toBe('https://magaza.example.com/wp-admin/post.php?post=24&action=edit');
  });

  it('mutlak şablon farklı bir (genel) hostta olabilir — operatör bilerek tanımlar', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'marketplace',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'https://panel.example.net/orders/{orderId}',
        },
        ORDER_ID,
      ),
    ).toBe('https://panel.example.net/orders/24');
  });

  it("göreli şablon → site domain origin'iyle çözülür", () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: '/wp-admin/post.php?post={orderId}&action=edit',
        },
        ORDER_ID,
      ),
    ).toBe('https://magaza.example.com/wp-admin/post.php?post=24&action=edit');
  });

  it("göreli şablon başka origin'e sıçrayamaz (protokol-göreli //baska-host)", () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: '//kotu.example.net/wp-admin/post.php?post={orderId}',
        },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  it('javascript:/data: şablonu → null (ham geçirilmez)', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'javascript:alert({orderId})',
        },
        ORDER_ID,
      ),
    ).toBeNull();
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'data:text/html,{orderId}',
        },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  // ─── F15: kimlik bilgisi taşıyan URL reddedilir ───────────────────────────────────────
  it('kimlik bilgili şablon → null (sır ekrana/geçmişe düşmez, user@host gizleme hilesi kapalı)', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'https://admin:parola123@magaza.example.com/wp-admin/post.php?post={orderId}',
        },
        ORDER_ID,
      ),
    ).toBeNull();
    // Yalnız kullanıcı adı (parolasız) da reddedilir — `https://magaza.example.com@kotu.example.net/`
    // biçimi gerçek hedefi gizler.
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: 'https://magaza.example.com@kotu.example.net/orders/{orderId}',
        },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  it('kimlik bilgili DOMAIN ile göreli şablon → null (origin türetilmez)', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'https://admin:parola123@magaza.example.com',
          adminOrderUrlTemplate: '/wp-admin/post.php?post={orderId}&action=edit',
        },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  // ─── S4: şablon YOKSA hiçbir tipte link üretilmez (tahmin kaldırıldı) ─────────────────
  it('şablon yok + woocommerce → null (HPOS/alt-dizin tahmini KALDIRILDI)', () => {
    expect(buildStoreAdminUrl({ type: 'woocommerce', domain: 'magaza.example.com' }, ORDER_ID)).toBeNull();
    expect(
      buildStoreAdminUrl({ type: 'woocommerce', domain: 'https://magaza.example.com/magaza/' }, ORDER_ID),
    ).toBeNull();
    // Boş/boşluklu şablon da "yok" sayılır.
    expect(
      buildStoreAdminUrl(
        { type: 'woocommerce', domain: 'magaza.example.com', adminOrderUrlTemplate: '   ' },
        ORDER_ID,
      ),
    ).toBeNull();
  });

  it('şablonsuz marketplace/reseller/tipsiz → null (uydurma link YOK)', () => {
    expect(buildStoreAdminUrl({ type: 'marketplace', domain: 'magaza.example.com' }, ORDER_ID)).toBeNull();
    expect(buildStoreAdminUrl({ type: 'reseller', domain: 'magaza.example.com' }, ORDER_ID)).toBeNull();
    expect(buildStoreAdminUrl({ type: null, domain: 'magaza.example.com' }, ORDER_ID)).toBeNull();
  });

  it('şablon var ama domain yok → göreli şablon çözülemez (null); mutlak şablon çalışır', () => {
    expect(
      buildStoreAdminUrl(
        { type: 'woocommerce', domain: null, adminOrderUrlTemplate: '/wp-admin/post.php?post={orderId}' },
        ORDER_ID,
      ),
    ).toBeNull();
    expect(
      buildStoreAdminUrl(
        { type: 'woocommerce', domain: '   ', adminOrderUrlTemplate: '/wp-admin/post.php?post={orderId}' },
        ORDER_ID,
      ),
    ).toBeNull();
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: null,
          adminOrderUrlTemplate: 'https://magaza.example.com/wp-admin/post.php?post={orderId}',
        },
        ORDER_ID,
      ),
    ).toBe('https://magaza.example.com/wp-admin/post.php?post=24');
  });

  it('remoteOrderId kaçırılır (query/yol parçalanamaz)', () => {
    expect(
      buildStoreAdminUrl(
        {
          type: 'woocommerce',
          domain: 'magaza.example.com',
          adminOrderUrlTemplate: '/wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}',
        },
        '24&admin=1',
      ),
    ).toBe('https://magaza.example.com/wp-admin/admin.php?page=wc-orders&action=edit&id=24%26admin%3D1');
  });

  it('site veya sipariş no yoksa null', () => {
    expect(buildStoreAdminUrl(null, ORDER_ID)).toBeNull();
    expect(buildStoreAdminUrl(undefined, ORDER_ID)).toBeNull();
    const site = {
      type: 'woocommerce',
      domain: 'magaza.example.com',
      adminOrderUrlTemplate: '/wp-admin/post.php?post={orderId}',
    };
    expect(buildStoreAdminUrl(site, null)).toBeNull();
    expect(buildStoreAdminUrl(site, '')).toBeNull();
  });
});
