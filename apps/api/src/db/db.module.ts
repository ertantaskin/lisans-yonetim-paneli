import { Global, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { drizzle, PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

export const DB = Symbol('DB');
export const PG_CLIENT = Symbol('PG_CLIENT');

export type Database = PostgresJsDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.getOrThrow<string>('DATABASE_URL');
        // max: API stateless çoğaltıldığı için havuz mütevazı tutulur (§1).
        //
        // ZAMAN AŞIMLARI (fault-injection bulgusu): timeout ayarı olmadan tek bir
        // takılı sorgu/kilit tüm havuzu (max=10) kilitliyordu → 100 eşzamanlı yazmada
        // istekler ~50sn askıda kaldı, /health bile yanıt veremedi. Aşağıdaki ayarlar
        // hem istemci-taraflı (havuz) hem sunucu-taraflı (Postgres) sınırlar koyar.
        return postgres(url, {
          max: 10,
          // İstemci-taraflı: bağlantı 10sn'de kurulamıyorsa vazgeç (ölü DB'de sonsuz asılı kalma yok).
          connect_timeout: 10,
          // İstemci-taraflı: 30sn boşta kalan bağlantıyı kapat → havuz tazelenir, yarım-ölü soket birikmez.
          idle_timeout: 30,
          // Sunucu-taraflı GUC'ler: her yeni bağlantının başlangıç parametreleri olarak gönderilir
          // (postgres.js `connection` seçeneği → StartupMessage/SET). Postgres tarafında uygulanır,
          // yani takılan sorgu/kilit/açık-tx havuzu meşgul TUTMADAN sunucuda iptal edilir.
          // NOT: ConnectionParameters bu üç alanı `number` olarak tipler; birimsiz sayı Postgres'te
          // MİLİSANİYE demektir (statement_timeout=30000 ⇒ 30sn). '30s' string'i tip hatası verirdi.
          connection: {
            // Tek bir sorgu 30sn'yi aşarsa Postgres iptal eder. CÖMERT sınır: normal sorgular
            // milisaniye mertebesinde; yalnız patolojik hangleri (kartezyen/kilitli tarama) yakalar.
            // Sweep'ler (reconcile/expiry) da kısa sürer, 30sn onlara fazlasıyla yeter.
            // KRİTİK: Bu GLOBAL bir varsayılandır. Kendi (daha kısa) sınırını isteyen yerler
            // `SET LOCAL statement_timeout` kullanır (ör. AI readonly-sql 5s, readonly-sql.service.ts):
            // SET LOCAL transaction kapsamında ÜSTÜN GELİR, tx bitince geri döner → 30sn global onları
            // etkilemez. Meşru uzun bir iş gerekirse aynı SET LOCAL deseniyle yerel olarak gevşetilmeli.
            statement_timeout: 30000,
            // Bir kilidi 10sn bekleyip alamazsa iptal → kilit çekişmesi süresiz beklemesin
            // (advisory-lock/FOR UPDATE çekişmesinde havuzu tüketen zincirleme bekleme kapanır).
            lock_timeout: 10000,
            // Açık kalmış (idle) transaction'ı 60sn'de sonlandır → sızan/yarım-kalan tx bağlantıyı
            // ve tuttuğu kilitleri süresiz rehin almaz.
            idle_in_transaction_session_timeout: 60000,
          },
        });
      },
    },
    {
      provide: DB,
      inject: [PG_CLIENT],
      useFactory: (client: ReturnType<typeof postgres>) => drizzle(client, { schema }),
    },
  ],
  exports: [DB, PG_CLIENT],
})
export class DbModule implements OnModuleDestroy {
  constructor() {}

  async onModuleDestroy(): Promise<void> {
    // Bağlantı kapatma enableShutdownHooks üzerinden PG_CLIENT provider'ında
    // ele alınır; postgres-js süreç kapanışında sonlandırılır.
  }
}
