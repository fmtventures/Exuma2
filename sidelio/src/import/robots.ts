/**
 * robots.txt parsing.
 *
 * Sidelio's crawler identifies itself honestly and obeys the source site's
 * robots.txt, including crawl-delay. Even when a user attests to owning a
 * site, we still respect its published rules by default; an owner can override
 * for their own host, and the override is recorded on the import job.
 */

export const CRAWLER_USER_AGENT = 'SidelioImportBot';
export const CRAWLER_UA_STRING =
  `Mozilla/5.0 (compatible; ${CRAWLER_USER_AGENT}/1.0; +https://sidelio.com/bot)`;

export interface RobotsRule {
  type: 'allow' | 'disallow';
  path: string;
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  crawlDelaySeconds?: number;
  sitemaps: string[];
}

/** An empty/missing robots.txt means "crawl freely". */
export const PERMISSIVE_POLICY: RobotsPolicy = { rules: [], sitemaps: [] };

/**
 * Parse robots.txt, selecting the most specific group that applies to us:
 * an exact `SidelioImportBot` group wins over the `*` group.
 */
export function parseRobots(text: string, userAgent = CRAWLER_USER_AGENT): RobotsPolicy {
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, RobotsRule[]>();
  const delays = new Map<string, number>();
  const sitemaps: string[] = [];

  let currentAgents: string[] = [];
  let lastDirectiveWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    switch (field) {
      case 'user-agent': {
        const agent = value.toLowerCase();
        if (!lastDirectiveWasAgent) currentAgents = [];
        currentAgents.push(agent);
        if (!groups.has(agent)) groups.set(agent, []);
        lastDirectiveWasAgent = true;
        break;
      }
      case 'allow':
      case 'disallow': {
        lastDirectiveWasAgent = false;
        for (const agent of currentAgents) {
          groups.get(agent)?.push({ type: field, path: value });
        }
        break;
      }
      case 'crawl-delay': {
        lastDirectiveWasAgent = false;
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          for (const agent of currentAgents) delays.set(agent, seconds);
        }
        break;
      }
      case 'sitemap': {
        lastDirectiveWasAgent = false;
        if (value) sitemaps.push(value);
        break;
      }
      default:
        lastDirectiveWasAgent = false;
    }
  }

  const key = groups.has(userAgent.toLowerCase()) ? userAgent.toLowerCase() : '*';
  const policy: RobotsPolicy = {
    rules: groups.get(key) ?? [],
    sitemaps,
  };
  const delay = delays.get(key);
  if (delay !== undefined) policy.crawlDelaySeconds = delay;
  return policy;
}

/** Translate a robots path pattern (supporting `*` and `$`) to a matcher. */
function matches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchoredEnd = pattern.endsWith('$');
  const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}${anchoredEnd ? '$' : ''}`);
  return re.test(path);
}

/**
 * Standard precedence: the longest matching rule wins; Allow beats Disallow on
 * an exact-length tie.
 */
export function isAllowed(policy: RobotsPolicy, urlOrPath: string): boolean {
  let path: string;
  try {
    path = urlOrPath.startsWith('http') ? new URL(urlOrPath).pathname + new URL(urlOrPath).search : urlOrPath;
  } catch {
    path = urlOrPath;
  }

  let best: { rule: RobotsRule; length: number } | null = null;
  for (const rule of policy.rules) {
    if (!matches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.type === 'allow')) {
      best = { rule, length };
    }
  }
  if (!best) return true;
  return best.rule.type === 'allow';
}
