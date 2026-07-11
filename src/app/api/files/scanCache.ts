import { listFilesWithProjectCatalog } from "@/lib/scanner";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanRefresh = {
  revision: number;
  promise: Promise<FileScanSnapshot>;
};
type FileScanCacheSlot = {
  snapshot?: FileScanSnapshot;
  snapshotRevision: number;
  refreshedAt: number;
  refresh?: FileScanRefresh;
  refreshScheduled?: boolean;
};

export type CachedFileScan = {
  snapshot: FileScanSnapshot;
  refreshAfterResponse?: () => Promise<void>;
};

const FILE_SCAN_FRESH_MS = 1_000;
const FILE_SCAN_CACHE_MAX_PROJECTS = 32;
const fileScanCacheStore = globalThis as typeof globalThis & {
  __llvFilesRouteScans?: Map<string, FileScanCacheSlot>;
};

function fileScanCache(): Map<string, FileScanCacheSlot> {
  fileScanCacheStore.__llvFilesRouteScans ??= new Map();
  return fileScanCacheStore.__llvFilesRouteScans;
}

function beginFileScanRefresh(slot: FileScanCacheSlot, selectedProject: string | undefined, revision: number): FileScanRefresh {
  let refresh!: FileScanRefresh;
  const promise = listFilesWithProjectCatalog(selectedProject, { persist: false }).then((snapshot) => {
    slot.snapshot = snapshot;
    slot.snapshotRevision = Math.max(slot.snapshotRevision, revision);
    slot.refreshedAt = Date.now();
    return snapshot;
  }).finally(() => {
    if (slot.refresh === refresh) slot.refresh = undefined;
  });
  refresh = { revision, promise };
  slot.refresh = refresh;
  return refresh;
}

async function refreshThroughRevision(
  slot: FileScanCacheSlot,
  selectedProject: string | undefined,
  requestedRevision: number,
): Promise<FileScanSnapshot> {
  while (!slot.snapshot || slot.snapshotRevision < requestedRevision) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, requestedRevision);
    await refresh.promise;
  }
  return slot.snapshot;
}

export async function cachedFileScan(
  selectedProject?: string,
  now = Date.now(),
  requestedRevision?: number,
): Promise<CachedFileScan> {
  const key = selectedProject ?? "";
  const cache = fileScanCache();
  let slot = cache.get(key);
  if (!slot) {
    if (cache.size >= FILE_SCAN_CACHE_MAX_PROJECTS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    slot = { snapshotRevision: 0, refreshedAt: 0 };
    cache.set(key, slot);
  } else {
    cache.delete(key);
    cache.set(key, slot);
  }

  if (requestedRevision !== undefined) {
    const snapshot = await refreshThroughRevision(slot, selectedProject, requestedRevision);
    return { snapshot: structuredClone(snapshot) };
  }

  if (!slot.snapshot) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotRevision);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }

  let refreshAfterResponse: (() => Promise<void>) | undefined;
  if (!slot.refresh && !slot.refreshScheduled && now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    slot.refreshScheduled = true;
    refreshAfterResponse = async () => {
      try {
        const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotRevision);
        await refresh.promise;
      } catch (error) {
        console.error("[files] background scan refresh failed", error);
      } finally {
        slot.refreshScheduled = false;
      }
    };
  }
  return { snapshot: structuredClone(slot.snapshot), refreshAfterResponse };
}

export function resetFilesRouteCacheForTests(): void {
  fileScanCache().clear();
}
