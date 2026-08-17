import { describe, expect, it } from 'vitest';
import { asId, type DomainId, type OrgId, type SiteId, type UserId } from '../src/core/ids.ts';
import {
  auditRedirects, canServe, certificatesDue, checkDomain, flattenRedirects,
  isApex, matchRedirect, normalizeHostname, normalizeRedirectPath, publish,
  requiredDnsRecords, robotsTxt, rollback, shouldForceHttps,
  type Domain, type DnsLookup, type PublishCheck, type PublishedVersion, type Redirect,
} from '../src/publishing/domains.ts';
import {
  byDay, canConsume, checkLimits, classifyReferrer, prorate, rollUp,
  summarise, topPages, topSources, visitorHash,
  type MetricEvent, type Plan, type SiteHealth, type Subscription, type Usage,
} from '../src/analytics/metrics.ts';

const SITE = asId<SiteId>('site_p');
const ORG = asId<OrgId>('org_p');
const USER = asId<UserId>('usr_p');
const NOW = new Date('2026-06-01T12:00:00Z');
let seq = 0;
const makeId = (p: string) => `${p}_${String(++seq).padStart(4, '0')}`;

/* ------------------------------------------------------------------ */

describe('hostname normalisation', () => {
  it('extracts the host from what people actually paste', () => {
    // A support ticket is the alternative to accepting this input.
    for (const [input, expected] of [
      ['https://www.example.com/contact?utm=1', 'www.example.com'],
      ['EXAMPLE.COM', 'example.com'],
      ['example.com.', 'example.com'],
      ['http://user:pw@example.com:8080/x', 'example.com'],
      ['  shop.example.co.uk  ', 'shop.example.co.uk'],
    ] as const) {
      const r = normalizeHostname(input);
      expect(r.ok, input).toBe(true);
      expect((r as { value: string }).value).toBe(expected);
    }
  });

  it('rejects things that are not domains', () => {
    for (const bad of ['', 'localhost', '203.0.113.5', 'no spaces.com', '-bad.example.com', 'a'.repeat(300)]) {
      expect(normalizeHostname(bad).ok, bad).toBe(false);
    }
  });

  it('knows apex from subdomain so the DNS advice is right', () => {
    // An apex cannot hold a CNAME; telling everyone to add one produces a
    // zone the registrar refuses or that breaks MX.
    expect(isApex('example.com')).toBe(true);
    expect(isApex('example.co.uk')).toBe(true);
    expect(isApex('www.example.com')).toBe(false);
  });

  it('gives A records for an apex and a CNAME for a subdomain', () => {
    const target = { ipv4: ['203.0.113.10'], cname: 'sites.sidelio.net' };
    const apex = requiredDnsRecords({ hostname: 'example.com', verificationToken: 'tok' }, target);
    expect(apex.some((r) => r.type === 'A')).toBe(true);
    expect(apex.some((r) => r.type === 'CNAME')).toBe(false);

    const sub = requiredDnsRecords({ hostname: 'www.example.com', verificationToken: 'tok' }, target);
    expect(sub.some((r) => r.type === 'CNAME')).toBe(true);
    expect(sub.some((r) => r.type === 'TXT')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

const domain = (over: Partial<Domain> = {}): Domain => ({
  id: asId<DomainId>('dom_1'), siteId: SITE, hostname: 'example.com', isPrimary: true,
  status: 'pending_dns', verificationToken: 'tok_abc', forceHttps: true,
  createdAt: NOW.toISOString(), ...over,
});

const target = { ipv4: ['203.0.113.10'], cname: 'sites.sidelio.net' };

const stubDns = (records: Partial<Record<string, string[]>>): DnsLookup => ({
  async resolve(hostname, type) {
    const key = `${type} ${hostname}`;
    const value = records[key];
    if (!value) throw new Error('NXDOMAIN');
    return value;
  },
});

describe('domain verification', () => {
  it('refuses to serve a domain pointed here but never verified', async () => {
    // Otherwise whoever claims a name first receives someone else's traffic.
    const dns = stubDns({ 'A example.com': ['203.0.113.10'] });
    const checked = await checkDomain(domain(), target, dns, NOW);
    expect(checked.status).toBe('error');
    expect(canServe(checked)).toBe(false);
  });

  it('requires the domain to actually point here as well as verify', async () => {
    const dns = stubDns({ 'TXT _sidelio-challenge.example.com': ['tok_abc'] });
    const checked = await checkDomain(domain(), target, dns, NOW);
    expect(checked.status).toBe('error');
    expect(checked.lastError).toMatch(/does not resolve/);
  });

  it('activates once both checks pass and a certificate exists', async () => {
    const dns = stubDns({
      'TXT _sidelio-challenge.example.com': ['"tok_abc"'],
      'A example.com': ['203.0.113.10'],
    });
    const withCert = domain({
      certificate: { issuedAt: NOW.toISOString(), expiresAt: '2026-09-01T00:00:00Z', issuer: 'test' },
    });
    const checked = await checkDomain(withCert, target, dns, NOW);
    expect(checked.status).toBe('active');
    expect(canServe(checked)).toBe(true);
  });

  it('never forces https before a certificate exists', () => {
    // Redirecting to https without a certificate takes the site offline, and
    // the merchant's customers find out first.
    expect(shouldForceHttps(domain({ forceHttps: true }), NOW)).toBe(false);
    expect(shouldForceHttps(domain({
      forceHttps: true,
      certificate: { issuedAt: '2026-01-01T00:00:00Z', expiresAt: '2026-09-01T00:00:00Z', issuer: 'x' },
    }), NOW)).toBe(true);
  });

  it('stops forcing https once the certificate has expired', () => {
    expect(shouldForceHttps(domain({
      forceHttps: true,
      certificate: { issuedAt: '2025-01-01T00:00:00Z', expiresAt: '2026-01-01T00:00:00Z', issuer: 'x' },
    }), NOW)).toBe(false);
  });

  it('lists certificates due for renewal soonest first', () => {
    const due = certificatesDue([
      domain({ hostname: 'a.com', certificate: { issuedAt: 'x', expiresAt: '2026-06-20T00:00:00Z', issuer: 'i' } }),
      domain({ hostname: 'b.com', certificate: { issuedAt: 'x', expiresAt: '2026-06-05T00:00:00Z', issuer: 'i' } }),
      domain({ hostname: 'c.com', certificate: { issuedAt: 'x', expiresAt: '2027-01-01T00:00:00Z', issuer: 'i' } }),
    ], NOW);
    expect(due.map((d) => d.hostname)).toEqual(['b.com', 'a.com']);
  });
});

/* ------------------------------------------------------------------ */

describe('redirects', () => {
  const r = (id: string, from: string, to: string): Redirect => ({ id, from, to, status: 301 });

  it('normalises paths before comparing them', () => {
    expect(normalizeRedirectPath('https://x.com/about/?a=1#b')).toBe('/about');
    expect(normalizeRedirectPath('about')).toBe('/about');
    expect(normalizeRedirectPath('//a//b//')).toBe('/a/b');
    expect(normalizeRedirectPath('/')).toBe('/');
  });

  it('finds a loop, which would otherwise be an outage', () => {
    const problems = auditRedirects([r('1', '/a', '/b'), r('2', '/b', '/a')]);
    expect(problems.some((p) => p.kind === 'loop')).toBe(true);
  });

  it('finds a chain, which costs a round trip and dilutes link equity', () => {
    const problems = auditRedirects([r('1', '/a', '/b'), r('2', '/b', '/c')]);
    const chain = problems.find((p) => p.kind === 'chain');
    expect(chain?.message).toMatch(/\/c/);
  });

  it('finds a rule that can never fire', () => {
    const problems = auditRedirects([r('1', '/a', '/b'), r('2', '/a/', '/c')]);
    expect(problems.some((p) => p.kind === 'duplicate')).toBe(true);
  });

  it('finds a self-redirect', () => {
    expect(auditRedirects([r('1', '/a', '/a/')]).some((p) => p.kind === 'self')).toBe(true);
  });

  it('flattens chains to their final destination', () => {
    const flat = flattenRedirects([r('1', '/a', '/b'), r('2', '/b', '/c')]);
    expect(flat.find((x) => x.id === '1')?.to).toBe('/c');
  });

  it('leaves a loop alone for a human rather than flattening into nonsense', () => {
    const flat = flattenRedirects([r('1', '/a', '/b'), r('2', '/b', '/a')]);
    expect(flat.find((x) => x.id === '1')?.to).toBe('/b');
  });

  it('matches ignoring trailing slashes and query strings', () => {
    expect(matchRedirect([r('1', '/old', '/new')], '/old/?utm=1')?.to).toBe('/new');
  });
});

/* ------------------------------------------------------------------ */

describe('publishing', () => {
  const base = {
    siteId: SITE, pageCount: 5, digest: 'sha-1', publishedBy: USER,
    now: NOW, makeId,
  };
  const blocking: PublishCheck = { id: 'c1', severity: 'blocking', message: 'A page has no title' };
  const warning: PublishCheck = { id: 'c2', severity: 'warning', message: 'Two images have no alt text' };

  it('publishes when nothing is wrong', () => {
    const r = publish({ ...base, checks: [] });
    expect((r as { value: PublishedVersion }).value.number).toBe(1);
  });

  it('cannot be forced past a blocking check', () => {
    const r = publish({ ...base, checks: [blocking], acknowledgeWarnings: true });
    expect(r.ok).toBe(false);
    expect((r as { error: { blocking: PublishCheck[] } }).error.blocking).toHaveLength(1);
  });

  it('requires warnings to be acknowledged deliberately', () => {
    // One button that dismisses everything trains people to dismiss the one
    // that mattered.
    expect(publish({ ...base, checks: [warning] }).ok).toBe(false);
    expect(publish({ ...base, checks: [warning], acknowledgeWarnings: true }).ok).toBe(true);
  });

  it('does not burn a version number republishing identical content', () => {
    const first = (publish({ ...base, checks: [] }) as { value: PublishedVersion }).value;
    const again = publish({ ...base, checks: [], previous: first });
    expect((again as { value: PublishedVersion }).value.number).toBe(1);
  });

  it('increments from the previous version', () => {
    const first = (publish({ ...base, checks: [] }) as { value: PublishedVersion }).value;
    const second = publish({ ...base, digest: 'sha-2', checks: [], previous: first });
    expect((second as { value: PublishedVersion }).value.number).toBe(2);
  });

  it('rolls back by moving forward, never by deleting history', () => {
    // A rollback that erases the bad version hides the incident from whoever
    // investigates it later.
    const v1 = (publish({ ...base, checks: [] }) as { value: PublishedVersion }).value;
    const v2 = (publish({ ...base, digest: 'sha-2', checks: [], previous: v1 }) as { value: PublishedVersion }).value;
    const back = rollback(v1, v2, USER, NOW, makeId);
    const version = (back as { value: PublishedVersion }).value;
    expect(version.number).toBe(3);
    expect(version.digest).toBe('sha-1');
    expect(version.rolledBackFrom).toBe(2);
  });

  it('refuses to roll back to a version from another site', () => {
    const v1 = (publish({ ...base, checks: [] }) as { value: PublishedVersion }).value;
    const other = { ...v1, siteId: asId<SiteId>('site_other'), number: 9 };
    expect(rollback(v1, other, USER, NOW, makeId).ok).toBe(false);
  });

  it('keeps an unpublished site out of the index by default', () => {
    // A staging site that outranks the real one is very hard to undo.
    expect(robotsTxt({ origin: 'https://x.com', indexable: false })).toContain('Disallow: /');
    const live = robotsTxt({ origin: 'https://x.com', indexable: true });
    expect(live).toContain('Sitemap: https://x.com/sitemap.xml');
    expect(live).toContain('Disallow: /checkout');
  });
});

/* ------------------------------------------------------------------ */

const event = (over: Partial<MetricEvent> = {}): MetricEvent => ({
  siteId: SITE, kind: 'page_view', at: '2026-06-01T13:00:00Z', path: '/', ...over,
});

describe('analytics', () => {
  it('counts unique visitors by hash, not by hit', () => {
    const totals = summarise([
      event({ visitorHash: 'a' }), event({ visitorHash: 'a' }), event({ visitorHash: 'b' }),
    ]);
    expect(totals.views).toBe(3);
    expect(totals.visitors).toBe(2);
  });

  it('sums revenue from order events only', () => {
    const totals = summarise([
      event({ kind: 'order_placed', valueMinor: 5000 }),
      event({ kind: 'checkout_started', valueMinor: 9999 }),
    ]);
    expect(totals.orders).toBe(1);
    expect(totals.revenueMinor).toBe(5000);
  });

  it('buckets by the site local day, not UTC', () => {
    // UTC bucketing moves every evening booking in the Americas into the
    // following day, so Monday's numbers are wrong.
    const days = byDay([event({ at: '2026-06-02T02:00:00Z' })], 'America/Halifax');
    expect([...days.keys()]).toEqual(['2026-06-01']);
  });

  it('ranks pages and computes a bounce rate', () => {
    const pages = topPages([
      event({ path: '/', visitorHash: 'a' }),
      event({ path: '/', visitorHash: 'b' }),
      event({ path: '/about', visitorHash: 'b' }),
    ]);
    expect(pages[0]!.path).toBe('/');
    expect(pages[0]!.bounceRate).toBe(0.5); // a bounced, b did not
  });

  it('drops self-referrals, which are a measurement artifact', () => {
    // A site's own hostname as its top source crowds out real ones.
    const sources = topSources([
      event({ referrer: 'https://example.com/about' }),
      event({ referrer: 'https://www.google.com/' }),
      event({ referrer: '' }),
    ], 'example.com');
    expect(sources.map((s) => s.source)).not.toContain('example.com');
    expect(sources.some((s) => s.source.startsWith('Search'))).toBe(true);
    expect(sources.some((s) => s.source === 'Direct')).toBe(true);
  });

  it('classifies an unparseable referrer as direct rather than throwing', () => {
    expect(classifyReferrer('not a url', 'example.com')).toBe('Direct');
  });

  it('rotates the visitor hash daily and per site', () => {
    // Without rotation this is a durable identifier — a cookie by another
    // name, with none of the disclosure.
    const sha = (s: string) => Buffer.from(s).toString('hex').padEnd(32, '0');
    const a = visitorHash('1.2.3.4', 'UA', 'saltA', '2026-06-01', sha);
    const b = visitorHash('1.2.3.4', 'UA', 'saltA', '2026-06-02', sha);
    const c = visitorHash('1.2.3.4', 'UA', 'saltB', '2026-06-01', sha);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).toBe(visitorHash('1.2.3.4', 'UA', 'saltA', '2026-06-01', sha));
  });
});

/* ------------------------------------------------------------------ */

const plan: Plan = {
  id: 'pro', name: 'Pro', priceMinor: 4900, currency: 'CAD', interval: 'month',
  features: [],
  limits: {
    sites: 1, pagesPerSite: 50, monthlyPageViews: 100000, storageMb: 5000,
    products: 500, staffSeats: 5, aiCreditsPerMonth: 1000, customDomains: 3,
  },
};

const usage = (over: Partial<Usage> = {}): Usage => ({
  sites: 1, pages: 10, monthlyPageViews: 1000, storageMb: 100,
  products: 5, staffSeats: 2, aiCreditsUsed: 10, customDomains: 1, ...over,
});

describe('plan limits', () => {
  it('warns before it blocks', () => {
    // A merchant who discovers a limit by being cut off mid-launch does not
    // renew.
    const verdicts = checkLimits(plan, usage({ pages: 42 }));
    expect(verdicts.find((v) => v.key === 'pagesPerSite')?.state).toBe('approaching');
  });

  it('reports exceeded separately from approaching', () => {
    const verdicts = checkLimits(plan, usage({ pages: 60 }));
    expect(verdicts.find((v) => v.key === 'pagesPerSite')?.state).toBe('exceeded');
  });

  it('treats Infinity as unlimited rather than a magic number', () => {
    const unlimited: Plan = { ...plan, limits: { ...plan.limits, pagesPerSite: Infinity } };
    expect(checkLimits(unlimited, usage({ pages: 99999 })).find((v) => v.key === 'pagesPerSite')?.state).toBe('ok');
    expect(canConsume(unlimited, usage({ pages: 99999 }), 'pagesPerSite').ok).toBe(true);
  });

  it('blocks adding past a limit', () => {
    expect(canConsume(plan, usage({ pages: 50 }), 'pagesPerSite').ok).toBe(false);
    expect(canConsume(plan, usage({ pages: 49 }), 'pagesPerSite').ok).toBe(true);
  });

  it('blocks adding but says nothing about serving what exists', () => {
    // Hiding a paying customer's live pages because their traffic grew is a
    // way to lose them; the overage is reported, not enforced on delivery.
    const over = checkLimits(plan, usage({ monthlyPageViews: 250000 }));
    expect(over.find((v) => v.key === 'monthlyPageViews')?.state).toBe('exceeded');
    expect(canConsume(plan, usage({ pages: 1 }), 'pagesPerSite').ok).toBe(true);
  });
});

describe('proration', () => {
  const subscription: Subscription = {
    id: 'sub_1', orgId: ORG, planId: 'pro', status: 'active',
    currentPeriodStart: '2026-06-01T00:00:00Z',
    currentPeriodEnd: '2026-07-01T00:00:00Z',
  };
  const bigger: Plan = { ...plan, id: 'agency', name: 'Agency', priceMinor: 14900 };

  it('rounds in the customer favour', () => {
    // A cent in the merchant's favour on every upgrade is not worth the
    // support conversation it causes.
    const r = prorate(plan, bigger, subscription, new Date('2026-06-16T00:00:00Z'));
    const { creditMinor, chargeMinor } = (r as { value: { creditMinor: number; chargeMinor: number } }).value;
    expect(creditMinor).toBeGreaterThanOrEqual(Math.floor(4900 * 0.5));
    expect(chargeMinor).toBeLessThanOrEqual(Math.ceil(14900 * 0.5));
  });

  it('charges nothing extra at the very end of a period', () => {
    const r = prorate(plan, bigger, subscription, new Date('2026-07-01T00:00:00Z'));
    expect((r as { value: { netMinor: number } }).value.netMinor).toBe(0);
  });

  it('refuses to prorate across currencies', () => {
    expect(prorate(plan, { ...bigger, currency: 'USD' }, subscription, NOW).ok).toBe(false);
  });

  it('refuses an invalid billing period', () => {
    const broken = { ...subscription, currentPeriodEnd: subscription.currentPeriodStart };
    expect(prorate(plan, bigger, broken, NOW).ok).toBe(false);
  });
});

describe('agency roll-up', () => {
  const site = (name: string, issues: SiteHealth['issues']): SiteHealth => ({
    siteId: SITE, name, issues,
    totals: { views: 10, visitors: 5, forms: 1, bookings: 0, orders: 1, revenueMinor: 5000 },
  });

  it('sorts by how much attention each site needs, not alphabetically', () => {
    // An agency with sixty sites opens this to find the two that are broken.
    const rolled = rollUp([
      site('Alpha', []),
      site('Zulu', [{ severity: 'critical', message: 'certificate expired' }]),
      site('Mike', [{ severity: 'warning', message: 'no alt text' }]),
    ]);
    expect(rolled.sites.map((s) => s.name)).toEqual(['Zulu', 'Mike', 'Alpha']);
    expect(rolled.criticalCount).toBe(1);
    expect(rolled.warningCount).toBe(1);
  });

  it('sums totals across every site', () => {
    const rolled = rollUp([site('A', []), site('B', [])]);
    expect(rolled.totals.revenueMinor).toBe(10000);
    expect(rolled.totals.views).toBe(20);
  });
});
