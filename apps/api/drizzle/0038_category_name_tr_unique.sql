-- Kategori adında TÜRKÇE ikiz kilidi: düz lower() İ/I/ı/i dört varyantını AYRI sayıyor
-- (en_US.utf8'de lower('LİSANSLARI')='lisanslari' ama lower('lisansları')='lisansları'),
-- bu yüzden "WINDOWS LİSANSLARI" ikiz olmasına rağmen kabul ediliyordu. translate() ile
-- dört varyant tek harfe indirilir.
--
-- ÖN TEMİZLİK ŞART (denetim bulgusu): bu dosya yalnız DROP + CREATE UNIQUE içeriyordu.
-- 0037 uygulanmış ve ARADA Türkçe-ikiz kategori oluşturulmuş bir veritabanında (ör. o
-- aralıkta alınmış bir yedeğin geri yüklenmesi) CREATE UNIQUE INDEX hata verir; migration
-- boot'ta koştuğu için API HİÇ AÇILMAZ. İkizleri sessizce SİLMEK de olmaz (ürünler o
-- kategoriye bağlı) → ikinci ve sonraki kayıt deterministik olarak yeniden adlandırılır,
-- operatör panelde görüp birleştirebilir.
--
-- NOT: bu dosya prod'a uygulandıktan SONRA sertleştirildi. Drizzle migrator sırayı zaman
-- damgasından yürüttüğü için uygulanmış bir migration yeniden KOŞMAZ; değişiklik yalnız
-- yeni/temiz olmayan kurulumları korur.
DO $$
DECLARE
  r RECORD;
  n INT;
BEGIN
  IF to_regclass('public.product_categories') IS NULL THEN
    RETURN;
  END IF;

  FOR r IN
    SELECT id, name, lower(translate(name, 'İIı', 'iii')) AS folded
    FROM product_categories p
    WHERE EXISTS (
      SELECT 1 FROM product_categories q
      WHERE q.id <> p.id
        AND lower(translate(q.name, 'İIı', 'iii')) = lower(translate(p.name, 'İIı', 'iii'))
        AND (q.created_at, q.id) < (p.created_at, p.id)
    )
    ORDER BY created_at, id
  LOOP
    n := 2;
    WHILE EXISTS (
      SELECT 1 FROM product_categories x
      WHERE lower(translate(x.name, 'İIı', 'iii')) = lower(translate(r.name || ' (' || n || ')', 'İIı', 'iii'))
    ) LOOP
      n := n + 1;
    END LOOP;
    UPDATE product_categories SET name = r.name || ' (' || n || ')' WHERE id = r.id;
    RAISE NOTICE 'product_categories: ikiz ad yeniden adlandırıldı → %', r.name || ' (' || n || ')';
  END LOOP;
END $$;--> statement-breakpoint
DROP INDEX IF EXISTS "product_categories_name_lower_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_categories_name_lower_idx" ON "product_categories" USING btree (lower(translate("name", 'İIı', 'iii')));
