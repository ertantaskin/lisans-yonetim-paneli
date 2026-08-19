# `docs/` — hangi soru hangi belgede

Belgelerin **hangisinin geçerli olduğu** bir dönem yazılı değildi: README
aylarca "Faz 1 MVP" dedi, şartname var olmayan tabloları anlattı. Sıra artık yazılı —
**çelişki görürsen daha yukarıdaki kazanır**:

| # | Belge | Hangi soruya cevap verir | Denetim |
|---|---|---|---|
| 1 | **Kod** (`apps/api/src/db/schema/`, controller'lar) | "Bu kolon/parametre gerçekte nedir?" | — |
| 2 | **[MIMARI.md](MIMARI.md)** | "Ne, neden, hangi kural?" — şartname (v2.7, 18 bölüm) | `pnpm check:docs` |
| 3 | **[../CLAUDE.md](../CLAUDE.md)** | "Bugün durum ne, hangi tuzaklara dikkat?" | rota sayıları `check:docs` |
| 4 | **[RUNBOOK-RELEASE.md](RUNBOOK-RELEASE.md)** · **[RUNBOOK-DR.md](RUNBOOK-DR.md)** · **[GELISTIRME.md](GELISTIRME.md)** | "Nasıl yapılır?" — yayın/dağıtım · yedek/felaket kurtarma · yerel geliştirme | elle |
| 5 | **[../CHANGELOG.md](../CHANGELOG.md)** · **[DEPLOY-LOG.md](DEPLOY-LOG.md)** | "Ne değişti / ne zaman prod'a gitti?" | elle |
| 6 | **[GECMIS.md](GECMIS.md)** | "Bu karar NEDEN böyle? Hangi arıza yaşandı?" — tur günlüğü | elle |
| 7 | **mimari-gorsel.html** | MIMARI.md'nin görsel kopyası — **ÜRETİLİR** (`pnpm docs:gorsel`), elle düzenlenmez | `check:docs` (bayatsa kırar) |

## Nereden başlamalı

- **Projeye yeni geliyorsan:** [`../README.md`](../README.md) → [MIMARI.md](MIMARI.md) §1-2
  (mimari + para yolu) → [GELISTIRME.md](GELISTIRME.md) (yerelde ayağa kaldır).
- **Kod yazacaksan:** [`../CLAUDE.md`](../CLAUDE.md) → "Tekrarlayan tuzaklar" (her maddesi bu
  projede en az bir kez üretime çıkmış bir arızadır) + ilgili MIMARI bölümü.
- **Dağıtım/yayın yapacaksan:** [RUNBOOK-RELEASE.md](RUNBOOK-RELEASE.md) — panel ve WP eklentisi
  AYRI hedeflerdir, betikler de öyle ([`../scripts/README.md`](../scripts/README.md)).
- **Yedek/kurtarma gerekiyorsa:** [RUNBOOK-DR.md](RUNBOOK-DR.md).
- **"Bu neden böyle yapılmış?" diyorsan:** [GECMIS.md](GECMIS.md) içinde `grep`le
  (ör. `grep -n "advisory-lock" docs/GECMIS.md`).

## MIMARI.md bölüm haritası

| Bölüm | İçerik |
|---|---|
| §1-2 | Genel mimari & yığın · sipariş/teslimat akışı + **atomik atama SQL'i** (sistemin kalbi) |
| §3-4 | Veri modeli (32 tablo) · API sözleşmesi (HMAC imza, hata modeli) |
| §5-7 | Kısmi teslimat · teslimat & mail · WordPress eklentisi (ince istemci) |
| §8-10 | Güvenlik · KVKK/GDPR & saklama · çok kanallı satış |
| §11-13 | Ürün tipi matrisi · stok zekâsı & tedarik · admin deneyimi + **§13.1 rota haritası** |
| §14-16 | Onboarding · AI operasyon · test/sürüm/DR + **§16.1 kuyruklar & zamanlanmış işler** |
| §17-18 | Arayüz tasarımı & tasarım sistemi · yol haritası |
| son | **Bilinçli kapsam DIŞI** (YAGNI kararları — "eksik" değil, yapılmayacak) |
