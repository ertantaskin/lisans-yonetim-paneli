import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { BackupAlarmService } from './backup-alarm.service';
import { DEPLOY_TARGETS, DeploymentsService } from './deployments.service';

// note: hedefe özel serbest metin — 'plugin' hedefinde sürüm changelog'u (runner claim
// yanıtından okur). max(2000) servisin MAX_NOTE_CHARS .slice değeriyle HİZALI.
const RequestSchema = z.object({
  target: z.enum(DEPLOY_TARGETS),
  note: z.string().max(2000).optional(),
});
type RequestInput = z.infer<typeof RequestSchema>;

// log/error üst sınırları servisin .slice değerleriyle HİZALI (MAX_LOG_CHARS=20000 / 4000).
// Runner de göndermeden jq içinde bu sınırlara kısaltır → tutarsız cap yüzünden 400 olmaz.
const FinishSchema = z.object({
  status: z.enum(['success', 'failed']),
  gitSha: z.string().max(80).optional(),
  log: z.string().max(20000).optional(),
  error: z.string().max(4000).optional(),
});
type FinishInput = z.infer<typeof FinishSchema>;

/**
 * Runner claim filtresi: her runner YALNIZ kendi hedef sınıfını alır (dağıtım runner'ı
 * `deploy.sh` hedeflerini, yedek runner'ı `backup*` hedeflerini). Alan VERİLMEZSE eski
 * davranış (tüm hedefler) sürer → eski `deploy-runner.sh` sürümü kırılmaz.
 */
const ClaimSchema = z.object({
  targets: z.array(z.enum(DEPLOY_TARGETS)).min(1).max(DEPLOY_TARGETS.length).optional(),
});
type ClaimInput = z.infer<typeof ClaimSchema>;

/**
 * Admin: panelden prod dağıtımı yönetimi (§16). Tüm uçlar X-Admin-Token korumalı.
 * - POST         → yeni dağıtım İSTEĞİ kaydeder (owner-only Next katmanında zorlanır).
 * - GET          → dağıtım geçmişi (salt-okunur görünüm).
 * - POST /claim  → VPS host runner'ının bekleyen isteği atomik alması.
 * - PATCH /:id/finish → runner'ın sonucu (success/failed + log/sha) geri yazması.
 *
 * - GET /backup-summary → son yedek / son tatbikat özeti (§16 DR, salt-okunur).
 *
 * Panel yalnız KAYIT tutar; gerçek `deploy.sh` çağrısını host'taki runner yapar
 * (API konteynerine Docker soketi VERİLMEZ — güvenlik). 'plugin' hedefinde runner
 * deploy.sh yerine eklenti zip'ini üretip panele publish eder; 'backup'/'backup-drill'
 * hedeflerini AYRI bir cron runner (`scripts/backup-runner.sh`) alır ve `backup-drill.sh`'ı
 * çalıştırır. Hepsi AYNI istek/çalıştırma ayrımı — panelden `pg_dump`/docker çalıştırılmaz.
 */
@Controller('admin/deployments')
@UseGuards(AdminGuard)
export class DeploymentsController {
  constructor(
    private readonly deployments: DeploymentsService,
    private readonly backupAlarm: BackupAlarmService,
  ) {}

  // OwnerGuard: savunma-derinliği (denetim H1) — prod dağıtımı tetikleyen bu uç, Next isOwner()
  // kontrolüne EK olarak API'de de owner rolü ister (tek eksik UI kontrolü yükselmeyi sağlamasın).
  @Post()
  @UseGuards(OwnerGuard)
  async request(@Body(new ZodBody(RequestSchema)) body: RequestInput, @AdminActor() actor: string) {
    return this.deployments.request(body.target, actor, body.note);
  }

  @Get()
  async list() {
    return this.deployments.list();
  }

  /**
   * Yedek / tatbikat özeti (§16 DR) — "son yedek ne zaman, tatbikat geçti mi". Salt-okunur;
   * `deployments` kayıtlarından türetilir (yeni tablo YOK). Rota `:id` içeren hiçbir GET ile
   * çakışmaz ama yine de parametreli rotalardan ÖNCE tanımlandı (Nest sıraya göre eşler).
   */
  @Get('backup-summary')
  async backupSummary() {
    return this.deployments.backupSummary();
  }

  /**
   * Yedek/tatbikat TAZELİK alarmını ELLE koştur (§16 DR). Tekrarlı iş 6 saatte bir aynı işi
   * yapar; bu uç kurulum doğrulaması + RUNBOOK adımı içindir ("alarm kanalı gerçekten
   * çalışıyor mu?" sorusu ancak tetiklenerek yanıtlanır — yedek yolu sessizce ölebildiği için
   * bu doğrulamanın kendisi de bir DR gereğidir). Yan etkisi YALNIZ bildirim üretimidir;
   * yedek ALMAZ (yedek tetiklemek owner-only POST / ile yapılır).
   */
  @Post('backup-alarm/run')
  async runBackupAlarm() {
    return this.backupAlarm.checkFreshness();
  }

  /**
   * Runner: bekleyen en eski isteği claim et (pending→running). Yoksa null.
   * Gövdedeki `targets` ile runner kendi hedef sınıfını süzer (yedek runner'ı dağıtım
   * isteğini ASLA kapmasın — claim geri alınamaz).
   *
   * OwnerGuard (denetim D3): kuyruğu ÜRETEN uç (POST /) owner-only iken TÜKETEN uçlar açıktı.
   * Owner-olmayan bir admin, Next sunucusu üzerinden (ör. bir sunucu aksiyonundaki yol
   * enjeksiyonu — bkz. ops/actions.ts SEC notu) claim çağırıp owner'ın isteğini KAPABİLİRDİ:
   * claim geri alınamaz, gerçek runner işi bulamaz, istek "çalıştı" sanılıp kaybolurdu.
   *
   * RUNNER KIRILMAZ: `deploy-runner.sh` / `backup-runner.sh` yalnız `X-Admin-Token` gönderir,
   * `x-admin-role` GÖNDERMEZ → guard'ın "başlık yok → geçir" dalına düşer. Guard yalnız
   * başlığı İLETEN (yani Next oturumu üzerinden gelen) owner-olmayan çağrıyı keser.
   */
  @Post('claim')
  @UseGuards(OwnerGuard)
  async claim(@Body(new ZodBody(ClaimSchema)) body: ClaimInput) {
    const row = await this.deployments.claimNext(body.targets);
    return row ?? {};
  }

  /**
   * Runner: dağıtım sonucunu yaz.
   *
   * OwnerGuard (denetim D3): bu uç dağıtım GEÇMİŞİNİ yazar ve o geçmiş bir denetim kaydı olarak
   * okunuyor. Korumasızken owner-olmayan bir admin uydurma `status:'success'` + uydurma
   * `gitSha`/`log` yazabilir, panel "dağıtım başarılı" gösterirken gerçekte hiçbir şey
   * dağıtılmamış olurdu. Runner uyumu `claim` ile aynı gerekçeyle korunur (rol başlığı yok).
   */
  @Patch(':id/finish')
  @UseGuards(OwnerGuard)
  async finish(@Param('id') id: string, @Body(new ZodBody(FinishSchema)) body: FinishInput) {
    const row = await this.deployments.finish(id, body.status, {
      gitSha: body.gitSha,
      log: body.log,
      error: body.error,
    });
    return row ?? {};
  }
}
