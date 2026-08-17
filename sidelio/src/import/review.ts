import type { KnowledgeGraph } from '../knowledge/graph.ts';
import type { ExtractedPage, AuditFinding } from './extract/html.ts';
import type { ImportJob } from './pipeline.ts';

/**
 * Import review model.
 *
 * Backs the screen the spec describes:
 *
 *     We found:
 *       38 pages   142 images   9 services   14 employees …
 *     [IMPORT EVERYTHING] [REVIEW] [SELECT ITEMS] [IGNORE]
 *
 * Every page and asset carries a decision the user can change, plus a
 * Sidelio-recommended default so "Import everything" is a sensible one-click
 * path rather than a blind bulk action.
 */

export type PageDecision = 'import' | 'improve' | 'replace' | 'archive' | 'ignore';
export type AssetDecision = 'use_original' | 'enhance' | 'replace_ai' | 'replace_manual' | 'archive';

export interface PageReviewItem {
  url: string;
  title: string;
  pageKind: ExtractedPage['pageKind'];
  wordCount: number;
  imageCount: number;
  formCount: number;
  /** What Sidelio suggests; the user may override. */
  recommended: PageDecision;
  decision: PageDecision;
  reasons: string[];
  findings: AuditFinding[];
}

export interface AssetReviewItem {
  url: string;
  alt?: string;
  width?: number;
  height?: number;
  usedOnPages: string[];
  recommended: AssetDecision;
  decision: AssetDecision;
  reasons: string[];
}

export interface ImportSummary {
  pages: number;
  images: number;
  documents: number;
  videos: number;
  forms: number;
  services: number;
  products: number;
  employees: number;
  locations: number;
  articles: number;
  faqs: number;
  testimonials: number;
  events: number;
  socialProfiles: number;
  /** Facts that need a human decision before publish. */
  needsReview: number;
  conflicts: number;
}

export interface MigrationWarning {
  severity: 'info' | 'warning' | 'blocking';
  code: string;
  message: string;
  affected: string[];
}

export interface ImportReview {
  jobId: string;
  summary: ImportSummary;
  pages: PageReviewItem[];
  assets: AssetReviewItem[];
  /** Site-wide technical findings rolled up from every page. */
  siteFindings: Array<AuditFinding & { affectedPages: number }>;
  warnings: MigrationWarning[];
  /** URLs that could not be read, so the user knows what is missing. */
  unreachable: Array<{ url: string; reason: string }>;
  skippedByRobots: string[];
}

const LOW_RES_THRESHOLD = 600;

function recommendPage(page: ExtractedPage): { decision: PageDecision; reasons: string[] } {
  const reasons: string[] = [];

  if (page.pageKind === 'legal') {
    reasons.push('Legal pages are imported as-is so wording is preserved.');
    return { decision: 'import', reasons };
  }
  // A placeholder page: almost no copy, nothing interactive, and at most a
  // single decorative image. Gallery pages are excluded by the image count —
  // they are legitimately image-heavy and word-light.
  if (page.wordCount < 60 && page.images.length <= 1 && page.forms.length === 0) {
    reasons.push(
      page.images.length === 0
        ? `Only ${page.wordCount} words and no media — likely an empty or placeholder page.`
        : `Only ${page.wordCount} words and a single image — likely a placeholder page.`,
    );
    return { decision: 'ignore', reasons };
  }
  if (page.robotsMeta?.includes('noindex')) {
    reasons.push('Marked noindex on the current site.');
    return { decision: 'archive', reasons };
  }

  const errors = page.audit.filter((f) => f.severity === 'error');
  if (errors.length > 0) {
    reasons.push(...errors.map((e) => e.message));
    return { decision: 'improve', reasons };
  }
  if (page.wordCount < 150) {
    reasons.push('Thin content — Sidelio can expand it during rebuild.');
    return { decision: 'improve', reasons };
  }
  reasons.push('Content looks healthy.');
  return { decision: 'import', reasons };
}

function recommendAsset(item: {
  width?: number;
  height?: number;
  alt?: string;
  url: string;
}): { decision: AssetDecision; reasons: string[] } {
  const reasons: string[] = [];
  const small = (item.width ?? 0) > 0 && (item.width ?? 0) < LOW_RES_THRESHOLD;

  if (small) {
    reasons.push(`Only ${item.width}px wide — too small for a modern layout.`);
    return { decision: 'replace_ai', reasons };
  }
  if (!item.alt || item.alt.trim() === '') {
    reasons.push('Missing alt text — AI Media Studio will draft it.');
    return { decision: 'enhance', reasons };
  }
  if (/\.(bmp|tiff?)$/i.test(item.url)) {
    reasons.push('Legacy format — will be converted to WebP/AVIF.');
    return { decision: 'enhance', reasons };
  }
  reasons.push('Looks good as-is.');
  return { decision: 'use_original', reasons };
}

export function buildReview(job: ImportJob, graph: KnowledgeGraph): ImportReview {
  const extracted = job.outcomes.filter((o) => o.status === 'extracted' && o.page);
  const pages = extracted.map((o) => o.page as ExtractedPage);

  const pageItems: PageReviewItem[] = pages.map((page) => {
    const rec = recommendPage(page);
    return {
      url: page.url,
      title: page.title ?? page.headings.find((h) => h.level === 1)?.text ?? page.url,
      pageKind: page.pageKind,
      wordCount: page.wordCount,
      imageCount: page.images.length,
      formCount: page.forms.length,
      recommended: rec.decision,
      decision: rec.decision,
      reasons: rec.reasons,
      findings: page.audit,
    };
  });

  // Assets are deduplicated across pages — one image used on ten pages is one
  // decision, not ten.
  const assetMap = new Map<string, AssetReviewItem>();
  for (const page of pages) {
    for (const img of page.images) {
      const key = img.absolute ?? img.src;
      const existing = assetMap.get(key);
      if (existing) {
        if (!existing.usedOnPages.includes(page.url)) existing.usedOnPages.push(page.url);
        // A single missing-alt usage is enough to warrant enhancement.
        if ((!img.alt || img.alt.trim() === '') && existing.decision === 'use_original') {
          const rec = recommendAsset({ ...img, url: key });
          existing.recommended = rec.decision;
          existing.decision = rec.decision;
          existing.reasons = rec.reasons;
        }
        continue;
      }
      const rec = recommendAsset({ ...img, url: key });
      assetMap.set(key, {
        url: key,
        ...(img.alt !== undefined ? { alt: img.alt } : {}),
        ...(img.width !== undefined ? { width: img.width } : {}),
        ...(img.height !== undefined ? { height: img.height } : {}),
        usedOnPages: [page.url],
        recommended: rec.decision,
        decision: rec.decision,
        reasons: rec.reasons,
      });
    }
  }

  // Roll findings up so the user sees "images_missing_alt on 22 pages" once.
  const findingRollup = new Map<string, AuditFinding & { affectedPages: number }>();
  for (const page of pages) {
    for (const finding of page.audit) {
      const existing = findingRollup.get(finding.code);
      if (existing) existing.affectedPages += 1;
      else findingRollup.set(finding.code, { ...finding, affectedPages: 1 });
    }
  }

  const stats = graph.stats();
  const summary: ImportSummary = {
    pages: pages.length,
    images: assetMap.size,
    documents: stats.entitiesByType.Document ?? 0,
    videos: new Set(pages.flatMap((p) => p.videos)).size,
    forms: stats.entitiesByType.Form ?? 0,
    services: stats.entitiesByType.Service ?? 0,
    products: stats.entitiesByType.Product ?? 0,
    employees: stats.entitiesByType.Employee ?? 0,
    locations: stats.entitiesByType.Location ?? 0,
    articles: stats.entitiesByType.Article ?? 0,
    faqs: stats.entitiesByType.FAQ ?? 0,
    testimonials: stats.entitiesByType.Testimonial ?? 0,
    events: stats.entitiesByType.Event ?? 0,
    socialProfiles: stats.entitiesByType.SocialProfile ?? 0,
    needsReview: stats.pendingReview,
    conflicts: stats.conflicts,
  };

  return {
    jobId: job.id,
    summary,
    pages: pageItems,
    assets: [...assetMap.values()],
    siteFindings: [...findingRollup.values()].sort((a, b) => b.affectedPages - a.affectedPages),
    warnings: buildWarnings(job, pages, graph),
    unreachable: job.outcomes
      .filter((o) => o.status === 'unreachable' || o.status === 'error')
      .map((o) => ({ url: o.url, reason: o.message ?? 'unknown' })),
    skippedByRobots: job.outcomes.filter((o) => o.status === 'skipped_robots').map((o) => o.url),
  };
}

/** Human-readable lines for the "We found:" panel. */
export function summaryLines(summary: ImportSummary): string[] {
  const rows: Array<[number, string, string]> = [
    [summary.pages, 'page', 'pages'],
    [summary.images, 'image', 'images'],
    [summary.services, 'service', 'services'],
    [summary.products, 'product', 'products'],
    [summary.employees, 'employee', 'employees'],
    [summary.locations, 'location', 'locations'],
    [summary.articles, 'article', 'articles'],
    [summary.forms, 'form', 'forms'],
    [summary.documents, 'downloadable document', 'downloadable documents'],
    [summary.faqs, 'FAQ', 'FAQs'],
    [summary.testimonials, 'testimonial', 'testimonials'],
    [summary.events, 'event', 'events'],
    [summary.videos, 'video', 'videos'],
    [summary.socialProfiles, 'social account', 'social accounts'],
  ];
  return rows.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
}

function buildWarnings(job: ImportJob, pages: ExtractedPage[], graph: KnowledgeGraph): MigrationWarning[] {
  const warnings: MigrationWarning[] = [];

  const unreachable = job.outcomes.filter((o) => o.status === 'unreachable');
  if (unreachable.length > 0) {
    warnings.push({
      severity: 'warning',
      code: 'pages_unreachable',
      message: `${unreachable.length} page(s) could not be read and will not be migrated.`,
      affected: unreachable.map((o) => o.url),
    });
  }

  const robotsBlocked = job.outcomes.filter((o) => o.status === 'skipped_robots');
  if (robotsBlocked.length > 0) {
    warnings.push({
      severity: 'info',
      code: 'robots_blocked',
      message: `${robotsBlocked.length} page(s) were skipped because the source site's robots.txt disallows them.`,
      affected: robotsBlocked.map((o) => o.url),
    });
  }

  const budgetHit = job.outcomes.some((o) => o.status === 'skipped_budget');
  if (budgetHit) {
    warnings.push({
      severity: 'warning',
      code: 'budget_reached',
      message: `The crawl stopped at ${job.budget.maxPages} pages. Raise the limit to capture the rest of the site.`,
      affected: [],
    });
  }

  const conflicts = graph.conflicts();
  if (conflicts.length > 0) {
    warnings.push({
      severity: 'blocking',
      code: 'conflicting_facts',
      message: `${conflicts.length} business detail(s) were found with more than one value. Confirm the correct one before publishing.`,
      affected: conflicts.map((f) => f.path),
    });
  }

  const needsReview = graph.reviewQueue();
  if (needsReview.length > 0) {
    warnings.push({
      severity: 'warning',
      code: 'unverified_facts',
      message: `${needsReview.length} extracted detail(s) are unverified and will be left off the published site until you approve them.`,
      affected: needsReview.slice(0, 50).map((f) => f.path),
    });
  }

  // Preserving URLs is the single biggest SEO risk in any migration.
  const indexable = pages.filter((p) => !p.robotsMeta?.includes('noindex'));
  if (indexable.length > 0) {
    warnings.push({
      severity: 'info',
      code: 'redirects_required',
      message: `${indexable.length} existing URL(s) will need redirects so search rankings and inbound links are preserved. Sidelio generates these automatically.`,
      affected: indexable.map((p) => p.url).slice(0, 100),
    });
  }

  const tracking = new Set(pages.flatMap((p) => p.tracking.map((t) => t.vendor)));
  if (tracking.size > 0) {
    warnings.push({
      severity: 'warning',
      code: 'tracking_needs_reconnection',
      message: `The current site uses ${[...tracking].join(', ')}. Reconnect these in Integrations after publishing so measurement is not interrupted.`,
      affected: [...tracking],
    });
  }

  return warnings;
}

/** Apply a bulk action from the review screen. */
export function applyBulkDecision(
  review: ImportReview,
  action: 'import_everything' | 'accept_recommendations' | 'ignore_all',
): ImportReview {
  const pageDecision: PageDecision | null =
    action === 'import_everything' ? 'import' : action === 'ignore_all' ? 'ignore' : null;
  const assetDecision: AssetDecision | null =
    action === 'import_everything' ? 'use_original' : action === 'ignore_all' ? 'archive' : null;

  return {
    ...review,
    pages: review.pages.map((p) => ({ ...p, decision: pageDecision ?? p.recommended })),
    assets: review.assets.map((a) => ({ ...a, decision: assetDecision ?? a.recommended })),
  };
}

/** Pages that will actually be built, given current decisions. */
export function selectedPages(review: ImportReview): PageReviewItem[] {
  return review.pages.filter((p) => p.decision !== 'ignore' && p.decision !== 'archive');
}

/** Redirect map from old URLs to new Sidelio paths — generated on apply. */
export function buildRedirectMap(review: ImportReview): Array<{ from: string; to: string; status: 301 }> {
  return selectedPages(review).map((p) => {
    let path = '/';
    try {
      path = new URL(p.url).pathname.replace(/\/index\.html?$/i, '/') || '/';
    } catch { /* keep root */ }
    return { from: path, to: path, status: 301 as const };
  });
}
