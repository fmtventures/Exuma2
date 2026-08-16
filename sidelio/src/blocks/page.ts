import type { Block } from './schema.ts';

/** A page is metadata plus an ordered block list. Nothing else. */
export interface Page {
  id: string;
  siteId: string;
  /** Leading slash, no trailing slash except root. */
  path: string;
  title: string;
  blocks: Block[];
  seo: PageSeo;
  /** Structural arrangement; see src/render/layouts.ts. Defaults to 'stack'. */
  layout?: string;
  /** Visual devices applied on top of the layout; see src/render/treatments.ts. */
  treatments?: string[];
  status: 'draft' | 'published' | 'scheduled' | 'archived';
  /** Set when this page is generated from a CMS collection record. */
  collectionId?: string;
  recordId?: string;
  /** Template pages render one page per record of a collection. */
  isTemplate?: boolean;
  parentId?: string;
  order: number;
  locale: string;
  publishedAt?: string;
  scheduledFor?: string;
  updatedAt: string;
}

export interface PageSeo {
  metaTitle?: string;
  metaDescription?: string;
  canonical?: string;
  noindex: boolean;
  ogImageAssetId?: string;
  /** Extra JSON-LD merged with what the renderer derives automatically. */
  structuredData?: Record<string, unknown>[];
}

export interface NavigationItem {
  id: string;
  label: string;
  /** Either an internal page or an external href. */
  pageId?: string;
  href?: string;
  children: NavigationItem[];
  openInNewTab?: boolean;
}

export interface Navigation {
  id: string;
  siteId: string;
  /** header, footer, mobile, utility… */
  slot: string;
  items: NavigationItem[];
}

export function normalizePath(input: string): string {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '' || trimmed === '/') return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, '') || '/';
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Flatten a page tree into the order the sitemap should list them. */
export function sitemapOrder(pages: Page[]): Page[] {
  return [...pages]
    .filter((p) => p.status === 'published' && !p.seo.noindex && !p.isTemplate)
    .sort((a, b) => (a.path === '/' ? -1 : b.path === '/' ? 1 : a.order - b.order || a.path.localeCompare(b.path)));
}
