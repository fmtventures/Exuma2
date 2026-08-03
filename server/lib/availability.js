'use strict';

const { eachNight, eachDay, inSeason } = require('./dates');

/**
 * Availability is counted, not assigned. The calendar tracks how many sites of
 * each type are spoken for on a given night; which numbered site a guest ends
 * up on is settled at the office, the way it always has been. That keeps the
 * booking rules simple and matches how the campground actually runs.
 *
 * An occupancy record is:
 *   { siteTypeId, arrival, departure, units, state, holdExpires }
 * where state is 'confirmed' | 'hold' | 'block'. Departure is exclusive.
 */

/** A hold only blocks inventory until it lapses, so an abandoned checkout frees up on its own. */
function isLive(record, nowMs) {
  if (record.state !== 'hold') return true;
  if (!record.holdExpires) return true;
  return Date.parse(record.holdExpires) > nowMs;
}

function inventoryOf(rates) {
  const out = {};
  for (const type of rates.siteTypes) out[type.id] = type.inventory || 0;
  return out;
}

/**
 * Free sites per type, per night, across an inclusive date range.
 * Returns { 'YYYY-MM-DD': { 'full-service': 3, ... } }.
 */
function computeAvailability(rates, occupancy, from, to, now = Date.now()) {
  const inventory = inventoryOf(rates);
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const grid = {};

  for (const date of eachDay(from, to)) {
    grid[date] = {};
    for (const id of Object.keys(inventory)) {
      grid[date][id] = inSeason(date, rates.season) ? inventory[id] : 0;
    }
  }

  for (const record of occupancy) {
    if (!isLive(record, nowMs)) continue;
    const units = record.units || 1;
    for (const night of eachNight(record.arrival, record.departure)) {
      const row = grid[night];
      if (!row || !(record.siteTypeId in row)) continue;
      row[record.siteTypeId] = Math.max(0, row[record.siteTypeId] - units);
    }
  }

  return grid;
}

/** True when every night of the stay still has a site of that type free. */
function isStayAvailable(grid, siteTypeId, arrival, departure) {
  const stay = eachNight(arrival, departure);
  if (stay.length === 0) return false;
  return stay.every((night) => grid[night] && grid[night][siteTypeId] > 0);
}

/** The nights that block a stay — used to explain a refusal instead of just denying it. */
function unavailableNights(grid, siteTypeId, arrival, departure) {
  return eachNight(arrival, departure).filter(
    (night) => !grid[night] || grid[night][siteTypeId] <= 0
  );
}

/**
 * Which numbered sites are spoken for, night by night.
 *
 * Records that name a site block that site. Records that only name a type — an
 * owner blocking "two tent sites", say — cannot be pinned to a square on the
 * map, so they are reported separately as a count. The map then greys out what
 * it truly knows and says how many more of that type are unavailable, rather
 * than guessing at squares.
 */
function computeSiteOccupancy(occupancy, from, to, now = Date.now()) {
  const nowMs = typeof now === 'number' ? now : Date.parse(now);
  const grid = {};

  for (const date of eachDay(from, to)) grid[date] = { taken: [], claims: {}, typeHolds: {} };

  for (const record of occupancy) {
    if (!isLive(record, nowMs)) continue;
    for (const night of eachNight(record.arrival, record.departure)) {
      const row = grid[night];
      if (!row) continue;
      if (record.siteNumber) {
        const number = String(record.siteNumber);
        // `claims` counts how many records want the square — two is the
        // signature of a race — while `taken` is the plain list the map draws.
        row.claims[number] = (row.claims[number] || 0) + 1;
        if (row.claims[number] === 1) row.taken.push(number);
      } else {
        const units = record.units || 1;
        row.typeHolds[record.siteTypeId] = (row.typeHolds[record.siteTypeId] || 0) + units;
      }
    }
  }

  return grid;
}

/** The sites of a type that are free every night of a stay, lowest number first. */
function freeSitesForStay(sites, siteGrid, siteTypeId, arrival, departure) {
  const nights = eachNight(arrival, departure);
  if (!nights.length) return [];

  const candidates = sites.filter((site) => !siteTypeId || site.typeId === siteTypeId);

  const free = candidates.filter((site) =>
    nights.every((night) => siteGrid[night] && !siteGrid[night].taken.includes(String(site.number)))
  );

  // Type-level blocks still consume capacity even though they name no square.
  const byType = {};
  for (const site of free) (byType[site.typeId] = byType[site.typeId] || []).push(site);

  const out = [];
  for (const [typeId, list] of Object.entries(byType)) {
    const held = nights.reduce(
      (most, night) => Math.max(most, (siteGrid[night] && siteGrid[night].typeHolds[typeId]) || 0),
      0
    );
    out.push(...list.slice(0, Math.max(0, list.length - held)));
  }

  return out.sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, { numeric: true }));
}

module.exports = {
  computeAvailability,
  computeSiteOccupancy,
  freeSitesForStay,
  isStayAvailable,
  unavailableNights,
  inventoryOf,
  isLive,
};
