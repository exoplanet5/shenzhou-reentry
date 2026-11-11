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
  require(index.schema_version === 1, 'Unsupported profile manifest version');
  require(Array.isArray(index.profiles) && index.profiles.length, 'No launch profiles');
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
export function validateMission(data) {
  require(data.schema_version === 1 && data.meta && data.tracks, 'Unsupported mission data');
  const m = data.meta;
  for (const k of ['title','vehicle','mission','date']) require(typeof m[k] === 'string', `Missing meta.${k}`);
  require(/^\d{4}-\d{2}-\d{2}$/.test(m.date) && finite(Date.parse(m.date)), 'Invalid mission date');
  // A flight that begins in orbit and ends on the ground has a landing site instead of a pad, and starts before T0 (meta.met_min).
  if (m.landing !== undefined) require(!!m.landing && typeof m.landing.name === 'string' && m.landing.name.length <= 40 && finite(m.landing.lon) && finite(m.landing.lat) && Math.abs(m.landing.lat) <= 90, 'Invalid meta.landing: it needs name, lon and lat');
  if (m.pad !== undefined || !m.landing) require(typeof m.pad_name === 'string' && Array.isArray(m.pad) && m.pad.length === 2 && m.pad.every(finite) && Math.abs(m.pad[1]) <= 90, 'Invalid launch pad');
  if (m.met_min !== undefined) require(finite(m.met_min) && m.met_min <= 0, 'Invalid meta.met_min: zero or negative seconds');
  const start = m.met_min ?? 0;
  const lo = clockSeconds(m.t0_min), hi = clockSeconds(m.t0_max), def = clockSeconds(m.t0_default);
  require(finite(lo) && finite(hi) && lo <= def && def <= hi, 'Invalid T0 range/default');
  require(Array.isArray(m.flight_segments) && m.flight_segments.length, 'No flight segments');
  for (const [key, seg] of Object.entries(data.tracks)) {
    require(finite(seg.met0) && finite(seg.dt) && seg.dt > 0, `Invalid times in ${key}`);
    require(Array.isArray(seg.lon) && seg.lon.length >= 2 && seg.lon.length <= 200000, `Invalid samples in ${key}`);
    for (const k of ['lon','lat','alt']) require(Array.isArray(seg[k]) && seg[k].length === seg.lon.length && seg[k].every(finite), `Invalid ${key}.${k}`);
    require(seg.lat.every((v) => Math.abs(v) <= 90), `Invalid latitude in ${key}`);
    require(typeof seg.label === 'string' && /^#[0-9a-f]{6}$/i.test(seg.color), `Invalid style in ${key}`);
    for (const k of EXTRAS) if (seg[k] !== undefined) require(Array.isArray(seg[k]) && seg[k].length === seg.lon.length && seg[k].every(finite), `Invalid ${key}.${k}`);
  }
  let prev;
  for (const key of m.flight_segments) {
    const seg = data.tracks[key]; require(!!seg, `Missing flight segment ${key}`);
    if (prev) {
      require(Math.abs(prev.met0 + (prev.lon.length - 1) * prev.dt - seg.met0) < 1e-5, 'Flight segments must share their endpoint time');
      const i = prev.lon.length - 1;
      const p = A.geodeticToScene(prev.lon[i], prev.lat[i], prev.alt[i]), q = A.geodeticToScene(seg.lon[0], seg.lat[0], seg.alt[0]);
      require(Math.hypot(...p.map((v, j) => v - q[j])) < 0.01, 'Flight segments must share their endpoint position');
    } else require(seg.met0 === start, m.met_min === undefined ? 'First flight segment must start at MET zero' : 'First flight segment must start at meta.met_min');
    prev = seg;
  }
  require(!!data.tracks.ascent || (m.met_min !== undefined && !m.jelly), 'An ascent track is required for the illumination envelope, unless the flight begins in orbit (meta.met_min)');
  const end = prev.met0 + (prev.lon.length - 1) * prev.dt;
  require(finite(m.insertion_met) && (m.insertion_met > 0 || (m.met_min !== undefined && m.insertion_met >= start)) && m.insertion_met <= end, 'Invalid insertion time');
  for (const k of ['inc','perigee_km','apogee_km']) require(finite(m[k]), `Invalid meta.${k}`);
  require(finite(m.period_s) && m.period_s > 0 && finite(m.orbit_revolutions), 'Invalid orbit duration');
  if (m.orbit_end_met !== undefined) require(finite(m.orbit_end_met) && m.orbit_end_met > m.insertion_met && m.orbit_end_met <= end + 1e-5, 'Invalid meta.orbit_end_met');
  require(Math.abs((m.orbit_end_met ?? end) - m.insertion_met - m.period_s * m.orbit_revolutions) < 1e-4, 'Orbit duration does not match revolutions');
  require(Array.isArray(m.powered_intervals) && m.powered_intervals.every((v) => v.length === 2 && v.every(finite) && v[0] >= start && v[1] > v[0] && v[1] <= end), 'Invalid powered intervals');
  if (m.plasma_intervals !== undefined) require(Array.isArray(m.plasma_intervals) && m.plasma_intervals.every((v) => v.length === 2 && v.every(finite) && v[0] >= start && v[1] > v[0] && v[1] <= end), 'Invalid meta.plasma_intervals');
  require(Array.isArray(m.phases) && m.phases.length && m.phases.every((p, i) => finite(p.until) && typeof p.label === 'string' && (!i || p.until > m.phases[i-1].until)), 'Invalid phase sequence');
  require(Array.isArray(m.views) && m.views.length && m.views.every((v) => v.length === 4 && typeof v[0] === 'string' && v.slice(1).every(finite) && Math.abs(v[2]) <= 90 && v[3] >= 1.05 && v[3] <= 14), 'Invalid camera views');
  require(Array.isArray(m.notes) && m.notes.every((s) => typeof s === 'string'), 'Missing model notes');
  require(Array.isArray(m.t0_presets) && m.t0_presets.every((p) => typeof p.label === 'string' && clockSeconds(p.time) >= lo && clockSeconds(p.time) <= hi), 'Invalid T0 presets');
  const v = m.visibility;
  require(v && Array.isArray(v.extent) && v.extent.length === 4 && v.extent.every(finite), 'Missing visibility bounds');
  const [w,e,s,n] = v.extent;
  require(e > w && e-w <= 360 && s >= -90 && n <= 90 && n > s && finite(v.grid_step_deg) && v.grid_step_deg > 0 && finite(v.time_step_s) && v.time_step_s > 0, 'Invalid visibility grid');
  require((1 + (e-w)/v.grid_step_deg) * (1 + (n-s)/v.grid_step_deg) <= 200000, 'Visibility grid exceeds 200,000 cells');
  require(Array.isArray(v.levels) && v.levels.length && v.levels.every((l, i) => finite(l) && l > 0 && l < 90 && (!i || l > v.levels[i-1])), 'Invalid elevation thresholds');
  require(Array.isArray(data.events) && data.events.every((e) => finite(e.met) && e.met >= start && e.met <= end+1e-5 && typeof e.label === 'string' && (e.short === undefined || (typeof e.short === 'string' && e.short.length <= 32)) && (!e.track || !!data.tracks[e.track])), 'Invalid events');
  require(Array.isArray(data.zones), 'Invalid zones');
  for (const z of data.zones) {
    if (z.label !== undefined) require(typeof z.label === 'string' && z.label.length <= 40, 'Invalid zone label');
    require(typeof z.id === 'string' && typeof z.role === 'string' && /^#[0-9a-f]{6}$/i.test(z.color), 'Invalid zone style');
    require(Array.isArray(z.ring) && z.ring.length >= 4 && z.ring.every((p) => p.length === 2 && p.every(finite) && Math.abs(p[1]) <= 90), 'Invalid hazard polygon');
    require(Array.isArray(z.centroid) && z.centroid.length === 2 && z.centroid.every(finite), 'Invalid hazard centroid');
    for (const k of ['t0','t1']) require(/^([01]\d|2[0-3])[0-5]\d$/.test(z[k]), 'Invalid hazard window');
    if (z.impact) require(['met','lon','lat'].every((k) => finite(z.impact[k])), 'Invalid optional impact');
  }
  const sun = data.sun;
  require(sun && finite(Date.parse(sun.start_utc)) && finite(sun.dt) && sun.dt > 0 && Array.isArray(sun.vectors) && sun.vectors.length >= 2 && sun.vectors.every((p) => p.length === 3 && p.every(finite)), 'Invalid solar ephemeris');
  require(Date.parse(sun.start_utc) <= A.dateT0ms(m.date, lo) + Math.min(-600, start) * 1000 && Date.parse(sun.start_utc) + (sun.vectors.length - 1) * sun.dt * 1000 >= A.dateT0ms(m.date, hi) + end * 1000, 'Solar ephemeris does not cover playback/T0 range');
  if (data.tle_ref?.sets?.length) {
    require(finite(Date.parse(data.tle_ref.t0)) && finite(data.tle_ref.raan_rate_deg_per_min), 'Invalid TLE reference');
    for (const t of data.tle_ref.sets) require(t.l1?.length === 69 && t.l2?.length === 69 && typeof t.name === 'string' && t.l1[68] === A.tleChecksum(t.l1) && t.l2[68] === A.tleChecksum(t.l2), 'Invalid synthetic TLE');
  }
  if (m.jelly) require(finite(m.solid_end_met) && ['prime_sun_deg','clear_ray_km','high_km'].every((k) => finite(m.jelly[k])) && Array.isArray(m.jelly.stages) && Array.isArray(m.jelly.cities), 'Invalid meta.jelly: it needs solid_end_met, prime_sun_deg, clear_ray_km, high_km, stages and cities');
  const stackOK = (st) => !!st && finite(st.total_m) && finite(st.burn_end) && (st.width_boost === undefined || (finite(st.width_boost) && st.width_boost > 0)) && Array.isArray(st.states) && st.states.length > 0 && st.states.every((s) => Array.isArray(s.segs) && s.segs.every((k) => st.segments?.[k]) && (!s.boosters || ['count','len','w'].every((k) => finite(s.boosters[k])))
    && [undefined, 'prograde', 'retrograde', 'up'].includes(s.attitude) && [undefined, 'drogue', 'main'].includes(s.chute) && [undefined, true, false].includes(s.plasma) && [undefined, true, false].includes(s.scorched));
  if (m.stack) require(stackOK(m.stack), 'Invalid meta.stack');
  if (m.companion) require(typeof m.companion.track === 'string' && !!data.tracks[m.companion.track] && !m.flight_segments.includes(m.companion.track) && typeof m.companion.label === 'string' && [undefined, true, false].includes(m.companion.tail_first) && stackOK(m.companion.stack) && Array.isArray(m.companion.powered_intervals) && m.companion.powered_intervals.every((v) => v.length === 2 && v.every(finite) && v[1] > v[0]), 'Invalid meta.companion: it needs track (a non-flight track), label, stack and powered_intervals');
  if (m.track_window !== undefined) require(!!m.track_window && typeof m.track_window.track === 'string' && m.flight_segments.includes(m.track_window.track) && (m.track_window.revolutions === undefined || (finite(m.track_window.revolutions) && m.track_window.revolutions > 0)), 'Invalid meta.track_window: it needs a flight segment and a positive number of revolutions');
  if (m.zone_noun !== undefined) require(typeof m.zone_noun === 'string' && m.zone_noun.length <= 24, 'Invalid meta.zone_noun');
  if (m.layer_labels !== undefined) require(!!m.layer_labels && typeof m.layer_labels === 'object' && Object.values(m.layer_labels).every((t) => typeof t === 'string' && t.length <= 32), 'Invalid meta.layer_labels');
  if (m.layer_defaults !== undefined) require(!!m.layer_defaults && typeof m.layer_defaults === 'object' && Object.entries(m.layer_defaults).every(([k, v]) => LAYERS.includes(k) && typeof v === 'boolean'), 'Invalid meta.layer_defaults: layer names with true or false');
  if (m.layer_order !== undefined) require(Array.isArray(m.layer_order) && m.layer_order.every((k) => LAYERS.includes(k)), 'Invalid meta.layer_order: a list of layer names');
  if (m.extra_cities) require(Array.isArray(m.extra_cities) && m.extra_cities.every((c) => c.length === 4 && typeof c[0] === 'string' && finite(c[1]) && finite(c[2]) && finite(c[3])), 'Invalid meta.extra_cities');
  if (m.model_badge !== undefined) require(typeof m.model_badge === 'string' && m.model_badge.length <= 40, 'Invalid meta.model_badge');
  if (m.cutoff_label !== undefined) require(typeof m.cutoff_label === 'string' && m.cutoff_label.length <= 24, 'Invalid meta.cutoff_label');
  if (m.about !== undefined) require(Array.isArray(m.about) && m.about.every((t) => typeof t === 'string'), 'Invalid meta.about');
  if (m.readme_url !== undefined) require(typeof m.readme_url === 'string' && /^https:\/\//.test(m.readme_url), 'Invalid meta.readme_url');
  if (m.subtitle !== undefined) require(typeof m.subtitle === 'string' && m.subtitle.length <= 90, 'Invalid meta.subtitle');
  if (m.tle_note !== undefined) require(typeof m.tle_note === 'string', 'Invalid meta.tle_note');
  if (m.headings !== undefined) require(!!m.headings && typeof m.headings === 'object' && Object.entries(m.headings).every(([k, t]) => HEADINGS.includes(k) && typeof t === 'string' && t.length <= 40), `Invalid meta.headings: ${HEADINGS.join(', ')} with texts up to 40 characters`);
  if (m.summary !== undefined) require(!!m.summary && typeof m.summary.title === 'string' && m.summary.title.length <= 40 && Array.isArray(m.summary.rows) && m.summary.rows.every((r) => Array.isArray(r) && r.length === 2 && r.every((t) => typeof t === 'string')), 'Invalid meta.summary: a title and rows of [name, value]');
  if (m.sky_mark !== undefined) require(!!m.sky_mark && finite(m.sky_mark.met) && m.sky_mark.met >= start && m.sky_mark.met <= end && typeof m.sky_mark.label === 'string' && m.sky_mark.label.length <= 24, 'Invalid meta.sky_mark');
  if (m.links !== undefined) require(Array.isArray(m.links) && m.links.every((l) => typeof l.label === 'string' && l.label.length <= 60 && typeof l.href === 'string' && /^(https:\/\/|\.\/)[^\s"'<>]*$/.test(l.href)), 'Invalid meta.links: label and an https or ./ href');
  return data;
}

export class Track {
  constructor(seg) {
    Object.assign(this, {met0:seg.met0, dt:seg.dt, n:seg.lon.length, lon:seg.lon, lat:seg.lat, alt:Float64Array.from(seg.alt)});
    this.extra = Object.fromEntries(EXTRAS.filter((k) => seg[k]).map((k) => [k, Float64Array.from(seg[k])]));   // optional vrel, vin, mach, g
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
    const out = {u:lerp(this.u,true), p:lerp(this.P,false), alt:this.alt[i] + (this.alt[i+1]-this.alt[i])*w};
    for (const k in this.extra) out[k] = this.extra[k][i] + (this.extra[k][i+1]-this.extra[k][i])*w;
    return out;
  }
  pt(i, exag, h = null) { return Array.from(this.u.subarray(3*i,3*i+3), (v) => v * (1 + (h ?? this.alt[i])*exag/A.RE)); }
  pts(exag, i0 = 0, i1 = this.n-1, ground = false) {
    const out = [];
    for (let i = Math.max(0,i0); i <= Math.min(this.n-1,i1); i++) out.push(...this.pt(i, exag, ground ? 0.0012*A.RE/exag : null));
    return out;
  }
}
export function createFlight(data) {
  const tracks = Object.fromEntries(Object.entries(data.tracks).map(([k,v]) => [k,new Track(v)]));
  const flight = data.meta.flight_segments.map((k) => tracks[k]);
  const shipAt = (met) => (flight.find((s) => met <= s.end) || flight.at(-1)).sample(met);
  const poweredAt = (met) => data.meta.powered_intervals.some(([a,b]) => met > a && met < b);
  const plasmaAt = (met) => !!data.meta.plasma_intervals && data.meta.plasma_intervals.some(([a,b]) => met >= a && met <= b);   // self-luminous entry
  return {tracks, flight, shipAt, poweredAt, plasmaAt, start:flight[0].met0, end:flight.at(-1).end};
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
export function shadowHeight(lon, lat, sun) {
  if (A.lookAngles(A.siteFrame(lon,lat),sun).el >= 0) return 0;
  let lo = 0, hi = 1e6;
  if (sunlightClearance(A.geodeticToScene(lon,lat,hi),sun) <= 0) return Infinity;
  for (let j = 0; j < 30; j++) { const mid = (lo+hi)/2; if (sunlightClearance(A.geodeticToScene(lon,lat,mid),sun)>0) hi = mid; else lo = mid; }
  return (lo+hi)/2;
}
export function computeJelly(asc, sunAt, T0) {
  const lit = new Uint8Array(asc.n), dep = new Float32Array(asc.n), h = new Float32Array(asc.n), transitions = [];
  let pickup = null;
  for (let i = 0; i < asc.n; i++) {
    const sun = sunAt(T0+asc.metAt(i)*1000), p = asc.P.subarray(3*i,3*i+3);
    lit[i] = sunlightClearance(p,sun)>0 ? 1 : 0;
    dep[i] = -A.lookAngles(A.siteFrame(asc.lon[i],asc.lat[i]),sun).el;
    h[i] = shadowHeight(asc.lon[i],asc.lat[i],sun);
    if (i && lit[i] !== lit[i-1]) {
      let lo = asc.metAt(i-1), hi = asc.metAt(i);
      for (let j = 0; j < 24; j++) { const mid = (lo+hi)/2, on = sunlightClearance(asc.sample(mid).p,sunAt(T0+mid*1000))>0; if (on === !!lit[i-1]) lo = mid; else hi = mid; }
      const met = (lo+hi)/2; transitions.push({met,lit:!!lit[i]});
      if (lit[i] && !pickup) pickup = {met,...asc.sample(met)};
    }
  }
  if (lit[0]) pickup = {met:asc.met0,...asc.sample(asc.met0),fromLiftoff:true};
  return {T0,lit,dep,h,pickup,transitions};
}

// Optional per-sample arrays of a track: air-relative and inertial speed (km/s), Mach number and sensed load (g).
export const EXTRAS = ['vrel', 'vin', 'mach', 'g'];
// Panel headings a mission may reword through meta.headings.
export const HEADINGS = ['config', 't0', 'playback', 'timeline', 'tle'];
export function greatCircleKm(lon1, lat1, lon2, lat2) {
  const p1 = lat1 * A.D2R, p2 = lat2 * A.D2R, dl = (lon2 - lon1) * A.D2R;
  return 2 * 6371 * Math.asin(Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2));
}
// The layer checkboxes, in the panel's order: the keys of meta.layer_defaults, meta.layer_order and the ?layer=0 URL state.
export const LAYERS = ['term', 'zones', 'labels', 'gt', 'jelly', 'vis', 'falls', 'sky', 'grid', 'lights', 'cities', 'fp', 'borders'];
