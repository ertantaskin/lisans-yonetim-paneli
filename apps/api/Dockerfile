# syntax=docker/dockerfile:1
# Lisans Yönetim Paneli API — NestJS + Fastify (Node 22 LTS, §1).
# Kök bağlamdan build edilir: docker build -f apps/api/Dockerfile .

FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
WORKDIR /app

# ── Bağımlılıklar + build ───────────────────────────────────────────────────
FROM base AS build
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* turbo.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
# `|| pnpm install` YEDEĞİ KALDIRILDI (tedarik zinciri denetimi O1): `--frozen-lockfile`
# lockfile ile package.json uyuşmadığında HATA VERİR; eski yedek bu hatayı YUTUP build anında
# yeniden çözüm yapıyordu → o an registry'de yayınlanmış, kod incelemesinden GEÇMEMİŞ bir
# transitif sürüm sessizce prod imajına girip build "başarılı" görünüyordu. İmajlar VPS'te
# deploy.sh ile üretildiği için bu doğrudan canlıya giden bir yoldu. Artık GÜRÜLTÜLÜ ÇÖKER
# (SESSION_SECRET/MASTER_KEY doğrulamalarındaki fail-closed ilkesiyle aynı): lockfile bayatsa
# çözüm `pnpm install` ile lockfile'ı GÜNCELLEYİP commit'lemektir, build'de gizlice çözmek değil.
RUN pnpm install --frozen-lockfile
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api
RUN pnpm --filter @lisans/shared build \
  && pnpm --filter @lisans/api build

# ── Yalnız üretim bağımlılıkları ────────────────────────────────────────────
# AYRI aşama (denetim D1): eski runtime `COPY --from=build /app /app` ile TÜM devDependency
# ağacını (vitest [CRITICAL CVE], drizzle-kit, tsx, @nestjs/cli, esbuild, typescript) + tüm
# `src`/`test` kaynaklarını prod imajına taşıyordu. Uzaktan sömürülebilir DEĞİL; etki
# sömürü-SONRASI: konteynerde kod çalıştırma primitifi elde eden saldırgan hazır `tsx` +
# `drizzle-kit` + `DATABASE_URL` bulurdu. apps/admin/Dockerfile bu hatayı yapmıyordu.
#
# NOT — `--ignore-scripts` BİLEREK EKLENMEDİ: prod ağacında install script'i olan tek paket
# `msgpackr-extract` (bullmq→msgpackr'ın yerel hızlandırıcısı). Build aşaması bugün script'leri
# çalıştırıyor; runtime kurulumunu ondan FARKLI davrandırmak, yerelde build edilemeyen bir
# imajda yeni bir arıza yolu açardı. Genel tedarik-zinciri yüzeyi zaten build aşamasınca
# belirleniyor; buradaki kazanç imajın küçülmesi ve dev araçlarının YOK olmasıdır.
FROM base AS deps-prod
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/
RUN pnpm install --prod --frozen-lockfile

# ── Runtime ─────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
# DAVRANIŞ NOTU (tek bilinen fark): `app.module` pino transport'unu YALNIZ
# NODE_ENV !== 'production' iken `pino-pretty`ye (devDependency) bağlar. Bu imaj ve
# docker-compose varsayılanı ikisi de production olduğu için üretim yolu etkilenmez; ancak
# bu prod imajı bilerek NODE_ENV=development ile koşturulursa pino-pretty artık BULUNAMAZ.
# Prod imajını dev modda çalıştırmak zaten desteklenen bir kullanım değil (dev için
# docker-compose.dev.yml / `pnpm dev` var) — sürpriz olmasın diye yazıldı.
# pnpm izole düzeni: gerçek paketler /app/node_modules/.pnpm altında, proje node_modules'leri
# oraya GÖRECELİ symlink verir. Üç ağaç da AYNI mutlak yollara kopyalandığı için symlink'ler
# birebir çözülür (Docker COPY symlink'i dereference ETMEZ, symlink olarak korur).
COPY --from=deps-prod /app/node_modules ./node_modules
COPY --from=deps-prod /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=deps-prod /app/apps/api/node_modules ./apps/api/node_modules
# @lisans/shared workspace paketi: apps/api/node_modules/@lisans/shared → /app/packages/shared
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
# apps/api/package.json ŞART: health.service sürümü `__dirname/../../package.json`dan okur
# (npm_package_version `node dist/main.js` altında set DEĞİLDİR) — yoksa /health '0.0.0' derdi.
COPY --from=build /app/apps/api/package.json ./apps/api/
COPY --from=build /app/apps/api/dist ./apps/api/dist
# drizzle/ ŞART: compose command'ı `node dist/db/migrate.js` çalıştırır ve migrate.ts
# `migrationsFolder: './drizzle'` (WORKDIR'e GÖRECELİ) kullanır. Migration drizzle-orm'un
# postgres-js migrator'ı ile koşar — `drizzle-kit` CLI'ı RUNTIME'da GEREKMEZ (kanıt: migrate.ts
# yalnız 'drizzle-orm/postgres-js/migrator' + 'postgres' import eder, ikisi de dependencies).
COPY --from=build /app/apps/api/drizzle ./apps/api/drizzle
WORKDIR /app/apps/api
EXPOSE 3001
# En az ayrıcalık (güvenlik denetimi): servis root yerine hazır 'node' kullanıcısıyla çalışır.
# Uygulama diske YAZMAZ (stateless); root-sahipli dosyalar node için okunabilir/çalıştırılabilir.
# Bir çalışma-zamanı RCE'sinde konteyner-kaçış/host etki yüzeyini daraltır (savunma-derinliği).
USER node
# Migration compose command'ında koşturulur; imaj yalnız servisi başlatır.
CMD ["node", "dist/main.js"]
