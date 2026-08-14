import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { CustomersService } from './customers.service';

const UpdateCustomerBody = z.object({
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});
type UpdateCustomerBody = z.infer<typeof UpdateCustomerBody>;

/**
 * Boş string = "süzgeç yok" (admin tarafı `?site=` gibi boş parametre gönderebilir);
 * dolu ise GEÇERLİ UUID olmak ZORUNDA. Desen `stock.controller.ts` içindeki `optionalUuid`
 * ile birebir aynıdır (z.preprocess/z.coerce KULLANILMAZ — girdi tipini `unknown` yapıp
 * `ZodBody<T>` ile çakışırlar).
 */
const optionalUuid = z.union([z.literal(''), z.string().uuid()]).optional();

/**
 * `/customers` liste süzgeçleri.
 *
 * NEDEN DOĞRULAMA: `siteId` daha önce doğrulanmadan SQL'e gidiyordu → geçersiz değer
 * Postgres 22P02 (`invalid input syntax for type uuid`) ile **500** üretiyor ve admin
 * ekranı hata kartına düşüyordu.
 *
 * NEDEN "sessizce yok say" DEĞİL de AÇIK 400: bozuk bir `?site=` değerini süzgeçsiz kabul
 * etmek TÜM müşterileri listelerdi — operatör baktığı kapsamın daraltıldığını sanırken
 * aslında global listeye bakardı. Bu projede sessiz kapsam sapması (sessiz kırpma/sessiz
 * genişletme) bilinçli olarak dürüst hataya çevriliyor; 400 operatöre bağlantının bozuk
 * olduğunu SÖYLER.
 *
 * `search` üst sınırı: girdi mağaza/operatör kaynaklı serbest metin — sınırsız string
 * gövde ve log şişirme yüzeyidir; 200 karakter e-posta aramasına fazlasıyla yeter.
 */
const ListCustomersQuery = z.object({
  search: z.string().max(200).optional(),
  siteId: optionalUuid,
});
type ListCustomersQuery = z.infer<typeof ListCustomersQuery>;

/** Admin: müşteri kayıtları (§13). ADMIN_TOKEN gerektirir. */
@Controller('admin/customers')
@UseGuards(AdminGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query(new ZodBody(ListCustomersQuery)) query: ListCustomersQuery) {
    return this.customers.list({ search: query.search, siteId: query.siteId });
  }

  /**
   * Mağaza başına müşteri özeti (`/customers` giriş ekranı).
   *
   * ROTA SIRASI KRİTİK: `@Get(':email')`ten ÖNCE tanımlanmalı — Nest rotaları tanımlanma
   * sırasına göre eşler ve aşağıya konsaydı bu adres `email = "site-summary"` olarak
   * detay ucuna düşerdi (sessizce 404/boş müşteri).
   */
  @Get('site-summary')
  siteSummary() {
    return this.customers.siteSummary();
  }

  @Get(':email')
  detail(@Param('email') email: string) {
    return this.customers.detail(email);
  }

  @Patch(':email')
  update(
    @Param('email') email: string,
    @Body(new ZodBody(UpdateCustomerBody)) body: UpdateCustomerBody,
  ) {
    return this.customers.update(email, body);
  }
}
