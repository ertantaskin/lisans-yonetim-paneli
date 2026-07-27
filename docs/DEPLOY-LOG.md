# Dağıtım Günlüğü (Deploy Log)

Prod'a (VPS) yapılan her dağıtımın **append-only** kaydı. En yeni en üstte.
Her satır: tarih · sürüm/commit · ne dağıtıldı · sonuç. `scripts/deploy.sh` bu dosyaya
otomatik satır ekler; elle dağıtımda da buraya yaz. Bu, "güncelleme geçmişi"nin kalıcı
kaydıdır (sohbet hafızasından bağımsız).

Hedef: `root@167.233.108.12:/opt/lisans-yonetim-paneli` · URL'ler:
`api.167-233-108-12.sslip.io` / `admin.167-233-108-12.sslip.io`

| Tarih | Commit | Servis(ler) | Not | Sonuç |
|---|---|---|---|---|
| 2026-07-27 | (bekleyen) | admin | Sipariş detayı yerleşim yeniden tasarımı: 4 büyük stat kartı → tek ince özet şeridi; "Satırlar" + "Aktif Lisanslar" tek ÜRÜN-MERKEZLİ "Ürünler ve Lisanslar" bölümünde birleşti (her ürün kartı: ad+teslim durumu+anahtarlar+aksiyonlar); öncelik sırası (uyarı/destek → ürünler → geçmiş/referans katlanır en altta); geçmiş+değişim-geçmişi katlanır, zaman çizelgesi yükseklik-sınırlı | typecheck temiz · dev canlı doğrulandı (konsol hatasız) |
| 2026-07-27 | 1a0d219 | api + admin + eklenti v0.5.1 | Sipariş detayı + destek akışı UX/correctness dalgası (kullanıcı geri bildirimi + 4-lens denetim/23 bulgu): sipariş detayında ürün adı + site + held uyarısı + aktif/iptal atama ayrımı + değişim geçmişinde tam eski key; "Kalanları Ata" added=0 dürüst raporlama; support↔sipariş çift yönlü bağ + siparişte inline değişim onay/red; replacements.approve TOCTOU advisory-lock + onay bildirimi; WP notları Türkçe (ham event/enum sızmaz) + başarısızlık notu. Migration YOK | /health 200 v1.0.0 · entegrasyon 115/115 + yarış 3/3 · PHP-lint temiz · dev canlı deneyim (approve→409 zaten-çözülmüş, eski key tam) · plugin v0.5.1 publish |
| 2026-07-27 | 48513d7 | api + admin + eklenti v0.5.0 | §7 WP-parite: lisanslar sipariş-kalemi altında (per-line, uzun yan metabox yerine) + **yenilenmiş kart UI** (özet sayaç, renkli durum rozetleri, ikonlu/hiyerarşik butonlar, ürün-bazlı Bonus Ekle, 5+ anahtarda kaydırma, katlanır değişim geçmişi) + kısmi-iade net-adet re-sync (bundleQty ölçekli, aşırı-revoke kapandı) + 16 WP denetim düzeltmesi. Backend değişmedi (kart UI saf sunum, migration yok) | /health 200 v1.0.0 · entegrasyon 115/115 + yarış 3/3 · PHP-lint temiz · plugin publish 201 (id 411e750b) |
| 2026-07-27 | 74a53e6 | api + admin + eklenti v0.4.0 | §7 D2 (meta box operasyon katmanı: reveal/replace/suspend/bonus/resend + admin-view, site-scoped HMAC + wp:kullanıcı@site audit) + D3 (ürün eşleme kutusu + liste filtresi + bundle) + P1 admin UX + P2 perf + P3 güvenlik; 5-lens denetim → 3 HIGH + 2 MED düzeltildi | /health 200 v1.0.0 · entegrasyon 114/114 + yarış 3/3 · PHP-lint 11/11 · tüm yeni rota map'lendi · plugin publish 201 |
| 2026-07-27 | 2c6be72 | api + eklenti v0.3.0 | §7 WP-parite D1: kısmi-iade satır-revoke (bedava-lisans kapandı) + tanılama sekmesi + admin bar + müşteri cila (parola göster/gizle, ilerleme, toplu .txt, canlı yoklama) | /health 200 · PHP-lint 3/3 · entegrasyon 94/94 · dev kısmi-iade e2e (3→2, karantina) |
| 2026-07-27 | ada9e12 | api + admin | Teslimat-hazırlık denetimi (5-lens, 16 bulgu): deploy detached-HEAD + runner log cap + WP async/read-timeout + connect→webhookUrl + sürüm 1.0.0 | /health 200 **v1.0.0** · PHP-lint 9/9 · entegrasyon 94/94 + yarış 2/2 · yeni deploy.sh (admin probe) sahada |
| 2026-07-27 | 9d050a9 | api + admin | Tam rename (jetlisans→@lisans/wpteslimat) + panelden dağıtım yönetimi (/deployments, migration 0021) | /health 200 · entegrasyon 92/92 + yarış 2/2 |
| 2026-07-27 | ecbc51b | admin | Panelden-dağıtım E2E kanıtı (runner claim→deploy→success) | /health 200 |
| 2026-07-27 | 5c8dda8 | admin | Sürüm yönetim sistemi + /releases sayfası (deploy.sh ile) | /health 200 (auto-rollback'li) |
| 2026-07-27 | 6dffa26 | admin | (docs) marka notu | — |
| 2026-07-27 | 49cf534 | api + admin | Marka "WP Teslimat Eklentisi" (görünen ad) | /health 200 |
| 2026-07-27 | 712e328 | api | 5-lens denetim 9 bulgu düzeltmesi | /health 200 · entegrasyon 89/89 + yarış 2/2 |
| 2026-07-27 | 04f8f5f | api + admin | Site→müşteri hiyerarşisi | /health 200 |

<!-- YENİ KAYITLAR YUKARIYA, tablo başlığının hemen altına eklenir (deploy.sh böyle yapar). -->
