# Lisans Yönetim Paneli — Merkezi Lisans Dağıtım Paneli

Dijital lisans satışı (Windows/Office key, hesaplar, kodlar) için WooCommerce'ten
ayrık merkezi stok/teslimat paneli.

**Tam mimari şartname: [`docs/MIMARI.md`](docs/MIMARI.md)** (v2.7, 18 bölüm — HER önemli
kararda önce bu dokümana bak). Veri modeli, rota haritası ve API tablosu `pnpm check:docs`
ile **kod tarafından denetlenir**; şartname artık sessizce geride kalamaz.
`docs/mimari-gorsel.html` aynı belgenin **üretilmiş** görsel kopyasıdır (`pnpm docs:gorsel`);
elle düzenlenmez, bayatsa `pnpm check:docs` kırar.

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

## Görsel kimlik (özet — **tam tanım: [MIMARI.md §17](docs/MIMARI.md)**)

Referans: **satnaing/shadcn-admin** paleti + **shadcnspace** (2026-08-14, tarayıcıda ÖLÇÜLEREK
uyarlandı). Kısaca: standart shadcn **nötr oklch** paleti (monokrom, nötr primary) · **beş hue**
durum dili (`success/info/warning/attention/destructive`) + `-vivid/-fill/-ring` yüzey katmanı ·
**Geist / Geist Mono** (`latin-ext` ŞART — `latin` alt kümesinde ş/ğ/İ/ı/ç yok) · `--radius`
**0.5rem** · kabuk shadcn **sidebar block** `variant="inset"` · Radix (Base UI DEĞİL) + TanStack
Table + Recharts + lucide + cmdk + sonner + next-themes; hepsi ücretsiz/MIT.

**Tek kaynaklar:** tema `apps/admin/app/globals.css` · rozet tonu `components/ui/badge.tsx` ·
sözlükler `lib/labels.ts` · menü `components/shell/nav.ts`.

Token tablosu, ölçülen kontrastlar, **bilinçli sapmalar** (`--ring` 0.48'de kalır · gerçekten
sabit sticky başlık · beş hue) ve menü hiyerarşisi **MIMARI.md §17**'dedir — burada
TEKRARLANMAZ (aynı içeriğin iki elle sürdürülen kopyası bu projede tekrarlayan arızadır, #4).

### Kod yazmadan önce bilinmesi gerekenler

- **Tailwind v4 `@theme inline`'da her renk token'ı base + `-foreground` ÇİFT olmalı**
  (`--color-muted` + `--color-muted-foreground`); base atlanırsa Tailwind o `bg-*` utility'sini
  HİÇ üretmez — **sessiz kırılma**.
- **`apps/admin/theme-backup/legacy/` geri yüklenebilir DEĞİL** — tarihî anlık görüntüdür.
  Yedekten sonra durum renkleri beş hue'ya çıktı ve yüzeyler `--<hue>-vivid/-fill/-ring`
  token'larından besleniyor; yedekteki `globals.css` bunları TANIMLAMIYOR (ölçüldü:
  `--success-vivid` yedekte 0, güncelde 6) → geri yükleme sessizce renksiz bir arayüz bırakırdı.
  `restore.sh` bu yüzden varsayılan olarak DURUR (`THEME_RESTORE_ONAY=1` ile geçilir); eski bir
  dosyaya dönmenin doğru yolu **git**'tir. Klasör `tsconfig.json` `exclude`,
  `check-use-server.js` `SKIP_DIRS` ve ESLint `ignores` içinde — build'e/taramaya GİRMEZ.
- **login/logout MUTLAKA native form POST → Route Handler** olmalı; Server Action + redirect
  cookie'yi bindiremiyor (canlıda iki kez kırıldı).

## Durum — özet

**Tasarım (v2.6) + Faz 0 + Faz 1 + Faz 2 TAMAM; panel ve WP eklentisi CANLI.** Kodlanabilir
mimari eksik yok; kalanlar yalnız yapısal kapsam-dışı maddeler (aşağıda).

| | |
|---|---|
| Prod | Ubuntu VPS + Docker Compose + Caddy TLS · API+admin **v1.2.0** (`a0a944d`, etiket `v1.2.0`) · `/v1/health` 200 — 2026-08-19 ölçüldü: db+redis ok, 0 ERROR |
| Dev/staging | Aynı VPS, ayrı compose projesi (`lisansdev`) + kendi WordPress'i — prod'a DOKUNMAZ · `/v1/health` 200 (henüz **v1.1.0**; dev yığını ayrıca `dev-stack.sh up` ile tazelenir) |
| Servisler | PostgreSQL 17 · Redis 7 · API (Nest/Fastify) · Admin (Next 15) · Caddy · Mailpit |
| Migration | **0000-0046** (`__drizzle_migrations` izleme 47) |
| WP eklentisi | **v1.1.8** — kaynak = yayınlanan (2026-08-19 ölçüldü: `/v1/updates/plugin/info` → 1.1.8, download 200); sürüm üç yazımı `pnpm check:plugin-version` ile denetleniyor |
| Test | birim 68+184+170 · **entegrasyon 455 + yarış 3** (izole PG/Redis) · WP davranış 108 · PHP-lint 13 |

**Zincir kanıtlandı (gerçek WooCommerce):** sipariş → HMAC push → atomik atama (SKIP LOCKED) →
My Account'ta çözülmüş anahtar → geri-kanal webhook. Tek/çok kullanımlık (MAK), hesap, süreli
hesap, kod, stoksuz; kısmi teslimat, ya-hep-ya-hiç, iade/kısmi iade, değişim, inceleme kuyruğu.


### Tamamlanan büyük turlar (ayrıntı: CHANGELOG · docs/GECMIS.md)

- **UI migrasyonu TAMAM:** tüm sayfa/primitifler standart shadcn token kullanıyor, legacy compat
  köprüsü kaldırıldı (kod tabanında sıfır `ink/surface/accent-soft…`); 20 dosya deterministik
  codemod ile taşındı, 5 lensli adversaryel denetimden geçti, iki temada WCAG AA tarayıcıda
  doğrulandı. Siparişler/Stok/Siteler **DataTable** (arama · faceted filtre · sıralama ·
  sayfalama · kolon görünürlüğü); sipariş detayı Card/Table/StatTile/timeline.
- **Stok yönetimi ürün-merkezli hub (commit 3613262):** `/stock` yalnız ürün DataTable + "Yeni
  Ürün" Sheet (7.23→1.93 kB); ürün-özel işler `/products/[id]` detayında toplandı (Key/Stok İçe
  Aktar — ürün SABİT, Site Eşlemeleri — yalnız o ürünün, başlıkta Düzenle). `products/:id/detail`
  eşlemeleri de döndürür; global "tüm eşlemeler" tablosu kaldırıldı. Migration YOK.
- **Çoklu-admin auth (§8, canlı, adversaryel-denetimli):** `admin_users` (scrypt · role ·
  token_version, migration 0007-0008) + `auth/login|validate` + CRUD; Next imzalı oturum (HMAC,
  role+ver, TTL 12s) + middleware her istekte `validate` (anlık iptal) + `/admins` owner-only RBAC
  + open-redirect/rate-limit/atomik-lockout korumaları. **env-gated (`SESSION_SECRET` +
  `ADMIN_SEED_*`), varsayılan KAPALI** (auth kapalıyken UI sarı uyarı bandı). Aktivasyon: memory
  `admin-auth`. Marka: "Lisans Paneli".

### Ne nerede

- **API** (`apps/api/src`): 42 Nest modülü. Çekirdek para yolu `orders/` (createOrder ·
  fulfillment · admin-orders · pending-lines) + `assignment/assign.ts` (atama SQL'i) +
  `stock/` (import/envanter/düzeltme). Yan alanlar: replacements · supplier-claims · suppliers ·
  purchase-orders · batches · customers · security · notifications · maintenance (retention/
  reconcile/expiry) · deployments · updates · ai (varsayılan KAPALI) · admin-users (2FA).
- **Admin** (`apps/admin/app`): 38 sayfa rotası (kök `/` sayılmaz; duman testi 37 tarar — yalnız
  `/login` hariç; sayılar `pnpm check:docs` ile denetlenir). Sözlükler **tek kaynak** `lib/labels.ts`; rozet ton
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
- **Dev/staging yığını eski sürümde** (v1.1.0) — prod v1.2.0'a geçti. Gerçek bir dev testi
  gerektiğinde `./scripts/dev-stack.sh up` ile tazelenir; prod'u ETKİLEMEZ.

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
23. **"Uyarı olarak koşan" bir adım = adım var, DENETİM YOK.** CI'ın `Lint` adımı
    `continue-on-error: true` idi ve **134 hata** üretiyordu; hataların tamamı yapılandırma
    boşluğundan (`scripts/*.js` Node genel değişkenleriyle tanımlı değil) geliyordu, yani
    gerçek bir bulgu bu gürültünün içinde asla görünmezdi. Aynı sınıf: kodda `react-hooks/…`
    bastırmaları vardı ama eklenti KURULU DEĞİLDİ (yazar kuralın koştuğunu varsaymış).
    Bir adımı "şimdilik uyarı" bırakacaksan, ne zaman bloklayıcı olacağını da yaz.
24. **Bir kapı TEK YÖNLÜ denetliyorsa, ters yön sessizce bozulur.** `check-docs` "koddaki her
    ekran belgede geçiyor mu" diye bakıyordu; belgenin var OLMAYAN bir ekranı (`/inventory`)
    anlatması hiç görülmedi. Aynı kapının kurulma sebebi zaten "belge 4 uydurma tablo
    anlatıyordu" idi. Denetim yazarken iki yönü de sor: eksik ne var, FAZLA ne var?

## Doğrulama

| Komut | Kapsam |
|---|---|
| `pnpm typecheck` | 4 paket tipi **+ yedi kapı**: use-server · nest-wiring · env · workflows · tx-pool · **plugin-version** · **docs** (şartname↔kod: tablo · rota · **hayalet ekran** · **rota sayısı iddiaları** · uç · **üretilmiş görsel kopya**) |
| `pnpm lint` | ESLint — **CI'da bloklayıcı** (2026-08-19'a kadar `continue-on-error` idi ve her koşuda kırmızıydı; yapılandırma boşluğu kapatıldı, 134 hata → 0) |
| `pnpm test` | Birim (shared + api + admin) |
| `pnpm test:iso` | **Entegrasyon + yarış, izole PG17/Redis7 konteynerleriyle** (yalnız `docker` ister) |
| `pnpm build` | Üç paket derlemesi (admin production build dahil) |
| `bash scripts/smoke-routes.sh <url>` | 37 admin rotası (`/` ve `/login` hariç; liste app/ ağacıyla otomatik karşılaştırılır) — HTTP koduna DEĞİL, gövdedeki `error.tsx` imzasına bakar |

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

Aynı harita klasörlerin İÇİNDE de duruyor (oraya bakan biri buraya bakmayabilir):
[`docs/README.md`](docs/README.md) — hangi soru hangi belgede + MIMARI bölüm haritası ·
[`scripts/README.md`](scripts/README.md) — hangi betik NEREDE koşar (dev makinesi ↔ VPS) + kapılar.

| # | Belge | Ne söyler | Denetim |
|---|---|---|---|
| 1 | **Kod** (`apps/api/src/db/schema/`, controller'lar) | Kolon/parametre düzeyinde GERÇEK | — |
| 2 | **[docs/MIMARI.md](docs/MIMARI.md)** | Şartname: ne, neden, hangi kural (v2.7) | `pnpm check:docs` (tablo · **kuyruk** · rota · hayalet ekran · rota sayısı · uç · görsel kopya) |
| 3 | **Bu dosya (CLAUDE.md)** | Güncel durum özeti + değişmez kurallar + tekrarlayan tuzaklar | rota sayıları `pnpm check:docs`, gerisi elle |
| 4 | **Runbook'lar** (`RUNBOOK-RELEASE`, `RUNBOOK-DR`, `GELISTIRME`) | Nasıl yapılır (yayın/DR/yerel) | elle |
| 5 | `CHANGELOG.md` · `docs/DEPLOY-LOG.md` | Sürüm ve dağıtım geçmişi | elle |
| 6 | **[docs/GECMIS.md](docs/GECMIS.md)** | Tur-tur çalışma günlüğü — şartname DEĞİL | elle |
| 7 | `docs/mimari-gorsel.html` | Şartnamenin görsel kopyası — **ÜRETİLİR** (`pnpm docs:gorsel`), elle düzenlenmez | `pnpm check:docs` (bayatsa kırar) |

Panel içindeki **`/guide`** ekranı operatöre yöneliktir (bu dosyalar geliştiriciye). "Tekrarlayan
tuzaklar" listesi GECMIS.md'nin damıtılmış hâlidir; bir maddenin ARDINDAKİ vakayı okumak
istersen orada ara.
