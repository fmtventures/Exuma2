'use strict';

/**
 * The campground's site map, as data.
 *
 * `config/sites.json` holds every numbered site — its service level, where it
 * sits on the map, and what is good about it. Moving a site on the website is
 * editing two numbers; renumbering the loop is editing one file. Nothing about
 * the layout is baked into the code or the drawing.
 *
 * When a site map is loaded it becomes the source of truth for inventory: how
 * many full-service sites exist is however many are drawn, not a number typed
 * separately into the rate card.
 */

const AMPS = [15, 30, 50];
const HOOKUPS = ['power', 'water', 'sewer'];

function fail(message) {
  const err = new Error(`Site map: ${message}`);
  err.code = 'bad_site_map';
  return err;
}

/** Checks the map is coherent before the server will serve it. */
function validate(map, rates) {
  if (!map || !Array.isArray(map.sites) || map.sites.length === 0) {
    throw fail('no sites are defined');
  }

  const typeIds = new Set(rates.siteTypes.map((t) => t.id));
  const seen = new Set();

  for (const site of map.sites) {
    if (!site.number) throw fail('a site is missing its number');
    if (seen.has(site.number)) throw fail(`site ${site.number} appears twice`);
    seen.add(site.number);

    if (!typeIds.has(site.typeId)) {
      throw fail(`site ${site.number} has an unknown type "${site.typeId}"`);
    }
    if (site.amps != null && !AMPS.includes(site.amps)) {
      throw fail(`site ${site.number} has an odd power rating (${site.amps} amp)`);
    }
    for (const hookup of site.hookups || []) {
      if (!HOOKUPS.includes(hookup)) throw fail(`site ${site.number} has an unknown hookup "${hookup}"`);
    }
    if (typeof site.x !== 'number' || typeof site.y !== 'number') {
      throw fail(`site ${site.number} has no position on the map`);
    }
  }

  return map;
}

function index(map) {
  const byNumber = new Map();
  for (const site of map.sites) byNumber.set(String(site.number), site);
  return byNumber;
}

/** How many sites of each type actually exist on the map. */
function inventory(map) {
  const counts = {};
  for (const site of map.sites) counts[site.typeId] = (counts[site.typeId] || 0) + 1;
  return counts;
}

/**
 * Rates and map must agree on how many sites there are. The map wins — it is
 * the thing that can be seen and counted — but a mismatch is worth saying out
 * loud, because it usually means a site was added on one side only.
 */
function reconcile(map, rates, log = console.warn) {
  const counted = inventory(map);
  const reconciled = rates.siteTypes.map((type) => {
    const actual = counted[type.id] || 0;
    if (type.inventory !== actual) {
      log(`▸ ${type.name}: rate card says ${type.inventory} sites, the map has ${actual} — using ${actual}.`);
    }
    return { ...type, inventory: actual };
  });
  return { ...rates, siteTypes: reconciled };
}

/** Everything the website needs to draw the map and describe each site. */
function publicMap(map, rates) {
  const priced = new Map(rates.siteTypes.map((t) => [t.id, t]));
  return {
    bounds: map.bounds || { width: 100, height: 100 },
    orientation: map.orientation || '',
    water: map.water || [],
    roads: map.roads || [],
    landmarks: map.landmarks || [],
    trees: map.trees || [],
    sites: map.sites.map((site) => ({
      number: String(site.number),
      typeId: site.typeId,
      typeName: (priced.get(site.typeId) || {}).name || site.typeId,
      amps: site.amps == null ? null : site.amps,
      hookups: site.hookups || [],
      pullThrough: Boolean(site.pullThrough),
      facing: site.facing || null,
      features: site.features || [],
      x: site.x,
      y: site.y,
      nightly: (priced.get(site.typeId) || {}).nightly ?? null,
    })),
  };
}

/** Human-readable service level, used on the map and in the site list. */
function serviceLabel(site) {
  const hookups = site.hookups || [];
  if (!hookups.length) return 'Unserviced';
  const power = site.amps ? `${site.amps} amp` : 'power';
  if (hookups.includes('sewer')) return `Full service · ${power}`;
  if (hookups.includes('water')) return `Power & water · ${power}`;
  return power;
}

module.exports = { validate, index, inventory, reconcile, publicMap, serviceLabel };
