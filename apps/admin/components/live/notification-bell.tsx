'use client';
import Link from 'next/link';
import { Bell, CheckCheck, Volume2, VolumeX, WifiOff } from 'lucide-react';
import { useLive } from './live-provider';
import { notificationTypeLabel, severityLabel } from '../../lib/labels';
import { cn } from '../../lib/utils';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';

/** Dropdown'da gösterilecek en fazla bildirim (tamamı için /notifications). */
const MAX_ITEMS = 10;

/** Seviye → nokta rengi. Renk TEK BAŞINA bilgi taşımaz: seviye adı sr-only metinde de var. */
const SEVERITY_DOT: Record<string, string> = {
  critical: 'bg-destructive',
  warning: 'bg-warning',
  info: 'bg-muted-foreground',
};

/**
 * Göreli zaman ("3 dk önce") — YEREL yardımcı, dış bağımlılık yok.
 * `lib/utils.relativeTime` son eki ("3 dk") taşımadığı ve 7 günden eskiyi tarihe
 * düşürmediği için burada ayrı tutuldu.
 *
 * Hydration notu: `Date.now()` kullanır ama bu metin YALNIZ açılan dropdown içinde ve
 * yalnız veri geldikten sonra render edilir (sunucuda liste her zaman boştur) → SSR/CSR
 * çıktısı ayrışmaz. 7 gün üstü mutlak tarih SABİT timezone ile biçimlenir.
 */
function relativeLabel(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diff = Date.now() - t;
  if (diff < 60_000) return 'az önce'; // gelecek tarihli (saat sapması) kayıtlar da buraya düşer
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} dk önce`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} sa önce`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} gün önce`;
  return new Date(t).toLocaleDateString('tr-TR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    timeZone: 'Europe/Istanbul',
  });
}

/**
 * Üst bar bildirim çanı (§17) — okunmamış rozeti + açılır bildirim listesi.
 *
 * Veri KAYNAĞI `useLive()`: kendi fetch'ini AÇMAZ, panelin tek canlı poll'unu paylaşır
 * (kullanıcı: "gün boyu açık kalacak, gereksiz yük/performans sorunu olmasın"). Ses
 * VARSAYILAN KAPALI ve tercihi sağlayıcı localStorage'da tutar; ses yalnız kullanıcı
 * açıkça açarsa çalar (tarayıcı otomatik-oynatma politikasıyla da uyumlu).
 *
 * Sürekli animasyon (sallanan çan / atan rozet) BİLİNÇLİ olarak yok: panel gün boyu açık
 * kalıyor, kalıcı hareket dikkat yorar (ayrıca prefers-reduced-motion sorunu doğurur).
 */
export function NotificationBell() {
  const { data, errorCount, fresh, soundEnabled, setSoundEnabled, markRead, refresh } = useLive();
  const unread = data.notifications.unread;
  const items = data.notifications.recent.slice(0, MAX_ITEMS);
  const offline = errorCount > 0;

  const badgeText = unread > 99 ? '99+' : String(unread);
  const label =
    unread > 0 ? `Bildirimler, ${unread} okunmamış` : 'Bildirimler, okunmamış bildirim yok';

  return (
    <div className="flex items-center">
      {/*
        Bağlantı sorunu: sessiz, küçük uyarı — ekranı kırmaz, modal açmaz.
        `sm` ve üstünde üst bardaki "BAĞLANTI YOK" rozeti aynı bilgiyi verdiği için burada
        GİZLENİR (aynı durumu iki kez göstermeyelim); dar ekranda o rozet gizli olduğundan
        tek gösterge burasıdır.
      */}
      {offline && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => refresh()}
              aria-label="Canlı bağlantı kesildi, yeniden deneniyor — şimdi yeniden dene"
              title="Canlı bağlantı kesildi, yeniden deneniyor — şimdi yeniden dene"
              className="inline-flex size-8 items-center justify-center rounded-md text-warning outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60 sm:hidden"
            >
              <WifiOff className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>Canlı bağlantı kesildi, yeniden deneniyor — şimdi yeniden dene</TooltipContent>
        </Tooltip>
      )}

      {/* Okunmamış sayısı değiştiğinde ekran okuyucuya bildir (görsel rozetin sesli karşılığı). */}
      <span aria-live="polite" className="sr-only">
        {unread > 0 ? `${unread} okunmamış bildirim` : ''}
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={label} title={label} className="relative">
            <Bell
              className={cn(
                unread > 0 ? 'fill-foreground/15 text-foreground' : 'text-muted-foreground',
              )}
            />
            {unread > 0 && (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-none text-destructive-foreground tabular-nums"
              >
                {badgeText}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          collisionPadding={12}
          className="w-[min(22rem,calc(100vw-1.5rem))] p-1"
        >
          <div className="flex items-center justify-between gap-1">
            <DropdownMenuLabel className="py-1">
              Bildirimler
              {unread > 0 && (
                <span className="ml-1.5 font-semibold normal-case tracking-normal text-foreground tabular-nums">
                  {badgeText} yeni
                </span>
              )}
            </DropdownMenuLabel>
            {unread > 0 && (
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault(); // panel açık kalsın (arka arkaya işlem yapılabilir)
                  void markRead();
                }}
                className="shrink-0 px-2 py-1 text-[11px] font-medium [&_svg]:size-3.5"
              >
                <CheckCheck />
                Tümünü okundu işaretle
              </DropdownMenuItem>
            )}
          </div>

          <DropdownMenuSeparator />

          {offline && (
            <p className="flex items-center gap-1.5 px-2.5 pb-1.5 pt-0.5 text-[11px] leading-snug text-warning">
              <WifiOff className="size-3 shrink-0" />
              Canlı bağlantı kesildi, yeniden deneniyor — liste güncel olmayabilir.
            </p>
          )}

          {items.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">Yeni bildirim yok.</p>
          ) : (
            <div className="max-h-80 overflow-y-auto">
              {items.map((n) => {
                const isUnread = n.readAt === null;
                const isFresh = fresh.has(`n:${n.id}`);
                return (
                  <DropdownMenuItem
                    key={n.id}
                    onSelect={(e) => {
                      e.preventDefault(); // panel açık kalsın
                      if (isUnread) void markRead([n.id]);
                    }}
                    title={isUnread ? 'Okundu işaretle' : undefined}
                    className={cn(
                      'items-start gap-2.5 px-2.5 py-2',
                      isUnread && 'bg-accent/40',
                      isFresh && 'ring-1 ring-ring/50',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1.5 size-2 shrink-0 rounded-full',
                        SEVERITY_DOT[n.severity] ?? 'bg-muted-foreground',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={cn(
                            'truncate text-xs text-foreground',
                            isUnread ? 'font-semibold' : 'font-medium',
                          )}
                          title={n.title}
                        >
                          {/* Renk tek başına bilgi taşımasın (WCAG 1.4.1). */}
                          <span className="sr-only">{severityLabel(n.severity)}: </span>
                          {n.title}
                        </span>
                        <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
                          {relativeLabel(n.createdAt)}
                        </span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                        {n.message}
                      </p>
                      <span className="mt-1 block text-[11px] text-muted-foreground">
                        {notificationTypeLabel(n.type)}
                        {isUnread && ' · okunmadı'}
                      </span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </div>
          )}

          <DropdownMenuSeparator />

          {/*
            Ses tercihi: menuitemcheckbox (aria-checked) → durum ekran okuyucuya da geçer.
            onSelect preventDefault panelin kapanmasını engeller; Radix `onCheckedChange`'i
            checkForDefaultPrevented:false ile çağırdığı için tercih yine de uygulanır.
          */}
          <DropdownMenuCheckboxItem
            checked={soundEnabled}
            onCheckedChange={(v) => setSoundEnabled(Boolean(v))}
            onSelect={(e) => e.preventDefault()}
            className="items-start py-2"
          >
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                {soundEnabled ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
                Bildirim sesi
              </span>
              <span className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                Yeni bildirim geldiğinde kısa bir uyarı sesi çalar.
              </span>
            </span>
          </DropdownMenuCheckboxItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem asChild className="justify-center py-1.5 text-xs font-medium">
            <Link href="/notifications">Tümünü gör</Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
