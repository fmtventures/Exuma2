import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';
import type { Asset, FocalPoint, SubjectBox } from './asset.ts';
import type { ImageAspect } from '../ai/provider.ts';

/**
 * AI Media Studio — the deterministic half.
 *
 * Provider calls (generation, generative fill, upscaling) live behind the AI
 * provider registry. Everything here is pure geometry and policy: smart
 * cropping, derivative formats, responsive srcsets, duplicate detection and
 * batch normalization plans. Keeping it deterministic means the same photo
 * always crops the same way, previews match output, and none of it costs a
 * credit.
 */

/* ------------------------------------------------------------------ */
/* Responsive smart crop                                               */
/* ------------------------------------------------------------------ */

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const ASPECT_RATIOS: Record<ImageAspect, number> = {
  '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9,
  '21:9': 21 / 9, '9:16': 9 / 16, '4:5': 4 / 5, '2:3': 2 / 3,
};

/**
 * Crop an image to a target aspect ratio while keeping the subject in frame.
 *
 * Preference order: an explicit subject box (from vision analysis), then a
 * focal point, then centre. The crop is the largest rectangle of the target
 * ratio that fits the source, translated so the subject stays centred, then
 * clamped to the image bounds — which is why a subject near an edge still
 * produces a valid, in-bounds crop rather than a negative offset.
 */
export function smartCrop(
  source: { width: number; height: number },
  targetAspect: number,
  hints: { subjectBox?: SubjectBox; focalPoint?: FocalPoint } = {},
): CropRect {
  const { width: sw, height: sh } = source;
  if (sw <= 0 || sh <= 0) return { x: 0, y: 0, width: 0, height: 0 };

  const sourceAspect = sw / sh;
  let cropW: number;
  let cropH: number;
  if (sourceAspect > targetAspect) {
    cropH = sh;
    cropW = sh * targetAspect;
  } else {
    cropW = sw;
    cropH = sw / targetAspect;
  }

  // Where the crop should be centred, in pixels.
  let centreX = sw / 2;
  let centreY = sh / 2;

  if (hints.subjectBox) {
    const b = hints.subjectBox;
    centreX = (b.x + b.width / 2) * sw;
    centreY = (b.y + b.height / 2) * sh;
    // Faces and headroom read better slightly above centre.
    const subjectPixelHeight = b.height * sh;
    if (subjectPixelHeight < cropH) {
      centreY -= (cropH - subjectPixelHeight) * 0.08;
    }
  } else if (hints.focalPoint) {
    centreX = hints.focalPoint.x * sw;
    centreY = hints.focalPoint.y * sh;
  }

  const x = clamp(centreX - cropW / 2, 0, sw - cropW);
  const y = clamp(centreY - cropH / 2, 0, sh - cropH);

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(cropW),
    height: Math.round(cropH),
  };
}

/** Does the crop still contain the whole subject? Warns the editor if not. */
export function subjectFullyVisible(
  source: { width: number; height: number },
  crop: CropRect,
  subject: SubjectBox,
): boolean {
  const sx = subject.x * source.width;
  const sy = subject.y * source.height;
  const sw = subject.width * source.width;
  const sh = subject.height * source.height;
  return sx >= crop.x && sy >= crop.y && sx + sw <= crop.x + crop.width && sy + sh <= crop.y + crop.height;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.max(min, n)));
}

/* ------------------------------------------------------------------ */
/* Derivative formats                                                  */
/* ------------------------------------------------------------------ */

export interface DerivativeSpec {
  name: string;
  width: number;
  height: number;
  /** Where this derivative is used, for the UI. */
  purpose: string;
  format: 'webp' | 'avif' | 'jpeg' | 'png' | 'ico';
  quality?: number;
}

/**
 * One source image feeds every surface the business needs. Sizes follow each
 * platform's current published requirements.
 */
export const DERIVATIVE_PRESETS: DerivativeSpec[] = [
  { name: 'favicon', width: 32, height: 32, purpose: 'Browser tab icon', format: 'png' },
  { name: 'favicon_large', width: 180, height: 180, purpose: 'Apple touch icon', format: 'png' },
  { name: 'og_image', width: 1200, height: 630, purpose: 'Link previews (Open Graph)', format: 'jpeg', quality: 82 },
  { name: 'twitter_card', width: 1200, height: 600, purpose: 'X/Twitter card', format: 'jpeg', quality: 82 },
  { name: 'instagram_square', width: 1080, height: 1080, purpose: 'Instagram feed post', format: 'jpeg', quality: 85 },
  { name: 'instagram_portrait', width: 1080, height: 1350, purpose: 'Instagram portrait post', format: 'jpeg', quality: 85 },
  { name: 'story', width: 1080, height: 1920, purpose: 'Stories / Reels cover', format: 'jpeg', quality: 85 },
  { name: 'email_header', width: 1200, height: 400, purpose: 'Email banner', format: 'jpeg', quality: 80 },
  { name: 'hero_desktop', width: 2400, height: 1200, purpose: 'Desktop hero', format: 'webp', quality: 78 },
  { name: 'hero_tablet', width: 1400, height: 900, purpose: 'Tablet hero', format: 'webp', quality: 78 },
  { name: 'hero_mobile', width: 800, height: 1000, purpose: 'Mobile hero', format: 'webp', quality: 78 },
  { name: 'card', width: 800, height: 600, purpose: 'Card / grid thumbnail', format: 'webp', quality: 78 },
  { name: 'thumbnail', width: 320, height: 240, purpose: 'Small thumbnail', format: 'webp', quality: 72 },
  { name: 'product', width: 1200, height: 1200, purpose: 'Product image', format: 'webp', quality: 82 },
];

export interface Derivative extends DerivativeSpec {
  crop: CropRect;
  /** True when the source is smaller than the target — upscaling needed. */
  requiresUpscale: boolean;
}

export function planDerivatives(asset: Asset, presets = DERIVATIVE_PRESETS): Result<Derivative[]> {
  if (!asset.width || !asset.height) {
    return fail(err('VALIDATION_FAILED', 'asset dimensions are unknown', {
      userMessage: 'We need to process this image before generating other sizes.',
    }));
  }
  const source = { width: asset.width, height: asset.height };
  const hints = {
    ...(asset.subjectBox ? { subjectBox: asset.subjectBox } : {}),
    ...(asset.focalPoint ? { focalPoint: asset.focalPoint } : {}),
  };

  return ok(presets.map((preset) => {
    const crop = smartCrop(source, preset.width / preset.height, hints);
    return {
      ...preset,
      crop,
      requiresUpscale: crop.width < preset.width || crop.height < preset.height,
    };
  }));
}

/* ------------------------------------------------------------------ */
/* Responsive delivery                                                 */
/* ------------------------------------------------------------------ */

export const SRCSET_WIDTHS = [320, 480, 640, 768, 1024, 1280, 1536, 1920, 2400];

export interface ResponsiveImage {
  src: string;
  srcset: string;
  sizes: string;
  width: number;
  height: number;
  alt: string;
  loading: 'lazy' | 'eager';
  decoding: 'async' | 'sync';
  fetchPriority?: 'high' | 'low' | 'auto';
}

export interface CdnUrlBuilder {
  (key: string, opts: { width: number; height?: number; format?: string; quality?: number; crop?: CropRect }): string;
}

/** Default CDN URL shape — query params an image CDN can read. */
export const defaultCdnUrl: CdnUrlBuilder = (key, opts) => {
  const params = new URLSearchParams();
  params.set('w', String(opts.width));
  if (opts.height) params.set('h', String(opts.height));
  if (opts.format) params.set('fm', opts.format);
  if (opts.quality) params.set('q', String(opts.quality));
  if (opts.crop) params.set('rect', `${opts.crop.x},${opts.crop.y},${opts.crop.width},${opts.crop.height}`);
  return `/cdn/${key}?${params.toString()}`;
};

/**
 * Build a responsive <img> descriptor. Hero images load eagerly with high
 * priority (they are the LCP element); everything else lazy-loads.
 */
export function responsiveImage(
  asset: Asset,
  opts: {
    displayWidth: number;
    aspect?: number;
    isHero?: boolean;
    sizes?: string;
    buildUrl?: CdnUrlBuilder;
  },
): ResponsiveImage {
  const build = opts.buildUrl ?? defaultCdnUrl;
  const sourceW = asset.width ?? opts.displayWidth;
  const sourceH = asset.height ?? Math.round(opts.displayWidth / (opts.aspect ?? 16 / 9));
  const aspect = opts.aspect ?? sourceW / sourceH;

  const hints = {
    ...(asset.subjectBox ? { subjectBox: asset.subjectBox } : {}),
    ...(asset.focalPoint ? { focalPoint: asset.focalPoint } : {}),
  };
  const crop = smartCrop({ width: sourceW, height: sourceH }, aspect, hints);

  // Never offer a width larger than the source — upscaling in the CDN just
  // ships more bytes for a blurrier result.
  const widths = SRCSET_WIDTHS.filter((w) => w <= Math.max(sourceW, opts.displayWidth));
  if (widths.length === 0) widths.push(sourceW);

  const srcset = widths
    .map((w) => `${build(asset.storageKey, { width: w, height: Math.round(w / aspect), format: 'webp', quality: 78, crop })} ${w}w`)
    .join(', ');

  const result: ResponsiveImage = {
    src: build(asset.storageKey, { width: opts.displayWidth, height: Math.round(opts.displayWidth / aspect), format: 'webp', quality: 78, crop }),
    srcset,
    sizes: opts.sizes ?? (opts.isHero ? '100vw' : `(max-width: 768px) 100vw, ${opts.displayWidth}px`),
    width: opts.displayWidth,
    height: Math.round(opts.displayWidth / aspect),
    alt: asset.altText ?? '',
    loading: opts.isHero ? 'eager' : 'lazy',
    decoding: opts.isHero ? 'sync' : 'async',
  };
  if (opts.isHero) result.fetchPriority = 'high';
  return result;
}

/* ------------------------------------------------------------------ */
/* Library health: duplicates, quality, consistency                    */
/* ------------------------------------------------------------------ */

/** Hamming distance between two hex perceptual hashes. */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i] as string, 16) ^ parseInt(b[i] as string, 16);
    distance += (x.toString(2).match(/1/g) ?? []).length;
  }
  return distance;
}

export interface DuplicateGroup {
  kind: 'exact' | 'near' | 'lower_resolution';
  assets: Asset[];
  /** The asset Sidelio recommends keeping. */
  keep: Asset;
  reason: string;
}

const NEAR_DUPLICATE_THRESHOLD = 6;

export function findDuplicates(assets: Asset[]): DuplicateGroup[] {
  const withHash = assets.filter((a) => a.phash && !a.archivedAt);
  const groups: DuplicateGroup[] = [];
  const claimed = new Set<string>();

  for (let i = 0; i < withHash.length; i++) {
    const a = withHash[i] as Asset;
    if (claimed.has(a.id)) continue;
    const matches: Asset[] = [a];

    for (let j = i + 1; j < withHash.length; j++) {
      const b = withHash[j] as Asset;
      if (claimed.has(b.id)) continue;
      const distance = hammingDistance(a.phash as string, b.phash as string);
      if (distance <= NEAR_DUPLICATE_THRESHOLD) matches.push(b);
    }

    if (matches.length < 2) continue;
    for (const m of matches) claimed.add(m.id);

    const exact = matches.every((m) => m.phash === a.phash);
    // Keep the largest — resolution is what you cannot get back.
    const keep = [...matches].sort((x, y) => pixels(y) - pixels(x) || y.sizeBytes - x.sizeBytes)[0] as Asset;
    const resolutionsDiffer = new Set(matches.map(pixels)).size > 1;

    groups.push({
      kind: exact ? 'exact' : resolutionsDiffer ? 'lower_resolution' : 'near',
      assets: matches,
      keep,
      reason: exact
        ? `${matches.length} identical copies.`
        : resolutionsDiffer
          ? `${matches.length} versions of the same image at different resolutions; keeping the ${keep.width}×${keep.height} original.`
          : `${matches.length} visually similar images.`,
    });
  }
  return groups;
}

function pixels(a: Asset): number {
  return (a.width ?? 0) * (a.height ?? 0);
}

export interface QualityIssue {
  assetId: string;
  code: 'low_resolution' | 'missing_alt' | 'oversized_file' | 'legacy_format' | 'unapproved_rights' | 'unreviewed_ai_alt';
  severity: 'info' | 'warning' | 'error';
  message: string;
  suggestedAction: string;
}

/** Audit the whole library — drives the "these 4 images are low resolution" nudge. */
export function auditLibrary(assets: Asset[], opts: { minHeroWidth?: number } = {}): QualityIssue[] {
  const minWidth = opts.minHeroWidth ?? 1200;
  const issues: QualityIssue[] = [];

  for (const asset of assets) {
    if (asset.archivedAt || asset.kind !== 'image') continue;

    if ((asset.width ?? 0) > 0 && (asset.width as number) < minWidth) {
      issues.push({
        assetId: asset.id,
        code: 'low_resolution',
        severity: 'warning',
        message: `${asset.filename} is ${asset.width}px wide — below the ${minWidth}px needed for a full-width section.`,
        suggestedAction: 'Use a higher-resolution original, upscale it, or generate an alternative.',
      });
    }
    if (!asset.altText || asset.altText.trim() === '') {
      issues.push({
        assetId: asset.id,
        code: 'missing_alt',
        severity: 'error',
        message: `${asset.filename} has no alt text.`,
        suggestedAction: 'Generate alt text with AI Media Studio, then review it.',
      });
    } else if (asset.altTextGenerated) {
      issues.push({
        assetId: asset.id,
        code: 'unreviewed_ai_alt',
        severity: 'info',
        message: `${asset.filename} has AI-generated alt text that has not been reviewed.`,
        suggestedAction: 'Confirm or edit the description.',
      });
    }
    if (asset.sizeBytes > 2 * 1024 * 1024) {
      issues.push({
        assetId: asset.id,
        code: 'oversized_file',
        severity: 'warning',
        message: `${asset.filename} is ${(asset.sizeBytes / 1024 / 1024).toFixed(1)} MB.`,
        suggestedAction: 'Sidelio will serve optimized WebP/AVIF derivatives automatically.',
      });
    }
    if (/(bmp|tiff?)$/i.test(asset.mimeType)) {
      issues.push({
        assetId: asset.id,
        code: 'legacy_format',
        severity: 'info',
        message: `${asset.filename} uses a legacy format.`,
        suggestedAction: 'Convert to WebP for smaller, faster delivery.',
      });
    }
    if (!asset.rights.approvedForCommercialUse) {
      issues.push({
        assetId: asset.id,
        code: 'unapproved_rights',
        severity: 'error',
        message: `${asset.filename} has not been confirmed for commercial use.`,
        suggestedAction: 'Confirm you have the rights, or replace the image.',
      });
    }
  }
  return issues;
}

/* ------------------------------------------------------------------ */
/* Batch normalization plans                                           */
/* ------------------------------------------------------------------ */

export interface NormalizationPlan {
  target: { width: number; height: number; aspect: number };
  items: Array<{
    assetId: string;
    crop: CropRect;
    requiresUpscale: boolean;
    /** Warns when a face/subject would be clipped by the shared crop. */
    subjectClipped: boolean;
  }>;
  notes: string[];
}

/**
 * Staff photo normalizer. Produces one consistent crop across headshots taken
 * on different cameras at different distances.
 *
 * It changes framing, size and container — never the person. Identity-altering
 * edits (reshaping features, changing skin tone, "beautification") are not
 * offered anywhere in the studio.
 */
export function planStaffPhotoNormalization(
  assets: Asset[],
  opts: { width?: number; height?: number } = {},
): NormalizationPlan {
  const width = opts.width ?? 800;
  const height = opts.height ?? 800;
  const aspect = width / height;
  const notes: string[] = [];

  const items = assets.map((asset) => {
    const source = { width: asset.width ?? width, height: asset.height ?? height };
    const hints = {
      ...(asset.subjectBox ? { subjectBox: asset.subjectBox } : {}),
      ...(asset.focalPoint ? { focalPoint: asset.focalPoint } : {}),
    };
    const crop = smartCrop(source, aspect, hints);
    return {
      assetId: asset.id,
      crop,
      requiresUpscale: crop.width < width,
      subjectClipped: asset.subjectBox ? !subjectFullyVisible(source, crop, asset.subjectBox) : false,
    };
  });

  const missingSubject = assets.filter((a) => !a.subjectBox && !a.focalPoint).length;
  if (missingSubject > 0) {
    notes.push(`${missingSubject} photo(s) have no detected subject and will be centre-cropped. Run subject detection first for better framing.`);
  }
  const clipped = items.filter((i) => i.subjectClipped).length;
  if (clipped > 0) {
    notes.push(`${clipped} photo(s) would have the subject clipped at this aspect ratio — review these individually.`);
  }
  const upscales = items.filter((i) => i.requiresUpscale).length;
  if (upscales > 0) {
    notes.push(`${upscales} photo(s) are smaller than ${width}px and will need upscaling.`);
  }
  notes.push('Framing, size and background treatment only — facial features are never altered.');

  return { target: { width, height, aspect }, items, notes };
}

/** Product image normalizer — same canvas, margin and background for a grid. */
export function planProductNormalization(
  assets: Asset[],
  opts: { size?: number; marginPercent?: number } = {},
): NormalizationPlan {
  const size = opts.size ?? 1200;
  const margin = opts.marginPercent ?? 8;
  const items = assets.map((asset) => {
    const source = { width: asset.width ?? size, height: asset.height ?? size };
    const hints = {
      ...(asset.subjectBox ? { subjectBox: asset.subjectBox } : {}),
      ...(asset.focalPoint ? { focalPoint: asset.focalPoint } : {}),
    };
    return {
      assetId: asset.id,
      crop: smartCrop(source, 1, hints),
      requiresUpscale: Math.min(source.width, source.height) < size,
      subjectClipped: false,
    };
  });
  return {
    target: { width: size, height: size, aspect: 1 },
    items,
    notes: [
      `Square ${size}×${size} canvas with a ${margin}% margin around each product.`,
      'Background removal and replacement run as a separate provider step.',
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Natural-language asset search                                       */
/* ------------------------------------------------------------------ */

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export interface AssetSearchHit {
  asset: Asset;
  score: number;
  matchedOn: 'embedding' | 'tags' | 'text' | 'filter';
}

/**
 * "Show me photos of the team outside", "find unused photos".
 * Structured filters are parsed out of the query first — they are exact, and
 * mixing them into semantic scoring would make "unused" a fuzzy concept.
 */
export function searchAssets(
  assets: Asset[],
  query: string,
  opts: { queryEmbedding?: number[]; limit?: number } = {},
): AssetSearchHit[] {
  const limit = opts.limit ?? 40;
  const q = query.toLowerCase().trim();

  let pool = assets.filter((a) => !a.archivedAt);

  if (/\bunused\b|\bnot used\b/.test(q)) pool = pool.filter((a) => a.usageCount === 0);
  if (/\bai[- ]generated\b|\bgenerated by ai\b/.test(q)) pool = pool.filter((a) => a.rights.aiGenerated);
  if (/\bvideos?\b/.test(q)) pool = pool.filter((a) => a.kind === 'video');
  if (/\bdocuments?\b|\bpdfs?\b/.test(q)) pool = pool.filter((a) => a.kind === 'document');

  const structuralOnly = /^(show me |find |list )?(all )?(my |the )?(unused|ai[- ]generated|videos?|documents?|pdfs?)\s*(photos?|images?|files?)?$/.test(q);
  if (structuralOnly) {
    return pool.slice(0, limit).map((asset) => ({ asset, score: 1, matchedOn: 'filter' as const }));
  }

  const terms = q.split(/\s+/).filter((t) => t.length > 2 && !STOPWORDS.has(t));
  const hits: AssetSearchHit[] = [];

  for (const asset of pool) {
    if (opts.queryEmbedding && asset.embedding) {
      const score = cosineSimilarity(opts.queryEmbedding, asset.embedding);
      if (score > 0.2) hits.push({ asset, score, matchedOn: 'embedding' });
      continue;
    }

    const haystack = [asset.altText, asset.caption, asset.filename, ...asset.tags]
      .filter(Boolean).join(' ').toLowerCase();
    const matched = terms.filter((t) => haystack.includes(t));
    if (matched.length > 0) {
      hits.push({
        asset,
        score: matched.length / Math.max(1, terms.length),
        matchedOn: asset.tags.some((t) => terms.includes(t.toLowerCase())) ? 'tags' : 'text',
      });
    }
  }

  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

const STOPWORDS = new Set([
  'show', 'find', 'the', 'all', 'photos', 'photo', 'pictures', 'picture',
  'images', 'image', 'files', 'file', 'with', 'from', 'and', 'for', 'that',
  'have', 'has', 'our', 'your', 'me', 'get',
]);
