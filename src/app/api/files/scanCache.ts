import { listFilesWithProjectCatalog } from "@/lib/scanner";

type FileScanSnapshot = Awaited<ReturnType<typeof listFilesWithProjectCatalog>>;
type FileScanRefresh = {
  generation: number;
  promise: Promise<FileScanSnapshot>;
};
type FileScanCacheSlot = {
  snapshot?: FileScanSnapshot;
  snapshotGeneration: number;
  requestedGeneration: number;
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

function beginFileScanRefresh(slot: FileScanCacheSlot, selectedProject: string | undefined, generation: number): FileScanRefresh {
  let refresh!: FileScanRefresh;
  const promise = listFilesWithProjectCatalog(selectedProject, { persist: false }).then((snapshot) => {
    slot.snapshot = snapshot;
    slot.snapshotGeneration = Math.max(slot.snapshotGeneration, generation);
    slot.refreshedAt = Date.now();
    return snapshot;
  }).finally(() => {
    if (slot.refresh === refresh) slot.refresh = undefined;
  });
  refresh = { generation, promise };
  slot.refresh = refresh;
  return refresh;
}

async function refreshThroughGeneration(
  slot: FileScanCacheSlot,
  selectedProject: string | undefined,
  requestedGeneration: number,
): Promise<FileScanSnapshot> {
  while (!slot.snapshot || slot.snapshotGeneration < requestedGeneration) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, requestedGeneration);
    await refresh.promise;
  }
  return slot.snapshot;
}

export async function cachedFileScan(
  selectedProject?: string,
  now = Date.now(),
  requireFresh = false,
): Promise<CachedFileScan> {
  const key = selectedProject ?? "";
  const cache = fileScanCache();
  let slot = cache.get(key);
  if (!slot) {
    if (cache.size >= FILE_SCAN_CACHE_MAX_PROJECTS) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    slot = { snapshotGeneration: 0, requestedGeneration: 0, refreshedAt: 0 };
    cache.set(key, slot);
  } else {
    cache.delete(key);
    cache.set(key, slot);
  }

  if (requireFresh) {
    const requestedGeneration = slot.requestedGeneration + 1;
    slot.requestedGeneration = requestedGeneration;
    const snapshot = await refreshThroughGeneration(slot, selectedProject, requestedGeneration);
    return { snapshot: structuredClone(snapshot) };
  }

  if (!slot.snapshot) {
    const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotGeneration);
    const snapshot = await refresh.promise;
    return { snapshot: structuredClone(snapshot) };
  }

  let refreshAfterResponse: (() => Promise<void>) | undefined;
  if (!slot.refresh && !slot.refreshScheduled && now - slot.refreshedAt >= FILE_SCAN_FRESH_MS) {
    slot.refreshScheduled = true;
    refreshAfterResponse = async () => {
      try {
        const refresh = slot.refresh ?? beginFileScanRefresh(slot, selectedProject, slot.snapshotGeneration);
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
