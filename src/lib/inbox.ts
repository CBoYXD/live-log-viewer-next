import path from "node:path";

import { inboxDir } from "@/lib/configDir";

/** Where the composer stores pasted images before handing agents their paths. */
export const INBOX_DIR = inboxDir();

/* Serve-side mime map. `jpeg` is accepted alongside `jpg` for files that
   predate the current save-side extension normalisation. */
const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

/* A bare filename with a whitelisted image extension. No separators, so the
   joined path cannot leave INBOX_DIR; ".." without a slash is inert. */
const INBOX_NAME_RE = /^[A-Za-z0-9._-]+\.(png|jpe?g|gif|webp)$/i;

export interface InboxImageRef {
  path: string;
  mime: string;
}

/**
 * Resolves a client-supplied inbox image name to its on-disk path. The name is
 * the only request input /api/inbox trusts, so everything that is not a plain
 * whitelisted-image basename inside INBOX_DIR is rejected here.
 */
export function inboxImageRef(name: string): InboxImageRef | null {
  const match = name.match(INBOX_NAME_RE);
  if (!match || path.basename(name) !== name) return null;
  const mime = EXT_MIME[(match[1] ?? "").toLowerCase()];
  if (!mime) return null;
  return { path: path.join(INBOX_DIR, name), mime };
}
