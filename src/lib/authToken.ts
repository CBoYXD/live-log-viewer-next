import { createHash, timingSafeEqual } from "node:crypto";

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function tokensMatch(a: string, b: string): boolean {
  try {
    return timingSafeEqual(hashToken(a), hashToken(b));
  } catch {
    return false;
  }
}
