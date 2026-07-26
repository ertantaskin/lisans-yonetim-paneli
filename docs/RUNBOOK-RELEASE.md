# Yayın Runbook'u (Release Runbook)

Bu belge **yayın sürecinin tek doğruluk kaynağıdır** — kim (insan veya AI oturumu)
dağıtım yapacaksa bu adımları izler. Amaç: her seferinde aynı, güvenli, izlenebilir süreç.

## Altın kural

> **Kod git'te yaşar. Ortamlar sadece git checkout + docker build'dir.**
> Prod'a asla elle dokunma; değişikliği **git üzerinden terfi ettir**. Dev'in verisi
> (test sipariş/site/stok) prod'a GİTMEZ — ayrı DB'de kalır. Sadece kod taşınır.

## Ortamlar

| Ortam | Nerede | Amaç | Veri |
|---|---|---|---|
| **Yerel dev** | Windows / `docker compose` | Hızlı geliştirme + test | Yerel DB (atılabilir) |
| **İzole dev/staging** | VPS, `-p lisansdev` projesi | Prod'a gitmeden gerçek ortam testi | Ayrı DB/ağ (prod'a dokunmaz) |
| **Prod** | VPS, `/opt/lisans-yonetim-paneli` | Canlı — müşteriye açık | Prod DB |

İki dağıtım **hedefi** ayrıdır:
1. **Panel** (API + Admin) → bizim sunucumuz → `scripts/deploy.sh`.
2. **WP eklentisi** → müşterinin WordPress siteleri → `scripts/release-plugin.sh` + `/releases`.

---

## A. Panel sürümü çıkarma (kod → prod)

1. **Geliştir** (yerel veya izole dev). Değişikliği test et:
   ```bash
   pnpm typecheck && pnpm build
   pnpm --filter @jetlisans/api test        # birim
   # davranış değiştiyse VPS izole test DB'sinde entegrasyon+yarış (bkz. RUNBOOK-DR / CLAUDE.md)
   ```
2. **CHANGELOG.md** → `[Yayınlanmamış]` altına ne değiştiğini yaz.
3. **Sürüm** (kullanıcı-görünür değişiklik veya birikmiş iş varsa): `package.json` version'ı
   SemVer'e göre artır (yama=fix, minör=özellik, majör=kırıcı). `[Yayınlanmamış]` → `[X.Y.Z] - TARİH`.
4. **Commit + push:**
   ```bash
   git add -A && git commit -m "..."   # sonunda Co-Authored-By trailer
   git push origin main
   git tag vX.Y.Z && git push origin vX.Y.Z    # sürüm çıktıysa
   ```
5. **Dağıt** (prod'da çalışır):
   ```bash
   ssh -i <key> root@167.233.108.12 'cd /opt/lisans-yonetim-paneli && ./scripts/deploy.sh api admin'
   ```
   `deploy.sh` şunları yapar: `git pull` → değişen servis(ler)i build → `up -d` →
   migration (api açılışında otomatik: `migrate.js && main.js`) → `/health` 200 kontrolü →
   **başarısızsa otomatik geri alma** (önceki commit'e checkout + rebuild) → `docs/DEPLOY-LOG.md`'ye kayıt.
6. **Doğrula:** `curl https://api.167-233-108-12.sslip.io/v1/health` → `{"status":"ok"}`.

### Geri alma (rollback)
`deploy.sh` health başarısızsa otomatik geri alır. Elle geri almak için:
```bash
ssh ... 'cd /opt/lisans-yonetim-paneli && git checkout <önceki-sha> && ./scripts/deploy.sh api admin'
```
Migration geri alma: migration'lar ileri-uyumlu additive'dir; şema geri almak GEREKMEZ
(eski kod yeni şemayla çalışır). Gerekirse DB yedeğinden dön (bkz. RUNBOOK-DR).

---

## B. WP eklentisi sürümü çıkarma (kod → müşteri siteleri)

Eklenti müşterinin sitesinde çalışır; güncelleme **panel üzerinden** dağıtılır (eklenti
kendi güncelleyicisiyle `/v1/updates/plugin/info`'yu yoklar).

1. **Geliştir + test** — yerel/izole WP dev sitesinde (`scripts/wp-dev.sh`; plugin bind-mount
   → anında yansır). Klon guard, sipariş push, teslimat, webhook akışını dene.
2. **Yayınla:**
   ```bash
   ./scripts/release-plugin.sh <yeni-sürüm>     # ör. 0.2.0
   ```
   Script: `jetlisans.php` + `readme.txt` sürümünü günceller → temiz `.zip` paketler →
   panele publish (`POST /v1/admin/updates/plugin`, ADMIN_TOKEN) → CHANGELOG'a not.
   Alternatif (UI): panelde **Sürümler (/releases)** → "Yeni sürüm yayınla" (zip yükle).
3. **Doğrula:** panelde **/releases** listesinde yeni sürüm görünür; müşteri sitesi
   WP yönetici → Güncellemeler'de eklentiyi güncelleyebilir.

> SemVer: yama = hata düzeltme; minör = yeni özellik; majör = kırıcı/uyumsuz değişiklik.

---

## C. İzole dev/staging (VPS'te)

Prod'a dokunmadan gerçek bir ortamda test için ayrı proje:
```bash
# VPS'te (ayrı proje adı → ayrı DB/ağ/volume; prod ile karışmaz)
ssh ... 'cd /opt/lisans-dev && docker compose -p lisansdev --env-file .env.dev up -d --build'
```
Detay + alt-alan adları: `docs/GELISTIRME.md` ve dev override dosyaları. İzole yığın
kendi Postgres/Redis/DB'siyle çalışır → test siparişleri prod DB'sine **asla** yazılmaz.

---

## Kontrol listesi (her yayında)

- [ ] typecheck + build temiz
- [ ] ilgili testler geçti (davranış değiştiyse entegrasyon/yarış)
- [ ] CHANGELOG güncellendi
- [ ] sürüm artırıldı + tag atıldı (sürüm çıktıysa)
- [ ] `deploy.sh` health 200 döndü
- [ ] DEPLOY-LOG.md satırı eklendi (deploy.sh otomatik ekler)
- [ ] (eklentiyse) /releases'te yeni sürüm göründü
