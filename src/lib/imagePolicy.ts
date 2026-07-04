/**
 * Inbox image whitelist shared by the server (validation before saving) and
 * the client (attach-time checks) so both agree on what is acceptable. No
 * node: imports here — this module is bundled into client components too.
 */
export const IMAGE_MIME_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export const MAX_INBOX_IMAGE_BYTES = 10 * 1024 * 1024;

/** File extension for a whitelisted inbox image mime, or null when unsupported. */
export function inboxImageExt(mime: string): string | null {
  return IMAGE_MIME_EXT[mime] ?? null;
}
