import { createHash } from 'node:crypto';
import { newId, type AssetId, type SiteId, type UserId } from '../core/ids.ts';
import { covers, type ImportAttestation } from '../import/authorization.ts';
import type { Fetcher } from '../import/fetcher.ts';
import type { AssetReviewItem, ImportReview } from '../import/review.ts';
import type { Asset, AssetRights } from './asset.ts';
import { extensionFor, probeImage } from './probe.ts';
import { assetKey, type ObjectStore } from './store.ts';

/**
 * Import → Asset ingestion.
 *
 * The gap this fills: Smart Import recorded image URLs in the review model but
 * never created asset records, so the entire media module had no data source
 * and the renderer's `assetId` branch was unreachable.
 *
 * Ingestion is driven by the review decisions the user has already made, so it
 * honours "archive this one" rather than hoovering up everything, and it
 * re-checks the import attestation per URL because this is a new fetch path
 * that must not slip past the permission gate the crawl obeys.
 */

export interface IngestOptions {
  /** Hard ceiling on how many images one job will download. */
  maxAssets?: number;
  /** Skip anything larger than this; the fetcher also enforces its own cap. */
  maxBytes?: number;
  /** Decisions that should not be downloaded at all. */
  skipDecisions?: AssetReviewItem['decision'][];
}

export const DEFAULT_INGEST_OPTIONS: Required<IngestOptions> = {
  maxAssets: 300,
  maxBytes: 8 * 1024 * 1024,
  // An archived asset is one the user has said they do not want; downloading
  // it anyway would be both wasteful and a small betrayal of the decision.
  skipDecisions: ['archive'],
};

export interface IngestDeps {
  fetcher: Fetcher;
  storage: ObjectStore;
  siteId: SiteId;
  attestation: ImportAttestation;
  uploadedBy: UserId | 'system';
}

export type IngestOutcome =
  | { url: string; status: 'stored'; asset: Asset }
  | { url: string; status: 'duplicate'; assetId: string }
  | { url: string; status: 'skipped'; reason: string }
  | { url: string; status: 'failed'; reason: string };

export interface IngestResult {
  assets: Asset[];
  outcomes: IngestOutcome[];
  bytesStored: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Download, probe, hash and store every image the review kept.
 *
 * Failure-tolerant by design, like the crawl: an image that 404s is reported
 * and the run continues. A migration that aborts because one logo moved would
 * be useless.
 */
export async function ingestImages(
  review: ImportReview,
  deps: IngestDeps,
  options: IngestOptions = {},
): Promise<IngestResult> {
  const opts = { ...DEFAULT_INGEST_OPTIONS, ...options };
  const outcomes: IngestOutcome[] = [];
  const assets: Asset[] = [];
  /** Content hash → asset id, so the same file fetched twice stores once. */
  const byHash = new Map<string, Asset>();
  let bytesStored = 0;

  for (const item of review.assets) {
    if (assets.length >= opts.maxAssets) {
      outcomes.push({ url: item.url, status: 'skipped', reason: `asset limit of ${opts.maxAssets} reached` });
      continue;
    }
    if (opts.skipDecisions.includes(item.decision)) {
      outcomes.push({ url: item.url, status: 'skipped', reason: `review decision is "${item.decision}"` });
      continue;
    }
    if (!/^https?:/i.test(item.url)) {
      outcomes.push({ url: item.url, status: 'skipped', reason: 'not an absolute http(s) URL' });
      continue;
    }
    // The attestation is per-host and re-checked per URL. An image hotlinked
    // from a third-party CDN is outside what the user attested to, so it is
    // not downloaded.
    if (!covers(deps.attestation, item.url)) {
      outcomes.push({ url: item.url, status: 'skipped', reason: 'outside the attested sources' });
      continue;
    }

    const fetched = await deps.fetcher.getBinary(item.url);
    if (!fetched.ok) {
      outcomes.push({ url: item.url, status: 'failed', reason: fetched.error.userMessage });
      continue;
    }
    const { bytes, contentType } = fetched.value;

    if (bytes.byteLength === 0) {
      outcomes.push({ url: item.url, status: 'failed', reason: 'empty response' });
      continue;
    }
    if (bytes.byteLength > opts.maxBytes) {
      outcomes.push({ url: item.url, status: 'skipped', reason: `larger than ${opts.maxBytes} bytes` });
      continue;
    }

    const hash = sha256(bytes);
    const existing = byHash.get(hash);
    if (existing) {
      // Byte-identical file already stored under another URL — record the
      // sighting on the asset we have instead of storing it twice.
      existing.usageCount += item.usedOnPages.length;
      outcomes.push({ url: item.url, status: 'duplicate', assetId: existing.id });
      continue;
    }

    const info = probeImage(bytes);
    if (!info) {
      outcomes.push({
        url: item.url,
        status: 'failed',
        reason: `not a recognizable image (${contentType || 'unknown type'})`,
      });
      continue;
    }

    const id = newId('asset') as AssetId;
    const key = assetKey(deps.siteId, id, extensionFor(info.format));
    const stored = await deps.storage.put(key, bytes, info.mimeType);
    if (!stored.ok) {
      outcomes.push({ url: item.url, status: 'failed', reason: stored.error.userMessage });
      continue;
    }
    bytesStored += bytes.byteLength;

    const rights: AssetRights = {
      origin: 'import_crawl',
      source: item.url,
      // Migrated media is unapproved until a human confirms the rights. This
      // is the media half of the same publish gate the knowledge graph uses:
      // `isPublishable` refuses it, so it cannot reach a live page by default.
      approvedForCommercialUse: false,
      aiGenerated: false,
      editHistory: [],
      materiallyAltered: false,
    };

    const asset: Asset = {
      id,
      siteId: deps.siteId,
      kind: 'image',
      filename: filenameFrom(item.url, extensionFor(info.format)),
      storageKey: key,
      mimeType: info.mimeType,
      sizeBytes: bytes.byteLength,
      width: info.width,
      height: info.height,
      // Alt text carries over only when the source page actually had it; an
      // empty alt stays empty so the library audit flags it for review rather
      // than the gap being papered over.
      ...(item.alt && item.alt.trim() ? { altText: item.alt.trim() } : {}),
      altTextGenerated: false,
      tags: [],
      rights,
      contentHash: hash,
      usageCount: item.usedOnPages.length,
      uploadedBy: deps.uploadedBy,
      createdAt: new Date().toISOString(),
    };

    byHash.set(hash, asset);
    assets.push(asset);
    outcomes.push({ url: item.url, status: 'stored', asset });
  }

  return { assets, outcomes, bytesStored };
}

/** A readable filename from the source URL, falling back to the detected type. */
function filenameFrom(url: string, extension: string): string {
  let base = 'image';
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) base = decodeURIComponent(last).replace(/\.[^.]+$/, '');
  } catch { /* keep the fallback */ }

  const clean = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
  return `${clean || 'image'}.${extension}`;
}

export interface IngestSummary {
  stored: number;
  duplicates: number;
  skipped: number;
  failed: number;
  bytesStored: number;
}

export function summarizeIngest(result: IngestResult): IngestSummary {
  const count = (status: IngestOutcome['status']) =>
    result.outcomes.filter((o) => o.status === status).length;
  return {
    stored: count('stored'),
    duplicates: count('duplicate'),
    skipped: count('skipped'),
    failed: count('failed'),
    bytesStored: result.bytesStored,
  };
}
