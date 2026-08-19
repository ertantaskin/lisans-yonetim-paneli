#!/usr/bin/env node
/**
 * docs/mimari-gorsel.html ÜRETİCİSİ — görsel kopya artık ELLE sürdürülmüyor.
 *
 * NEDEN VAR (ölçüldü, tahmin değil): `docs/mimari-gorsel.html` aynı mimarinin ELLE yazılmış
 * ikinci kopyasıydı ve sürdürülemedi. 2026-08-19'da ölçüldüğünde şartname v2.7'yken görsel
 * kopya v2.6'da donmuştu ve CANLI SİSTEMLE ÇELİŞİYORDU:
 *   · Faz 3'ü (WP migrasyonu) hâlâ planlanan bir aşama gibi anlatıyordu — şartname onu
 *     DÜŞÜRÜLDÜ olarak kapatmıştı,
 *   · şemada hiç var olmamış 4 tabloyu (`stock_batches`, `customer_tags`, `panel_users`,
 *     `blocklist`) anlatıyordu,
 *   · terk edilmiş kararları canlı gibi sunuyordu: Resend/SES mail sağlayıcısı (kurulum
 *     SMTP-only ilerledi), pgBackRest + S3 + PITR (bugün `pg_dump` + cron), argon2 (gerçeği
 *     scrypt), indigo palet + Inter (gerçeği nötr shadcn paleti + Geist).
 * Yani "uygulama öncesi teklif" metniydi; sistem canlıydı. CLAUDE.md tuzak #4: aynı kavramın
 * iki elle sürdürülen tanımı ÇELİŞİR. Çözüm kopyayı güncellemek değil, KOPYA OLMAKTAN
 * ÇIKARMAK: bu betik görseli `docs/MIMARI.md`den ÜRETİR, tazeliğini `pnpm check:docs`
 * denetler (üretilmiş dosya bayatsa CI kırılır).
 *
 * Kullanım:
 *   node scripts/build-mimari-gorsel.js           → docs/mimari-gorsel.html'i yeniden üretir
 *   node scripts/build-mimari-gorsel.js --check   → bayatsa 1 döner (yazmaz) — kapı bunu çağırır
 *
 * Markdown desteği BİLEREK dar: yalnız MIMARI.md'nin kullandığı alt küme (başlık, paragraf,
 * liste, tablo, alıntı, kod bloğu, yatay çizgi + satır içi kalın/kod/bağlantı). Genel amaçlı
 * bir markdown motoru değildir; MIMARI.md'ye yeni bir sözdizimi girerse burası da büyümeli.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KAYNAK = path.join(ROOT, 'docs/MIMARI.md');
const HEDEF = path.join(ROOT, 'docs/mimari-gorsel.html');
const SABLON = path.join(__dirname, 'mimari-gorsel.template.html');

// ── Satır içi biçimlendirme ──────────────────────────────────────────────────
function kacir(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * ÖNEMLİ SIRA: önce `kod` parçaları çıkarılıp yer tutucuya alınır, sonra kalan metne
 * kalın/bağlantı uygulanır. Aksi halde `**` içeren bir kod parçası (ör. `qty**2`) kalın
 * sanılır ve belge sessizce yanlış render edilir.
 */
const NUL = String.fromCharCode(0);
function satirIci(s) {
  // Yer tutucu sınırlayıcısı NUL'dur: markdown metninde asla geçmez. Sınırlayıcı olarak
  // BOŞLUK kullanmak sıradan bir sayıyı (" 3 ") kod parçası sanardı.
  const kodlar = [];
  let t = s.replace(/`([^`]+)`/g, (_, k) => {
    kodlar.push(k);
    return NUL + (kodlar.length - 1) + NUL;
  });
  t = kacir(t);
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, metin, url) => `<a href="${url}">${metin}</a>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)]|$)/g, '$1<em>$2</em>');
  return t.replace(
    new RegExp(NUL + '(\\d+)' + NUL, 'g'),
    (_, i) => `<code>${kacir(kodlar[Number(i)])}</code>`,
  );
}

function slug(s) {
  return s
    .toLowerCase()
    .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c])
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Blok ayrıştırma ──────────────────────────────────────────────────────────
function listeRender(ogeler, etiket = 'ul') {
  return (
    `<${etiket}>` +
    ogeler
      .map((o) => `<li>${satirIci(o.metin)}${o.alt.length ? listeRender(o.alt) : ''}</li>`)
      .join('') +
    `</${etiket}>`
  );
}

/** Sırasız madde: `- `, `* ` ve MIMARI.md'nin alıntı bloklarında kullandığı `· `. */
const MADDE = /^(\s*)(?:[-*]|·)\s+(.*)$/;
/** Sıralı madde: `1. ` — §2 teslimat akışı bunu kullanır (paragrafa düşerse adımlar kaybolur). */
const SIRALI = /^(\s*)\d+\.\s+(.*)$/;

/** Girinti seviyesine göre iç içe liste kurar (MIMARI.md 2 boşlukla girintiler). */
function listeTopla(satirlar, kalip = MADDE) {
  const kok = [];
  const yigin = [{ derinlik: -1, cocuk: kok }];
  for (const s of satirlar) {
    const m = s.match(kalip);
    if (m) {
      const derinlik = m[1].length;
      while (yigin.length > 1 && derinlik <= yigin[yigin.length - 1].derinlik) yigin.pop();
      const oge = { metin: m[2], alt: [] };
      yigin[yigin.length - 1].cocuk.push(oge);
      yigin.push({ derinlik, cocuk: oge.alt });
    } else {
      // Girintili devam satırı: bir önceki maddeye eklenir (madde metni satırlara bölünmüş).
      const ust = yigin[yigin.length - 1];
      const hedef = ust.cocuk.length ? ust.cocuk[ust.cocuk.length - 1] : null;
      const sahip = hedef || (kok.length ? kok[kok.length - 1] : null);
      if (sahip) sahip.metin += ' ' + s.trim();
    }
  }
  return kok;
}

function tabloRender(satirlar) {
  const hucreler = (satir) =>
    satir
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((h) => h.trim());
  const bas = hucreler(satirlar[0]);
  const govde = satirlar.slice(2).map(hucreler);
  return (
    '<div class="tbl-wrap"><table>\n<tr>' +
    bas.map((h) => `<th>${satirIci(h)}</th>`).join('') +
    '</tr>\n' +
    govde
      .map((r) => '<tr>' + r.map((c) => `<td>${satirIci(c)}</td>`).join('') + '</tr>')
      .join('\n') +
    '\n</table></div>'
  );
}

function bloklariRender(satirlar) {
  const cikti = [];
  let i = 0;
  while (i < satirlar.length) {
    const s = satirlar[i];

    if (s.trim() === '') {
      i++;
      continue;
    }

    // Kod bloğu
    if (/^```/.test(s.trim())) {
      const govde = [];
      i++;
      while (i < satirlar.length && !/^```/.test(satirlar[i].trim())) govde.push(satirlar[i++]);
      i++;
      cikti.push(`<pre class="code"><code>${kacir(govde.join('\n'))}</code></pre>`);
      continue;
    }

    // Yatay çizgi — bölüm ayracı, görselde boşlukla temsil edilir
    if (/^---+$/.test(s.trim())) {
      i++;
      continue;
    }

    // Başlık
    const b = s.match(/^(#{1,4})\s+(.*)$/);
    if (b) {
      const dz = b[1].length;
      const metin = b[2];
      if (dz === 2) cikti.push(`<h2 id="${slug(metin)}">${satirIci(metin)}</h2>`);
      else if (dz === 1) cikti.push(`<h1>${satirIci(metin)}</h1>`);
      else cikti.push(`<h${dz}>${satirIci(metin)}</h${dz}>`);
      i++;
      continue;
    }

    // Alıntı → callout
    if (/^>/.test(s)) {
      const govde = [];
      while (i < satirlar.length && /^>/.test(satirlar[i])) {
        govde.push(satirlar[i].replace(/^>\s?/, ''));
        i++;
      }
      cikti.push(`<div class="callout">${bloklariRender(govde)}</div>`);
      continue;
    }

    // Tablo
    if (/^\|/.test(s) && i + 1 < satirlar.length && /^\|[\s:|-]+\|$/.test(satirlar[i + 1].trim())) {
      const govde = [];
      while (i < satirlar.length && /^\|/.test(satirlar[i])) govde.push(satirlar[i++]);
      cikti.push(tabloRender(govde));
      continue;
    }

    // Liste (sırasız `- `/`· ` ya da sıralı `1. `)
    const listeKalibi = MADDE.test(s) ? MADDE : SIRALI.test(s) ? SIRALI : null;
    if (listeKalibi) {
      const etiket = listeKalibi === MADDE ? 'ul' : 'ol';
      const govde = [];
      while (
        i < satirlar.length &&
        satirlar[i].trim() !== '' &&
        (listeKalibi.test(satirlar[i]) || /^\s{2,}\S/.test(satirlar[i]))
      ) {
        govde.push(satirlar[i++]);
      }
      cikti.push(listeRender(listeTopla(govde, listeKalibi), etiket));
      continue;
    }

    // Paragraf (sarılmış satırlar tek paragrafa toplanır)
    const govde = [];
    while (
      i < satirlar.length &&
      satirlar[i].trim() !== '' &&
      !/^(#{1,4}\s|>|\||```|---+$)/.test(satirlar[i].trim()) &&
      !MADDE.test(satirlar[i]) &&
      !SIRALI.test(satirlar[i])
    ) {
      govde.push(satirlar[i++].trim());
    }
    if (govde.length) cikti.push(`<p>${satirIci(govde.join(' '))}</p>`);
  }
  return cikti.join('\n');
}

// ── Üretim ───────────────────────────────────────────────────────────────────
/**
 * SATIR SONU NORMALİZASYONU — kapının platformlar arası çalışması buna bağlı.
 *
 * Geliştirme Windows'ta, CI Linux'ta koşuyor ve `.gitattributes` depoda LF dayatıyor: kaynak
 * markdown Windows çalışma kopyasında CRLF, CI'da LF olur. Normalize edilmezse üretilen HTML
 * iki platformda BİREBİR AYNI OLMAZ (satır sonlarındaki `\r` çıktının içine sızar) ve
 * `--check` CI'da "bayat" diye kırılırdı — dosyada hiçbir sorun yokken. Hem girdi hem
 * karşılaştırma LF'e indirgenir; dosya LF yazılır.
 */
const lf = (s) => s.replace(/\r\n/g, '\n');

function uret() {
  const md = lf(fs.readFileSync(KAYNAK, 'utf8'));
  const sablon = lf(fs.readFileSync(SABLON, 'utf8'));
  const satirlar = md.split('\n');

  const baslik = (satirlar[0] || '').replace(/^#\s*/, '').trim();
  const surum = (md.match(/^\*\*(v[\d.]+ · [^*]+)\*\*/m) || ['', ''])[1];

  // İçindekiler: yalnız `##` başlıkları (h3 alt başlıkları TOC'u boğuyordu — ölçüldü: 22 → 40 satır)
  const toc = satirlar
    .filter((l) => /^##\s+/.test(l))
    .map((l) => l.replace(/^##\s+/, '').trim())
    .map((t) => `  <a href="#${slug(t)}">${satirIci(t)}</a>`)
    .join('\n');

  // Gövde: h1 ve sürüm satırı hero'ya taşındığı için ana akıştan çıkarılır.
  const govdeSatirlari = satirlar
    .slice(1)
    .filter((l, idx) => !(idx < 3 && /^\*\*v[\d.]+ ·/.test(l)));
  const govde = bloklariRender(govdeSatirlari);

  // split/join: <!--BASLIK--> hem <title> hem <h1> içinde geçiyor; String.replace yalnız
  // İLKİNİ değiştirir ve sayfa başlığı yer tutucu olarak kalırdı.
  const doldur = (metin, yer, deger) => metin.split(yer).join(deger);
  let cikti = doldur(sablon, '<!--BASLIK-->', kacir(baslik));
  cikti = doldur(cikti, '<!--SURUM-->', kacir(surum));
  cikti = doldur(cikti, '<!--TOC-->', toc);
  return doldur(cikti, '<!--ICERIK-->', govde);
}

const html = uret();
if (process.argv.includes('--check')) {
  // Diskteki dosya da LF'e indirgenerek karşılaştırılır: git checkout ayarı (autocrlf) onu
  // CRLF'e çevirmiş olabilir ve bu, İÇERİK farkı değildir.
  const mevcut = fs.existsSync(HEDEF) ? lf(fs.readFileSync(HEDEF, 'utf8')) : null;
  if (mevcut !== html) {
    console.error(
      '\n✗ docs/mimari-gorsel.html BAYAT — docs/MIMARI.md değişmiş ama görsel kopya yeniden' +
        '\n  üretilmemiş. Düzeltmesi: `pnpm docs:gorsel` (ve çıkan dosyayı commit edin).' +
        '\n  Bu dosya ELLE düzenlenmez; tek kaynak docs/MIMARI.md.',
    );
    process.exit(1);
  }
  console.log('✓ mimari-gorsel: üretilmiş görsel kopya MIMARI.md ile aynı.');
} else {
  fs.writeFileSync(HEDEF, html);
  console.log('✓ docs/mimari-gorsel.html yeniden üretildi (' + html.length + ' bayt).');
}
