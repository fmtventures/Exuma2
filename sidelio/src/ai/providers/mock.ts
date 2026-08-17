import { err } from '../../core/errors.ts';
import { fail, ok, type Result } from '../../core/result.ts';
import type {
  EmbeddingProvider, GenerationContext, ImageEditProvider, ImageEditRequest,
  ImageGenerateRequest, ImageGenerateResponse, ImageProvider, TextProvider,
  TextRequest, TextResponse, UsageRecord, VisionProvider, VisionRequest, VisionResponse,
} from '../provider.ts';

/**
 * Deterministic provider used by tests, local development and the import
 * dry-run mode. Same input always produces the same output, so assistant
 * behaviour can be asserted without a network call or a model in the loop.
 */

function usage(capability: UsageRecord['capability'], credits: number): UsageRecord {
  return { provider: 'mock', model: 'mock-1', capability, credits };
}

/** Stable pseudo-random from a string — keeps mock output reproducible. */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export class MockTextProvider implements TextProvider {
  readonly name = 'mock';
  readonly models = ['mock-1'];

  /** Optional canned answers keyed by a substring of the prompt. */
  private readonly canned: Array<{ match: RegExp; text: string }>;

  constructor(canned: Array<{ match: RegExp; text: string }> = []) {
    this.canned = canned;
  }

  async generateText(req: TextRequest, _ctx: GenerationContext): Promise<Result<TextResponse>> {
    const hit = this.canned.find((c) => c.match.test(req.prompt));
    if (hit) {
      let json: unknown;
      try { json = JSON.parse(hit.text); } catch { /* plain text */ }
      return ok({ text: hit.text, ...(json !== undefined ? { json } : {}), usage: usage('text', 1) });
    }

    if (req.jsonSchema) {
      // Without a canned answer we refuse rather than inventing structure —
      // silently returning `{}` would look like a successful empty plan.
      return fail(err('AI_PLAN_NOT_APPLICABLE', 'mock provider has no canned JSON response for this prompt', {
        userMessage: 'The assistant could not produce a plan for that request.',
      }));
    }

    return ok({
      text: `[mock] ${req.prompt.slice(0, 120)}`,
      usage: usage('text', 1),
    });
  }
}

export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';

  async generateImage(req: ImageGenerateRequest, _ctx: GenerationContext): Promise<Result<ImageGenerateResponse>> {
    const [w, h] = dimensionsFor(req.aspect);
    const count = req.count ?? 1;
    return ok({
      images: Array.from({ length: count }, (_, i) => ({
        url: `mock://image/${hash(req.prompt + i)}.png`,
        width: w,
        height: h,
        seed: req.seed ?? hash(req.prompt + i) % 100000,
        mimeType: 'image/png',
      })),
      usage: usage('image_generate', count * 5),
    });
  }
}

export class MockImageEditProvider implements ImageEditProvider {
  readonly name = 'mock';
  readonly supportedOperations: ImageEditRequest['operations'][number]['op'][] = [
    'remove_background', 'replace_background', 'generative_fill', 'expand',
    'remove_object', 'replace_object', 'add_object', 'upscale', 'restore',
    'enhance_lighting', 'color_correct', 'white_balance', 'denoise', 'sharpen',
    'straighten', 'perspective_correct', 'sky_replace', 'blur_region', 'privacy_blur',
  ];

  async editImage(req: ImageEditRequest, _ctx: GenerationContext): Promise<Result<ImageGenerateResponse>> {
    const ops = req.operations.map((o) => o.op).join('+');
    return ok({
      images: [{
        url: `mock://edited/${hash(req.sourceUrl + ops)}.png`,
        width: 1600,
        height: 900,
        mimeType: 'image/png',
      }],
      usage: usage('image_edit', req.operations.length * 2),
    });
  }
}

export class MockVisionProvider implements VisionProvider {
  readonly name = 'mock';

  async analyzeImage(req: VisionRequest, _ctx: GenerationContext): Promise<Result<VisionResponse>> {
    switch (req.task) {
      case 'alt_text':
        return ok({ altText: `Photograph related to ${req.context ?? 'the page'}`, usage: usage('vision', 1) });
      case 'tags':
        return ok({ tags: ['exterior', 'daylight', 'building'], usage: usage('vision', 1) });
      case 'subject_box':
        return ok({ subjectBox: { x: 0.25, y: 0.15, width: 0.5, height: 0.6 }, usage: usage('vision', 1) });
      case 'quality_audit':
        return ok({
          quality: { sharpness: 0.8, exposure: 0.6, noise: 0.2, notes: [] },
          usage: usage('vision', 1),
        });
    }
  }
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'mock';

  async embed(inputs: string[], _ctx: GenerationContext) {
    // 16-dim deterministic vectors — enough for similarity tests.
    return ok({
      vectors: inputs.map((text) =>
        Array.from({ length: 16 }, (_, i) => ((hash(`${text}:${i}`) % 2000) - 1000) / 1000)),
      usage: usage('embedding', inputs.length),
    });
  }
}

function dimensionsFor(aspect: ImageGenerateRequest['aspect']): [number, number] {
  const map: Record<string, [number, number]> = {
    '1:1': [1024, 1024], '4:3': [1280, 960], '3:2': [1536, 1024],
    '16:9': [1920, 1080], '21:9': [2100, 900], '9:16': [1080, 1920],
    '4:5': [1080, 1350], '2:3': [1024, 1536],
  };
  return map[aspect] ?? [1024, 1024];
}
