import { z } from 'zod';

/**
 * Business Knowledge Graph — entity schemas.
 *
 * This is the reusable structured record of "what this business actually is".
 * It is produced by Smart Import, refined by the user, and then consumed by
 * every other module: page generation, SEO/schema.org output, the AI
 * assistant's context, CRM sync, and other Sidelio suite products.
 *
 * Design rules:
 *  - Only `id` and a display name are ever required. Import is incremental and
 *    partial knowledge must round-trip without failing validation.
 *  - Nothing here stores a raw value's trust; that lives on the Fact wrapper
 *    in core/provenance.ts, keyed by `entityId` + field path.
 *  - Field names deliberately track schema.org where a mapping exists, so the
 *    renderer can emit structured data without a translation table.
 */

export const ENTITY_TYPES = [
  'Business', 'Brand', 'Location', 'Department', 'Employee', 'Agent',
  'Service', 'ServiceArea', 'Product', 'ProductVariant', 'Collection',
  'Promotion', 'Testimonial', 'FAQ', 'Event', 'Article', 'Document',
  'Photo', 'Video', 'Form', 'ContactPoint', 'SocialProfile', 'OpeningHours',
  'Price', 'Policy', 'CTA', 'LeadSource', 'Integration', 'Domain',
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

const base = z.object({
  id: z.string(),
  type: z.enum(ENTITY_TYPES),
  /** Free-form tags used by the assistant and the review UI. */
  tags: z.array(z.string()).default([]),
});

const money = z.object({
  amount: z.number(),
  currency: z.string().length(3).default('CAD'),
});

const address = z.object({
  street: z.string().optional(),
  street2: z.string().optional(),
  city: z.string().optional(),
  region: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const openingHoursSpec = z.object({
  dayOfWeek: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  opens: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closes: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  closed: z.boolean().default(false),
});

export const BusinessSchema = base.extend({
  type: z.literal('Business'),
  name: z.string(),
  legalName: z.string().optional(),
  description: z.string().optional(),
  /** Free-text industry label plus an optional normalized code. */
  industry: z.string().optional(),
  industryCode: z.string().optional(),
  foundedYear: z.number().int().optional(),
  employeeCount: z.number().int().optional(),
  taxId: z.string().optional(),
  websiteUrl: z.string().optional(),
  primaryLocationId: z.string().optional(),
  valueProposition: z.string().optional(),
  /** Short phrases the assistant reuses for tone-consistent copy. */
  toneKeywords: z.array(z.string()).default([]),
});

export const BrandSchema = base.extend({
  type: z.literal('Brand'),
  name: z.string(),
  logoAssetId: z.string().optional(),
  altLogoAssetId: z.string().optional(),
  faviconAssetId: z.string().optional(),
  colors: z.record(z.string()).default({}),
  fonts: z.object({ heading: z.string().optional(), body: z.string().optional() }).default({}),
  voice: z.string().optional(),
  imageStyle: z.array(z.string()).default([]),
});

export const LocationSchema = base.extend({
  type: z.literal('Location'),
  name: z.string(),
  address: address.default({}),
  phone: z.string().optional(),
  email: z.string().optional(),
  hours: z.array(openingHoursSpec).default([]),
  timezone: z.string().optional(),
  mapUrl: z.string().optional(),
  isPrimary: z.boolean().default(false),
});

export const EmployeeSchema = base.extend({
  type: z.literal('Employee'),
  name: z.string(),
  role: z.string().optional(),
  bio: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  photoAssetId: z.string().optional(),
  locationId: z.string().optional(),
  departmentId: z.string().optional(),
  socialProfileIds: z.array(z.string()).default([]),
  /** Licences/designations — common in regulated industries. */
  credentials: z.array(z.string()).default([]),
});

export const ServiceSchema = base.extend({
  type: z.literal('Service'),
  name: z.string(),
  description: z.string().optional(),
  shortDescription: z.string().optional(),
  categoryPath: z.array(z.string()).default([]),
  price: money.optional(),
  priceNote: z.string().optional(),
  durationMinutes: z.number().int().optional(),
  serviceAreaIds: z.array(z.string()).default([]),
  bookable: z.boolean().default(false),
  imageAssetIds: z.array(z.string()).default([]),
});

export const ProductSchema = base.extend({
  type: z.literal('Product'),
  name: z.string(),
  sku: z.string().optional(),
  description: z.string().optional(),
  price: money.optional(),
  compareAtPrice: money.optional(),
  currency: z.string().length(3).optional(),
  inventoryQuantity: z.number().int().optional(),
  categoryPath: z.array(z.string()).default([]),
  imageAssetIds: z.array(z.string()).default([]),
  variantIds: z.array(z.string()).default([]),
  weightGrams: z.number().optional(),
  taxable: z.boolean().default(true),
});

export const TestimonialSchema = base.extend({
  type: z.literal('Testimonial'),
  quote: z.string(),
  authorName: z.string().optional(),
  authorTitle: z.string().optional(),
  rating: z.number().min(0).max(5).optional(),
  date: z.string().optional(),
  /** Where the testimonial was displayed on the source site. */
  sourceUrl: z.string().optional(),
});

export const FAQSchema = base.extend({
  type: z.literal('FAQ'),
  question: z.string(),
  answer: z.string(),
  categoryPath: z.array(z.string()).default([]),
});

export const EventSchema = base.extend({
  type: z.literal('Event'),
  name: z.string(),
  description: z.string().optional(),
  startsAt: z.string().optional(),
  endsAt: z.string().optional(),
  allDay: z.boolean().default(false),
  recurrenceRule: z.string().optional(),
  locationId: z.string().optional(),
  venueName: z.string().optional(),
  capacity: z.number().int().optional(),
  registrationUrl: z.string().optional(),
  price: money.optional(),
  imageAssetIds: z.array(z.string()).default([]),
});

export const ArticleSchema = base.extend({
  type: z.literal('Article'),
  title: z.string(),
  slug: z.string().optional(),
  excerpt: z.string().optional(),
  body: z.string().optional(),
  authorEmployeeId: z.string().optional(),
  publishedAt: z.string().optional(),
  categoryPath: z.array(z.string()).default([]),
  heroAssetId: z.string().optional(),
});

export const ContactPointSchema = base.extend({
  type: z.literal('ContactPoint'),
  contactType: z.enum(['phone', 'email', 'fax', 'whatsapp', 'sms', 'other']),
  value: z.string(),
  label: z.string().optional(),
  locationId: z.string().optional(),
  /** e.g. "sales", "support", "emergency". */
  purpose: z.string().optional(),
});

export const SocialProfileSchema = base.extend({
  type: z.literal('SocialProfile'),
  network: z.string(),
  url: z.string(),
  handle: z.string().optional(),
});

export const FormSchema = base.extend({
  type: z.literal('Form'),
  name: z.string(),
  fields: z.array(z.object({
    name: z.string(),
    label: z.string().optional(),
    inputType: z.string(),
    required: z.boolean().default(false),
    options: z.array(z.string()).default([]),
  })).default([]),
  submitLabel: z.string().optional(),
  destinationEmail: z.string().optional(),
  sourceUrl: z.string().optional(),
});

export const DocumentSchema = base.extend({
  type: z.literal('Document'),
  title: z.string(),
  fileUrl: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().optional(),
});

export const PolicySchema = base.extend({
  type: z.literal('Policy'),
  name: z.string(),
  /** privacy, terms, returns, shipping, accessibility, cookie… */
  policyType: z.string(),
  body: z.string().optional(),
  sourceUrl: z.string().optional(),
});

export const CTASchema = base.extend({
  type: z.literal('CTA'),
  label: z.string(),
  href: z.string().optional(),
  /** call, book, quote, buy, subscribe, directions, download… */
  intent: z.string().optional(),
  occurrences: z.number().int().default(1),
});

/** Types without bespoke fields still get a name + free-form attributes. */
const GenericSchema = base.extend({
  name: z.string(),
  attributes: z.record(z.unknown()).default({}),
});

export const ENTITY_SCHEMAS: Partial<Record<EntityType, z.ZodTypeAny>> = {
  Business: BusinessSchema,
  Brand: BrandSchema,
  Location: LocationSchema,
  Employee: EmployeeSchema,
  Agent: EmployeeSchema,
  Service: ServiceSchema,
  Product: ProductSchema,
  Testimonial: TestimonialSchema,
  FAQ: FAQSchema,
  Event: EventSchema,
  Article: ArticleSchema,
  ContactPoint: ContactPointSchema,
  SocialProfile: SocialProfileSchema,
  Form: FormSchema,
  Document: DocumentSchema,
  Policy: PolicySchema,
  CTA: CTASchema,
};

export function schemaFor(type: EntityType): z.ZodTypeAny {
  return ENTITY_SCHEMAS[type] ?? GenericSchema.extend({ type: z.literal(type) });
}

export type Business = z.infer<typeof BusinessSchema>;
export type Location = z.infer<typeof LocationSchema>;
export type Employee = z.infer<typeof EmployeeSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Testimonial = z.infer<typeof TestimonialSchema>;
export type FAQ = z.infer<typeof FAQSchema>;
export type SiteEvent = z.infer<typeof EventSchema>;
export type Article = z.infer<typeof ArticleSchema>;
export type ContactPoint = z.infer<typeof ContactPointSchema>;
export type SocialProfile = z.infer<typeof SocialProfileSchema>;
export type SiteForm = z.infer<typeof FormSchema>;

/** Any validated entity. */
export interface Entity {
  id: string;
  type: EntityType;
  tags: string[];
  [key: string]: unknown;
}
