"use client";

import { useLocale } from "@/lib/i18n";
import type { RateLimitState } from "@/lib/types";

import { rateLimitText } from "./rateLimit";

export function RateLimitBadge({ rateLimit }: { rateLimit?: RateLimitState | null }) {
  const { locale, t } = useLocale();
  if (!rateLimit) return null;
  const label = rateLimitText(t, locale, rateLimit);
  return (
    <span
      data-rate-limited
      className="inline-flex shrink-0 items-center rounded-full border border-err/35 bg-[#fbeaea] px-2 py-0.5 text-[10px] font-bold text-err"
      title={label}
    >
      {label}
    </span>
  );
}
