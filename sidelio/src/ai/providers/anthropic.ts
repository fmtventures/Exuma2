import { err } from '../../core/errors.ts';
import { fail, ok, type Result } from '../../core/result.ts';
import type {
  GenerationContext, TextProvider, TextRequest, TextResponse, VisionProvider,
  VisionRequest, VisionResponse,
} from '../provider.ts';

/**
 * Anthropic adapter (text + vision).
 *
 * Deliberately implemented against the HTTP API rather than an SDK: the
 * platform runs in several deployment targets and one fetch call is easier to
 * audit, proxy and rate-limit than a vendored client. Model ids are injected
 * so they can be changed by configuration without a deploy.
 */

export interface AnthropicConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxRetries?: number;
  /** Credits charged per 1k tokens, for the org's AI allowance. */
  creditsPerKToken?: number;
}

const DEFAULT_MODEL = 'claude-sonnet-5';
const API_VERSION = '2023-06-01';

interface AnthropicMessageResponse {
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  model?: string;
}

export class AnthropicProvider implements TextProvider, VisionProvider {
  readonly name = 'anthropic';
  readonly models: string[];

  constructor(private readonly config: AnthropicConfig) {
    this.models = [config.model ?? DEFAULT_MODEL];
  }

  private get model() {
    return this.config.model ?? DEFAULT_MODEL;
  }

  private credits(input: number, output: number): number {
    const rate = this.config.creditsPerKToken ?? 1;
    return Math.ceil(((input + output) / 1000) * rate);
  }

  private async call(body: Record<string, unknown>): Promise<Result<AnthropicMessageResponse>> {
    const url = `${this.config.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`;
    const maxRetries = this.config.maxRetries ?? 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.config.apiKey,
            'anthropic-version': API_VERSION,
          },
          body: JSON.stringify(body),
        });

        if (res.status === 429 || res.status >= 500) {
          if (attempt < maxRetries) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const backoff = Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 2 ** attempt * 500;
            await new Promise((r) => setTimeout(r, backoff));
            continue;
          }
          return fail(err(res.status === 429 ? 'AI_QUOTA_EXCEEDED' : 'AI_PROVIDER_ERROR',
            `Anthropic returned ${res.status}`, {
              userMessage: 'The AI service is busy. Please try again in a moment.',
              retryable: true,
            }));
        }

        if (!res.ok) {
          const detail = await res.text().catch(() => '');
          return fail(err('AI_PROVIDER_ERROR', `Anthropic ${res.status}: ${detail.slice(0, 400)}`, {
            userMessage: 'The AI request could not be completed.',
            retryable: false,
          }));
        }

        return ok((await res.json()) as AnthropicMessageResponse);
      } catch (cause) {
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
          continue;
        }
        return fail(err('AI_PROVIDER_ERROR', 'could not reach the AI service', {
          userMessage: 'The AI service is unreachable right now.',
          retryable: true,
          cause,
        }));
      }
    }
    return fail(err('AI_PROVIDER_ERROR', 'retries exhausted', { retryable: true }));
  }

  async generateText(req: TextRequest, _ctx: GenerationContext): Promise<Result<TextResponse>> {
    // JSON mode is requested through an explicit instruction plus a prefilled
    // assistant turn, which is far more reliable than asking in prose alone.
    const messages: Array<Record<string, unknown>> = [{ role: 'user', content: req.prompt }];
    let system = req.system;
    if (req.jsonSchema) {
      system = `${system ? `${system}\n\n` : ''}Respond with a single JSON object matching this schema and nothing else:\n${JSON.stringify(req.jsonSchema)}`;
      messages.push({ role: 'assistant', content: '{' });
    }

    const result = await this.call({
      model: this.model,
      max_tokens: req.maxTokens ?? 4096,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(system ? { system } : {}),
      messages,
    });
    if (!result.ok) return result;

    const raw = result.value.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
    const text = req.jsonSchema ? `{${raw}` : raw;

    let json: unknown;
    if (req.jsonSchema) {
      try {
        json = JSON.parse(text);
      } catch {
        return fail(err('AI_PROVIDER_ERROR', 'model did not return valid JSON', {
          userMessage: 'The assistant returned an unexpected response. Please try again.',
          retryable: true,
        }));
      }
    }

    const inputTokens = result.value.usage?.input_tokens ?? 0;
    const outputTokens = result.value.usage?.output_tokens ?? 0;

    return ok({
      text,
      ...(json !== undefined ? { json } : {}),
      usage: {
        provider: this.name,
        model: result.value.model ?? this.model,
        capability: 'text',
        inputTokens,
        outputTokens,
        credits: this.credits(inputTokens, outputTokens),
      },
    });
  }

  async analyzeImage(req: VisionRequest, _ctx: GenerationContext): Promise<Result<VisionResponse>> {
    const instructions: Record<VisionRequest['task'], string> = {
      alt_text:
        'Write concise, useful alt text for this image (max 125 characters). Describe what a sighted visitor would gain from it. Do not start with "image of". Return only the alt text.',
      tags:
        'List 5-10 short descriptive tags for this image as a JSON array of strings. Return only the array.',
      quality_audit:
        'Assess this image for web use. Return JSON: {"sharpness":0-1,"exposure":0-1,"noise":0-1,"notes":["..."]}.',
      subject_box:
        'Identify the primary subject. Return JSON: {"x":0-1,"y":0-1,"width":0-1,"height":0-1} as normalized coordinates.',
    };

    const result = await this.call({
      model: this.model,
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: req.imageUrl } },
          { type: 'text', text: `${instructions[req.task]}${req.context ? `\n\nPage context: ${req.context}` : ''}` },
        ],
      }],
    });
    if (!result.ok) return result;

    const text = result.value.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('').trim();
    const inputTokens = result.value.usage?.input_tokens ?? 0;
    const outputTokens = result.value.usage?.output_tokens ?? 0;
    const usage = {
      provider: this.name,
      model: this.model,
      capability: 'vision' as const,
      inputTokens,
      outputTokens,
      credits: this.credits(inputTokens, outputTokens),
    };

    switch (req.task) {
      case 'alt_text':
        return ok({ altText: text.replace(/^["']|["']$/g, ''), usage });
      case 'tags': {
        const tags = safeJson<string[]>(text);
        return tags ? ok({ tags, usage }) : ok({ tags: [], usage });
      }
      case 'quality_audit': {
        const quality = safeJson<VisionResponse['quality']>(text);
        return quality ? ok({ quality, usage }) : ok({ usage });
      }
      case 'subject_box': {
        const box = safeJson<VisionResponse['subjectBox']>(text);
        return box ? ok({ subjectBox: box, usage }) : ok({ usage });
      }
    }
  }
}

function safeJson<T>(text: string): T | undefined {
  const match = /[[{][\s\S]*[\]}]/.exec(text);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]) as T;
  } catch {
    return undefined;
  }
}
