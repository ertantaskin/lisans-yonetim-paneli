/**
 * Kayıtlı görünümler (§14) — KAYDETME ONAYININ METNİ.
 *
 * NEDEN AYRI DOSYA: bu metin tek bir soruya cevap veriyor — "şimdi bastığım düğme NEYİ
 * kaydediyor?". Menü bileşeninin içinde iken cevabı YANLIŞTI (denetim bulgusu U1): uyarı
 * yalnız "adres çubuğu tamamen boş" dalında görünüyordu. Oysa asıl tehlikeli durum şu:
 * adreste sayfanın KENDİ parametresi var (`?site=…`) ama tablo İÇİ süzgeçler (arama/facet)
 * adrese yazılmıyor → operatör dolu bir adres görüyor, hiç uyarı almıyor, geri yüklediğinde
 * FARKLI bir liste geliyor. Yani "yaptım sanıp yapmamak" — bu paneldeki en tehlikeli kusur
 * sınıfı. Metin buraya taşındı ki saf mantık olarak test edilebilsin.
 *
 * `unsyncedFilters`: ekranda adrese YAZILMAYAN süzgeçlerin insan-okur adı (ör. "tablo içi
 * hızlı süzgeçler (Bildirim/Ürün/Tedarikçi/Site)"). Verilmezse ekranın tüm süzgeçleri
 * adreste yaşıyor demektir ve ek uyarı basılmaz.
 */
export interface SavedViewSaveNotice {
  /** Modal açıklaması (tek cümle). */
  description: string;
  /** Ek uyarı maddeleri — boş dizi ise uyarı yok. */
  details: string[];
}

export function savedViewSaveNotice(params: {
  /** Adres çubuğunda en az bir parametre var mı. */
  hasQuery: boolean;
  /** Bu ekranda adrese yazılmayan süzgeçlerin adı (varsa). */
  unsyncedFilters?: string;
}): SavedViewSaveNotice {
  const details: string[] = [];

  const description = params.hasQuery
    ? 'Adres çubuğundaki süzgeç durumu bu adla kaydedilir; menüden tek tıkla geri dönebilirsiniz. Görünüm yalnız size görünür.'
    : // Kaydı ENGELLEMİYORUZ (bir ekranın "varsayılan hâli" de meşru bir görünümdür),
      // ama operatör ne kaydettiğini bilerek onaylasın.
      'DİKKAT: Adres çubuğunda şu an hiçbir süzgeç yok — bu görünüm sayfayı süzgeçsiz açar.';

  if (params.unsyncedFilters) {
    // Adres DOLU olsa bile basılır: bulgunun tam olarak kaçırdığı durum budur.
    details.push(
      `Bu ekranda ${params.unsyncedFilters} adres çubuğuna yazılmaz — kaydedilen görünüme GİRMEZ ve geri yüklediğinizde uygulanmaz.`,
    );
  }

  return { description, details };
}
