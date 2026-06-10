// Turns distance + locks into an estimated journey time, and self-calibrates
// from logged trips (expected vs actual).
//
//   raw hours = miles / speed  +  locks * lockMinutes / 60
//   estimate  = raw hours * correction      (correction learned from trips)
//
// The correction is a single multiplier fitted as Σactual / Σraw across logged
// trips — robust with only a handful of journeys. With more data this can be
// split into separate cruising/lock factors.

const SETTINGS_KEY = 'cp.settings';
const TRIPS_KEY = 'cp.trips';

export const DEFAULTS = { speedMph: 3, lockMinutes: 12, hoursPerDay: 7 };

export function getSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export function getTrips() {
  try { return JSON.parse(localStorage.getItem(TRIPS_KEY) || '[]'); }
  catch { return []; }
}

// Log a completed trip. `actualHours` measured (manual stop-clock or GPS track).
export function logTrip({ miles, locks, predictedHours, actualHours }) {
  const trips = getTrips();
  trips.push({ miles, locks, predictedHours, actualHours, at: Date.now() });
  localStorage.setItem(TRIPS_KEY, JSON.stringify(trips));
  return trips;
}

function rawHours(miles, locks, s, bendFactor = 1) {
  return (miles * bendFactor) / s.speedMph + (locks * s.lockMinutes) / 60;
}

// Learned multiplier from logged trips (1 = no correction).
export function correctionFactor(s = getSettings()) {
  const trips = getTrips();
  if (trips.length < 2) return { factor: 1, samples: trips.length };
  let sumRaw = 0, sumActual = 0;
  for (const t of trips) {
    sumRaw += rawHours(t.miles, t.locks, s);
    sumActual += t.actualHours;
  }
  if (sumRaw <= 0) return { factor: 1, samples: trips.length };
  return { factor: sumActual / sumRaw, samples: trips.length };
}

// opts.bendFactor (>=1, from graph.bendFactor) slows the cruising portion on
// twisty canals. The learned correction is fit on un-bent raw hours, so this is
// a physical adjustment on top of it.
export function estimate(miles, locks, s = getSettings(), opts = {}) {
  const bend = opts.bendFactor || 1;
  const { factor, samples } = correctionFactor(s);
  const raw = rawHours(miles, locks, s, bend);
  const hours = raw * factor;
  const days = Math.max(1, Math.ceil(hours / s.hoursPerDay));
  return { hours, days, factor, samples, bend, cruiseHours: (miles * bend) / s.speedMph, lockHours: (locks * s.lockMinutes) / 60 };
}

export function formatDuration(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (h === 0) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}
