/** A deliberately messy small-business site: the shape Smart Import must handle. */

export const HOME_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Acme Roofing | Charlottetown PEI Roofing Contractors</title>
  <meta name="description" content="Acme Roofing has been replacing and repairing roofs across Prince Edward Island since 1998.">
  <link rel="canonical" href="https://acmeroofing.ca/">
  <meta property="og:site_name" content="Acme Roofing">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "RoofingContractor",
    "name": "Acme Roofing Ltd.",
    "description": "Residential and commercial roofing on PEI since 1998.",
    "telephone": "+1-902-555-1234",
    "email": "info@acmeroofing.ca",
    "url": "https://acmeroofing.ca",
    "address": {
      "@type": "PostalAddress",
      "streetAddress": "42 Water Street",
      "addressLocality": "Charlottetown",
      "addressRegion": "PE",
      "postalCode": "C1A 1A9",
      "addressCountry": "CA"
    },
    "sameAs": ["https://www.facebook.com/acmeroofingpei", "https://www.instagram.com/acmeroofing"]
  }
  </script>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC1234567"></script>
  <script>fbq('init', '123456789012345');</script>
</head>
<body>
  <header>
    <nav>
      <ul>
        <li><a href="/">Home</a></li>
        <li><a href="/services">Services</a>
          <ul>
            <li><a href="/services/roof-replacement">Roof Replacement</a></li>
            <li><a href="/services/roof-repair">Roof Repair</a></li>
          </ul>
        </li>
        <li><a href="/about">About</a></li>
        <li><a href="/contact">Contact</a></li>
      </ul>
    </nav>
  </header>

  <main>
    <h1>Roofing you can rely on, across Prince Edward Island</h1>
    <img src="/img/hero.jpg" width="1920" height="900">
    <p>Acme Roofing has protected Island homes and businesses since 1998. We handle
       everything from a single missing shingle to a full commercial re-roof, and we
       stand behind every job with a written workmanship warranty.</p>
    <p>Our crews are fully insured, WCB-covered, and trained on every major shingle
       and metal system sold on the Island. We show up when we say we will.</p>

    <h2>What we do</h2>
    <ul>
      <li><a href="/services/roof-replacement">Roof Replacement</a></li>
      <li><a href="/services/roof-repair">Roof Repair</a></li>
      <li><a href="/services/emergency">24/7 Emergency Service</a></li>
    </ul>

    <a href="tel:9025551234" class="btn">Call now</a>
    <a href="/contact" class="btn">Get a free quote</a>

    <h2>What our customers say</h2>
    <blockquote>Acme replaced our roof in two days and left the yard cleaner than they
      found it. Honest pricing, no surprises on the invoice.<cite>Dana MacLeod</cite></blockquote>
    <blockquote>They came out during a January storm to tarp our roof at 11pm. I would
      not call anyone else on this Island.<cite>Robert Gallant</cite></blockquote>

    <h2>Questions we get asked</h2>
    <h3>How long does a roof replacement take?</h3>
    <p>Most residential roofs are finished in one to three days, weather permitting.</p>
    <h3>Do you offer financing?</h3>
    <p>Yes — we offer monthly payment plans on replacements over $5,000.</p>
  </main>

  <footer>
    <address>
      Acme Roofing Ltd.
      42 Water Street, Charlottetown, PE C1A 1A9
      Phone: (902) 555-1234
      Email: info@acmeroofing.ca
    </address>
    <p>Hours:
Monday - Friday: 7:00am - 5:00pm
Saturday: 8:00am - 12:00pm
Sunday: Closed</p>
    <a href="https://www.facebook.com/acmeroofingpei">Facebook</a>
    <a href="https://www.instagram.com/acmeroofing">Instagram</a>
    <a href="/warranty.pdf">Download our warranty (PDF)</a>
  </footer>
</body>
</html>`;

export const CONTACT_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Contact Acme Roofing</title></head>
<body>
  <main>
    <h1>Contact us</h1>
    <p>Call <a href="tel:9025551234">(902) 555-1234</a> or send us a note.</p>
    <address>42 Water Street, Charlottetown, PE C1A 1A9</address>
    <form action="/submit" method="post">
      <label for="name">Your name</label>
      <input type="text" id="name" name="name" required>
      <label for="email">Email</label>
      <input type="email" id="email" name="email" required>
      <input type="tel" name="phone" placeholder="Phone">
      <select name="service"><option>Replacement</option><option>Repair</option></select>
      <textarea name="message" aria-label="How can we help?"></textarea>
      <button type="submit">Send request</button>
    </form>
  </main>
</body>
</html>`;

/** A page with real problems: no title, no alt text, thin content. */
export const BROKEN_HTML = `<!DOCTYPE html>
<html>
<head></head>
<body>
  <main>
    <img src="/img/small.jpg" width="320" height="240">
    <p>Coming soon.</p>
  </main>
</body>
</html>`;

export const TEAM_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Our Team | Acme Roofing</title></head>
<body>
  <main>
    <h1>Our team</h1>
    <h2>Melissa Doyle</h2>
    <p>Melissa has estimated over 1,200 Island roofs and runs our quoting desk.</p>
    <h2>Robert Arsenault</h2>
    <p>Robert leads our commercial crew and has 22 years on flat roofing systems.</p>
    <h2>Our Services</h2>
    <p>Not a person — the extractor must not treat this heading as a name.</p>
  </main>
</body>
</html>`;

export const SITEMAP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://acmeroofing.ca/</loc></url>
  <url><loc>https://acmeroofing.ca/contact</loc></url>
  <url><loc>https://acmeroofing.ca/team</loc></url>
  <url><loc>https://acmeroofing.ca/private</loc></url>
</urlset>`;

export const ROBOTS_TXT = `User-agent: *
Disallow: /private
Allow: /
Crawl-delay: 0

Sitemap: https://acmeroofing.ca/sitemap.xml
`;

import { PNG_1600x900, PNG_320x240 } from './images.ts';

export const FIXTURE_PAGES: Record<string, {
  body?: string;
  binary?: Uint8Array;
  contentType?: string;
}> = {
  'https://acmeroofing.ca/robots.txt': { body: ROBOTS_TXT, contentType: 'text/plain' },
  'https://acmeroofing.ca/sitemap.xml': { body: SITEMAP_XML, contentType: 'application/xml' },
  'https://acmeroofing.ca/': { body: HOME_HTML },
  'https://acmeroofing.ca/contact': { body: CONTACT_HTML },
  'https://acmeroofing.ca/team': { body: TEAM_HTML },
  'https://acmeroofing.ca/private': { body: BROKEN_HTML },
  'https://acmeroofing.ca/services': { body: BROKEN_HTML },
  'https://acmeroofing.ca/about': { body: BROKEN_HTML },
  'https://acmeroofing.ca/services/roof-replacement': { body: BROKEN_HTML },
  'https://acmeroofing.ca/services/roof-repair': { body: BROKEN_HTML },
  'https://acmeroofing.ca/services/emergency': { body: BROKEN_HTML },
  'https://acmeroofing.ca/warranty.pdf': { body: '%PDF-1.4', contentType: 'application/pdf' },

  // Real image bytes, so media ingestion has something genuine to download,
  // probe and store rather than a stubbed response.
  'https://acmeroofing.ca/img/hero.jpg': { binary: PNG_1600x900, contentType: 'image/png' },
  'https://acmeroofing.ca/img/small.jpg': { binary: PNG_320x240, contentType: 'image/png' },
};
