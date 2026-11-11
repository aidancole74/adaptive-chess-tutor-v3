/** Lazy, versioned content-pack loading with a storage-quota check. Packs are same-origin static files. */
import type { PackInfo, PackManifest } from './types';

const base = (): string => `${import.meta.env.BASE_URL}packs/`;
let manifestPromise: Promise<PackManifest | null> | null = null;
const shardCache = new Map<string, Promise<unknown>>();

export function loadManifest(): Promise<PackManifest | null> {
  manifestPromise ??= fetch(`${base()}manifest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<PackManifest>) : null))
    .catch(() => null);
  return manifestPromise;
}

export async function packInfo(id: string): Promise<PackInfo | null> {
  return (await loadManifest())?.packs.find((p) => p.id === id) ?? null;
}

/** Fetch one shard (cached in memory; the service worker caches it for offline use). Null when unavailable. */
export function loadShard<T>(pack: PackInfo, file: string): Promise<T | null> {
  const url = `${base()}${pack.id}/${file}?v=${encodeURIComponent(pack.version)}`;
  let p = shardCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    shardCache.set(url, p);
    void p.then((v) => {
      if (v === null) shardCache.delete(url);
    });
  }
  return p as Promise<T | null>;
}

export interface QuotaCheck {
  ok: boolean;
  /** Bytes; null when the browser does not report them. */
  usage: number | null;
  quota: number | null;
  needed: number;
}

/** Is there room to cache `needed` more bytes? Unknown quota counts as ok. */
export async function checkQuota(needed: number): Promise<QuotaCheck> {
  try {
    const est = await navigator.storage?.estimate?.();
    if (!est || est.quota === undefined) return { ok: true, usage: null, quota: null, needed };
    const usage = est.usage ?? 0;
    return { ok: est.quota - usage > needed * 1.2, usage, quota: est.quota, needed };
  } catch {
    return { ok: true, usage: null, quota: null, needed };
  }
}

export function packBytes(p: PackInfo): number {
  return p.shards.reduce((a, s) => a + s.bytes, 0);
}

/** Download every shard of a pack so it is available offline. Reports progress in bytes. */
export async function downloadPack(pack: PackInfo, onProgress?: (done: number, total: number) => void): Promise<{ ok: boolean; reason?: string }> {
  const total = packBytes(pack);
  const q = await checkQuota(total);
  if (!q.ok) return { ok: false, reason: `Not enough storage: needs ${(total / 1e6).toFixed(1)} MB.` };
  let done = 0;
  for (const s of pack.shards) {
    const data = await loadShard(pack, s.file);
    if (data === null) return { ok: false, reason: `Could not download ${s.file}.` };
    done += s.bytes;
    onProgress?.(done, total);
  }
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* optional */
  }
  return { ok: true };
}
