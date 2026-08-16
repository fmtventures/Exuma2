import type { AssetId, SiteId, UserId } from '../core/ids.ts';

/**
 * Media asset model.
 *
 * Every asset records where it came from and what may be done with it. This is
 * the difference between a media library and a liability: an agency managing
 * 80 client sites needs to know which images are licensed, which were AI
 * generated, and which were scraped from a source site during migration.
 */

export type AssetKind = 'image' | 'video' | 'document' | 'audio';

export type AssetOrigin =
  | 'upload'
  | 'import_crawl'
  | 'ai_generated'
  | 'ai_edited'
  | 'stock_library'
  | 'integration';

export interface AssetRights {
  origin: AssetOrigin;
  /** Who supplied it — user name, stock provider, or source URL. */
  source?: string;
  owner?: string;
  license?: string;
  /** Explicit confirmation, required before an asset can be published. */
  approvedForCommercialUse: boolean;
  expiresAt?: string;
  /** True for anything a model produced or materially altered. */
  aiGenerated: boolean;
  /** Chain of AI operations applied, newest last. */
  editHistory: Array<{ operation: string; at: string; by: UserId | 'system'; provider?: string }>;
  /**
   * Set when an edit could change what the image factually depicts — sky
   * replacement on a property listing, object removal, generative fill. Used
   * to force disclosure in industries where that matters.
   */
  materiallyAltered: boolean;
}

export interface FocalPoint {
  /** Normalized 0..1 coordinates of the subject's centre. */
  x: number;
  y: number;
}

export interface SubjectBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Asset {
  id: AssetId;
  siteId: SiteId;
  kind: AssetKind;
  filename: string;
  /** Storage key; the CDN URL is derived, never stored. */
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  altText?: string;
  /** True when alt text came from a model and has not been reviewed. */
  altTextGenerated: boolean;
  caption?: string;
  tags: string[];
  focalPoint?: FocalPoint;
  subjectBox?: SubjectBox;
  rights: AssetRights;
  /** Perceptual hash for duplicate detection. */
  phash?: string;
  /** Vision embedding for natural-language search. */
  embedding?: number[];
  /** Pages/records currently referencing this asset. */
  usageCount: number;
  uploadedBy: UserId | 'system';
  createdAt: string;
  archivedAt?: string;
}

/** Assets may not be published until rights are settled. */
export function isPublishable(asset: Asset): { ok: boolean; reason?: string } {
  if (asset.archivedAt) return { ok: false, reason: 'Asset is archived.' };
  if (!asset.rights.approvedForCommercialUse) {
    return { ok: false, reason: 'Commercial use has not been confirmed for this asset.' };
  }
  if (asset.rights.expiresAt && Date.parse(asset.rights.expiresAt) <= Date.now()) {
    return { ok: false, reason: 'The licence for this asset has expired.' };
  }
  return { ok: true };
}

/**
 * SEO-friendly filename derived from alt text or caption. Search engines and
 * screen readers both benefit; `IMG_4821.jpg` helps neither.
 */
export function seoFilename(asset: Asset, fallback: string): string {
  const base = (asset.altText || asset.caption || fallback)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 60)
    .replace(/^-|-$/g, '');
  const ext = asset.filename.split('.').pop() ?? 'jpg';
  return `${base || 'image'}.${ext}`;
}
