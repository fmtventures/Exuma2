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

module.exports = { computeAvailability, isStayAvailable, unavailableNights, inventoryOf, isLive };
