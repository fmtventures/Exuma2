/**
 * schema.org / JSON-LD extraction.
 *
 * Structured data is the single highest-value signal on an existing website:
 * the business has already told search engines what it is. When present it
 * outranks every heuristic in the extractor, so these facts are seeded at high
 * confidence and typically auto-approve.
 */

export interface StructuredNode {
  type: string;
  data: Record<string, unknown>;
}

/** Types we map into the knowledge graph; anything else is retained verbatim. */
export const MAPPED_TYPES: Record<string, string> = {
  Organization: 'Business',
  LocalBusiness: 'Business',
  Corporation: 'Business',
  ProfessionalService: 'Business',
  Store: 'Business',
  Restaurant: 'Business',
  RealEstateAgent: 'Business',
  HomeAndConstructionBusiness: 'Business',
  Person: 'Employee',
  Product: 'Product',
  Service: 'Service',
  Event: 'Event',
  Article: 'Article',
  BlogPosting: 'Article',
  NewsArticle: 'Article',
  Review: 'Testimonial',
  Question: 'FAQ',
  Place: 'Location',
  PostalAddress: 'Location',
  ContactPoint: 'ContactPoint',
};

function typesOf(node: Record<string, unknown>): string[] {
  const raw = node['@type'];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === 'string');
  return [];
}

/**
 * Walk arbitrarily-nested JSON-LD (including `@graph` and embedded objects)
 * and flatten every typed node. Real-world markup nests three or four levels
 * deep, so a shallow read misses most of the value.
 */
export function flattenJsonLd(input: unknown, acc: StructuredNode[] = [], depth = 0): StructuredNode[] {
  if (depth > 8 || input === null || typeof input !== 'object') return acc;

  if (Array.isArray(input)) {
    for (const item of input) flattenJsonLd(item, acc, depth + 1);
    return acc;
  }

  const node = input as Record<string, unknown>;
  const types = typesOf(node);
  for (const type of types) {
    acc.push({ type, data: node });
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === '@context' || key === '@type') continue;
    if (value !== null && typeof value === 'object') flattenJsonLd(value, acc, depth + 1);
  }
  return acc;
}

export function parseJsonLdBlocks(blocks: string[]): StructuredNode[] {
  const out: StructuredNode[] = [];
  for (const block of blocks) {
    try {
      out.push(...flattenJsonLd(JSON.parse(block)));
    } catch {
      // Malformed JSON-LD is extremely common; skipping one block must never
      // fail the whole import.
    }
  }
  return out;
}

/** Extract `og:` / `twitter:` metadata into a flat record. */
export function readSocialMeta(metas: Array<{ property?: string; name?: string; content?: string }>) {
  const out: Record<string, string> = {};
  for (const m of metas) {
    const key = (m.property ?? m.name ?? '').toLowerCase();
    if (!m.content) continue;
    if (key.startsWith('og:') || key.startsWith('twitter:')) out[key] = m.content;
  }
  return out;
}

export interface SchemaBusinessFields {
  name?: string;
  description?: string;
  telephone?: string;
  email?: string;
  url?: string;
  address?: Record<string, unknown>;
  openingHours?: unknown;
  sameAs?: string[];
  logo?: string;
}

/** Pull the business-level fields out of an Organization/LocalBusiness node. */
export function readBusinessNode(node: StructuredNode): SchemaBusinessFields {
  const d = node.data;
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
  const sameAsRaw = d['sameAs'];
  const logoRaw = d['logo'];

  const out: SchemaBusinessFields = {};
  const name = str('name'); if (name) out.name = name;
  const description = str('description'); if (description) out.description = description;
  const telephone = str('telephone'); if (telephone) out.telephone = telephone;
  const email = str('email')?.replace(/^mailto:/i, ''); if (email) out.email = email;
  const url = str('url'); if (url) out.url = url;
  if (d['address'] && typeof d['address'] === 'object') out.address = d['address'] as Record<string, unknown>;
  if (d['openingHoursSpecification']) out.openingHours = d['openingHoursSpecification'];
  else if (d['openingHours']) out.openingHours = d['openingHours'];
  if (Array.isArray(sameAsRaw)) out.sameAs = sameAsRaw.filter((s): s is string => typeof s === 'string');
  else if (typeof sameAsRaw === 'string') out.sameAs = [sameAsRaw];
  if (typeof logoRaw === 'string') out.logo = logoRaw;
  else if (logoRaw && typeof logoRaw === 'object' && typeof (logoRaw as Record<string, unknown>)['url'] === 'string') {
    out.logo = (logoRaw as Record<string, string>)['url'];
  }
  return out;
}

/** Flatten a schema.org PostalAddress into the graph's address shape. */
export function readPostalAddress(node: Record<string, unknown>) {
  const str = (k: string) => (typeof node[k] === 'string' ? (node[k] as string) : undefined);
  return {
    street: str('streetAddress'),
    city: str('addressLocality'),
    region: str('addressRegion'),
    postalCode: str('postalCode'),
    country: str('addressCountry'),
  };
}
