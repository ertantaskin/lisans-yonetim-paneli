import { HttpException, HttpStatus } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { ReadonlySqlService } from '../../src/ai/readonly-sql.service';
import { makeDb } from './_helpers';

/**
 * ReadonlySqlService entegrasyon testi (§15 "salt-okunur DB rolü, üretilen SQL gösterilir").
 *
 * Gerçek PostgreSQL gerektirir: servisin asıl güvencesi (READ ONLY transaction) DB
 * tarafında zorlanır, salt-birim taklit edilemez. Servis PG_CLIENT'ı (ham postgres.Sql)
 * bekler → makeDb().client'ı doğrudan geçiriyoruz. Bu test HİÇBİR ŞEY yazmaz (tümü red ya
 * da salt-okuma), dolayısıyla seed/cleanup yok — yalnız bağlantı açılır/kapanır.
 */

let client: Sql;
let end: () => Promise<void>;
let service: ReadonlySqlService;

/** runSelect'in verilen sorguyu 400 (BAD_REQUEST) ile reddettiğini doğrular. */
async function expectRejected(query: string): Promise<void> {
  try {
    await service.runSelect(query);
    throw new Error(`Reddedilmesi beklenirken sorgu geçti: ${query}`);
  } catch (err) {
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(HttpStatus.BAD_REQUEST);
  }
}

describe('ReadonlySqlService (NL→SQL salt-okunur çalıştırma)', () => {
  beforeAll(() => {
    const h = makeDb();
    end = h.end;
    // Servis @Inject(PG_CLIENT) — ham postgres.Sql istemcisini bekler (drizzle değil).
    client = h.client as unknown as Sql;
    service = new ReadonlySqlService(client);
  });

  afterAll(async () => {
    await end();
  });

  it('yazma ifadeleri (INSERT/UPDATE/DELETE) sözdizim kapısında reddedilir', async () => {
    await expectRejected("INSERT INTO sites (domain) VALUES ('x.test')");
    await expectRejected("UPDATE sites SET domain = 'y.test'");
    await expectRejected('DELETE FROM sites');
  });

  it('DDL ifadeleri (CREATE/DROP/ALTER/TRUNCATE) reddedilir', async () => {
    await expectRejected('CREATE TABLE it_should_not_exist (id int)');
    await expectRejected('DROP TABLE sites');
    await expectRejected('ALTER TABLE sites ADD COLUMN hacked int');
    await expectRejected('TRUNCATE sites');
  });

  it('çoklu-ifade (noktalı virgülle zincirleme) reddedilir', async () => {
    // Sondaki ; hoş görülür; ORTADAKİ ; ikinci ifade demek → reddedilir.
    await expectRejected('SELECT 1; SELECT 2');
    await expectRejected('SELECT 1; DROP TABLE sites');
  });

  it('SELECT/WITH dışı ifade (EXPLAIN/SHOW) ve boş sorgu reddedilir', async () => {
    await expectRejected('EXPLAIN SELECT 1');
    await expectRejected('SHOW statement_timeout');
    await expectRejected('');
    await expectRejected('   ');
  });

  it('salt-okunur transaction yazan CTE\'yi engeller (asıl güvence)', async () => {
    // Sözdizim kapısını geçer (WITH ile başlar) ama READ ONLY transaction yazmayı reddeder.
    // WHERE hiçbir satırı eşlemez ve UPDATE no-op'tur → koruma çökse bile veri güvende;
    // koruma çalışırsa "cannot execute UPDATE in a read-only transaction" → 400.
    await expectRejected(
      "WITH d AS (UPDATE sites SET domain = domain " +
        "WHERE id = '00000000-0000-0000-0000-000000000000' RETURNING id) SELECT count(*) FROM d",
    );
    await expectRejected(
      "WITH d AS (DELETE FROM sites " +
        "WHERE id = '00000000-0000-0000-0000-000000000000' RETURNING id) SELECT count(*) FROM d",
    );
  });

  it('geçerli SELECT çalışır; sondaki ; hoş görülür; kolonlar döner', async () => {
    const res = await service.runSelect('SELECT 1 AS a, 2 AS b;');
    expect(res.columns).toEqual(['a', 'b']);
    expect(res.rowCount).toBe(1);
    expect(res.truncated).toBe(false);
    expect(res.rows).toHaveLength(1);
    expect(Number(res.rows[0]!.a)).toBe(1);
    expect(Number(res.rows[0]!.b)).toBe(2);
  });

  it('MAX_ROWS (200) aşılınca sonuç kırpılır ve truncated=true olur', async () => {
    const res = await service.runSelect('SELECT generate_series(1, 250) AS n');
    // OOM koruması: sorgu DB'de LIMIT MAX_ROWS+1 (201) ile sarılır → belleğe 250'nin tamamı DEĞİL,
    // en fazla 201 satır gelir. rowCount getirilen+kırpılan satır sayısıdır (MAX_ROWS=200); gerçek
    // toplam (250) fetch edilmeden bilinemez — bu, OOM korumasının bilinçli ödünüdür.
    expect(res.rowCount).toBe(200);
    expect(res.rows).toHaveLength(200);
    expect(res.truncated).toBe(true);
    expect(res.columns).toEqual(['n']);
  });

  it('tam sınır (200 satır) kırpılmaz (truncated=false)', async () => {
    const res = await service.runSelect('SELECT generate_series(1, 200) AS n');
    expect(res.rowCount).toBe(200);
    expect(res.rows).toHaveLength(200);
    expect(res.truncated).toBe(false);
  });

  it('satır→metin CAST (s::text / cast(s AS text)) reddedilir — composite serialize bypass (denetim P4)', async () => {
    // Bir SATIR/kayıt değişkenini metne çevirmek TÜM satırı (sır kolonları dahil) tek skaler text
    // (OID 25) olarak döndürüp dönen-tip/kolon-adı/row-wrap süzgeçlerinin HEPSİNİ atlardı. CAST_TO_SCALAR_RE
    // artık runSelect'e bağlı → bu vektör kapalı (regresyon koruması: fix "tanımlı ama bağlanmamış"tı).
    await expectRejected('SELECT s::text FROM sites s');
    await expectRejected('SELECT cast(s AS text) FROM sites s');
    await expectRejected('SELECT l::varchar FROM license_items l');
    await expectRejected('SELECT s::bytea FROM sites s');
  });

  it('satır-serialize yardımcıları (format/concat + to_jsonb/array_agg) reddedilir', async () => {
    await expectRejected("SELECT format('%s', s) FROM sites s");
    await expectRejected('SELECT concat(s) FROM sites s');
    await expectRejected('SELECT to_jsonb(s) AS r FROM sites s');
    await expectRejected('SELECT array_agg(s) AS r FROM sites s');
  });

  it('tehlikeli fonksiyonlar (dosya/ağ/LO/sleep) reddedilir (denetim M2)', async () => {
    // SALT-OKUNUR tx yazmayı engeller ama superuser rolünde bunlar SELECT bağlamında sunucu
    // dosyası/ağı okur → metin kapısında reddedilmeli. (Fonksiyon var olmasa bile kapı ADdan
    // yakalar; sözdizim doğru olduğu için READ ONLY'ye ulaşmadan 400 döner.)
    await expectRejected("SELECT pg_read_file('/etc/passwd')");
    await expectRejected("SELECT pg_read_binary_file('postgresql.conf')");
    await expectRejected("SELECT pg_ls_dir('.')");
    await expectRejected("SELECT pg_stat_file('base')");
    await expectRejected("SELECT dblink('host=x', 'SELECT 1')");
    await expectRejected("SELECT lo_import('/etc/hostname')");
    await expectRejected('SELECT pg_sleep(10)');
  });

  it('sistem/kimlik katalogları (pg_authid/pg_shadow/pg_user_mapping) reddedilir (denetim M2)', async () => {
    // Rol katalogları superuser rolünde parola-hash'i (rolpassword/passwd) taşır → tablo kapısında red.
    await expectRejected('SELECT rolname FROM pg_authid');
    await expectRejected('SELECT usename FROM pg_shadow');
    await expectRejected('SELECT umoptions FROM pg_user_mapping');
    await expectRejected('SELECT * FROM pg_user_mappings');
  });

  it('parola-hash kolon adları (rolpassword/passwd/umoptions) metin kapısında reddedilir (denetim M2)', async () => {
    // Tablo adı geçmese bile (görünüm/alias) kolon-adı katmanı yakalar (savunma-derinliği).
    await expectRejected('SELECT rolpassword FROM some_view');
    await expectRejected('SELECT passwd FROM some_view');
    await expectRejected('SELECT umoptions FROM some_view');
  });

  it('unicode-escape sözdizimi (U&"..." / U&\'...\') reddedilir — denylist obfuscation kapısı', async () => {
    // U&'\0061dmin_users' gibi kod-noktası kaçışı denylist ADlarını gizleyip TÜM metin
    // denylist'lerini (tablo/kolon/fonksiyon) atlatabilir → sözdizimini tümden reddet.
    await expectRejected('SELECT n FROM U&"\\0070g_authid"'); // identifier: pg_authid gizli (yıldızsız)
    await expectRejected("SELECT U&'\\0072olpassword' FROM t"); // string: rolpassword gizli
    await expectRejected('SELECT 1 WHERE U&"col" = 1'); // çıplak U& identifier de reddedilir
  });
});
