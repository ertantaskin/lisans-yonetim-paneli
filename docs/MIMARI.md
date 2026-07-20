# Jetlisans — Merkezi Lisans Dağıtım Paneli Mimarisi

**v2.6 · Temmuz 2026** · Görsel kopya: https://claude.ai/code/artifact/4adb7a2c-ba7d-4379-b0ee-2f7b07b56b7c

WooCommerce siteleri yalnızca vitrin + sipariş + ödeme olur; stok, atama,
teslimat, değişim/iade ve çoklu site dağıtımı ayrı sunucudaki merkezi panelde
toplanır. Hedef: 1.000+ sipariş/gün, ortak stok havuzu. Çıkış sorunu: lisans
stoğunun WooCommerce ile aynı MySQL'de durup DB'yi şişirmesi. Çözüm: lisans
verisi WP'de HİÇ durmaz, panelde şifreli tek havuzda yaşar; WP order meta'da
yalnızca `assignment_id` referansı kalır.

---

## 1. Genel mimari & yığın

- **API:** NestJS (Node 22 LTS, Fastify adapter), REST + HMAC imzalı webhook
- **Admin UI:** Next.js + Tailwind v4 + shadcn/ui + TanStack Table/Query + Recharts
- **DB:** PostgreSQL 17 + Drizzle ORM (SKIP LOCKED, partial index, JSONB, partition)
- **Kuyruk/cache:** Redis 7 + BullMQ (mail, webhook, tamamlama, nonce, rate limit)
- **Mail:** Resend/SES — site başına domain doğrulamalı (SPF/DKIM/DMARC)
- **Dağıtım:** Docker Compose + Caddy (otomatik TLS), tek VPS; API stateless çoğaltılır
- **Yedek:** pgBackRest → offsite S3 + sürekli WAL (PITR); master key AYRI saklanır
- **Gözlem:** Sentry + pino JSON log + Uptime Kuma; monorepo pnpm + Turborepo
- **Neden mikroservis değil:** 1K–10K sipariş/gün modüler monolit için küçük yük;
  modüller (stok/atama/teslimat/site) net sınırlı, gerekirse worker ayrılır.

Her WooCommerce sitesi panelde ayrı bir "tenant"; kendi API anahtarı + HMAC
gizli anahtarıyla tanımlı.

---

## 2. Sipariş & teslimat akışı

1. Woo siparişi `processing/completed` → eklenti Action Scheduler ile
   `POST /v1/orders` (HMAC + `Idempotency-Key` = site+order+line). Ödeme sayfası beklemez.
2. Panel atomik atama yapar, `201` assignment listesi döner; eklenti order meta'ya
   `assignment_id` yazar (HPOS uyumlu).
3. Teslimat maili BullMQ kuyruğundan **asenkron** gider (mail sağlayıcı çökse bile
   atama tamamdır, kuyruk tekrar dener).
4. Müşteri "Siparişlerim → görüntüle": WP **server-side** panelden çeker; panel
   API'si ve sırlar tarayıcıya asla açılmaz, credential cache'lenmez.
5. Sağlayıcı `delivered/bounced` webhook'u → `email_log` → admin meta box'ta görünür.

### Atomik stok atama (sistemin kalbi)
```sql
UPDATE license_items SET status='assigned', assigned_at=now()
WHERE id IN (
  SELECT id FROM license_items
  WHERE product_id = $1 AND status = 'available'
  ORDER BY created_at LIMIT $2
  FOR UPDATE SKIP LOCKED)
RETURNING id;
```
- `FOR UPDATE SKIP LOCKED`: eşzamanlı siparişler farklı satır kilitler, deadlock yok,
  aynı satır iki kez seçilemez.
- Idempotency key UNIQUE → tekrar gelen istek yeni atama yapmaz, mevcut cevabı döner.
- Stok yetersizse: davranış ürün politikasına bağlı (§5). Varsayılan kısmi teslimat.
- Çok kullanımlıkta (`multi`): satır seçmek yerine kilitli tek satırda
  `use_count += adet` (koşul: `use_count + adet <= max_uses`) — kapasite aşımı imkânsız.

### Lisans yaşam döngüsü
`available → assigned → (suspended ⇄ assigned) | replaced | revoked`
`revoked → quarantined → (admin onayıyla available | imha)`.
İade edilen key otomatik satışa dönmez (müşteri görmüş olabilir) → karantina.
Çok kullanımlıkta dolunca `depleted`; süreli üründe süre bitince `expired`.

---

## 3. Veri modeli (ana tablolar)

- **sites** — `type(woocommerce|marketplace|reseller)`, domain, api_key_hash,
  hmac_secret_enc, sender_email, sender_domain_verified, status
- **products** — sku, name, `kind(key|account|custom|code)`, payload_schema(JSONB),
  `usage_mode(single|multi)`, `validity_days`+`on_expiry(hide|keep)`,
  `stockless`+`release_at`, `fulfillment_policy(partial-auto|partial-approval|all-or-nothing)`,
  warranty_days, key_format(regex), low_stock_threshold
- **site_product_mappings** — site_id, product_id, remote_product_id,
  remote_variation_id, bundle_qty (1 Woo adedi=N key), remote_sku,
  template_override_id, active
- **suppliers** — name, contact, import_profile(JSONB kolon eşleme), active
- **purchase_orders** — supplier_id, product_id, qty_ordered, qty_received,
  unit_cost, expected_at, `status(ordered|partially_received|received|cancelled)`
- **stock_batches** — supplier_id, po_id, unit_cost, currency, imported_by
- **license_items** — product_id, batch_id, payload_enc(AES-256-GCM),
  payload_hash(UNIQUE, mükerrer engeli), payload_suffix_hash(son 5 hane arama),
  expires_at(FEFO), max_uses+use_count, status, assigned_at
- **orders** — site_id, remote_order_id, customer_email, status, idempotency_key(UNIQUE)
- **order_lines** — qty, fulfilled_qty, `status(fulfilled|partial|pending)`,
  policy_override, priority
- **assignments** — order_id, line_item_id, license_item_id, units, valid_until,
  `status(active|suspended|replaced|revoked|expired)`, delivered_at
- **assignment_history** — old/new license_item_id, reason, actor ("eski anahtarlar")
- **fulfillment_events** — sipariş timeline'ı (panel + WP meta box'ta gösterilir)
- **replacement_requests** — müşteri "Sorun Bildir" kuyruğu, in_warranty işareti
- **customer_tags** — vip|wholesale|risky|blocked (e-posta bazlı, tüm siteler)
- **delivery_templates, email_log, outbox_events, audit_log(append-only),
  blocklist, panel_users**(argon2id + TOTP, RBAC)

**Performans:** partial index `WHERE status='available'` (10M satırda bile küçük index);
log tabloları aylık partition (milyonlu satıra yaklaşınca devreye, şema hazır yazılır).

---

## 4. API sözleşmesi (v1) — hepsi HMAC imzalı

| Uç | Yöntem | Görev |
|---|---|---|
| `/v1/orders` | POST | Sipariş bildir; 201 tam / 207 partial_fulfillment / 202 pending_stock |
| `/v1/orders/:id/deliveries` | GET | Yalnız aktif atamalar + rehber (müşteri ekranı) |
| `/v1/orders/bulk-status` | POST | Liste sayfası — N+1 önleme, key içermez |
| `/v1/orders/:id/admin-view` | GET | Atamalar + history + mail durumu |
| `/v1/orders/:id/timeline` | GET | fulfillment_events |
| `/v1/assignments/:id/replace` | POST | reason zorunlu; farklı ürünle değişim olabilir |
| `/v1/assignments/:id/suspend` \| `/unsuspend` | POST | Geri alınabilir gizleme |
| `/v1/fulfillments/:lineId/complete` | POST | "Kalanları/N adet ata" |
| `/v1/orders/:id/resend` | POST | 60 sn debounce |
| `/v1/orders/:id/revoke` | POST | İade/iptal → müşteri görünümü kapanır |
| `/v1/replacement-requests` | POST/GET | Müşteri "Sorun Bildir" |
| `/v1/products/mapped` · `/v1/health` | GET | Anlık stok · bağlantı testi |

**HMAC imza:** `X-Api-Key` + `X-Timestamp`(±300sn) + `X-Nonce`(Redis 10dk) +
`X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))`.
Anahtar rotasyonu: eski 24 saat paralel geçerli. `X-Trace-Id` uçtan uca taşınır.

**Hata modeli:** 401 invalid_signature (retry yok) · 404 mapping_not_found (sipariş
`unmapped` açılır, kaybolmaz) · 409 already_processed (mevcut atamalar döner) ·
422/207 insufficient/partial · 429 Retry-After · 5xx → eklenti 1dk/5dk/30dk retry.

---

## 5. Kısmi teslimat & sipariş tamamlama

Örnek: 50 sipariş / stokta 30 → 30 anında teslim, kalan 20 stok gelince tamamlanır.

**Politikalar** (ürün bazlı, sipariş override edilebilir):
- `partial-auto` (varsayılan): stok girilince kalanlar FIFO **otomatik** tamamlanır
- `partial-approval`: "Kalanları Ata" (tek tık) / "N Adet Ata" (kademeli) admin onayı
- `all-or-nothing`: tamamı hazır olmadan hiçbiri gitmez

Tamamlama motoru stok girişinde tetiklenir, bekleyenleri FIFO tarar (öncelik
değiştirilebilir). Turlar idempotent (`line_id+round`). Kısmi mailde "30/50 teslim
edildi, kalanı hazırlanıyor". Woo durumu "kısmen teslim edildi"; webhook
`order.partially_fulfilled`, tamamlanınca `order.fulfilled`.

---

## 6. Teslimat & mail

Şablonlar **tamamen panelde** (ürün bazlı + site override). Değişkenler:
`{{key}} {{username}} {{password}} {{units}} {{order_no}} {{site_name}} {{product_name}}`.
Site "mail kabuğu" (logo/renk/altbilgi) ürün şablonunu sarar. Maili **panel gönderir**
(BullMQ, site domaininden DKIM'li). Bounce/delivered `email_log`'a; bounce'ta müşteriye
My Account uyarı bandı ("mailiniz ulaşamadı, buradan görüntüleyin"). WP tarafında şablon
YOK — N sitede tek metin bakımı.

---

## 7. WordPress eklentisi (ince istemci)

Lisans verisi WP DB'de tutulmaz; yerel tablo yalnızca istek kuyruğu logu (30 gün
otomatik budanır — DB şişmesi geri gelmesin).

**Sipariş tarafı:** status hook'ları → panele push (Action Scheduler, retry).
Kısmi/tam iade → yalnız ilgili satır revoke.

**Müşteri (My Account):** server-side çekim, yalnız aktif atamalar; iade edilen key
kendiliğinden kaybolur. Görüntüleme UX: tek tık kopyala, şifre göster/gizle, çok
adetlide toplu .txt indirme (loglu), canlı tamamlama yoklaması.

**Admin meta box:** atanmış lisanslar (maskeli, "Göster"=loglu reveal), **Değiştir**
(sebepli + eski anahtar geçmişi altta), **Tekrar Mail Gönder** (60sn debounce),
**Askıya al/geri aç**, farklı ürünle değişim, +1 bonus atama, key bazında işlem.
Sipariş listesine teslimat kolonu + "eksik" filtresi + toplu aksiyon. Ürün ekranına
eşleme kutusu. Admin bar sağlık göstergesi. WP rolleri panel scope'una eşlenir
(shop_manager key açamaz); her aksiyon audit'e `actor: wp:kullanıcı@site` olarak düşer.

**Müşteri ekranı durum matrisi:** pending→"hazırlanıyor", held→"doğrulanıyor",
partial→30/50 + ilerleme, suspended→"inceleme altında", replaced→yalnız yeni key,
revoked→"iade edildi", expired→"süreniz doldu", bounce→uyarı bandı.

**Kenar durumları:** sipariş düzenleme (adet artır→ek atama, azalt→seçmeli revoke),
varyasyon/paket eşleme, webhook `sequence` (bayat webhook yok sayılır), bulk-status
(N+1 yok), page-cache hariç + `no-store` (key cache'lenmez), staging klon koruması
(URL değişince pasif mod), saat kayması ölçümü (60/240sn uyarı), WPML çeviri grubu,
tanılama sekmesi (Cloudflare/WAF webhook testi dahil), dual-run geçiş modu.

---

## 8. Güvenlik

- **Şifreleme:** license_items.payload_enc AES-256-GCM (libsodium), envelope
  encryption; master key ayrı secret store'da, DB yedeğinden AYRI, çevrimdışı 2 kopya,
  tatbikatta geri yükleme test edilir.
- **Patlama yarıçapı (site ele geçirilirse):** site başına **dinamik satış kotası**
  (30g ort. ×3; aşımda teslimat `held_for_review` + alarm), yüksek adetlide **Woo'ya
  geri doğrulama** ("bu sipariş gerçekten var/ödendi mi"), **anomali oto-askısı**
  (imza fırtınası → o kanal durur, diğerleri etkilenmez), her anahtar yalnız kendi sitesi.
- **Erişim:** admin IP/VPN (Tailscale) + 2FA(TOTP) + RBAC (reveal ayrı rol); DB/Redis
  dışa kapalı; zod şema doğrulama; parametrik sorgu; CSP.
- **Denetim:** append-only audit_log (reveal, replace, revoke, import, login).
- **İki kritik kural:** panel API sırları yalnız `wp-config.php` düzeyinde (WP DB'de düz
  metin option değil); müşteri yanıtında revoked/suspended payload SQL seviyesinde
  filtrelenir ("frontend gizleme" değil).
- **Ödeme:** tamamen WP/geçit tarafında; panel siparişi ödeme SONRASI görür, ödemeye
  dokunmaz. 3DS/Ethoca/Verifi panel işi DEĞİL. Chargeback: geçit→Woo→mevcut revoke;
  kanıt paketi (timeline+log+IP PDF) panelde kalır.

---

## 9. KVKK / GDPR & veri saklama

PII minimizasyonu (panel yalnız e-posta + sipariş no; ad/adres WP'de). email_log
gövdeleri 12 ay sonra maskelenir (aylık partition ucuz purge). Loglarda payload otomatik
redakte. Silme/anonimleştirme ucu (customer_email → anon_hash). WP hesap silme kancası
bu ucu otomatik çağırır. Aydınlatma metinlerinde panel "veri işleyen", mail yurtdışıysa
aktarım maddesi.

---

## 10. Çok kanallı satış

`sites.type = woocommerce | marketplace | reseller`. WP kanalı eklentiyle, pazar yeri
kanalı adaptör worker ile konuşur; atama/idempotency/şablon aynı. G2A/Kinguin Import/
Export API adaptörü (stok/fiyat senkron, stok bitince teklif pasife). Bayi API (Faz 4).
**Manuel satış kanalı:** WhatsApp/DM satışları panelden elle sipariş, aynı motor, site
kimliğiyle mail, raporda "manuel". Kanal bazlı efektif marj raporu.

---

## 11. Ürün tipi matrisi (hepsi tek çekirdek)

| Tip | Model | Davranış |
|---|---|---|
| Tek kullanımlık key | `usage_mode:single` | Varsayılan akış |
| Çok kullanımlık (MAK) | `usage_mode:multi`, `max_uses` | 1 key=500 satış, atomik kapasite düşümü, iade hakkı BİLİNÇLİ döner (aktivasyon tükenmiş olabilir) |
| Kalıcı hesap | `kind:account` | Teslimden sonra müşterinin; warranty_days |
| Süreli abonelik hesabı | `validity_days`+`on_expiry` | Süre TESLİMLE başlar (`valid_until`), bitince gizle/kalır. Yenileme entegrasyonu YOK |
| Kiralık slot | `multi`+`validity_days` | Süre dolunca hak OTOMATİK havuza (istisna) + şifre rotasyonu hatırlatması |
| Kod/hediye çeki | `kind:code`, `source:generated` | Key ile aynı; üretilenler stokla karışmaz |
| Stoksuz/ön sipariş | `stockless`, `release_at` | pending=normal akış (alarm değil), SLA'lı mesaj, tarih kapılı teslim |

> `expires_at` (stok ömrü, FEFO) ile `validity_days` (teslimle başlayan abonelik) AYRI kavram.

---

## 12. Stok zekâsı & tedarik zinciri

- **Tükenme tahmini:** satış hızından "kalan gün" (yoldaki stoğu da bilir:
  "2,8 gün + 500 yolda Çarşamba"). Min seviye + tedarik hatırlatması.
- **Satın alma siparişleri (purchase_orders):** yoldaki stok; kısmi teslim alma;
  ETA bekleyen ekranında ve müşteri mesajında.
- **FEFO:** süreli key'lerde önce ölecek satılır; süresi geçen `expired` + zayi raporu.
- **Parti kabulü/geri çekme:** spot check + şartlı kabul→karneye; recall: satılmamış
  `voided` (zayi), satılmış→toplu değiştirme sihirbazı.
- **Sebepli stok düzeltme:** audit'li, sebepsiz değişiklik imkânsız.
- **Tedarikçi karnesi:** parti bazlı değişim oranı, maliyet, PO'dan gerçek teslim süresi.
- **Import profilleri:** tedarikçi başına kolon eşleme; dosya→profil→PO kapanışı→dağıtım.

---

## 13. Admin deneyimi & operasyon kolaylıkları

- **Bekleyen Teslimatlar:** ana ekran — sipariş, ilerleme (30/50), bekleme süresi (renk),
  neden, aksiyonlar (Kalanları Ata / N Adet Ata / Önceliklendir / İptal), toplu seçim.
- **Akıllı stok girişi ("Onayla ve Dağıt"):** satır doğrulama + key_format regex +
  "bu giriş 3 bekleyen siparişi (45 adet) tamamlayacak" önizlemesi.
- **Ctrl+K arama:** sipariş no, e-posta, key son 5 hane (payload_suffix_hash).
- **Toplu değiştirme sihirbazı, sipariş timeline'ı (iki tarafta), Telegram inline onay**
  (Kalanları Ata / Onayla-Değiştir butonları), şablon önizleme + test maili.
- **Self-servis:** müşteri "Sorun Bildir" → destek kuyruğu (Onayla/Reddet/Bilgi İste),
  garanti süresi, müşteri 360 + etiketler, suistimal (değişim oranı) tespiti.

---

## 14. Onboarding & operasyon güvenliği

Site bağlama sihirbazı (tek seferlik 15dk kod, secret otomatik teslim, bağlantı testi,
~10dk). Sandbox/test modu (sahte key, mailler yalnız size). Operatör çakışma uyarısı
(Redis presence). Kayıtlı görünümler.

---

## 15. AI destekli operasyon

AI önerir, insan onaylar (otomatik gönderim yok). Talep triyajı + taslak cevap; günlük
özetin anomali paragrafı; doğal dilde rapor (salt-okunur DB rolü, üretilen SQL gösterilir).
Payload'lar modele maskeli gider; AI çökerse sistem AI'sız çalışır.

---

## 16. Operasyon: test, sürüm, DR

- **CI'da zorunlu yarış testi:** 100 eşzamanlı sipariş × 50 stok → çifte atama=0.
- **Tutarlılık denetçisi (gece):** use_count≤max_uses, fulfilled=units toplamı, çift
  atama yok, raporlanan stok=gerçek → ihlal kritik alarm.
- Yük testi (k6, p95<300ms), e2e (Playwright + wp-env), migrasyon kuru çalıştırma.
- Trace ID uçtan uca; dead-letter ekranı + yeniden oynat.
- Private update endpoint (eklenti sürümü tek yerden dağıtılır).
- İzleme eşikleri + günlük Telegram özeti. DR: RPO≤5dk / RTO≤2sa, aylık yedek tatbikatı.

---

## 17. Arayüz tasarımı & tasarım sistemi

**Felsefe:** operasyon aracı — "scan edilir, okunmaz". Yoğun tablo, net durum rengi,
her ekranda aynı desen.

**Yığın (kesinleşti — satnaing/shadcn-admin nötr dili):** Referans birebir
**satnaing/shadcn-admin** (shadcn-admin.netlify.app). Tailwind v4 (CSS-first; `tailwind.config.js`
YOK — token'lar `@theme`/`@theme inline`'da) + klasik **shadcn/ui deseni (kod sahipliği) +
Radix UI** primitifleri (Base UI DEĞİL — 2026 indigo/Base UI kararı bırakıldı) + TanStack
Table + Recharts + Inter + JetBrains Mono / tabular-nums + lucide + cmdk (Ctrl+K) +
sonner (toast) + next-themes (`attribute=class`, `.dark`). Framework: **Next.js 15
(sunucu-taraflı)** korunur — şablon Vite/TanStack Router olsa da veri çekimi sunucuda
(ADMIN_TOKEN tarayıcıya sızmaz, HMAC/site-scope) kalması güvenlik gereği. Açık + koyu
tema token seviyesinde. Hazır styled kütüphane (Mantine/HeroUI) KULLANILMAZ; hepsi ücretsiz/MIT.

**Renk kimliği (shadcn nötr paleti — kesinleşti):** standart shadcn **nötr oklch**
token'ları — monokrom; **nötr primary** (açıkta koyu, koyuda açık; renkli marka accent'i YOK),
katmanlı yüzeyler. Durum anlamı **semantik uzantı** renklerinde (nötr temada renkli tutulur).
Token'lar `apps/admin/app/globals.css` tek kaynağında (`:root`/`.dark` + `@theme inline`);
değişince tüm uygulama anında yayılır. Legacy sınıflar (`ink/surface/accent-soft…`) geçici
**compat @theme köprüsüyle** yeni palete bağlı — sayfalar standart token'lara taşınınca kalkar.

| Token | Açık (oklch L) | Koyu (oklch L) | Kullanım |
|---|---|---|---|
| background | `1.0` | `0.145` | Sayfa zemini |
| foreground | `0.145` | `0.985` | Metin |
| card / popover | `1.0` | `0.205` | Kart/panel/overlay |
| primary | `0.205` (koyu) | `0.922` (açık) | Buton, aktif, link (NÖTR — renk yok) |
| secondary / muted / accent | `0.97` | `0.269` | Dolgu, hover, seçili satır |
| muted-foreground | `0.556` | `0.708` | İkincil metin |
| border / input | `0.922` | `1.0 /10%` | Kenarlık / alan çeperi |
| ring | `0.708` | `0.556` | Odak halkası |
| sidebar-* | `0.985` zemin | `0.205` zemin | Kenar menü ayrı token seti |
| success | emerald | emerald | bitti (durum) |
| warning | amber | amber | aksiyon bekliyor (durum) |
| destructive | rose | rose | sorun / iptal |
| chart-1..6 | shadcn kategorik | (koyu varyant) | veri görselleştirme |

Primary NÖTR (marka renk vurgusu yok, shadcn-admin gibi); **durum anlamı** yalnız
success/warning/destructive semantik renklerinde; veri grafikleri `chart-1..6` kategorik.

**Kabuk (shadcn sidebar block):** `ui/sidebar.tsx` — resmi shadcn sidebar deseninin sadık
uyarlaması: `SidebarProvider` (cookie kalıcılık `sidebar_state`, Ctrl/⌘+B kısayolu, mobil
sheet), `Sidebar` (masaüstü icon-collapse rayı), `SidebarInset`, `SidebarTrigger`,
`SidebarMenu*`. `components/shell/app-sidebar` (marka + gruplu nav + `nav-user` footer) +
`site-header` (SidebarTrigger + breadcrumb + Ctrl+K + tema + CANLI rozeti).

**Bilgi mimarisi:** sol menü — Bekleyen Teslimatlar (ana), Siparişler, Stok
(ürün/parti/PO), Tedarikçiler, Destek, Müşteriler, Kanallar, Şablonlar, Raporlar,
Ayarlar. Rozetler + Ctrl+K + ortam rozeti.

**Desenler:** tek durum dili (pill+ikon, WCAG AA), kritik aksiyon=onay+sebep,
para/stok işleminde optimistic UI YOK, maskeli veride kopyalama=reveal (loglu),
J/K/A/R klavye kuyruğu, sandbox'ta sarı "TEST MODU" şeridi, mobil=okuma+onay
(asıl mobil kanal Telegram). Arayüz Türkçe-öncelikli, i18n katmanında.

**WP tarafı:** eklenti WP admin görsel dilinde (panel markası yok, durum renkleri
aynı); My Account bloğu tema-nötr.

---

## 18. Yol haritası

- **Faz 0 (~1 hafta):** VPS + Docker Compose + Caddy + PG + Redis; CI/CD; yedek;
  Sentry; NestJS/Next.js monorepo iskeleti; migration altyapısı.
- **Faz 1 (~3-4 hafta) MVP:** şifreli stok + import, atomik atama + idempotency,
  kısmi teslimat motoru + Bekleyen Teslimatlar, sipariş API + şablon + mail, WP eklentisi
  (push, My Account, meta box: göster/değiştir/tekrar gönder/revoke), geri kanal webhook.
  CI yarış testi ilk günden. Jetlisans'ta 1-2 pilot ürünle canlı (eski eklenti paralel).
- **Faz 2 (~2-3 hafta):** hesap ürünleri (JSONB), çok kullanımlık, şablon override, 2. site,
  domain doğrulama, mutabakat cron, düşük stok + Telegram, misafir link (site bayrağı),
  akıllı stok önizleme, Ctrl+K, toplu değiştirme, self-servis + müşteri 360, tedarik
  zinciri (PO/karne/import profili), sandbox, velocity + blocklist.
- **Faz 3 (~1-2 hafta):** eski WP eklentisinden migrasyon (eşleme + kuru çalıştırma +
  doğrulama), ürün bazlı dual-run cutover, WP tabloları temizlenir.
- **Faz 4 (sürekli):** kâr/maliyet raporları, tedarikçi API, bayi API, kanal adaptörleri,
  risk skoru otomasyonu, AI operasyon, private update endpoint.

---

## Bilinçli kapsam DIŞI (YAGNI kararları)
- Yenileme/abonelik entegrasyonu (hatırlatma zinciri, Woo Subscriptions) — hazır ürün modeli
- Havale/EFT stok rezervasyonu — ödeme Woo'da onaylanır, panel ödenmiş siparişi görür
- Seçici 3DS + Ethoca/Verifi — ödeme tamamen site/geçit tarafı
- Paylaşımlı hesap (`max_uses`) ürün olarak var ama paylaşımlı model gerekince genişletilir
