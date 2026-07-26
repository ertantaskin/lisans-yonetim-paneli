# Dağıtım Günlüğü (Deploy Log)

Prod'a (VPS) yapılan her dağıtımın **append-only** kaydı. En yeni en üstte.
Her satır: tarih · sürüm/commit · ne dağıtıldı · sonuç. `scripts/deploy.sh` bu dosyaya
otomatik satır ekler; elle dağıtımda da buraya yaz. Bu, "güncelleme geçmişi"nin kalıcı
kaydıdır (sohbet hafızasından bağımsız).

Hedef: `root@167.233.108.12:/opt/lisans-yonetim-paneli` · URL'ler:
`api.167-233-108-12.sslip.io` / `admin.167-233-108-12.sslip.io`

| Tarih | Commit | Servis(ler) | Not | Sonuç |
|---|---|---|---|---|
| 2026-07-27 | 5c8dda8 | admin | Sürüm yönetim sistemi + /releases sayfası (deploy.sh ile) | /health 200 (auto-rollback'li) |
| 2026-07-27 | 6dffa26 | admin | (docs) marka notu | — |
| 2026-07-27 | 49cf534 | api + admin | Marka "WP Teslimat Eklentisi" (görünen ad) | /health 200 |
| 2026-07-27 | 712e328 | api | 5-lens denetim 9 bulgu düzeltmesi | /health 200 · entegrasyon 89/89 + yarış 2/2 |
| 2026-07-27 | 04f8f5f | api + admin | Site→müşteri hiyerarşisi | /health 200 |

<!-- YENİ KAYITLAR YUKARIYA, tablo başlığının hemen altına eklenir (deploy.sh böyle yapar). -->
