// Mission loading and validation for the reentry viewer (schema 2, kind 'reentry').
// Adapted from the CZ-6A launch viewer (profile.js): same uniform-track contract, no ascent/insertion assumptions.
import * as A from './astro.js';

const finite = Number.isFinite;
const require = (ok, message) => { if (!ok) throw new Error(message); };
export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function clockSeconds(s) {
  if (typeof s !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(s)) return NaN;
  const [h, m, sec = 0] = s.split(':').map(Number);
  return h < 24 && m < 60 && sec < 60 ? h * 3600 + m * 60 + sec : NaN;
}
export async function fetchJSON(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.json();
}
export function validateManifest(index) {
  require(index.schema_version === 2, 'Unsupported mission manifest version');
  require(Array.isArray(index.profiles) && index.profiles.length, 'No spacecraft profiles');
  const ids = new Set();
  for (const p of index.profiles) {
    require(typeof p.id === 'string' && !ids.has(p.id) && typeof p.label === 'string', 'Invalid or duplicate profile');
    ids.add(p.id);
    require(Array.isArray(p.missions) && p.missions.length, `No missions in ${p.id}`);
    const missions = new Set();
    for (const m of p.missions) {
      require(typeof m.id === 'string' && !missions.has(m.id) && typeof m.label === 'string', 'Invalid or duplicate mission');
      require(/^data\/[a-zA-Z0-9_/-]+\.json$/.test(m.file), 'Mission file must be a local data JSON');
      missions.add(m.id);
    }
    require(missions.has(p.default_mission), `Missing default mission for ${p.id}`);
  }
  require(ids.has(index.default_profile), 'Missing default profile');
  return index;
}
export function selectProfile(index, query) {
  const profile = index.profiles.find((p) => p.id === query.get('profile')) || index.profiles.find((p) => p.id === index.default_profile);
  const entry = profile.missions.find((m) => m.id === query.get('mission')) || profile.missions.find((m) => m.id === profile.default_mission);
  return { profile, entry };
}
const EXTRA = ['vrel', 'vin', 'mach', 'g'];
export function validateMission(data) {
  require(data.schema_version === 2 && data.kind === 'reentry' && data.meta && data.tracks, 'Unsupported mission data');
  const m = data.meta;
  for (const k of ['title','vehicle','mission','date','site_name','t0_label']) require(typeof m[k] === 'string', `Missing meta.${k}`);
  require(/^\d{4}-\d{2}-\d{2}$/.test(m.date) && finite(Date.parse(m.date)), 'Invalid mission date');
  require(Array.isArray(m.site) && m.site.length === 2 && m.site.every(finite) && Math.abs(m.site[1]) <= 90 && finite(m.site_alt), 'Invalid landing site');
  const lo = clockSeconds(m.t0_min), hi = clockSeconds(m.t0_max), def = clockSeconds(m.t0_default);
  require(finite(lo) && finite(hi) && lo <= def && def <= hi, 'Invalid T0 range/default');
  require(finite(m.met_min) && m.met_min <= 0 && finite(m.met_default), 'Invalid MET range');
  require(Array.isArray(m.flight_segments) && m.flight_segments.length, 'No flight segments');
  for (const [key, seg] of Object.entries(data.tracks)) {
    require(finite(seg.met0) && finite(seg.dt) && seg.dt > 0, `Invalid times in ${key}`);
    require(Array.isArray(seg.lon) && seg.lon.length >= 2 && seg.lon.length <= 200000, `Invalid samples in ${key}`);
    for (const k of ['lon','lat','alt']) require(Array.isArray(seg[k]) && seg[k].length === seg.lon.length && seg[k].every(finite), `Invalid ${key}.${k}`);
    for (const k of EXTRA) if (seg[k] !== undefined) require(Array.isArray(seg[k]) && seg[k].length === seg.lon.length && seg[k].every(finite), `Invalid ${key}.${k}`);
    require(seg.lat.every((v) => Math.abs(v) <= 90), `Invalid latitude in ${key}`);
    require(typeof seg.label === 'string' && /^#[0-9a-f]{6}$/i.test(seg.color), `Invalid style in ${key}`);
  }
  let prev;
  for (const key of m.flight_segments) {
    const seg = data.tracks[key]; require(!!seg, `Missing flight segment ${key}`);
    if (prev) {
      require(Math.abs(prev.met0 + (prev.lon.length - 1) * prev.dt - seg.met0) < 1e-5, 'Flight segments must share their endpoint time');
      const i = prev.lon.length - 1;
      const p = A.geodeticToScene(prev.lon[i], prev.lat[i], prev.alt[i]), q = A.geodeticToScene(seg.lon[0], seg.lat[0], seg.alt[0]);
      require(Math.hypot(...p.map((v, j) => v - q[j])) < 0.01, 'Flight segments must share their endpoint position');
    } else require(Math.abs(seg.met0 - m.met_min) < 1e-6, 'First flight segment must start at meta.met_min');
    prev = seg;
  }
  const end = prev.met0 + (prev.lon.length - 1) * prev.dt;
  require(m.met_default >= m.met_min && m.met_default <= end, 'Default MET outside the flight');
  const o = m.orbit; require(o && ['inc','perigee_km','apogee_km','period_s'].every((k) => finite(o[k])), 'Invalid orbit summary');
  const intervals = (v) => Array.isArray(v) && v.every((p) => p.length === 2 && p.every(finite) && p[0] >= m.met_min && p[1] > p[0] && p[1] <= end);
  require(intervals(m.powered_intervals) && intervals(m.plasma_intervals), 'Invalid powered/plasma intervals');
  require(Array.isArray(m.phases) && m.phases.length && m.phases.every((p, i) => finite(p.until) && typeof p.label === 'string' && (!i || p.until > m.phases[i-1].until)), 'Invalid phase sequence');
  require(Array.isArray(m.views) && m.views.length && m.views.every((v) => v.length === 4 && typeof v[0] === 'string' && v.slice(1).every(finite) && Math.abs(v[2]) <= 90 && v[3] >= 1.05 && v[3] <= 14), 'Invalid camera views');
  require(Array.isArray(m.notes) && m.notes.every((s) => typeof s === 'string'), 'Missing model notes');
  require(Array.isArray(m.t0_presets) && m.t0_presets.every((p) => typeof p.label === 'string' && clockSeconds(p.time) >= lo && clockSeconds(p.time) <= hi), 'Invalid T0 presets');
  require(m.reported && typeof m.reported.landing_utc === 'string' && Array.isArray(m.reported.landing) && m.reported.landing.length === 2, 'Missing reported landing');
  require(m.diag && typeof m.diag === 'object', 'Missing model diagnostics');
  require(Array.isArray(data.events) && data.events.every((e) => finite(e.met) && e.met >= m.met_min - 1e-6 && e.met <= end + 1e-5 && typeof e.label === 'string' && (!e.track || !!data.tracks[e.track])), 'Invalid events');
  require(Array.isArray(data.zones), 'Invalid zones');
  for (const z of data.zones) {
    require(typeof z.id === 'string' && typeof z.role === 'string' && /^#[0-9a-f]{6}$/i.test(z.color), 'Invalid zone style');
    require(Array.isArray(z.ring) && z.ring.length >= 4 && z.ring.every((p) => p.length === 2 && p.every(finite) && Math.abs(p[1]) <= 90), 'Invalid zone polygon');
    require(Array.isArray(z.centroid) && z.centroid.length === 2 && z.centroid.every(finite), 'Invalid zone centroid');
  }
  const sun = data.sun;
  require(sun && finite(Date.parse(sun.start_utc)) && finite(sun.dt) && sun.dt > 0 && Array.isArray(sun.vectors) && sun.vectors.length >= 2 && sun.vectors.every((p) => p.length === 3 && p.every(finite)), 'Invalid solar ephemeris');
  require(Date.parse(sun.start_utc) <= A.dateT0ms(m.date, lo) + (m.met_min - 600) * 1000 && Date.parse(sun.start_utc) + (sun.vectors.length - 1) * sun.dt * 1000 >= A.dateT0ms(m.date, hi) + end * 1000, 'Solar ephemeris does not cover playback/T0 range');
  if (data.tle_ref?.sets?.length) {
    require(finite(Date.parse(data.tle_ref.t0)) && finite(data.tle_ref.raan_rate_deg_per_min), 'Invalid TLE reference');
    for (const t of data.tle_ref.sets) require(t.l1?.length === 69 && t.l2?.length === 69 && typeof t.name === 'string' && t.l1[68] === A.tleChecksum(t.l1) && t.l2[68] === A.tleChecksum(t.l2), 'Invalid TLE');
  }
  return data;
}

export class Track {
  constructor(seg) {
    Object.assign(this, {met0:seg.met0, dt:seg.dt, n:seg.lon.length, lon:seg.lon, lat:seg.lat, alt:Float64Array.from(seg.alt), color:seg.color, label:seg.label});
    for (const k of EXTRA) this[k] = seg[k] ? Float64Array.from(seg[k]) : null;
    this.u = new Float64Array(this.n * 3); this.P = new Float64Array(this.n * 3);
    for (let i = 0; i < this.n; i++) {
      this.u.set(A.llToVec(seg.lon[i], seg.lat[i]), 3*i);
      this.P.set(A.geodeticToScene(seg.lon[i], seg.lat[i], seg.alt[i]), 3*i);
    }
  }
  get end() { return this.met0 + (this.n - 1) * this.dt; }
  metAt(i) { return this.met0 + i*this.dt; }
  sample(met) {
    const f = clamp((met-this.met0)/this.dt, 0, this.n-1), i = Math.min(this.n-2, Math.floor(f)), w = f-i;
    const lerp = (v, norm) => { const p = [0,1,2].map((j) => v[3*i+j] + (v[3*(i+1)+j]-v[3*i+j])*w); return norm ? p.map((x) => x/Math.hypot(...p)) : p; };
    const s = (arr) => arr ? arr[i] + (arr[i+1]-arr[i])*w : null;
    return {u:lerp(this.u,true), p:lerp(this.P,false), alt:s(this.alt), vrel:s(this.vrel), vin:s(this.vin), mach:s(this.mach), g:s(this.g), color:this.color, label:this.label};
  }
  pt(i, exag, h = null) { return Array.from(this.u.subarray(3*i,3*i+3), (v) => v * (1 + (h ?? this.alt[i])*exag/A.RE)); }
  pts(exag, i0 = 0, i1 = this.n-1, ground = false) {
    const out = [];
    for (let i = Math.max(0,i0); i <= Math.min(this.n-1,i1); i++) out.push(...this.pt(i, exag, ground ? 0.0012*A.RE/exag : null));
    return out;
  }
  // indices of the samples inside [a, b] MET
  range(a, b) { return [Math.max(0, Math.ceil((a-this.met0)/this.dt)), Math.min(this.n-1, Math.floor((b-this.met0)/this.dt))]; }
}
export function createFlight(data) {
  const tracks = Object.fromEntries(Object.entries(data.tracks).map(([k,v]) => [k,new Track(v)]));
  const flight = data.meta.flight_segments.map((k) => tracks[k]);
  const segmentAt = (met) => flight.find((s) => met <= s.end) || flight.at(-1);
  const shipAt = (met) => segmentAt(met).sample(met);
  const inside = (list, met) => list.some(([a,b]) => met >= a && met <= b);
  const poweredAt = (met) => inside(data.meta.powered_intervals, met);
  const plasmaAt = (met) => inside(data.meta.plasma_intervals, met);
  return {tracks, flight, segmentAt, shipAt, poweredAt, plasmaAt, start:flight[0].met0, end:flight.at(-1).end};
}
export function solarEphemeris(table) {
  const start = Date.parse(table.start_utc);
  return (utc) => {
    const f = (utc-start)/(table.dt*1000);
    if (!finite(f) || f < -1e-6 || f > table.vectors.length-1+1e-6) throw new Error('Time outside solar ephemeris');
    const q = clamp(f,0,table.vectors.length-1), i = Math.min(table.vectors.length-2,Math.floor(q)), w = q-i;
    const p = table.vectors[i].map((v,j) => v+(table.vectors[i+1][j]-v)*w);
    return [p[0],p[2],-p[1]];
  };
}
export function sunlightClearance(position, sun) {
  const axes = [A.RE,A.WGS84_B,A.RE], r = position.map((v,i) => v/axes[i]), d = sun.map((v,i) => (v-position[i])/axes[i]);
  const t = clamp(-r.reduce((s,v,i) => s+v*d[i],0)/d.reduce((s,v) => s+v*v,0),0,1);
  return r.reduce((s,v,i) => s+(v+t*d[i])**2,0)-1;
}
// great-circle distance (km) between two lon/lat points on a 6371 km sphere
export function greatCircleKm(lon1, lat1, lon2, lat2) {
  const p1 = lat1*A.D2R, p2 = lat2*A.D2R, dl = (lon2-lon1)*A.D2R;
  const a = Math.sin((p2-p1)/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*6371*Math.asin(Math.min(1, Math.sqrt(a)));
}
