#!/usr/bin/env python3
"""Export a modeled Shenzhou return as a mission JSON for the launch-page template (out/web/<id>.json).

Inputs: the mission file (model/missions/<id>.json), the solved parameters (out/<id>_solution.json) and the 1 s
trajectory (out/<id>_trajectory.csv) written by model/shenzhou_reentry.py. The pre-burn orbit track is SGP4 from the
mission's element set; Sun and Moon vectors are geometric ECEF positions from the shared ~/JPLDE/de440s.bsp.

    ~/.venvs/astro313/bin/python tools/export_mission.py --id sz20
    ~/.venvs/astro313/bin/python tools/export_mission.py --id sz23-1129 --check     # docs/data/<id>.json is a rebuild

The format is the template's PROFILE_FORMAT.md (schema 1) with its reentry fields: meta.met_min (playback starts one
orbit before the burn), meta.landing, meta.plasma_intervals, meta.stack with the capsule kinds, meta.summary, and
tracks that carry vrel, vin, mach and g. tools/build_page.py registers the files in docs/. Tracks are uniform in time
with exact shared endpoints. Heights are WGS-84 ellipsoidal km; the page turns ECEF into its Y-up scene frame."""
import sys, json, csv, argparse, math
from pathlib import Path
from datetime import datetime, timedelta, timezone
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model'))
import shenzhou_reentry as R
from sgp4.api import Satrec, jday

MET_MIN = -5700.0          # s before ignition: a little over one orbit of free flight
OM_SEP_BEFORE_IGNITION = 105.0   # s, forecasts: the Shenzhou-20 interval from orbital-module separation to ignition
FORECAST_MADE = '11 Nov 2026'
T0_HALF_RANGE = 3 * 3600      # the T0 slider reaches this far either side of the model ignition, within the UTC day
README = 'https://github.com/exoplanet5/shenzhou-reentry#readme'


def utc(s):
    return R.utc(s)


def hms(t):
    return t.strftime('%H:%M:%S')


def rnd(a, n):
    return [round(float(x), n) for x in a]


def uniform(t_start, t_end, target_dt):
    n = max(1, round((t_end - t_start) / target_dt))
    dt = (t_end - t_start) / n
    t = t_start + np.arange(n + 1) * dt
    t[-1] = t_end
    return t, dt


def tle_checksum(line):
    s = 0
    for ch in line[:68]:
        if ch.isdigit():
            s += int(ch)
        elif ch == '-':
            s += 1
    return str(s % 10)


def make_tle(name, epoch, r_teme, v_teme, satnum=0, intl='25082A'):
    """Osculating classical elements of a TEME state -> two-line element set (placeholder catalog number)."""
    r, v = np.asarray(r_teme), np.asarray(v_teme)
    rr, vv = np.linalg.norm(r), np.linalg.norm(v)
    h = np.cross(r, v)
    n = np.cross([0, 0, 1.0], h)
    e_vec = ((vv**2 - R.MU / rr) * r - (r @ v) * v) / R.MU
    e = np.linalg.norm(e_vec)
    a = 1 / (2 / rr - vv**2 / R.MU)
    inc = math.acos(h[2] / np.linalg.norm(h))
    raan = math.atan2(n[1], n[0]) % (2 * math.pi)
    argp = math.acos(np.clip(n @ e_vec / (np.linalg.norm(n) * e), -1, 1))
    if e_vec[2] < 0:
        argp = 2 * math.pi - argp
    nu = math.acos(np.clip(e_vec @ r / (e * rr), -1, 1))
    if r @ v < 0:
        nu = 2 * math.pi - nu
    E = 2 * math.atan2(math.sqrt(1 - e) * math.sin(nu / 2), math.sqrt(1 + e) * math.cos(nu / 2))
    M = (E - e * math.sin(E)) % (2 * math.pi)
    n_rev = math.sqrt(R.MU / a**3) * 86400 / (2 * math.pi)
    doy = (epoch - datetime(epoch.year, 1, 1, tzinfo=timezone.utc)).total_seconds() / 86400 + 1
    l1 = f"1 {satnum:05d}U {intl:<8} {epoch.year % 100:02d}{doy:012.8f}  .00000000  00000-0  00000-0 0    0"
    l2 = (f"2 {satnum:05d} {math.degrees(inc):8.4f} {math.degrees(raan):8.4f} {f'{e:.7f}'[2:9]} "
          f"{math.degrees(argp):8.4f} {math.degrees(M):8.4f} {n_rev:11.8f}    0")
    l1, l2 = l1[:68] + tle_checksum(l1), l2[:68] + tle_checksum(l2)
    assert len(l1) == 69 and len(l2) == 69
    return dict(name=name, l1=l1, l2=l2), dict(a=a, e=e, perigee_km=a * (1 - e) - R.A_E, apogee_km=a * (1 + e) - R.A_E)


def ecef_to_teme(r, v, t):
    g = R.gmst_rad(t)
    c, s = math.cos(g), math.sin(g)
    Rz = np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])
    return Rz @ r, Rz @ (v + np.cross(R.W, r))


def body_tables(date, t0_min, t0_max, end_met, dt=30.0, pad=600.0):
    """Geometric Earth-to-Sun and Earth-to-Moon vectors, ECEF km, covering every T0 of the slider."""
    from skyfield.api import Loader, load_file
    from skyfield.framelib import itrs
    directory = Path.home() / 'JPLDE'
    kernel = directory / 'de440s.bsp'
    if not kernel.is_file():
        raise SystemExit('Missing ~/JPLDE/de440s.bsp (shared kernel; not downloaded here)')
    start = utc(f'{date}T{t0_min}Z') + timedelta(seconds=MET_MIN - pad)
    finish = utc(f'{date}T{t0_max}Z') + timedelta(seconds=end_met + pad)
    n = math.ceil((finish - start).total_seconds() / dt)
    seconds = np.arange(n + 1, dtype=float) * dt
    ts = Loader(str(directory)).timescale(builtin=True)
    times = ts.tt_jd(ts.from_datetime(start).tt + seconds / 86400)
    eph = load_file(str(kernel))
    try:
        sun = (eph['sun'] - eph['earth']).at(times).frame_xyz(itrs).km.T
        moon = (eph['moon'] - eph['earth']).at(times).frame_xyz(itrs).km.T
    finally:
        eph.close()
    table = lambda vec, what, nd: dict(start_utc=R.iso(start), dt=dt, vectors=[rnd(v, nd) for v in vec],
                                       model=f'DE440s geometric {what} centre in ITRS; WGS-84 occultation in the viewer')
    return table(sun, 'Sun', 1), table(moon, 'Moon', 2)


EXTRA_CITIES = [['Ejin Banner', 101.07, 41.95, 2], ['Dongfeng Space City', 100.29, 40.96, 2], ['Jinta', 98.90, 39.98, 3], ['Alxa Right Banner', 101.67, 39.21, 3],
                ['Aksu', 80.26, 41.17, 2], ['Kuqa', 82.96, 41.72, 3], ['Yining', 81.32, 43.92, 2], ['Shihezi', 86.04, 44.31, 3], ['Altay', 88.13, 47.85, 3],
                ['Ruoqiang', 88.17, 39.02, 3], ['Ulaanbaatar', 106.92, 47.92, 1], ['Islamabad', 73.05, 33.69, 1], ['Kabul', 69.17, 34.53, 1],
                ['Dushanbe', 68.78, 38.56, 1], ['Tashkent', 69.24, 41.30, 1], ['Bishkek', 74.59, 42.87, 1], ['Almaty', 76.95, 43.24, 1],
                ['Samarkand', 66.96, 39.65, 2], ['Khujand', 69.63, 40.28, 2], ['Osh', 72.80, 40.53, 2], ['Naryn', 75.98, 41.43, 3], ['Tehran', 51.39, 35.69, 1],
                ['Baghdad', 44.37, 33.31, 1], ['Riyadh', 46.68, 24.69, 1], ['Cairo', 31.24, 30.04, 1]]


def stack(t_om, burn_end, t_sep, t_b0, t_b1, t_chute, t_main):
    """The capsule cartoon: Shenzhou's three modules in orbit, two for the burn and coast, then the return module
    alone, in its plasma sheath, scorched, and under the drogue and main parachutes. Lengths and widths in metres."""
    return dict(total_m=12, burn_end=burn_end, width_boost=1,
                segments=dict(sm=dict(len=2.94, w=2.5, kind='service'), rm=dict(len=2.5, w=2.52, kind='capsule'), om=dict(len=2.8, w=2.25, kind='orbital')),
                states=[dict(until=t_om, segs=['sm', 'rm', 'om'], zoom=1, burn=None),
                        dict(until=t_sep, segs=['sm', 'rm'], zoom=1.25, burn='liquid', attitude='retrograde'),
                        dict(until=t_b0, segs=['rm'], zoom=2.4, burn=None, attitude='retrograde'),
                        dict(until=t_b1, segs=['rm'], zoom=2.0, burn=None, attitude='retrograde', plasma=True),
                        dict(until=t_chute, segs=['rm'], zoom=2.4, burn=None, attitude='retrograde', scorched=True),
                        dict(until=t_main, segs=['rm'], zoom=1.5, burn=None, attitude='up', chute='drogue', scorched=True),
                        dict(segs=['rm'], zoom=1.5, burn=None, attitude='up', chute='main', scorched=True)])


def build(mission_id):
    mission = R.Mission(ROOT / 'model' / 'missions' / f'{mission_id}.json')
    cfg, pred = mission.cfg, mission.prediction
    sol = json.loads((ROOT / 'out' / f'{mission_id}_solution.json').read_text())
    rows = list(csv.DictReader(open(ROOT / 'out' / f'{mission_id}_trajectory.csv')))
    t_ign = utc(sol['parameters']['t_ign_utc'])
    ev = {e['key']: e for e in sol['events']}
    d = sol['diag']
    met = np.array([float(r['met_s']) for r in rows])
    cols = {k: np.array([float(r[k]) for r in rows]) for k in
            ['lon_deg', 'lat_deg', 'alt_km', 'v_rel_kms', 'v_inertial_kms', 'mach', 'g_load', 'heating_Wcm2']}
    interp = lambda k, t: np.interp(t, met, cols[k])

    def csv_track(t0, t1, dt_target, color, label):
        t, dt = uniform(t0, t1, dt_target)
        return dict(met0=float(t0), dt=float(dt), lon=rnd(interp('lon_deg', t), 5), lat=rnd(interp('lat_deg', t), 5),
                    alt=rnd(interp('alt_km', t), 4), vrel=rnd(interp('v_rel_kms', t), 4), vin=rnd(interp('v_inertial_kms', t), 4),
                    mach=rnd(interp('mach', t), 2), g=rnd(interp('g_load', t), 3), color=color, label=label)

    # ---- pre-burn orbit: SGP4, Earth-fixed
    sat = Satrec.twoline2rv(cfg['tle']['line1'], cfg['tle']['line2'])
    t_orb, dt_orb = uniform(MET_MIN, 0.0, 10.0)
    lon, lat, alt, vin, vrel = [], [], [], [], []
    for tt in t_orb:
        t = t_ign + timedelta(seconds=float(tt))
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
        e, r, v = sat.sgp4(jd, fr)
        if e:
            raise SystemExit(f'SGP4 error {e}')
        re, ve = R.teme_to_ecef(r, v, t)
        la, lo, h = R.geodetic(re)
        lon.append(lo); lat.append(la); alt.append(h); vin.append(np.linalg.norm(v)); vrel.append(np.linalg.norm(ve))
    orbit = dict(met0=MET_MIN, dt=float(dt_orb), lon=rnd(lon, 5), lat=rnd(lat, 5), alt=rnd(alt, 4), vrel=rnd(vrel, 4), vin=rnd(vin, 4),
                 mach=[0.0] * len(lon), g=[0.0] * len(lon), color='#3987e5', label='Orbit')
    t_sep, t_ei, t_chute, t_land = ev['sm_separation']['met'], ev['entry_interface']['met'], ev['chute']['met'], ev['landing']['met']
    t_b0, t_b1 = ev['blackout_start']['met'], ev['blackout_end']['met']
    tracks = dict(orbit=orbit,
                  deorbit=csv_track(0.0, t_sep, 5.0, '#ffb84f', 'Burn and coast'),
                  entry=csv_track(t_sep, t_chute, 2.0, '#ff7043', 'Entry'),
                  descent=csv_track(t_chute, t_land, 5.0, '#c792ea', 'Parachutes'))
    for k in ('lon', 'lat', 'alt', 'vrel', 'vin', 'mach', 'g'):          # exact shared endpoints
        tracks['orbit'][k][-1] = tracks['deorbit'][k][0]
        tracks['deorbit'][k][-1] = tracks['entry'][k][0]
        tracks['entry'][k][-1] = tracks['descent'][k][0]

    # ---- events
    major = {'ignition', 'sm_separation', 'entry_interface', 'blackout_start', 'blackout_end', 'chute'}      # touchdown is the landing-site star
    short = dict(ignition='Deorbit burn', sm_separation=f'Service module off · {mission.h_sep:.0f} km', entry_interface=f'Entry · {mission.h_ei:.0f} km',
                 blackout_start=f'Blackout begins · {mission.h_black[0]:.0f} km', blackout_end=f'Blackout ends · {mission.h_black[1]:.0f} km',
                 chute=f'Parachutes · {mission.h_chute:.0f} km', landing='Touchdown')       # labels of the globe markers
    events = [dict(met=e['met'], label=e['label'], major=e['key'] in major, kind='ship', key=e['key'], official=False, **({'short': short[e['key']]} if e['key'] in short else {}))
              for e in sol['events']]
    if pred:
        t_om = -OM_SEP_BEFORE_IGNITION
        events.append(dict(met=t_om, label='Orbital module separation (nominal sequence)', major=False, kind='ship', key='om_separation', official=False))
    else:
        t_om = round((mission.t_omsep_rep - t_ign).total_seconds(), 1)
        events.append(dict(met=t_om, label='Orbital module separation (reported 08:44 Beijing)', major=False, kind='ship', key='om_separation', official=True))
        events.append(dict(met=round((mission.t_land_rep - t_ign).total_seconds(), 1), label='Touchdown reported (09:34 Beijing)', major=False, kind='ship', key='landing_reported', official=True))
    events.sort(key=lambda e: e['met'])
    burn_end, t_main = ev['burn_end']['met'], ev['main']['met']
    phases = [dict(until=0, label='Free flight after undocking'), dict(until=burn_end, label='Deorbit burn'),
              dict(until=t_sep, label='Coast, return + propulsion modules'), dict(until=t_ei, label='Return module coast'),
              dict(until=t_b0, label='Atmospheric entry'), dict(until=t_b1, label='Plasma blackout'),
              dict(until=t_chute, label='Supersonic descent'), dict(until=t_main, label='Drogue parachute'),
              dict(until=t_land, label='Main parachute'), dict(until=t_land + 1, label='Landed')]

    # ---- TLEs: the pre-burn set and the model deorbit ellipse (state at burn cutoff)
    i_end = int(np.searchsorted(met, burn_end))
    row = rows[i_end]
    r_e = R.ecef(float(row['lat_deg']), float(row['lon_deg']), float(row['alt_km']))
    # velocity from neighbouring samples (ECEF, km/s)
    r_a = R.ecef(float(rows[i_end - 1]['lat_deg']), float(rows[i_end - 1]['lon_deg']), float(rows[i_end - 1]['alt_km']))
    r_b = R.ecef(float(rows[i_end + 1]['lat_deg']), float(rows[i_end + 1]['lon_deg']), float(rows[i_end + 1]['alt_km']))
    v_e = (r_b - r_a) / 2.0
    t_cut = t_ign + timedelta(seconds=burn_end)
    r_t, v_t = ecef_to_teme(r_e, v_e, t_cut)
    syn, syn_el = make_tle(f"{cfg['name'].upper()} DEORBIT ELLIPSE (MODEL)", t_cut, r_t, v_t, intl=cfg['tle']['line1'][9:17].strip())
    first = f"{cfg['tle']['name'].upper()} (CELESTRAK SUP-GP FIT)" if pred else f"{cfg['tle']['name']} (SPACE-TRACK, PRE-BURN)"
    tle_ref = dict(t0=R.iso(t_ign), raan_rate_deg_per_min=360.98564736629 / 1440.0,
                   sets=[dict(name=first, l1=cfg['tle']['line1'], l2=cfg['tle']['line2']), syn])

    orbit_a = (R.MU / (float(cfg['tle']['line2'][52:63]) * 2 * math.pi / 86400) ** 2) ** (1 / 3)
    ecc = float('0.' + cfg['tle']['line2'][26:33])
    inc = float(cfg['tle']['line2'][8:16])
    period = 2 * math.pi * math.sqrt(orbit_a**3 / R.MU)
    site = [mission.site[1], mission.site[0]]
    name = cfg['name']
    ign_s = t_ign.hour * 3600 + t_ign.minute * 60 + t_ign.second
    clock = lambda sec: f'{int(sec) // 3600:02d}:{int(sec) % 3600 // 60:02d}:{int(sec) % 60:02d}'
    t0_min, t0_max = clock(max(0, ign_s - T0_HALF_RANGE)), clock(min(86399, ign_s + T0_HALF_RANGE))
    fmt_ll = lambda la, lo: f"{abs(la):.3f}°{'S' if la < 0 else 'N'} {abs(lo):.3f}°{'W' if lo < 0 else 'E'}"
    common_rows = [
        ['Deorbit burn', f"{d['dv_ms']:.1f} m/s in {d['burn_s']:.0f} s · perigee {d['deorbit_perigee_km']:.0f} km"],
        ['Entry interface', f"{{utc:{t_ei}}} · {d['ei_v_inertial_kms']:.2f} km/s · γ {d['ei_fpa_inertial_deg']:.2f}°"],
        ['Bank angle', f"±{abs(d['bank_deg']):.0f}° (L/D 0.30), one reversal"],
        ['Max deceleration', f"{d['max_g']:.1f} g"], ['Peak heating', f"{d['peak_heating_Wcm2']:.0f} W/cm² (Sutton–Graves)"],
        ['Blackout', f"{{utc:{t_b0}}} – {{utc:{t_b1}}} · {d['blackout_s'] / 60:.1f} min"], ['Parachute deploy', f"{d['v_at_chute_ms']:.0f} m/s at 10 km"]]
    if pred:
        ps = cfg['pass']
        drag = ps.get('drag_30pct')
        timing = f"±{max(abs(v) for v in drag['time_s']):.0f} s for ±30 % drag" if drag else 'not estimated'
        presets = [dict(label=f'Model {hms(t_ign)[:5]}', time=hms(t_ign))]
        if drag:
            k = max(abs(v) for v in drag['time_s'])
            presets = [dict(label=f'−{k:.0f} s', time=clock(ign_s - k)), presets[0], dict(label=f'+{k:.0f} s', time=clock(ign_s + k))]
        summary = dict(title='Forecast summary', rows=[
            ['Deorbit ignition', '{utc:0} (solved)'],
            ['Orbit pass', f"{ps['closest_utc'][11:19]}Z · ground track {abs(ps['cross_track_km']):.1f} km {'south' if ps['cross_track_km'] > 0 else 'north'} of the site"],
            *common_rows,
            ['Touchdown', f"{{utc:{t_land}}} · {d['v_touchdown_ms']:.1f} m/s before the retro-rockets"],
            ['Landing point', f"{fmt_ll(*mission.site)} (aim point)"],
            ['Timing', timing]])
        badge, subtitle = 'Forecast · not official', f"{mission.cfg['target']['landing_name']} · forecast touchdown {hms(utc(d['landing_utc']) + timedelta(seconds=30))[:5]} UTC"
        about = [f"Forecast of the {name} return, made {FORECAST_MADE}: the China Space Station orbit from CelesTrak supplemental elements (CMSA ephemeris) after the 13 November reboost, "
                 "and the deorbit burn and bank magnitude reconstructed for Shenzhou-20. Not an official schedule: the landing day, the pass and the burn are CMSA's to choose.",
                 f"WGS-84 geometry · JPL DE440s sunlight · {d['atmosphere'].split(',')[0]}."]
        notes = [
            f"Forecast, not official ephemeris. {cfg['tle']['source']}",
            'The descent is the Shenzhou-20 reconstruction moved onto this pass: a 3-DOF simulation (WGS-84, J2, rotating Earth, NRLMSIS 2.1 column) with the same burn '
            '(138.8 m/s in 160 s) and bank magnitude (47°). The ignition time and the bank reversal are solved so that the capsule reaches the Dongfeng aim point; the landing time is an output.',
            f"Timing: a drag error of ±30 % over the days of propagation moves the pass by {timing.split(' for')[0]}; a further station manoeuvre, a different burn or entry angle, or a different "
            'pass would move it more. The free-flying spacecraft also leaves the station orbit by a few km after undocking, which is not modeled.',
            'The T0 slider moves the Sun only: the Earth-fixed track stays. Its presets are the forecast time and the drag-error bounds.',
            'Plasma blackout is marked between the published 80 km and 40 km heights; the orange glow illustrates the self-luminous trail and is not a brightness model.',
            'Winds, the retro-rocket pulse, attitude dynamics and the real guidance law are not modeled; the single bank reversal is a proxy for the roll-modulated entry guidance.',
        ]
    else:
        presets = [dict(label=f'Actual {hms(t_ign)[:5]}', time=hms(t_ign))]
        rep = cfg['reported']
        summary = dict(title='Reconstruction vs reported', rows=[
            ['Deorbit ignition', '{utc:0} (model)'],
            ['Orbital module sep.', f"{rep['om_separation_utc'][11:19]}Z reported · ignition {d['ignition_after_om_separation_s']:.0f} s later"],
            *common_rows,
            ['Touchdown', f"{{utc:{t_land}}} model · {rep['landing_utc'][11:19]}Z reported"],
            ['Landing point', f"{fmt_ll(*d['landing'])} model\n{fmt_ll(*mission.site)} reported ({math.hypot(d['miss_north_km'], d['miss_east_km']):.2f} km)"]])
        badge, subtitle = 'Reconstruction · not official ephemeris', f"{rep['landing_name']} · landed {rep['landing_utc'][11:16]} UTC · reconstruction"
        about = ['Reconstruction from public reports and published Shenzhou return-sequence figures, solved for the reported landing point and minute; not official ephemeris.',
                 f"WGS-84 geometry · JPL DE440s sunlight · {d['atmosphere'].split(',')[0]}."]
        notes = [
            'Reconstruction, not official ephemeris: a 3-DOF simulation (WGS-84, J2, rotating Earth, NRLMSIS 2.1 column) of the deorbit burn, '
            'return-module entry with Mach-dependent capsule drag and 0.30 L/D bank steering, and the parachute sequence, solved so that the '
            'capsule reaches the reported landing point and minute for a deorbit ignition set by the reported orbital-module separation minute.',
            'The orbit before the burn is SGP4 from the spacecraft\'s own Space-Track element set; the Earth-fixed track does not change with the T0 slider, '
            'which only moves the Sun (for exploring the illumination of a return at another time of day).',
            'Plasma blackout is marked between the published 80 km and 40 km heights; the orange glow is an illustration of the self-luminous trail, not a brightness model.',
            'Winds, the retro-rocket pulse, attitude dynamics and the real guidance law are not modeled; the single bank reversal is a proxy for the roll-modulated entry guidance.',
        ]
    meta = dict(
        title=f'{name} reentry', vehicle=name, mission='Return to Dongfeng', date=cfg['date'], subtitle=subtitle,
        landing=dict(name=mission.cfg['target' if pred else 'reported']['landing_name'], lon=site[0], lat=site[1], alt_km=mission.h_site),
        t0_default=hms(t_ign), t0_min=t0_min, t0_max=t0_max, t0_presets=presets,
        met_min=MET_MIN, met_default=ev['peak_heating']['met'],
        insertion_met=MET_MIN, orbit_end_met=0, period_s=period, orbit_revolutions=-MET_MIN / period,
        inc=inc, perigee_km=round(orbit_a * (1 - ecc) - R.A_E, 1), apogee_km=round(orbit_a * (1 + ecc) - R.A_E, 1),
        flight_segments=['orbit', 'deorbit', 'entry', 'descent'],
        powered_intervals=[[0.0, burn_end]], plasma_intervals=[[t_b0, t_b1]],
        phases=phases,
        views=[['Global', 60, 20, 3.6], ['Burn point', d['burn_point'][1], d['burn_point'][0], 3.0], ['Entry corridor', 86, 39, 2.0],
               ['Dongfeng', site[0], site[1], 1.25]],
        visibility=dict(extent=[60, 112, 25, 55], grid_step_deg=0.25, time_step_s=2, levels=[10]),
        stack=stack(t_om, burn_end, t_sep, t_b0, t_b1, t_chute, t_main),
        sky_mark=dict(met=t_ei, label='Entry 100 km'), observer_home='Jiuquan', extra_cities=EXTRA_CITIES,
        model_badge=badge, about=about, notes=notes, summary=summary, readme_url=README,
        links=[dict(label='Methodology and Shenzhou-20 results', href='./model.html')],
        headings=dict(config='Return configuration', t0='Deorbit burn · UTC', playback='Playback', timeline='Return timeline', tle='Element sets'),
        tle_note=('The orbit set and the model deorbit ellipse at burn cutoff (perigee below the surface, placeholder catalog number 00000). '
                  'A changed T0 shifts epoch and RAAN for the same Earth-fixed path; the page uses the track samples, not SGP4.'),
        diag=dict(dv_ms=d['dv_ms'], burn_s=d['burn_s'], perigee_km=d['deorbit_perigee_km'], ei_fpa_deg=d['ei_fpa_inertial_deg'],
                  gamma120_deg=d['gamma_at_ref_deg'], ei_v_kms=d['ei_v_inertial_kms'], bank_deg=d['bank_deg'],
                  max_g=d['max_g'], peak_heating_Wcm2=d['peak_heating_Wcm2'], blackout_s=d['blackout_s'],
                  v_chute_ms=d['v_at_chute_ms'], v_touchdown_ms=d['v_touchdown_ms'],
                  landing=d['landing'], landing_utc=d['landing_utc'], miss_north_km=d['miss_north_km'], miss_east_km=d['miss_east_km'],
                  atmosphere=d['atmosphere'], synthetic_tle=dict(perigee_km=round(syn_el['perigee_km'], 1), apogee_km=round(syn_el['apogee_km'], 1))),
    )
    sun, moon = body_tables(cfg['date'], t0_min, t0_max, float(t_land))
    data = dict(schema_version=1, meta=meta, tracks=tracks, zones=[], events=events, tle_ref=tle_ref, sun=sun, moon=moon)
    return data, mission


def validate(data):
    m, tr = data['meta'], data['tracks']
    prev = None
    for key in m['flight_segments']:
        s = tr[key]
        n = len(s['lon'])
        assert all(len(s[k]) == n for k in ('lat', 'alt', 'vrel', 'vin', 'mach', 'g')), key
        assert all(np.isfinite(s[k]).all() for k in ('lon', 'lat', 'alt')), key
        if prev is not None:
            assert abs(prev['met0'] + (len(prev['lon']) - 1) * prev['dt'] - s['met0']) < 1e-6, key
            assert prev['lon'][-1] == s['lon'][0] and prev['alt'][-1] == s['alt'][0], key
        else:
            assert s['met0'] == m['met_min']
        prev = s
    end = prev['met0'] + (len(prev['lon']) - 1) * prev['dt']
    assert all(m['met_min'] - 1e-6 <= e['met'] <= end + 1e-6 for e in data['events']), 'event outside track'
    sun = data['sun']
    start = utc(sun['start_utc'])
    finish = start + timedelta(seconds=sun['dt'] * (len(sun['vectors']) - 1))
    assert start <= utc(f"{m['date']}T{m['t0_min']}Z") + timedelta(seconds=m['met_min'] - 600)
    assert finish >= utc(f"{m['date']}T{m['t0_max']}Z") + timedelta(seconds=end)
    for s in data['tle_ref']['sets']:
        assert len(s['l1']) == 69 and len(s['l2']) == 69 and s['l1'][68] == tle_checksum(s['l1']) and s['l2'][68] == tle_checksum(s['l2'])
    return end


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--id', default='sz20')
    ap.add_argument('--out', type=Path, default=ROOT / 'out' / 'web')
    ap.add_argument('--check', action='store_true', help='rebuild in memory and compare with the published docs/data/<id>.json')
    a = ap.parse_args()
    data, mission = build(a.id)
    end = validate(data)
    text = json.dumps(data, separators=(',', ':'), ensure_ascii=False)
    if a.check:
        assert (ROOT / 'docs' / 'data' / f'{a.id}.json').read_text() == text, 'published file differs from a rebuild'
        print('check ok')
        return
    a.out.mkdir(parents=True, exist_ok=True)
    out = a.out / f'{a.id}.json'
    out.write_text(text)
    print(f"wrote {out.relative_to(ROOT)} ({len(text) / 1e3:.0f} kB): tracks {[(k, len(v['lon'])) for k, v in data['tracks'].items()]}, "
          f"events {len(data['events'])}, sun vectors {len(data['sun']['vectors'])}, end MET {end:.1f} s")


if __name__ == '__main__':
    main()
