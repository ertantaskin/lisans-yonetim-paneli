# Lisans Yönetim Paneli — Merkezi Lisans Dağıtım Paneli

Dijital lisans satışı (Windows/Office key, hesaplar, kodlar) için WooCommerce'ten
ayrık merkezi stok/teslimat paneli.

**Tam mimari şartname: [`docs/MIMARI.md`](docs/MIMARI.md)** (v2.7, 18 bölüm — HER önemli
kararda önce bu dokümana bak). Veri modeli, rota haritası ve API tablosu `pnpm check:docs`
ile **kod tarafından denetlenir**; şartname artık sessizce geride kalamaz.
`docs/mimari-gorsel.html` aynı belgenin ELLE hazırlanmış görsel kopyasıdır ve **2026-07-27
tarihli anlık görüntüdür** — çelişki varsa `MIMARI.md` geçerlidir.

## Yığın (kesinleşti)

- NestJS (Node 22, Fastify) API + Next.js admin, pnpm + Turborepo monorepo
- PostgreSQL 17 + Drizzle ORM, Redis 7 + BullMQ, Docker Compose + Caddy
- UI: Tailwind v4 + shadcn/ui + TanStack Table/Query; WP eklentisi ince istemci (PHP)

## Değişmez kurallar

- Lisans verisi ASLA WP veritabanında durmaz; panel tek doğruluk kaynağı
- Atama: `FOR UPDATE SKIP LOCKED` + idempotency key (site+order+line) — çifte satış imkânsız
- Kısmi teslimat birinci sınıf akış (partial-auto varsayılan politika)
- Payload'lar AES-256-GCM envelope encryption; reveal/kopyalama audit'e düşer
- HMAC-SHA256 + timestamp + nonce imzalı API; site başına scope + dinamik satış kotası
- Ödeme tamamen WP/geçit tarafında — panel ödemeye dokunmaz, ödenmiş siparişi görür
- Yenileme/abonelik entegrasyonu YOK (bilinçli kapsam dışı); havale rezervasyonu YOK

## Ürün modeli

`usage_mode: single | multi` (MAK: 1 key = 500 kullanım, atomik kapasite düşümü,
iadede hak otomatik dönmez). Tipler: key, hesap, süreli hesap (`validity_days`,
teslimle başlar), kod/hediye çeki, stoksuz/ön sipariş (`stockless`, `release_at`).

## Görsel kimlik

> **GÜNCEL REFERANS (2026-08-14): shadcnspace** — `dashboard.shadcnspace.com` (analytics +
> ecommerce panoları) tarayıcıda ÖLÇÜLEREK uyarlandı. Aşağıdaki satnaing/shadcn-admin bölümü
> **paletin ve token mimarisinin** kaynağı olarak GEÇERLİ (ikisi de standart shadcn nötr oklch
> paletini kullanıyor — ölçüldü, değerler birebir aynı); DEĞİŞEN kısımlar:
> **font Inter/JetBrains Mono → Geist / Geist Mono** (`next/font/google`, `latin-ext` ŞART —
> `latin` alt kümesinde ş/ğ/İ/ı/ç yok) · **`--radius` 0.625rem → 0.5rem** (kart `rounded-xl`
> 12px, düğme/alan `rounded-lg` 8px) · **kabuk `variant="inset"`** (sayfa zemini `bg-sidebar`,
> içerik `m-2 ml-0 rounded-xl outline shadow-sm` ile YÜZEN kart; başlık `sticky top-2` +
> `rounded-t-xl`) · **sidebar aktif öğe DOLU pill** (`bg-primary text-primary-foreground`;
> eskiden soluk `bg-sidebar-accent`), hover `bg-primary/5 text-primary` + `translate-x-1`
> (ikon modunda ve `motion-reduce`'ta kapalı) · **grup etiketi 12px/600 uppercase muted** ·
> **tablo başlığı `h-11 text-sm font-semibold` KOYU, büyük harf YOK** (hücre `px-4 py-3` —
> referansın `py-6`'sı 8-12 kolonlu operasyon tablolarında kullanılamazdı, bilinçli sapma) ·
> **gölge dili `shadow-sm` → `shadow-xs`** (referansla birebir: `0 1px 2px rgb(0 0 0/.05)`) ·
> **yalnız-ikon düğme = DAİRE** · kart `px-6`, başlık 16px, açıklama 14px · StatTile etiketi
> normal cümle düzeninde 14px muted (eskiden 11px BÜYÜK HARF).
>
> **BİLİNÇLİ SAPMALAR (referansı KOPYALAMADIK):** (1) referansın `main`'i `overflow:hidden`
> olduğu için **sticky başlıkları çalışmıyor** (ölçüldü: 600px kaydırınca başlık −592'ye gitti)
> → bizde `overflow-x-clip` + `sticky top-2` ile başlık GERÇEKTEN sabit; (2) `--ring` referansta
> açık temada oklch(0.708) — bizde 0.48 KALIYOR, çünkü odak göstergesi TEK kaynak bu outline'dır
> ve 0.708 kontrastı 6.54:1'den ~2.5:1'e düşürürdü (belgelenmiş a11y kararı, §17); (3) 5 hue'lu
> semantik durum dili (`success/info/warning/attention/destructive`) KORUNDU — referansta yok
> ama panelin durum dili buna bağlı.
>
> **ESKİ TEMA YEDEĞİ (artık geri yüklenebilir DEĞİL):** `apps/admin/theme-backup/legacy/` bir
> TARİHÎ ANLIK GÖRÜNTÜDÜR. Yedek alındıktan sonra durum renkleri beş hue'ya çıktı ve yüzeyler
> `--<hue>-vivid/-fill/-ring` token'larından besleniyor; yedekteki `globals.css` bunları
> TANIMLAMIYOR (ölçüldü: `--success-vivid` yedekte 0, güncelde 6) → geri yükleme sessizce
> renksiz bir arayüz bırakırdı. `restore.sh` bu yüzden varsayılan olarak DURUR
> (`THEME_RESTORE_ONAY=1` ile geçilir); eski bir dosyaya dönmenin doğru yolu git'tir.
> Klasör `tsconfig.json` `exclude` ve `check-use-server.js` `SKIP_DIRS` içinde —
> build'e/taramaya GİRMEZ (girseydi göreli import'lar typecheck'i kırardı).

Referans (palet + token mimarisi): **satnaing/shadcn-admin** (shadcn-admin.netlify.app). Stack: klasik
**shadcn/ui deseni + Radix UI** (Base UI değil) + Tailwind v4 (CSS-first, `tailwind.config.js`
YOK — token'lar `@theme`/`@theme inline` içinde) + TanStack Table + Recharts + lucide +
cmdk + sonner + next-themes; hepsi ücretsiz/MIT. Framework: **Next.js 15 (sunucu-taraflı)**
korunur (şablon Vite olsa da güvenlik gereği). Palet: **standart shadcn nötr oklch** —
`--background/--foreground/--card/--primary/--secondary/--muted/--accent/--border/--ring`
+ `--sidebar-*` + `--chart-1..6`; nötr primary (açıkta koyu, koyuda açık), renk YOK
(monokrom). Semantik uzantı (durum dili, renkli tutulur) — **BEŞ hue** (kullanıcı kararı, eskiden
üçtü): `--success` (emerald: elimde/sağlıklı), **`--info` (mavi: teslim edildi/tamamlandı)**,
`--warning` (amber: bekliyor), **`--attention` (mor: insan kararı — İncelemede/Askıda)**,
`--destructive` (rose: ölü/engelli) — açık temada AA (≥4.5:1) sağlayacak koyulukta, koyu temada
daha açık. Rozet = soluk tint (%13-16) + saç teli `ring-inset` (%28-30). Tema: `.dark` class (next-themes `attribute=class`). **Tek kaynak:**
`apps/admin/app/globals.css`. Kabuk: resmi shadcn **sidebar block** deseni
(`ui/sidebar.tsx` — SidebarProvider/Sidebar/SidebarInset/SidebarTrigger, cookie kalıcılık,
Ctrl/⌘+B, icon-collapse, mobil sheet) + `app-sidebar` + `site-header` (breadcrumb).
**Migrasyon TAMAM:** tüm sayfalar/primitifler standart shadcn token kullanıyor; legacy compat
köprüsü kaldırıldı (kod tabanında sıfır `ink/surface/accent-soft…`). 20 dosya deterministik
codemod ile taşındı, 5-lensli adversaryel denetimden geçti (kritik + kontrast bulguları
düzeltildi), production build + iki temada WCAG AA tarayıcıda doğrulandı.
**KRİTİK NOT:** `@theme inline`'da her renk token'ı base + `-foreground` çift olmalı
(`--color-muted`+`--color-muted-foreground`, `--color-accent`+`--color-accent-foreground`);
base atlanırsa Tailwind v4 o `bg-*` utility'sini HİÇ üretmez (sessiz kırılma).
**UI TAMAMLANDI (canlı):** Siparişler/Stok/Siteler shadcn-admin **DataTable** (TanStack: arama,
faceted filtre, sıralama, sayfalama, kolon görünürlüğü); sipariş detayı Card/Table/StatTile/timeline;
formlar shadcn Input/Label/Textarea/Button/Alert; loading/error/404 state'leri. Ekranlar 2. adversaryel
audit'ten (a11y/kontrast) geçti. **STOK YÖNETİMİ ÜRÜN-MERKEZLİ HUB'A TAŞINDI (commit 3613262, CANLI):**
kullanıcı "/stock çok karışık, çok üründe yönetilemez" dedi → `/stock` 4 ağır bölümü (liste+import+
oluştur+global eşleme) üst üste yığmaktan **sadeleşti** (yalnız ürün DataTable + "Yeni Ürün" Sheet;
7.23→1.93 kB; STOK kolonuna düşük-stok göstergesi). Ürün-özel işler `/products/[id]` DETAY sayfasında
toplandı (bağlamsal): **Key/Stok İçe Aktar** (ürün SABİT→dropdown yok), **Site Eşlemeleri** (yalnız o
ürünün eşlemeleri), başlıkta **Düzenle**. Backend: `products/:id/detail` eşlemeleri de döndürür
(detailMappings, migration YOK); global "tüm eşlemeler" tablosu kaldırıldı (ürün+site bazına). Bileşenler
parametreleştirildi (import-stock-form `fixedProductId`, mappings-manager `productId`, edit/create Sheet
ayrıştırıldı); batches "stok gir" derin bağlantısı `/products/{id}?batchId=`. typecheck+build temiz, deploy. **ÇOKLU-ADMIN AUTH (§8, 4 faz, canlı, adversaryel-denetimli):**
API `admin_users` (scrypt/role/token_version, migration 0007-0008) + `auth/login|validate` + CRUD;
Next imzalı oturum (HMAC, role+ver, TTL 12s) + middleware her-istek `validate` (revocation) +
`/admins` owner-only RBAC + open-redirect/rate-limit/atomik-lockout korumaları. **env-gated
(SESSION_SECRET + ADMIN_SEED_*), varsayılan KAPALI** (auth kapalıyken UI sarı uyarı bandı) —
aktivasyon + detay: memory `admin-auth`. **Kritik:** login/logout MUTLAKA native form POST → Route
Handler (Server Action + redirect cookie'yi bindiremiyor). Detay: MIMARI.md §17. Marka: "Lisans Paneli".

## Durum — özet

**Tasarım (v2.6) + Faz 0 + Faz 1 + Faz 2 TAMAM; panel ve WP eklentisi CANLI.** Kodlanabilir
mimari eksik yok; kalanlar yalnız yapısal kapsam-dışı maddeler (aşağıda).

| | |
|---|---|
| Prod | Ubuntu VPS + Docker Compose + Caddy TLS · API+admin **v1.1.0** · `/v1/health` 200 |
| Dev/staging | Aynı VPS, ayrı compose projesi (`lisansdev`) + kendi WordPress'i — prod'a DOKUNMAZ |
| Servisler | PostgreSQL 17 · Redis 7 · API (Nest/Fastify) · Admin (Next 15) · Caddy · Mailpit |
| Migration | **0000-0046** (`__drizzle_migrations` izleme 47) |
| WP eklentisi | **v1.1.7** — panelden yayınlanır, müşteri siteleri updater ile alır |
| Test | birim 68+184+170 · **entegrasyon 454 + yarış 3** (izole PG/Redis) · WP davranış 108 · PHP-lint 13 |

**Zincir kanıtlandı (gerçek WooCommerce):** sipariş → HMAC push → atomik atama (SKIP LOCKED) →
My Account'ta çözülmüş anahtar → geri-kanal webhook. Tek/çok kullanımlık (MAK), hesap, süreli
hesap, kod, stoksuz; kısmi teslimat, ya-hep-ya-hiç, iade/kısmi iade, değişim, inceleme kuyruğu.

### Ne nerede

- **API** (`apps/api/src`): 42 Nest modülü. Çekirdek para yolu `orders/` (createOrder ·
  fulfillment · admin-orders · pending-lines) + `assignment/assign.ts` (atama SQL'i) +
  `stock/` (import/envanter/düzeltme). Yan alanlar: replacements · supplier-claims · suppliers ·
  purchase-orders · batches · customers · security · notifications · maintenance (retention/
  reconcile/expiry) · deployments · updates · ai (varsayılan KAPALI) · admin-users (2FA).
- **Admin** (`apps/admin/app`): 38 sayfa rotası (duman testi 36 tarar — `/` ve `/login` hariç). Sözlükler **tek kaynak** `lib/labels.ts`; rozet ton
  kuralı `components/ui/badge.tsx`; tema tek kaynak `app/globals.css`.
- **Eklenti** (`apps/wp-plugin/wpteslimat`): ince istemci. Lisans verisi WP'de DURMAZ.
- **Paylaşılan** (`packages/shared/src`): payload kontratı, maskeleme, rehber render, risk skoru
  — panel ve mail aynı fonksiyonu kullanır (iki uygulama er geç ayrışır).

### Yapısal kapsam-DIŞI (uydurulamaz, bilinçli)

Fiyat senkronu / kâr-marjı (satış fiyatı panelde YOK — §2/§6/§10) · marketplace dış-API
adaptörü · Faz-3 WP migrasyonu · abonelik/EFT/3DS.

### Operatöre kalan (kod değil)

- **Prod `SMTP_HOST` tanımsız** → teslimat mailleri gerçek müşteriye ULAŞMIYOR. Panel bunu her
  boot'ta kritik alarmla söyler (`mail_config`).
- **`BACKUP_OFFSITE_CMD` tanımsız** → yedekler yalnız o sunucuda (`backup_offsite` alarmı).

## Tekrarlayan tuzaklar — kod yazmadan ÖNCE oku

Bu liste tahmin değil: her maddesi bu projede **en az bir kez üretime çıkmış** ya da ölçülerek
yakalanmış bir arızadır. Ayrıntılı vaka anlatımları [docs/GECMIS.md](docs/GECMIS.md) içinde.

1. **H1 sınıfı — yeni terminal durum eklerken TÜM revoke/iade/değişim yollarını gözden geçir.**
   Beş kez tekrarladı (`canceled` · `held_for_review` · `suspended` · `canceled_units` · MAK
   kapasitesi). Bir durumu bir kümeye eklemek, o kümeyi okuyan HER yolu (revokeOrderForSite ·
   syncRefunds · revokeExcess · reconcileOrder · completeLine) etkiler; birini atlamak "bedava
   lisans" ya da "müşterinin canlı anahtarını yakma" üretir.
2. **Kendi düzeltmen yeni yol açar.** Her davranış değişikliğinden sonra bağımsız bir gözle
   yeniden denetle; düzeltme commit'i denetimin BİTİŞİ değil.
3. **Bir kolona ikinci anlam yükleme.** `qty` hem mağaza gerçeği hem doldurma hedefi olunca H1
   yeniden açıldı → ayrı defter (`canceled_units`) + tek türetilmiş tanım (`fillTarget`).
4. **Aynı kavramın İKİ tanımı çelişir.** "Satılmış birim", "atanabilir stok", "satış", "eşleme
   çözümü", rozet sözlükleri… hepsi bir kez ayrıştı. Yeni bir yüklem yazmadan önce mevcut olanı
   ARA ve paylaş (`notExpiredCond` · `STANDING_STATUSES` · `fillTargetSql` · `labels.ts`).
5. **Transaction gövdesinden `this.db` çağırma** — postgres.js'te tx bir bağlantı rezerve eder;
   kök havuzdan ikinci sorgu istemek havuz boyutu kadar eşzamanlılıkta KİLİTLENME üretir
   (k6 ile iki kez ölçüldü: `/v1/health` bile cevapsız kaldı). Kapı: `pnpm check:tx-pool`.
6. **`UPDATE … WHERE id IN/= (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` AŞIRI TESLİMAT üretir.**
   EvalPlanQual alt sorguyu yeniden koşturur, LIMIT fiilen kalkar (ölçüldü: 6 istenirken 20
   satır). Doğrusu `WITH … AS MATERIALIZED` ya da seç/güncelle ayrı ifade + fail-closed kalkan.
7. **LIMIT'li her `ORDER BY`ın benzersiz tie-break'i olmalı.** Aynı transaction'da yazılan
   satırların `created_at` damgaları BİREBİR eşittir (`now()` = tx başı) → sıra keyfi olur.
   Yön AYNA DEĞİLDİR: `DESC` ve `ASC` için ayrı index gerekir.
8. **Sessiz yutma yasak.** `catch {}` ile geçilen bir mail/webhook/audit, operatöre "başarılı"
   der ve müşteri lisansını hiç almaz. Yutulacaksa LOG + görünür olay bırak.
9. **Sessiz kırpma yasak.** LIMIT uygulanan her liste `truncated` ile bunu SÖYLEMELİ; sessiz
   kırpma "o kayıt yok" dedirtti.
10. **Ondalık/ayraç ayrıştırmasında sessiz 10×/1000× hatası.** Ayraç ancak ardından TAM 3 rakam
    gelirse binliktir (`500.0` → 5000 hatası ölçüldü).
11. **Kapı yazdıysan KONTROL DENEMESİ yap:** düzeltmeyi geri al, kapının/testin KIRMIZI olduğunu
    GÖR. Az denetleyen bir denetleyici, denetleyici yokluğundan BETERDİR (yanlış güven verir).
    Bir test fix geri alındığında da geçiyorsa, o testi "regresyon yakalar" diye anlatma.
12. **Env okuması compose'dan geçmezse `.env`'e yazmak ETKİSİZDİR** (iki kez yaşandı) →
    `pnpm check:env`. **DI/kuyruk kablolaması eksikse API HİÇ BOOT ETMEZ** ve `tsc` görmez →
    `pnpm check:nest-wiring`.
13. **`'use server'` dosyasından obje/değer export'u** `next build`'de TEMİZ geçer, tıklamada
    patlar (iki kez canlıda kırıldı) → `pnpm check:use-server`.
14. **Migration `when` damgası** bir öncekinden KÜÇÜK olursa migration sessizce HİÇ uygulanmaz
    (elle yazılan dosyalarda uydurma damga kullanıldığı için iki kez yaşandı).
15. **drizzle `sql` şablonunun İÇİNDE ters tırnak kullanma** — şablonu erken kapatır (bu projede
    on kez; `tsc` TS1005 ile yakalıyor). `ANY(${dizi}::uuid[])` de drizzle şablonunda BOZUK SQL
    üretir → parametreli `IN (...)` ya da JOIN.
16. **Güvenlik düzeltmesinin içinde "eski davranışa geri düşüş" bırakma** — düzeltme YAPILMAMIŞ
    sayılır (AAD oracle'ı böyle açık kaldı). Ve yeni bir guard/regex tanımladıysan enforcement
    yolunda GERÇEKTEN çağrıldığını grep'le.
17. **Fail-safe bir kapı SESSİZ olursa arıza teşhis edilemez** — eklenti günlerce panele hiç
    istek göndermedi, kimse fark etmedi. Bloklayan her kapı GÖRÜNÜR uyarı bırakmalı.
18. **Kullanıcı kararıyla davranış değişince o davranışı kodlayan TESTİ de güncelle.**
19. **Aralıklı kırmızıyı "gürültü" sayma** — aylarca öyle sanılan şey canlı bir para-yolu
    hatasıydı. Kontrol deneyi kur (değişikliğin olmadığı yolda da oluyor mu?).
20. **Doğrulama tarayıcısının sınırları:** klavye olayları ve CSS animasyonları çalışmıyor,
    Radix sekmeleri programatik `.click()` ile değişmiyor, `loading.tsx` olan rotalar ilk
    yüklemede iskelette kalıyor. Buradaki bir "ölçümü" canlı hata saymadan önce kontrol denemesi yap.
21. **Kodda duran bir `TODO` çoğu zaman "yapılmadı" değil, ÇALIŞAN BİR ARIZAdır.** İki örnek
    aynı turda çıktı: dağıtım listesi süzgeci (~50 günde `/releases` "yayın yok" diyordu) ve
    haftalık TAM mutabakat (kod "ayrı bir cron tetiklemeli" diyordu, hiçbir şey tetiklemiyordu).
    İkisinde de teşhis DOĞRU yazılmıştı; eksik olan çözümdü — yorumun ikna ediciliği, işin
    yapılmış olduğu izlenimini veriyordu.
22. **Bir yardımcının "tekillik" sözleşmesi, sonraki ihtiyacı SESSİZCE imkânsız kılabilir.**
    `upsertSoleJobScheduler` ("bu kuyrukta tam olarak bir zamanlayıcı") aynı kuyruğa ikinci
    tekrarlı iş eklemeyi engelliyordu: her çağrı diğerini yetim sayıp siliyor, geriye yalnız
    bir `warn` kalıyordu. Bir invaryantı zorlarken, onu GENİŞLETME yolunu da bırak.

## Doğrulama

| Komut | Kapsam |
|---|---|
| `pnpm typecheck` | 4 paket tipi **+ altı kapı**: use-server · nest-wiring · env · workflows · tx-pool · **docs** (şartname↔kod) |
| `pnpm test` | Birim (shared + api + admin) |
| `pnpm test:iso` | **Entegrasyon + yarış, izole PG17/Redis7 konteynerleriyle** (yalnız `docker` ister) |
| `pnpm build` | Üç paket derlemesi (admin production build dahil) |
| `bash scripts/smoke-routes.sh <url>` | 36 admin rotası (`/` ve `/login` hariç; liste app/ ağacıyla otomatik karşılaştırılır) — HTTP koduna DEĞİL, gövdedeki `error.tsx` imzasına bakar |

Şema sapması: `pnpm db:generate` **"No schema changes"** demeli. WP: `php -l` + `php
apps/wp-plugin/tests/run.php`. CI (`.github/workflows/ci.yml`) hepsini koşar — dosya bir kez
geçersiz YAML olduğu için **19 gün boyunca hiç koşmadı**, o yüzden `check-workflows` kapısı var.

## Geliştirme

**Yayın/dağıtım (özet — tam süreç `docs/RUNBOOK-RELEASE.md`):** Panel: kod → dev'de test →
`git push` → VPS'te `./scripts/deploy.sh api admin` (sağlık kapısı + otomatik rollback).
WP eklentisi: `./scripts/release-plugin.sh <sürüm>` (sürüm bump + commit, geliştirme makinesi)
ya da panelden `/releases` (VPS'te `publish-plugin.sh`, repo HEAD'inden paketler).
İzole dev (VPS): `./scripts/dev-stack.sh up|wp|down|status`. Yerel WP dev: `pnpm wp:dev`.
Geçmiş: `CHANGELOG.md` + `docs/DEPLOY-LOG.md`.

`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy+Mailpit). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Kısayollar: `pnpm stack:up|down|logs`, `pnpm wp:dev|wp:down|wp:cli`.

Entegrasyon/yarış paketi gerçek PG+Redis ister: **`pnpm test:iso`** kendi izole konteynerlerini
kurar (host'ta node/pnpm gerekmez, prod/dev yığınlarına dokunmaz). Var olan bir DB'ye karşı
koşmak için `pnpm test:integration` / `pnpm test:race` (`DATABASE_URL`+`REDIS_URL`+`MASTER_KEY`).
DB dışa kapalıdır; host'tan erişim için `docker-compose.override.yml.example` kopyalanır.

Lokal Node 22 önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.

## Belge haritası — hangisi geçerli

Çelişki görürsen **daha yukarıdaki kazanır**. Bu sıra yazılı olmadığı için bir dönem README
aylarca "Faz 1 MVP" dedi ve şartname var olmayan tabloları anlattı.

| # | Belge | Ne söyler | Denetim |
|---|---|---|---|
| 1 | **Kod** (`apps/api/src/db/schema/`, controller'lar) | Kolon/parametre düzeyinde GERÇEK | — |
| 2 | **[docs/MIMARI.md](docs/MIMARI.md)** | Şartname: ne, neden, hangi kural (v2.7) | `pnpm check:docs` (tablo · rota · uç) |
| 3 | **Bu dosya (CLAUDE.md)** | Güncel durum özeti + değişmez kurallar + tekrarlayan tuzaklar | elle |
| 4 | **Runbook'lar** (`RUNBOOK-RELEASE`, `RUNBOOK-DR`, `GELISTIRME`) | Nasıl yapılır (yayın/DR/yerel) | elle |
| 5 | `CHANGELOG.md` · `docs/DEPLOY-LOG.md` | Sürüm ve dağıtım geçmişi | elle |
| 6 | **[docs/GECMIS.md](docs/GECMIS.md)** | Tur-tur çalışma günlüğü — şartname DEĞİL | elle |
| 7 | `docs/mimari-gorsel.html` | Şartnamenin **2026-07-27 tarihli** görsel anlık görüntüsü | **YOK** (geride kalabilir) |

Panel içindeki **`/guide`** ekranı operatöre yöneliktir (bu dosyalar geliştiriciye). "Tekrarlayan
tuzaklar" listesi GECMIS.md'nin damıtılmış hâlidir; bir maddenin ARDINDAKİ vakayı okumak
istersen orada ara.
