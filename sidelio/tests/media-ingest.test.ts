import { describe, expect, it } from 'vitest';
import { asId, type OrgId, type SiteId, type UserId } from '../src/core/ids.ts';
import { createAttestation, type ImportAttestation } from '../src/import/authorization.ts';
import { StaticFetcher } from '../src/import/fetcher.ts';
import type { AssetReviewItem, ImportReview } from '../src/import/review.ts';
import { ingestImages, summarizeIngest } from '../src/media/ingest.ts';
import { extensionFor, probeImage } from '../src/media/probe.ts';
import { LocalObjectStore, MemoryObjectStore, assetKey } from '../src/media/store.ts';
import { findDuplicates, auditLibrary } from '../src/media/studio.ts';
import { isPublishable } from '../src/media/asset.ts';
import {
  BMP_16x16, GIF_32x24, JPEG_640x480, NOT_AN_IMAGE, PNG_1600x900,
  PNG_120x80, PNG_120x80_COPY, PNG_320x240, TRUNCATED_PNG, WEBP_800x600,
} from './fixtures/images.ts';

const ORG = asId<OrgId>('org_1');
const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

function attestation(hosts = ['acmeroofing.ca']): ImportAttestation {
  const r = createAttestation({
    orgId: ORG, siteId: SITE, attestedBy: USER, basis: 'owner', hosts, accepted: true,
  });
  if (!r.ok) throw new Error('setup failed');
  return r.value;
}

function reviewItem(over: Partial<AssetReviewItem> & { url: string }): AssetReviewItem {
  return {
    usedOnPages: ['https://acmeroofing.ca/'],
    recommended: 'use_original',
    decision: 'use_original',
    reasons: [],
    ...over,
  };
}

function review(assets: AssetReviewItem[]): ImportReview {
  return {
    jobId: 'imp_1',
    summary: {} as ImportReview['summary'],
    pages: [],
    assets,
    siteFindings: [],
    warnings: [],
    unreachable: [],
    skippedByRobots: [],
  };
}

describe('image probing', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(probeImage(PNG_120x80)).toMatchObject({ format: 'png', width: 120, height: 80 });
  });

  it('walks JPEG markers to SOF0 rather than reading a fixed offset', () => {
    // This fixture carries an EXIF-shaped APP1 segment before the frame, which
    // is what real camera output looks like and what breaks naive probes.
    expect(probeImage(JPEG_640x480)).toMatchObject({ format: 'jpeg', width: 640, height: 480 });
  });

  it('reads GIF little-endian dimensions', () => {
    expect(probeImage(GIF_32x24)).toMatchObject({ format: 'gif', width: 32, height: 24 });
  });

  it('reads a WebP extended-format canvas size', () => {
    expect(probeImage(WEBP_800x600)).toMatchObject({ format: 'webp', width: 800, height: 600 });
  });

  it('reads BMP dimensions', () => {
    expect(probeImage(BMP_16x16)).toMatchObject({ format: 'bmp', width: 16, height: 16 });
  });

  it('reads SVG width/height and falls back to viewBox', () => {
    const enc = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
    expect(probeImage(enc('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"></svg>')))
      .toMatchObject({ format: 'svg', width: 200, height: 100 });
    expect(probeImage(enc('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 48"></svg>')))
      .toMatchObject({ format: 'svg', width: 64, height: 48 });
  });

  it('returns null for non-images and truncated files', () => {
    expect(probeImage(NOT_AN_IMAGE)).toBeNull();
    expect(probeImage(TRUNCATED_PNG)).toBeNull();
    expect(probeImage(new Uint8Array(0))).toBeNull();
  });

  it('maps jpeg to a .jpg extension', () => {
    expect(extensionFor('jpeg')).toBe('jpg');
    expect(extensionFor('png')).toBe('png');
  });
});

describe('object store', () => {
  it('round-trips bytes and content type', async () => {
    const store = new MemoryObjectStore();
    const key = assetKey(SITE, 'ast_1', 'png');
    expect((await store.put(key, PNG_120x80, 'image/png')).ok).toBe(true);

    const got = await store.get(key);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.value.bytes).toEqual(PNG_120x80);
    expect(got.value.contentType).toBe('image/png');
  });

  it('refuses keys that escape the root', async () => {
    const store = new MemoryObjectStore();
    for (const key of ['../escape.png', '/etc/passwd', 'a\\..\\b.png', '']) {
      expect((await store.put(key, PNG_120x80, 'image/png')).ok, key).toBe(false);
    }
  });

  it('writes to disk and reads back', async () => {
    const root = `/tmp/sidelio-store-test-${Date.now()}`;
    const store = new LocalObjectStore({ root });
    const key = assetKey(SITE, 'ast_disk', 'png');
    expect((await store.put(key, PNG_120x80, 'image/png')).ok).toBe(true);

    const got = await store.get(key);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.value.bytes.byteLength).toBe(PNG_120x80.byteLength);

    expect((await store.delete(key)).ok).toBe(true);
    expect((await store.get(key)).ok).toBe(false);
  });

  it('reports a missing object rather than throwing', async () => {
    expect((await new MemoryObjectStore().get('sites/x/nope.png')).ok).toBe(false);
  });
});

describe('ingestion', () => {
  const deps = (over: Partial<Parameters<typeof ingestImages>[1]> = {}) => ({
    fetcher: new StaticFetcher({
      'https://acmeroofing.ca/img/hero.jpg': { binary: PNG_1600x900, contentType: 'image/png' },
      'https://acmeroofing.ca/img/small.jpg': { binary: PNG_320x240, contentType: 'image/png' },
      'https://acmeroofing.ca/img/copy.png': { binary: PNG_120x80_COPY, contentType: 'image/png' },
      'https://acmeroofing.ca/img/orig.png': { binary: PNG_120x80, contentType: 'image/png' },
      'https://acmeroofing.ca/img/broken.png': { binary: NOT_AN_IMAGE, contentType: 'image/png' },
    }),
    storage: new MemoryObjectStore(),
    siteId: SITE,
    attestation: attestation(),
    uploadedBy: USER as UserId,
    ...over,
  });

  it('downloads, probes and stores an image with full provenance', async () => {
    const d = deps();
    const result = await ingestImages(
      review([reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg', alt: 'A finished roof' })]),
      d,
    );

    expect(result.assets).toHaveLength(1);
    const asset = result.assets[0];
    if (!asset) throw new Error('no asset');

    expect(asset.width).toBe(1600);
    expect(asset.height).toBe(900);
    expect(asset.mimeType).toBe('image/png');
    expect(asset.altText).toBe('A finished roof');
    expect(asset.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.rights.origin).toBe('import_crawl');
    expect(asset.rights.source).toBe('https://acmeroofing.ca/img/hero.jpg');
    expect(asset.filename).toMatch(/\.png$/);

    // The bytes really landed in storage under the asset's key.
    const stored = await d.storage.get(asset.storageKey);
    expect(stored.ok).toBe(true);
  });

  it('leaves migrated media unapproved, so it cannot publish by default', async () => {
    const result = await ingestImages(
      review([reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' })]),
      deps(),
    );
    const asset = result.assets[0];
    if (!asset) throw new Error('no asset');

    expect(asset.rights.approvedForCommercialUse).toBe(false);
    const publishable = isPublishable(asset);
    expect(publishable.ok).toBe(false);
    expect(publishable.reason).toMatch(/commercial use/i);
  });

  it('re-checks the attestation per URL and refuses off-host images', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
        reviewItem({ url: 'https://someone-elses-cdn.com/img/stock.jpg' }),
      ]),
      deps(),
    );

    expect(result.assets).toHaveLength(1);
    const refused = result.outcomes.find((o) => o.url.includes('someone-elses-cdn'));
    expect(refused?.status).toBe('skipped');
    if (refused?.status === 'skipped') expect(refused.reason).toMatch(/attested/);
  });

  it('honours the review decision to archive an asset', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/small.jpg', decision: 'archive' }),
      ]),
      deps(),
    );
    expect(result.assets).toHaveLength(1);
    expect(result.outcomes.some((o) => o.status === 'skipped' && o.url.includes('small'))).toBe(true);
  });

  it('stores byte-identical files once and counts the extra usage', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/orig.png', usedOnPages: ['/a'] }),
        reviewItem({ url: 'https://acmeroofing.ca/img/copy.png', usedOnPages: ['/b', '/c'] }),
      ]),
      deps(),
    );

    expect(result.assets).toHaveLength(1);
    expect(result.outcomes.filter((o) => o.status === 'duplicate')).toHaveLength(1);
    expect(result.assets[0]?.usageCount).toBe(3);
  });

  it('reports an unrecognizable file without failing the run', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/broken.png' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
      ]),
      deps(),
    );

    expect(result.assets).toHaveLength(1);
    const failed = result.outcomes.find((o) => o.status === 'failed');
    expect(failed?.status).toBe('failed');
    if (failed?.status === 'failed') expect(failed.reason).toMatch(/not a recognizable image/);
  });

  it('keeps going when an image is unreachable', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/missing.png' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
      ]),
      deps(),
    );
    expect(result.assets).toHaveLength(1);
    expect(summarizeIngest(result).failed).toBe(1);
  });

  it('respects the asset limit', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/small.jpg' }),
      ]),
      deps(),
      { maxAssets: 1 },
    );
    expect(result.assets).toHaveLength(1);
    expect(summarizeIngest(result).skipped).toBe(1);
  });

  it('summarizes an ingest run', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/orig.png' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/copy.png' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/broken.png' }),
      ]),
      deps(),
    );
    const summary = summarizeIngest(result);
    expect(summary.stored).toBe(2);
    expect(summary.duplicates).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.bytesStored).toBeGreaterThan(0);
  });
});

describe('ingested assets feed the library tools', () => {
  it('groups exact duplicates by content hash without a perceptual hash', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/orig.png' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg' }),
      ]),
      {
        fetcher: new StaticFetcher({
          'https://acmeroofing.ca/img/orig.png': { binary: PNG_120x80, contentType: 'image/png' },
          'https://acmeroofing.ca/img/hero.jpg': { binary: PNG_1600x900, contentType: 'image/png' },
        }),
        storage: new MemoryObjectStore(),
        siteId: SITE,
        attestation: attestation(),
        uploadedBy: USER,
      },
    );

    // Two distinct images: no duplicate group.
    expect(findDuplicates(result.assets)).toHaveLength(0);

    // Same content hash on two records: grouped, even with no phash present.
    const twin = { ...(result.assets[0] as (typeof result.assets)[0]), id: asId<never>('ast_twin') };
    const groups = findDuplicates([...result.assets, twin]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('exact');
  });

  it('flags the real problems an imported library has', async () => {
    const result = await ingestImages(
      review([
        reviewItem({ url: 'https://acmeroofing.ca/img/small.jpg' }),
        reviewItem({ url: 'https://acmeroofing.ca/img/hero.jpg', alt: 'A finished roof' }),
      ]),
      {
        fetcher: new StaticFetcher({
          'https://acmeroofing.ca/img/small.jpg': { binary: PNG_320x240, contentType: 'image/png' },
          'https://acmeroofing.ca/img/hero.jpg': { binary: PNG_1600x900, contentType: 'image/png' },
        }),
        storage: new MemoryObjectStore(),
        siteId: SITE,
        attestation: attestation(),
        uploadedBy: USER,
      },
    );

    const codes = auditLibrary(result.assets).map((i) => i.code);
    expect(codes).toContain('low_resolution');    // the 320px one
    expect(codes).toContain('missing_alt');       // the one with no alt on the source
    expect(codes).toContain('unapproved_rights'); // every migrated asset, until confirmed
  });
});
