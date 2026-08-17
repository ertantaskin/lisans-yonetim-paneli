# Lisans Yönetim Paneli — Merkezi Lisans Dağıtım Paneli Mimarisi

**v2.7 · Ağustos 2026** — *bu dosya mimarinin TEK YETKİLİ tanımıdır.*

> **Üç şey karıştırılmasın:**
> · **Bu dosya** = şartname (ne, neden, hangi kural). Veri modeli (§3), rota haritası (§13.1) ve
>   API tablosu (§4) artık **`pnpm check:docs` ile kod tarafından denetlenir** — şemaya tablo,
>   panele ekran eklenip burası güncellenmezse CI kırılır. Kapı, belgenin bir dönem 15 tabloyu
>   hiç anmadığı ve **4 uydurma tablo** anlattığı ölçüldüğü için eklendi.
> · **`mimari-gorsel.html`** = aynı belgenin ELLE hazırlanmış görsel kopyası, **2026-07-27
>   tarihli anlık görüntü**. Denetim kapsamında DEĞİL ve geride kalabilir; çelişki varsa
>   **bu dosya geçerlidir**. (Aynı içeriğin iki elle sürdürülen kopyası, bu projede
>   tekrarlayan bir arıza sınıfıdır — bkz. CLAUDE.md → Tekrarlayan tuzaklar #4.)
> · **`docs/GECMIS.md`** = ne zaman ne yapıldığı (tur günlüğü); şartname değil.
>
> Kolon/parametre düzeyinde tek doğruluk kaynağı her zaman **koddur**
> (`apps/api/src/db/schema/`, controller'lar).

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
- **Mail:** SMTP (nodemailer) + BullMQ kuyruğu; geliştirmede Mailpit.
  *(Plan Resend/SES + site başına domain doğrulamasıydı; kurulum SMTP-only ilerledi —
  `bounced` durumu üretilmez, §2.5.)*
- **Dağıtım:** Docker Compose + Caddy (otomatik TLS), tek VPS; API stateless çoğaltılır
- **Yedek:** `pg_dump` + `scripts/backup-runner.sh` (cron) + aylık geri-yükleme TATBİKATI;
  dış kopya bir **kancadır** (`BACKUP_OFFSITE_CMD`) ve kurulu değilse panel `backup_offsite`
  alarmı üretir. MASTER_KEY yedeğin İÇİNDE DEĞİL — ayrı kasada. *(Plan pgBackRest + S3 + WAL/PITR
  idi; bugünkü gerçek budur — ayrıntı `docs/RUNBOOK-DR.md`.)*
- **Gözlem:** pino JSON log (PII maskeli) + `/v1/health` (degrade → 503) + panel içi alarmlar
  (`notifications`). **Sentry env-gated, varsayılan KAPALI** (`SENTRY_DSN` yoksa hiç başlatılmaz).
  *(Uptime Kuma kurulmadı — dışarıdan izleme hâlâ operatöre kalan bir iştir.)*
- Monorepo: pnpm + Turborepo
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
5. Gönderim sonucu `email_log`'a yazılır → panelde ve WP meta box'ta görünür.
   **Bilinçli daraltma:** mail sağlayıcı `delivered/bounced` webhook'u YOK — kurulum SMTP-only
   ilerledi, dolayısıyla `bounced` durumu hiç üretilmez. Bu belge bir dönem sağlayıcı webhook'u
   varmış gibi yazıyordu; gerçek yetenek budur.

### Atomik stok atama (sistemin kalbi)

> ⚠ **`WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` YAZMAYIN.** Bu belge bir dönem tam
> olarak o yazımı örnek gösteriyordu ve **üretimde aşırı teslimat üretti** (ÖLÇÜLDÜ: `qty=6`
> istenirken 20 satır — o ürünün TÜM stoğu — atandı). READ COMMITTED'da UPDATE hedef satırı
> eşzamanlı değiştirilmiş bulursa WHERE'i yeniden değerlendirir (EvalPlanQual) ve kilit yan
> etkili alt sorgu YENİDEN koşar; her koşuda "ilk n"i baştan seçtiği ve `SKIP LOCKED` farklı
> satırlar döndürdüğü için **LIMIT fiilen kalkar**. Doğrusu, seçimi bir kez maddeleştiren
> `MATERIALIZED` CTE'dir (`MATERIALIZED` açıkça yazılmalı: tek referanslı CTE inline edilebilir).

```sql
WITH picked AS MATERIALIZED (
  SELECT id FROM license_items
  WHERE product_id = $1 AND status = 'available'
    AND (expires_at IS NULL OR expires_at > now())      -- süresi geçmiş kalem atanmaz
  ORDER BY expires_at ASC NULLS LAST, created_at, seq   -- FEFO → FIFO → giriş sırası
  LIMIT $2
  FOR UPDATE SKIP LOCKED
)
UPDATE license_items li SET status='assigned', assigned_at=now()
FROM picked p WHERE li.id = p.id
RETURNING li.id;
```

- `FOR UPDATE SKIP LOCKED`: eşzamanlı siparişler farklı satır kilitler, deadlock yok,
  aynı satır iki kez seçilemez.
- **Fail-closed kalkan:** dönen satır sayısı istenenden çoksa transaction PATLATILIR. Bu sınıf
  arıza sessizdir (müşteriye bedava lisans + envanterden yanma) ve aylarca "testler bazen
  kırmızı" gürültüsü sanıldı — rollback, yanlış teslimattan iyidir.
- **Sıralama tie-break'i zorunludur:** aynı içe aktarmanın tüm satırları tek transaction'da
  yazıldığı için `created_at` damgaları BİREBİR aynıdır; `seq` olmadan blok içi sıra keyfidir.
- Idempotency key UNIQUE → tekrar gelen istek yeni atama yapmaz, mevcut cevabı döner.
- Stok yetersizse: davranış ürün politikasına bağlı (§5). Varsayılan kısmi teslimat.
- **Çok kullanımlıkta (`multi`)** satır seçilmez, kilitli satırda kapasite düşülür:
  `LEAST(istenen, max_uses − use_count)` — yani anahtar ne kadar taşıyorsa o kadar alınır, artan
  talep sonraki anahtara taşar. Sıralamada **birinci anahtar "talebi TEK BAŞINA karşılayan"dır**
  (müşterinin eline geçen her fazladan anahtar, fazladan aşırı-etkinleştirme yüzeyidir); FEFO/FIFO
  ikinci-üçüncü anahtar olarak korunur. `max_uses` **anahtar başınadır** (ürün ayarı yalnız
  VARSAYILAN) — tedarikçiden 50'lik ve 500'lük lotlar birlikte gelebilir.

### Lisans yaşam döngüsü
`available → assigned → (suspended ⇄ assigned) | replaced | revoked`
`revoked → quarantined → (admin onayıyla available | imha)`.
İade edilen key otomatik satışa dönmez (müşteri görmüş olabilir) → karantina.
Çok kullanımlıkta dolunca `depleted`; süreli üründe süre bitince `expired`.

---

## 3. Veri modeli (32 tablo — TAMAMI)

> **Bu liste kod tarafından denetlenir.** `pnpm check:docs` şemadaki her `pgTable` adının
> burada geçtiğini doğrular; yeni tablo eklenip bu bölüm güncellenmezse **CI kırılır**.
> Kapı bu yüzden var: liste bir dönem elle sürdürüldü ve sessizce 15 tablo eksik, 4 tablo
> **uydurma** hâle geldi (`stock_batches`/`customer_tags`/`panel_users`/`blocklist` — hiçbiri
> hiç var olmadı) — şartnameye güvenip kod yazan biri var olmayan bir tabloya yazardı.
> Kolon ayrıntısı için tek doğruluk kaynağı `apps/api/src/db/schema/`.

**Çekirdek satış/teslimat**

- **sites** — `type(woocommerce|marketplace|reseller)`, domain, api_key_hash (+`_prev` rotasyon
  aynası), hmac_secret_enc (+`_prev`), webhook_url, sales_daily_quota, dynamic_quota_enabled,
  review_multiplier, sandbox, admin_order_url_template(+`_manual`), plugin_version, last_seen_at
- **products** — sku, name, `kind(key|account|custom|code)`, payload_schema(JSONB),
  `usage_mode(single|multi)` + max_uses, `validity_days`+`on_expiry(hide|keep)`,
  `stockless`+`release_at`, `fulfillment_policy(partial-auto|partial-approval|all-or-nothing)`,
  warranty_days, key_format(regex), low_stock_threshold, category_id, guide_id
- **product_categories** — ad/açıklama/sabitleme sırası; ürün silinmez, `ON DELETE SET NULL`
- **product_guides** — kurulum/etkinleştirme rehberi (mağaza sayfası + mail + `.txt`, tek render)
- **site_product_mappings** — (site, remote_product_id[, variation]) → product_id + bundle_qty.
  **Eşleme yalnız ELLE kurulur** (otomatik eşleştirme YOK — §7)
- **site_remote_products** — mağaza ürün katalog SNAPSHOT'ı (ad/sku/tip/varyasyon; SIR YOK).
  Eşlemeler ayrı tabloda → katalog yenilense de kopmaz
- **license_items** — product_id, batch_id, payload_enc(AES-256-GCM + AAD), payload_hash(UNIQUE,
  mükerrer engeli), payload_suffix_hash(son 5 hane arama), expires_at(FEFO), **max_uses (ANAHTAR
  BAŞINA)** + use_count, unit_cost_cents(snapshot), status, assigned_at, **seq**(giriş sırası)
- **orders** — site_id, remote_order_id, customer_email, status, idempotency_key(UNIQUE),
  held_for_review + held_at/held_reason (§8 inceleme kuyruğu)
- **order_lines** — qty (MAĞAZA gerçeği, dokunulmaz), fulfilled_qty, **canceled_units** (iptal
  defteri; hedef = `qty − canceled_units`), canceled(terminal), bundle_qty(teslimat-anı snapshot),
  remote_product_id/remote_variation_id/remote_name
- **assignments** — order_id, line_id, license_item_id, units, valid_until,
  `status(active|suspended|replaced|revoked|expired)`, delivered_at
- **assignment_history** — eski/yeni license_item_id, reason, actor (değişim soyağacı)
- **fulfillment_events** — sipariş zaman çizelgesi + **seq** (aynı tx'te yazılan olaylar aynı
  damgayı taşır; sıra `created_at, seq`)

**Tedarik & envanter**

- **suppliers** · **purchase_orders** (qty_ordered/qty_received, unit_cost_cents, ordered_at
  NULL = otomatik giriş, `status(ordered|partially_received|received|cancelled)`) ·
  **batches** (parti; supplier_id, po_id, unit_cost, received_at, recalled)
- **stock_adjustments** — sebepli düzeltme/void/zayi (kalem başına satır; karantina sebebi buradan)
- **supplier_claims** + **supplier_claim_items** — kusurlu kalemin tedarikçiye bildirim fişi.
  Kalem alanları SNAPSHOT; `license_item_id` FK'siz (kalem silinse de fiş izi kalır)

**Müşteri & destek**

- **customers** — e-posta bazlı GLOBAL kayıt (etiket/not); site boyutu yalnız SUNUMDA
- **replacement_requests** — "Sorun Bildir" kuyruğu, garanti penceresi işareti
- **replacement_messages** — iki yönlü yazışma (iç notlar müşteriye gitmez)

**Operasyon & güvenlik**

- **admin_users** — **scrypt** (argon2 DEĞİL) + role + token_version (anlık iptal) +
  totp_secret_enc/totp_enabled (RFC 6238, sıfır bağımlılık)
- **site_connect_tokens** — tek kullanımlık bağlan kodu (15dk TTL, atomik claim, şifreli kimlik)
- **security_events** — velocity/anomaly/quota_exceeded/quota_review + yönetici oturum olayları
- **notifications** — düşük stok · günlük özet · mutabakat ihlali · süpürme/yedek/mail alarmları
- **audit_log** — append-only (reveal/revoke/import/anonymize/…)
- **saved_views** — aktör-kapsamlı kayıtlı liste görünümleri

**Mail & dış kanal**

- **delivery_templates** (ürün+site > ürün > site > genel öncelik) · **email_log** ·
  **outbox_events** (geri-kanal webhook, monoton `seq`)
- **plugin_releases** — WP eklentisi sürümleri (zip DB'de; §16 kararı) ·
  **deployments** — panelden dağıtım/yayın/yedek kuyruğu (istek ↔ runner ayrımı)

**Performans:** sıcak yollar kısmi index'lerle karşılanır (`WHERE status='available'`,
`WHERE status='active' AND valid_until IS NOT NULL`, bekleyen satır FIFO…). LIMIT'li her
sıralamanın benzersiz tie-break'i vardır ve **yön aynalı değildir** (ASC/DESC ayrı index).
Saklama süpürmesi (`RetentionService`) log tablolarını günlük budar.

---

## 4. API sözleşmesi (v1) — hepsi HMAC imzalı

| Uç | Yöntem | Görev |
|---|---|---|
| `/v1/orders` | POST | Sipariş bildir; 201 tam / 207 partial_fulfillment / 202 pending_stock |
| `/v1/orders/:id/deliveries` | GET | Yalnız aktif atamalar + rehber (müşteri ekranı) |
| `/v1/orders/bulk-status` | POST | Liste sayfası — N+1 önleme, key içermez |
| `/v1/orders/:id/admin-view` | GET | Atamalar + history + mail durumu |
| `/v1/orders/:id/timeline` | GET | fulfillment_events |
| `/v1/orders/:remoteOrderId/assignments/:aid/replace` | POST | Mağaza tarafı değişim; reason zorunlu (hedefin çağıran siteye ait olduğu ÖNCE doğrulanır) |
| `/v1/orders/:remoteOrderId/assignments/:aid/suspend` · `/bonus` · `/reveal` | POST | Geri alınabilir gizleme · bonus birim · loglu gösterim |
| `/v1/admin/assignments/:id/replace` · `/revoke` · `/suspend` · `/unsuspend` | POST | Panel tarafı (ADMIN_TOKEN + rol) |
| `/v1/admin/fulfillments/:lineId/complete` | POST | "Kalanları/N adet ata" |
| `/v1/orders/:id/resend` | POST | 60 sn debounce |
| `/v1/orders/:id/revoke` | POST | İade/iptal → müşteri görünümü kapanır |
| `/v1/replacements` | POST/GET | Müşteri "Sorun Bildir" (+ `/:id/messages` iki yönlü yazışma) |
| `/v1/site-mappings` | GET/POST/PATCH/DELETE | Mağazanın kendi eşlemeleri + `/catalog` snapshot push |
| `/v1/catalog` | GET | Bayi/kanal stok durumu — **fiyat DÖNMEZ** (§10) |
| `/v1/connect/claim` | POST | **PUBLIC** — tek kullanımlık bağlan kodu → kimlik (§14) |
| `/v1/updates/plugin/info` · `/download/:v` | GET | **PUBLIC** — eklenti güncelleyici (IP hız sınırlı) |
| `/v1/health` | GET | Sağlık; degrade durumda **503** |

> Uç adları bir dönem şartnamede yanlış yazılıydı: "replacement-requests" (gerçeği
> `/v1/replacements`), "products/mapped" (hiç var olmadı; gerçeği `/v1/catalog`) ve
> atama/tamamlama uçları önekleri olmadan. `pnpm check:docs` artık burada anılan her `/v1/...`
> ucunun gerçek bir controller önekine oturduğunu doğrular — hayalet uç CI'ı kırar.
>
> **Panel uçları `/v1/admin/...` altındadır** (ADMIN_TOKEN + rol); yukarıdaki önek taşımayan
> satırlar mağaza tarafıdır (site HMAC). İkisini karıştırmak yetki kararını da karıştırır.

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

- **Şifreleme:** `license_items.payload_enc` **AES-256-GCM** (Node `crypto`; libsodium
  KULLANILMADI), envelope encryption — payload başına DEK + master key. **AAD kayıt-id'sine
  bağlıdır** (`license_item:<id>` / `site_secret:<id>` / `connect_token:<id>`) → ciphertext'i
  başka bir satıra taşımak çözülemez. AAD ad alanı bir dönem `sites` ile connect-token arasında
  PAYLAŞILIYORDU ve bu, kimlik istemeyen bir ucu **çözme oracle'ına** çeviriyordu — ad alanları
  ayrıldı ve geri düşüş KALDIRILDI. Master key ayrı kasada, DB yedeğinden AYRI, çevrimdışı 2 kopya.
- **Patlama yarıçapı (site ele geçirilirse):** site başına **sert satış kotası** (`sales_daily_quota`,
  advisory-lock altında sayılır → say-sonra-ekle yarışı yok) + **dinamik kota** (30g ort. × çarpan,
  taban 20; aşımda sipariş REDDEDİLMEZ, `held_for_review` ile insan onayına alınır + `quota_review`
  güvenlik olayı) · **HMAC IP başarısızlık tavanı** — yalnız auth-FAIL sayılır, meşru mağaza asla
  kısıtlanmaz · her anahtar yalnız kendi sitesine görünür (çapraz-site erişim 404).
  **Uygulanmayan iki plan:** yüksek adetlide "Woo'ya geri doğrulama" ve **anomali OTO-ASKISI**
  yoktur — anomali/velocity yalnız `security_events`'e YAZILIR, kanalı kimse otomatik durdurmaz
  (§15 "AI/otomasyon önerir, insan onaylar" ilkesiyle bilinçli hizalı).
- **Erişim:** çoklu-admin **scrypt** (argon2 DEĞİL) + imzalı oturum + her istekte iptal kontrolü
  (`token_version`) + **owner/admin RBAC** — düz metin lisans YALNIZ owner'a, owner-olmayan admin
  maskeli görür · **2FA (TOTP, RFC 6238, sıfır bağımlılık)**, kullanıcı başına açılır ·
  DB/Redis dışa kapalı; zod şema doğrulama; parametrik sorgu; güvenlik başlıkları.
  **Uygulanmayan plan:** admin IP kısıtı / VPN (Tailscale) — kurulmadı, operatöre kalan bir iştir.
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

### 13.1 Panel ekranları — rota haritası (38 rota)

> **Bu liste de kod tarafından denetlenir** (`pnpm check:docs`): `apps/admin/app` altındaki her
> sayfa burada geçmelidir. Şartname bir dönem 38 rotanın 36'sını hiç anmıyordu — panelde bir
> ekranın var olup olmadığı ancak kodu okuyarak öğrenilebiliyordu.

| Grup | Rotalar |
|---|---|
| **Operasyon** | `/dashboard` (genel bakış + canlı akış) · `/pending` (Bekleyen Teslimatlar) · `/orders` → `/orders/[id]` · `/review` (inceleme kuyruğu) · `/support` (destek/değişim) |
| **Envanter** | `/stock` (kategori kartları → ürün listesi) · `/stock/import` (stok girişi) · `/products/[id]` (ürün detayı — `/products` → `/stock` yönlendirir) · `/categories` · `/guides` (kurulum rehberleri) · `/inventory` (lisans envanteri) · `/quarantine` (Kusurlu Stok) → `/quarantine/records`, `/quarantine/claims/[id]` |
| **Tedarik** | `/suppliers` → `/suppliers/[id]` · `/purchase-orders` · `/batches` → `/batches/[id]` |
| **Müşteri** | `/customers` (mağaza → müşteri hiyerarşisi) → `/customers/[email]` |
| **Rapor** | `/reports` · `/reports/costs` · `/reports/sla` · `/reports/reorder` |
| **Mağaza bağlantısı** | `/sites` → `/sites/[id]`, `/sites/new` (bağlan sihirbazı) · `/mappings` (ürün eşleştirme + eşleme bekleyen satırlar) |
| **Yapılandırma** | `/templates` → `/templates/new` · `/settings` · `/notifications` · `/guide` (kullanım rehberi) |
| **Sistem** | `/security` · `/audit` (denetim izi) · `/ops` (başarısız işler/outbox) · `/ai` (varsayılan KAPALI) · `/admins` → `/admins/security` (2FA) · `/releases` (eklenti sürümleri) · `/deployments` (dağıtım + yedek) · `/login` |

`bash scripts/smoke-routes.sh <url>` bu ekranların hepsini gezer ve **HTTP koduna değil**,
gövdedeki hata-sınırı imzasına bakar (Next hata sınırı 200 döndürür).

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
- İzleme eşikleri + günlük Telegram özeti (Telegram env-gated; yoksa no-op).
- **DR — HEDEF vs BUGÜNKÜ GERÇEK (karıştırmayın):** hedef RPO ≤ 5 dk / RTO ≤ 2 sa. Bugün
  `pg_dump` + cron + aylık geri-yükleme tatbikatı var; **sürekli WAL arşivleme (PITR) YOK**,
  dolayısıyla **gerçek RPO = son yedek anı**. Dış kopya kancası kurulmamışsa yedek yalnız aynı
  sunucudadır (panel `backup_offsite` alarmı üretir). Adım adım kurulum, eşikler ve kurtarma
  yordamı: **`docs/RUNBOOK-DR.md`** — çelişkide o belge geçerlidir.

---

## 17. Arayüz tasarımı & tasarım sistemi

**Felsefe:** operasyon aracı — "scan edilir, okunmaz". Yoğun tablo, net durum rengi,
her ekranda aynı desen.

**Yığın (kesinleşti — satnaing/shadcn-admin nötr dili):** Referans birebir
**satnaing/shadcn-admin** (shadcn-admin.netlify.app). Tailwind v4 (CSS-first; `tailwind.config.js`
YOK — token'lar `@theme`/`@theme inline`'da) + klasik **shadcn/ui deseni (kod sahipliği) +
Radix UI** primitifleri (Base UI DEĞİL — 2026 indigo/Base UI kararı bırakıldı) + TanStack
Table + Recharts + Geist + Geist Mono / tabular-nums + lucide + cmdk (Ctrl+K) +
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

> **DURUM (2026-08):** Faz 0 · 1 · 2 · 4 **TAMAM ve canlı**. Faz 3 **DÜŞÜRÜLDÜ** (aşağıda).
> Kodlanabilir mimari eksik kalmadı; açık kalanlar yalnız "Bilinçli kapsam DIŞI" başlığındaki
> yapısal maddelerdir. Aşağıdaki liste **planın kendisidir** (ne hedeflenmişti) — ne yapıldığının
> tur-tur kaydı `docs/GECMIS.md`, sürüm bazlı özeti `CHANGELOG.md`.

- **Faz 0 (~1 hafta) ✅:** VPS + Docker Compose + Caddy + PG + Redis; CI/CD; yedek;
  Sentry; NestJS/Next.js monorepo iskeleti; migration altyapısı.
- **Faz 1 (~3-4 hafta) MVP ✅:** şifreli stok + import, atomik atama + idempotency,
  kısmi teslimat motoru + Bekleyen Teslimatlar, sipariş API + şablon + mail, WP eklentisi
  (push, My Account, meta box: göster/değiştir/tekrar gönder/revoke), geri kanal webhook.
  CI yarış testi ilk günden. Lisans Yönetim Paneli'ta 1-2 pilot ürünle canlı (eski eklenti paralel).
- **Faz 2 (~2-3 hafta) ✅:** hesap ürünleri (JSONB), çok kullanımlık, şablon override, 2. site,
  domain doğrulama, mutabakat cron, düşük stok + Telegram, misafir link (site bayrağı),
  akıllı stok önizleme, Ctrl+K, toplu değiştirme, self-servis + müşteri 360, tedarik
  zinciri (PO/karne/import profili), sandbox, velocity + blocklist.
- **Faz 3 ❌ DÜŞÜRÜLDÜ:** eski WP eklentisinden migrasyon (eşleme + kuru çalıştırma, dual-run
  cutover). Gerekçe: kurulum greenfield ilerledi — taşınacak eski bir eklenti veri kümesi
  oluşmadı. Bir gün gerekirse yeniden planlanır; bekleyen iş DEĞİLDİR.
- **Faz 4 (sürekli) ✅:** kâr/maliyet raporları, tedarikçi API, bayi API, kanal adaptörleri,
  risk skoru otomasyonu, AI operasyon, private update endpoint.

---

## Bilinçli kapsam DIŞI (YAGNI kararları)

> Bunlar "eksik" değil, **YAPILMAYACAK** olarak karara bağlanmış maddelerdir. Panelde bir gün
> aranıp bulunamazsa sebebi budur; yeniden tartışmadan önce gerekçeyi oku.

- **Fiyat senkronu / kâr-marjı raporu** — satış fiyatı panelde **YOK** ve olmayacak (§2/§6/§10:
  ödeme ve fiyat mağazanın işidir). Panel yalnız **maliyet** tarafını bilir (`unit_cost_cents`),
  bu yüzden `/reports/costs` "kâr" değil **harcama + stok değerleme + teslim edilen COGS** verir.
- **Marketplace dış-API adaptörü** (Trendyol/Hepsiburada vb. çekme) — çekirdek zaten
  platform-bağımsız (jenerik HMAC `remote*` kontratı); gerekirse **yeni bir adaptör** yazılır,
  çekirdek değişmez.
- **Faz-3: eski WP eklentisinden migrasyon** — kurulum greenfield ilerledi, taşınacak veri yok (§18).
- Yenileme/abonelik entegrasyonu (hatırlatma zinciri, Woo Subscriptions) — hazır ürün modeli
- Havale/EFT stok rezervasyonu — ödeme Woo'da onaylanır, panel ödenmiş siparişi görür
- Seçici 3DS + Ethoca/Verifi — ödeme tamamen site/geçit tarafı
- Paylaşımlı hesap (`max_uses`) ürün olarak var ama paylaşımlı model gerekince genişletilir
- **MAK/çok kullanımlık kusurlu anahtar için panel-içi değişim** — üç değişim yolu da MAK'ı
  bilerek reddeder: geri alınan kapasite AYNI paylaşımlı anahtara döner, yeni atama yine o kusurlu
  anahtarı seçerdi. Arayüz düğmeyi sebebiyle KAPALI sunar (tıklanıp hata veren düğme, hiç
  sunulmayandan kötüdür) ve doğru reçeteyi yazar.
