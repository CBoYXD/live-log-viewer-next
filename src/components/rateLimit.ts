import type { TFunction, Locale } from "@/lib/i18n";
import type { RateLimitState } from "@/lib/types";

export function formatRateLimitTime(resetAt: number, locale: Locale): string {
  return new Date(resetAt * 1000).toLocaleTimeString(locale === "uk" ? "uk-UA" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function rateLimitText(t: TFunction, locale: Locale, rateLimit: Pick<RateLimitState, "resetAt">): string {
  return rateLimit.resetAt
    ? t("rateLimit.badgeUntil", { time: formatRateLimitTime(rateLimit.resetAt, locale) })
    : t("rateLimit.badge");
}
