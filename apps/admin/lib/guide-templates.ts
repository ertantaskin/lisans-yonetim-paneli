/**
 * Hazır rehber taslakları — operatör boş sayfayla başlamasın diye.
 *
 * BUNLAR BAŞLANGIÇ METNİDİR, dogma değil: panele yapıştırılır ve operatör kendi
 * mağazasına göre düzenler (adım sayısı, marka dili, destek kanalı). Panelde de açıkça
 * "taslak" olarak sunulur — aksi halde operatör kendi ürününe uymayan bir metni olduğu
 * gibi gönderir ve müşteri yanlış talimatla baş başa kalır.
 *
 * SUNUCU/İSTEMCİ ORTAK, sırsız, salt-veri: taslak seçimi tarayıcıda yapılır (ek istek yok).
 */

export interface GuideTemplate {
  /** Buton etiketi. */
  label: string;
  /** Hangi ürün tipine uygun olduğu — operatör doğru taslağı seçebilsin. */
  hint: string;
  title: string;
  body: string;
}

export const GUIDE_TEMPLATES: GuideTemplate[] = [
  {
    label: 'Office 365 (hesap)',
    hint: 'Kullanıcı adı + geçici parola ile teslim edilen abonelik hesapları',
    title: 'Office 365 kurulum ve etkinleştirme',
    body: `Office 365'i kullanabilmek için yukarıda gönderdiğimiz kullanıcı adı ve parola bilgileri gerekecektir.

1. https://www.office.com adresine gidin ve "Oturum aç" deyin.
2. Size gönderdiğimiz kullanıcı adı ve geçici parola ile giriş yapın.
3. İlk girişte karşınıza gelen ekranda parolanızı güncelleyin.
4. **Yeni belirlediğiniz parolayı mutlaka not alın.** Parolanızı unutmanız durumunda hesaba müdahale edemiyoruz.
5. Açılan "Hoş geldiniz" sayfasında sağ üstteki "Yükleme ve daha fazlası" düğmesinden Office kurulum dosyasını indirin ve kurun.
6. Kurulum bittikten sonra Word veya Excel'i açın, "Oturum aç" ekranından aynı kullanıcı adı ve yeni parolanızla giriş yapın.

Kurulum sırasında takılırsanız sipariş sayfanızdan "Sorun bildir" ile bize yazabilirsiniz.`,
  },
  {
    label: 'Office 2021 / 2019 (anahtar)',
    hint: 'Tek seferlik satın alınan, ürün anahtarıyla teslim edilen Office sürümleri',
    title: 'Office 2021 / 2019 kurulum ve etkinleştirme',
    body: `Size gönderdiğimiz 25 haneli ürün anahtarı ile Office kurulumunu tamamlayabilirsiniz.

1. https://www.office.com/setup adresine gidin.
2. Microsoft hesabınızla oturum açın; hesabınız yoksa ücretsiz olarak oluşturun.
3. Size gönderdiğimiz 25 haneli ürün anahtarını girin ve ülke/bölge seçimini yapın.
4. Anahtar hesabınıza tanımlandıktan sonra "Yükle" adımından kurulum dosyasını indirin.
5. Kurulum bittiğinde Word veya Excel'i açın; lisans hesabınıza bağlı olduğu için ek bir işlem gerekmez.

**Önemli:** Ürün anahtarını hangi Microsoft hesabına tanımladığınızı not alın — Office'i ileride yeniden kurmanız gerekirse aynı hesapla giriş yapmanız yeterlidir.`,
  },
  {
    label: 'Windows 10 / 11 (anahtar)',
    hint: 'İşletim sistemi ürün anahtarları',
    title: 'Windows 10 / 11 etkinleştirme',
    body: `Size gönderdiğimiz 25 haneli ürün anahtarı ile Windows'u etkinleştirebilirsiniz.

Windows 11 için:
1. Başlat > Ayarlar > Sistem > Etkinleştirme yolunu izleyin.
2. "Ürün anahtarını değiştir" seçeneğine tıklayın.
3. Size gönderdiğimiz 25 haneli anahtarı girin ve "İleri" deyin.

Windows 10 için:
1. Başlat > Ayarlar > Güncelleştirme ve Güvenlik > Etkinleştirme yolunu izleyin.
2. "Ürün anahtarını değiştir" seçeneğine tıklayın.
3. Size gönderdiğimiz 25 haneli anahtarı girin ve "İleri" deyin.

Etkinleştirme birkaç saniye sürer; işlem bitince aynı ekranda "Windows etkinleştirildi" yazısını görürsünüz.

**Not:** Anahtarın çalışması için bilgisayarınızın internete bağlı olması ve kurulu Windows sürümünün (Home / Pro) satın aldığınız sürümle aynı olması gerekir.`,
  },
  {
    label: 'Genel hesap teslimatı',
    hint: 'Kullanıcı adı/parola ile teslim edilen diğer hesap ürünleri',
    title: 'Hesap kullanım rehberi',
    body: `Hesabınızı kullanmaya başlamak için yukarıdaki bilgiler gerekecektir.

1. Hizmetin giriş sayfasına gidin ve size gönderdiğimiz kullanıcı adı ile parolayı girin.
2. İlk girişte parola değiştirmeniz istenirse yeni parolanızı belirleyin ve **mutlaka not alın**.
3. Hesabı başkasıyla paylaşmayın; aynı anda birden fazla cihazdan giriş yapmak hizmetin kapanmasına yol açabilir.

Giriş yapamazsanız sipariş sayfanızdan "Sorun bildir" ile bize ulaşın — inceleyip en kısa sürede dönüş yapıyoruz.`,
  },
];
