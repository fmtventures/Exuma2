import { err } from '../core/errors.ts';
import { fail, ok, type Result } from '../core/result.ts';

/**
 * AI provider abstraction.
 *
 * Nothing in Sidelio imports a vendor SDK directly. Text, image and video
 * generation each go through a capability interface, and providers register
 * themselves against those interfaces. That lets us swap or add a provider,
 * route by cost/latency/region, fall back when one is down, and run the whole
 * platform deterministically in tests — none of which is possible once a
 * vendor client is called from feature code.
 */

export type Capability = 'text' | 'image_generate' | 'image_edit' | 'vision' | 'embedding' | 'video';

export interface UsageRecord {
  provider: string;
  model: string;
  capability: Capability;
  inputTokens?: number;
  outputTokens?: number;
  images?: number;
  seconds?: number;
  /** Sidelio credits consumed; billed against the org's monthly allowance. */
  credits: number;
}

export interface GenerationContext {
  orgId: string;
  siteId: string;
  userId?: string;
  /** Free-form site context injected into prompts (brand, tone, page purpose). */
  siteContext?: SiteContext;
  /** Correlates every provider call made for one user action. */
  requestId: string;
}

export interface SiteContext {
  businessName?: string;
  businessDescription?: string;
  industry?: string;
  locale?: string;
  brandVoice?: string;
  imageStyle?: string[];
  primaryColor?: string;
  /** Page the user is editing, when applicable. */
  pageTitle?: string;
  pagePurpose?: string;
}

/* --- Text ---------------------------------------------------------- */

export interface TextRequest {
  system?: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  /** When set, the provider must return JSON matching this shape. */
  jsonSchema?: Record<string, unknown>;
}

export interface TextResponse {
  text: string;
  json?: unknown;
  usage: UsageRecord;
}

export interface TextProvider {
  readonly name: string;
  readonly models: string[];
  generateText(req: TextRequest, ctx: GenerationContext): Promise<Result<TextResponse>>;
}

/* --- Images -------------------------------------------------------- */

export type ImageAspect = '1:1' | '4:3' | '3:2' | '16:9' | '21:9' | '9:16' | '4:5' | '2:3';

export interface ImageGenerateRequest {
  prompt: string;
  aspect: ImageAspect;
  count?: number;
  /**
   * Descriptive attributes (cinematic, editorial, warm…). Deliberately not a
   * named-artist field — the platform does not offer living artists as presets.
   */
  styleAttributes?: string[];
  negativePrompt?: string;
  seed?: number;
  /** Transparent output for logos/icons where the provider supports it. */
  transparent?: boolean;
}

export interface GeneratedImage {
  /** Provider-hosted URL or a data reference the media service will persist. */
  url: string;
  width: number;
  height: number;
  seed?: number;
  mimeType: string;
}

export interface ImageGenerateResponse {
  images: GeneratedImage[];
  usage: UsageRecord;
}

export interface ImageProvider {
  readonly name: string;
  generateImage(req: ImageGenerateRequest, ctx: GenerationContext): Promise<Result<ImageGenerateResponse>>;
}

export type ImageEditOperation =
  | { op: 'remove_background' }
  | { op: 'replace_background'; prompt: string }
  | { op: 'generative_fill'; prompt: string; mask?: string }
  | { op: 'expand'; aspect: ImageAspect; prompt?: string }
  | { op: 'remove_object'; mask: string }
  | { op: 'replace_object'; mask: string; prompt: string }
  | { op: 'add_object'; prompt: string; mask?: string }
  | { op: 'upscale'; factor: 2 | 4 }
  | { op: 'restore' }
  | { op: 'enhance_lighting' }
  | { op: 'color_correct' }
  | { op: 'white_balance' }
  | { op: 'denoise' }
  | { op: 'sharpen' }
  | { op: 'straighten' }
  | { op: 'perspective_correct' }
  | { op: 'sky_replace'; prompt?: string }
  | { op: 'blur_region'; mask: string }
  | { op: 'privacy_blur' };

export interface ImageEditRequest {
  sourceUrl: string;
  operations: ImageEditOperation[];
}

export interface ImageEditProvider {
  readonly name: string;
  readonly supportedOperations: ImageEditOperation['op'][];
  editImage(req: ImageEditRequest, ctx: GenerationContext): Promise<Result<ImageGenerateResponse>>;
}

/* --- Vision -------------------------------------------------------- */

export interface VisionRequest {
  imageUrl: string;
  /** alt_text, tags, quality_audit, subject_box, embedding */
  task: 'alt_text' | 'tags' | 'quality_audit' | 'subject_box';
  context?: string;
}

export interface VisionResponse {
  altText?: string;
  tags?: string[];
  /** Normalized 0..1 box around the primary subject, for responsive cropping. */
  subjectBox?: { x: number; y: number; width: number; height: number };
  quality?: { sharpness: number; exposure: number; noise: number; notes: string[] };
  usage: UsageRecord;
}

export interface VisionProvider {
  readonly name: string;
  analyzeImage(req: VisionRequest, ctx: GenerationContext): Promise<Result<VisionResponse>>;
}

/* --- Embeddings (asset search) ------------------------------------- */

export interface EmbeddingProvider {
  readonly name: string;
  embed(inputs: string[], ctx: GenerationContext): Promise<Result<{ vectors: number[][]; usage: UsageRecord }>>;
}

/* --- Video --------------------------------------------------------- */

export interface VideoGenerateRequest {
  prompt?: string;
  sourceImageUrl?: string;
  durationSeconds: number;
  aspect: ImageAspect;
}

export interface VideoProvider {
  readonly name: string;
  generateVideo(
    req: VideoGenerateRequest,
    ctx: GenerationContext,
  ): Promise<Result<{ url: string; durationSeconds: number; usage: UsageRecord }>>;
}

/* --- Registry ------------------------------------------------------ */

export interface ProviderRegistration {
  text?: TextProvider;
  imageGenerate?: ImageProvider;
  imageEdit?: ImageEditProvider;
  vision?: VisionProvider;
  embedding?: EmbeddingProvider;
  video?: VideoProvider;
}

/**
 * Routes capability requests to providers, in preference order, with
 * automatic failover to the next provider on a retryable error.
 */
export class ProviderRegistry {
  private registrations: Array<{ name: string; providers: ProviderRegistration; priority: number }> = [];
  private usage: UsageRecord[] = [];

  register(name: string, providers: ProviderRegistration, priority = 100): this {
    this.registrations.push({ name, providers, priority });
    this.registrations.sort((a, b) => a.priority - b.priority);
    return this;
  }

  private chain<K extends keyof ProviderRegistration>(capability: K): NonNullable<ProviderRegistration[K]>[] {
    return this.registrations
      .map((r) => r.providers[capability])
      .filter((p): p is NonNullable<ProviderRegistration[K]> => p !== undefined);
  }

  has(capability: keyof ProviderRegistration): boolean {
    return this.chain(capability).length > 0;
  }

  recordUsage(u: UsageRecord): void {
    this.usage.push(u);
  }

  totalCredits(): number {
    return this.usage.reduce((sum, u) => sum + u.credits, 0);
  }

  usageLog(): readonly UsageRecord[] {
    return this.usage;
  }

  /** Run a capability with failover. The last error is returned if all fail. */
  private async withFailover<K extends keyof ProviderRegistration, R>(
    capability: K,
    run: (provider: NonNullable<ProviderRegistration[K]>) => Promise<Result<R & { usage: UsageRecord }>>,
  ): Promise<Result<R & { usage: UsageRecord }>> {
    const providers = this.chain(capability);
    if (providers.length === 0) {
      return fail(err('NOT_IMPLEMENTED', `no provider registered for ${String(capability)}`, {
        userMessage: 'This AI feature is not available on your plan yet.',
      }));
    }

    let last = err('AI_PROVIDER_ERROR', 'no provider attempted');
    for (const provider of providers) {
      const result = await run(provider);
      if (result.ok) {
        this.recordUsage(result.value.usage);
        return result;
      }
      last = result.error;
      // Only fail over on transient faults; a bad request will fail everywhere.
      if (!result.error.retryable) return result;
    }
    return fail(last);
  }

  generateText(req: TextRequest, ctx: GenerationContext) {
    return this.withFailover('text', (p) => p.generateText(req, ctx));
  }

  generateImage(req: ImageGenerateRequest, ctx: GenerationContext) {
    return this.withFailover('imageGenerate', (p) => p.generateImage(req, ctx));
  }

  editImage(req: ImageEditRequest, ctx: GenerationContext) {
    return this.withFailover('imageEdit', async (p) => {
      const unsupported = req.operations.filter((o) => !p.supportedOperations.includes(o.op));
      if (unsupported.length > 0) {
        return fail(err('NOT_IMPLEMENTED', `${p.name} cannot ${unsupported.map((o) => o.op).join(', ')}`, {
          retryable: true, // a different provider may support it
        }));
      }
      return p.editImage(req, ctx);
    });
  }

  analyzeImage(req: VisionRequest, ctx: GenerationContext) {
    return this.withFailover('vision', (p) => p.analyzeImage(req, ctx));
  }

  embed(inputs: string[], ctx: GenerationContext) {
    return this.withFailover('embedding', (p) => p.embed(inputs, ctx));
  }

  generateVideo(req: VideoGenerateRequest, ctx: GenerationContext) {
    return this.withFailover('video', (p) => p.generateVideo(req, ctx));
  }
}

/** Enforces the org's monthly AI allowance before a call is made. */
export class CreditGuard {
  private readonly monthlyAllowance: number;
  private used: number;

  constructor(monthlyAllowance: number, used = 0) {
    this.monthlyAllowance = monthlyAllowance;
    this.used = used;
  }

  check(estimatedCredits: number): Result<true> {
    if (this.used + estimatedCredits > this.monthlyAllowance) {
      return fail(err('AI_QUOTA_EXCEEDED', 'monthly AI allowance exhausted', {
        userMessage: `You've used your monthly AI allowance (${this.monthlyAllowance} credits). Upgrade your plan or wait for the next cycle.`,
      }));
    }
    return ok(true);
  }

  consume(credits: number): void {
    this.used += credits;
  }

  remaining(): number {
    return Math.max(0, this.monthlyAllowance - this.used);
  }
}
