import { describe, expect, it } from 'vitest';
import { asId, type AssetId, type SiteId, type UserId } from '../src/core/ids.ts';
import { isPublishable, seoFilename, type Asset } from '../src/media/asset.ts';
import {
  auditLibrary, cosineSimilarity, findDuplicates, hammingDistance,
  planDerivatives, planStaffPhotoNormalization, responsiveImage, searchAssets,
  smartCrop, subjectFullyVisible,
} from '../src/media/studio.ts';

const SITE = asId<SiteId>('site_1');
const USER = asId<UserId>('usr_1');

/** `id` is accepted as a plain string here; the branded type is applied for us. */
function asset(over: Partial<Omit<Asset, 'id'>> & { id?: string } = {}): Asset {
  return {
    siteId: SITE,
    kind: 'image',
    filename: 'photo.jpg',
    storageKey: 'sites/site_1/photo.jpg',
    mimeType: 'image/jpeg',
    sizeBytes: 400_000,
    width: 2400,
    height: 1600,
    altText: 'A finished roof',
    altTextGenerated: false,
    tags: [],
    rights: {
      origin: 'upload', approvedForCommercialUse: true, aiGenerated: false,
      editHistory: [], materiallyAltered: false,
    },
    usageCount: 1,
    uploadedBy: USER,
    createdAt: '2026-08-01T00:00:00Z',
    ...over,
    id: asId<AssetId>(over.id ?? 'ast_1'),
  };
}

describe('smart crop', () => {
  it('centres the crop when there is no hint', () => {
    const crop = smartCrop({ width: 2000, height: 1000 }, 1);
    expect(crop).toEqual({ x: 500, y: 0, width: 1000, height: 1000 });
  });

  it('keeps the crop inside the image when the subject sits at an edge', () => {
    const crop = smartCrop({ width: 2000, height: 1000 }, 1, {
      subjectBox: { x: 0.0, y: 0.0, width: 0.1, height: 0.1 },
    });
    expect(crop.x).toBeGreaterThanOrEqual(0);
    expect(crop.y).toBeGreaterThanOrEqual(0);
    expect(crop.x + crop.width).toBeLessThanOrEqual(2000);
    expect(crop.y + crop.height).toBeLessThanOrEqual(1000);
  });

  it('follows the subject box across aspect ratios', () => {
    const source = { width: 3000, height: 2000 };
    const subject = { x: 0.7, y: 0.3, width: 0.2, height: 0.4 };

    // 16:9 is wider than the 3:2 source, so the crop spans the full width and
    // can only move vertically; a portrait crop moves horizontally instead.
    const wide = smartCrop(source, 16 / 9, { subjectBox: subject });
    expect(wide.width).toBe(3000);
    expect(wide.x).toBe(0);
    expect(subjectFullyVisible(source, wide, subject)).toBe(true);

    const tall = smartCrop(source, 9 / 16, { subjectBox: subject });
    expect(tall.x).toBeGreaterThan(source.width / 4);
  });

  it('prefers the subject box over the focal point', () => {
    const withBox = smartCrop({ width: 2000, height: 1000 }, 1, {
      subjectBox: { x: 0.6, y: 0.2, width: 0.2, height: 0.2 },
      focalPoint: { x: 0.1, y: 0.5 },
    });
    expect(withBox.x).toBeGreaterThan(500);
  });

  it('detects when a crop would clip the subject', () => {
    const source = { width: 2000, height: 1000 };
    const wide = { x: 0, y: 0, width: 2000, height: 1000 };
    const narrow = { x: 900, y: 0, width: 200, height: 200 };
    const subject = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };
    expect(subjectFullyVisible(source, wide, subject)).toBe(true);
    expect(subjectFullyVisible(source, narrow, subject)).toBe(false);
  });

  it('handles a degenerate source without throwing', () => {
    expect(smartCrop({ width: 0, height: 0 }, 1)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('derivatives and responsive delivery', () => {
  it('plans every preset and flags the ones needing upscaling', () => {
    const result = planDerivatives(asset({ width: 800, height: 600 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThan(10);
    expect(result.value.find((d) => d.name === 'hero_desktop')?.requiresUpscale).toBe(true);
    expect(result.value.find((d) => d.name === 'thumbnail')?.requiresUpscale).toBe(false);
  });

  it('refuses to plan when dimensions are unknown', () => {
    const result = planDerivatives(asset({ width: undefined, height: undefined }));
    expect(result.ok).toBe(false);
  });

  it('never offers a srcset wider than the source', () => {
    const r = responsiveImage(asset({ width: 900, height: 600 }), { displayWidth: 800 });
    const widths = [...r.srcset.matchAll(/ (\d+)w/g)].map((m) => Number(m[1]));
    expect(Math.max(...widths)).toBeLessThanOrEqual(900);
  });

  it('marks a hero as eager and high priority, others as lazy', () => {
    expect(responsiveImage(asset(), { displayWidth: 1600, isHero: true })).toMatchObject({
      loading: 'eager', fetchPriority: 'high', sizes: '100vw',
    });
    expect(responsiveImage(asset(), { displayWidth: 800 }).loading).toBe('lazy');
  });
});

describe('library health', () => {
  it('groups exact duplicates and keeps the largest copy', () => {
    const groups = findDuplicates([
      asset({ id: 'ast_1', phash: 'ffff0000', width: 800, height: 600 }),
      asset({ id: 'ast_2', phash: 'ffff0000', width: 2400, height: 1800 }),
      asset({ id: 'ast_3', phash: '00001111', width: 1000, height: 800 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.assets).toHaveLength(2);
    expect(groups[0]?.keep.id).toBe('ast_2');
    expect(groups[0]?.kind).toBe('lower_resolution');
  });

  it('groups near-duplicates within the hamming threshold', () => {
    const groups = findDuplicates([
      asset({ id: 'ast_1', phash: 'ffff0000' }),
      asset({ id: 'ast_2', phash: 'ffff0001' }),
    ]);
    expect(groups[0]?.assets).toHaveLength(2);
  });

  it('computes hamming distance', () => {
    expect(hammingDistance('0000', '0000')).toBe(0);
    expect(hammingDistance('0000', '0001')).toBe(1);
    expect(hammingDistance('ffff', '0000')).toBe(16);
  });

  it('reports the real problems in a library', () => {
    const codes = auditLibrary([
      asset({ id: 'ast_1', width: 400, height: 300 }),
      asset({ id: 'ast_2', altText: undefined }),
      asset({ id: 'ast_3', sizeBytes: 5 * 1024 * 1024 }),
      asset({ id: 'ast_4', rights: { origin: 'import_crawl', approvedForCommercialUse: false, aiGenerated: false, editHistory: [], materiallyAltered: false } }),
      asset({ id: 'ast_5', altText: 'Generated', altTextGenerated: true }),
    ]).map((i) => i.code);

    expect(codes).toContain('low_resolution');
    expect(codes).toContain('missing_alt');
    expect(codes).toContain('oversized_file');
    expect(codes).toContain('unapproved_rights');
    expect(codes).toContain('unreviewed_ai_alt');
  });
});

describe('rights', () => {
  it('blocks publishing until commercial use is confirmed', () => {
    const a = asset({ rights: { origin: 'import_crawl', approvedForCommercialUse: false, aiGenerated: false, editHistory: [], materiallyAltered: false } });
    expect(isPublishable(a).ok).toBe(false);
  });

  it('blocks an expired licence', () => {
    const a = asset({ rights: { origin: 'stock_library', approvedForCommercialUse: true, aiGenerated: false, editHistory: [], materiallyAltered: false, expiresAt: '2020-01-01T00:00:00Z' } });
    expect(isPublishable(a).ok).toBe(false);
  });

  it('allows an approved, unexpired asset', () => {
    expect(isPublishable(asset()).ok).toBe(true);
  });

  it('derives an SEO filename from the alt text', () => {
    expect(seoFilename(asset({ altText: 'New asphalt roof in Charlottetown, PE' }), 'x'))
      .toBe('new-asphalt-roof-in-charlottetown-pe.jpg');
  });
});

describe('normalization plans', () => {
  it('plans a consistent square crop for headshots and reports caveats', () => {
    const plan = planStaffPhotoNormalization([
      asset({ id: 'ast_1', width: 1200, height: 1600, subjectBox: { x: 0.3, y: 0.1, width: 0.4, height: 0.5 } }),
      asset({ id: 'ast_2', width: 400, height: 500 }),
    ]);
    expect(plan.target).toMatchObject({ width: 800, height: 800, aspect: 1 });
    expect(plan.items).toHaveLength(2);
    expect(plan.items[1]?.requiresUpscale).toBe(true);
    expect(plan.notes.some((n) => n.includes('no detected subject'))).toBe(true);
    expect(plan.notes.some((n) => n.includes('facial features are never altered'))).toBe(true);
  });
});

describe('asset search', () => {
  const library = [
    asset({ id: 'ast_1', altText: 'The team standing outside the shop', tags: ['team', 'exterior'], usageCount: 2 }),
    asset({ id: 'ast_2', altText: 'A blue house with a new roof', tags: ['exterior', 'residential'], usageCount: 0 }),
    asset({ id: 'ast_3', altText: 'Interior of the Summerside office', tags: ['interior', 'summerside'], usageCount: 5 }),
  ];

  it('matches on alt text and tags', () => {
    expect(searchAssets(library, 'team outside')[0]?.asset.id).toBe('ast_1');
    expect(searchAssets(library, 'blue house')[0]?.asset.id).toBe('ast_2');
    expect(searchAssets(library, 'summerside')[0]?.asset.id).toBe('ast_3');
  });

  it('applies structural filters exactly', () => {
    const unused = searchAssets(library, 'show me unused photos');
    expect(unused).toHaveLength(1);
    expect(unused[0]?.asset.id).toBe('ast_2');
    expect(unused[0]?.matchedOn).toBe('filter');
  });

  it('ranks by embedding similarity when vectors are present', () => {
    const withVectors = [
      asset({ id: 'ast_1', embedding: [1, 0, 0] }),
      asset({ id: 'ast_2', embedding: [0, 1, 0] }),
    ];
    const hits = searchAssets(withVectors, 'anything', { queryEmbedding: [0.9, 0.1, 0] });
    expect(hits[0]?.asset.id).toBe('ast_1');
    expect(hits[0]?.matchedOn).toBe('embedding');
  });

  it('computes cosine similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });
});
