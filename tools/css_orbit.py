#!/usr/bin/env python3
"""China Space Station orbit forecast and Dongfeng landing opportunities for a coming Shenzhou return.

Input: a CelesTrak supplemental GP file for the CSS (NORAD 48274), which CelesTrak fits in 6-hour segments to the
ephemeris (OEM) published by CMSA. That ephemeris includes planned manoeuvres, so the segments after a reboost
describe the orbit the station will actually be in. Each segment is valid forward from its epoch: consecutive
segments agree to under 1 km at the next segment's epoch, and disagree by several km the other way.

    1. The segments after the last manoeuvre are sampled every 10 min over their own 6 h and one SGP4 element set
       (mean elements and B*) is fitted to them. Its B* is the mean drag of those days, carried forward.
    2. That set is propagated to the requested UTC dates and every pass of the ground track near the landing site
       is listed, with the signed cross-track miss. The site sits at the top of the ground track (its geodetic
       latitude equals the highest latitude of a 41.47 deg orbit), so the track crosses it heading east.
    3. For each date asked for, the pass with the smallest miss becomes a mission file for model/shenzhou_reentry.py.

    ~/.venvs/astro313/bin/python tools/css_orbit.py --supgp model/elements/css_supgp_2026-11-11.tle \
        --dates 2026-11-29 --id sz23 --name Shenzhou-23 --norad 69180 --intl 26113A

Outputs: out/<id>_orbit_forecast.json (fitted set, fit residuals, drag sensitivity, all passes) and
model/missions/<id>-<mmdd>.json for each date (template: model/missions/sz20.json)."""
import sys, json, argparse
from pathlib import Path
from datetime import datetime, timezone, timedelta
import numpy as np
from scipy.optimize import least_squares
from sgp4.api import Satrec, jday, WGS72

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'model'))
import shenzhou_reentry as R

SEGMENT_H = 6.0                    # each supplemental segment covers the 6 h after its epoch
LANDING_AFTER_PASS_S = 927.0       # Shenzhou-20: touchdown 01:34:30, its orbit's closest pass 01:19:03 UTC
IGNITION_BEFORE_PASS_S = 1998.0    # Shenzhou-20: ignition 00:45:45, same pass


def tle_checksum(line):
    return str(sum(int(c) if c.isdigit() else (1 if c == '-' else 0) for c in line[:68]) % 10)


def tle_exp(x):
    """TLE 'assumed decimal point' field, e.g. 0.00019968 -> ' 19968-3'."""
    if x == 0:
        return ' 00000-0'
    e = int(np.floor(np.log10(abs(x)))) + 1
    m = round(abs(x) / 10.0**e * 1e5)
    if m == 100000:
        m, e = 10000, e + 1
    return f"{'-' if x < 0 else ' '}{m:05d}{e:+d}"


def make_tle(satnum, intl, epoch, x):
    """Mean elements x = [n rad/min, e, i, raan, argp, M (rad), B*] -> two TLE lines."""
    doy = (epoch - datetime(epoch.year, 1, 1, tzinfo=timezone.utc)).total_seconds() / 86400 + 1
    deg = lambda a: np.degrees(a) % 360.0
    l1 = f"1 {satnum:05d}U {intl:<8} {epoch.year % 100:02d}{doy:012.8f}  .00000000  00000-0 {tle_exp(x[6])} 0  999"
    l2 = (f"2 {satnum:05d} {deg(x[2]):8.4f} {deg(x[3]):8.4f} {f'{x[1]:.7f}'[2:9]} {deg(x[4]):8.4f} {deg(x[5]):8.4f} "
          f"{x[0] * 1440 / (2 * np.pi):11.8f}    0")
    return l1 + tle_checksum(l1), l2 + tle_checksum(l2)


def teme(sat, t):
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
    e, r, v = sat.sgp4(jd, fr)
    if e != 0:
        raise RuntimeError(f'SGP4 error {e}')
    return np.array(r), np.array(v)


def rtn(dr, r, v):
    rh = r / np.linalg.norm(r)
    nh = np.cross(r, v)
    nh /= np.linalg.norm(nh)
    return np.array([dr @ rh, dr @ np.cross(nh, rh), dr @ nh])


def load_segments(path):
    L = [l for l in Path(path).read_text().splitlines() if l.strip()]
    out = []
    for i in range(0, len(L), 3):
        s = Satrec.twoline2rv(L[i + 1], L[i + 2])
        ep = datetime(2000 + s.epochyr, 1, 1, tzinfo=timezone.utc) + timedelta(days=s.epochdays - 1)
        out.append(dict(name=L[i].strip(), epoch=ep, sat=s, n=s.no_kozai * 1440 / (2 * np.pi), l1=L[i + 1], l2=L[i + 2]))
    return out


def after_last_manoeuvre(segs, tol_km=2.0):
    """Index of the first segment after the last one that fails to continue into its successor."""
    first = 0
    for k in range(len(segs) - 1):
        t = segs[k + 1]['epoch']
        ra, va = teme(segs[k]['sat'], t)
        rb, _ = teme(segs[k + 1]['sat'], t)
        if np.linalg.norm(ra - rb) > tol_km:
            first = k + 1
    return first


def fit(segs, satnum):
    ref = []
    for s in segs:
        for m in range(0, int(SEGMENT_H * 60), 10):
            t = s['epoch'] + timedelta(minutes=m)
            ref.append((t, *teme(s['sat'], t)))
    ep, s0 = segs[-1]['epoch'], segs[-1]['sat']
    days = (ep - datetime(1949, 12, 31, tzinfo=timezone.utc)).total_seconds() / 86400

    def sat_of(x):
        s = Satrec()
        s.sgp4init(WGS72, 'i', satnum, days, x[6], 0.0, 0.0, x[1], x[4], x[2], x[5], x[0], x[3])
        return s

    def res(x):
        s = sat_of(x)
        return np.concatenate([rtn(teme(s, t)[0] - r, r, v) for t, r, v in ref])

    sc = np.array([1e-6, 1e-5, 1e-5, 1e-5, 1e-3, 1e-3, 1e-4])
    x0 = np.array([s0.no_kozai, s0.ecco, s0.inclo, s0.nodeo, s0.argpo, s0.mo, 3e-4])
    sol = least_squares(lambda y: res(y * sc), x0 / sc)
    x = sol.x * sc
    r = res(x).reshape(-1, 3)
    return x, ep, sat_of, dict(samples=len(ref), span_utc=[R.iso(ref[0][0]), R.iso(ref[-1][0] + timedelta(minutes=10))],
                               rms_rtn_km=[round(float(v), 3) for v in np.sqrt((r**2).mean(0))],
                               max_rtn_km=[round(float(v), 3) for v in np.abs(r).max(0)])


def passes(sat, t0, t1, site, h_site, limit_km=400.0):
    """Closest approaches of the sub-satellite point to the site between t0 and t1 (ground distance below limit_km).
    cross_track_km is positive when the site is to the left of the direction of flight."""
    us = R.ecef(site[0], site[1], h_site)
    us /= np.linalg.norm(us)
    ang = lambda t: float(np.arccos(np.clip(R.teme_to_ecef(*teme(sat, t), t)[0] @ us / np.linalg.norm(teme(sat, t)[0]), -1, 1)))
    step = 10.0
    ts = [t0 + timedelta(seconds=k * step) for k in range(int((t1 - t0).total_seconds() / step) + 1)]
    d = np.array([ang(t) for t in ts])
    out = []
    for i in range(1, len(d) - 1):
        if d[i] < d[i - 1] and d[i] <= d[i + 1] and d[i] * 6371.0 < limit_km + 100:
            a, b = ts[i - 1], ts[i + 1]
            for _ in range(40):
                m1, m2 = a + (b - a) / 3, b - (b - a) / 3
                if ang(m1) < ang(m2):
                    b = m2
                else:
                    a = m1
            tc = a + (b - a) / 2
            r, v = R.teme_to_ecef(*teme(sat, tc), tc)
            lat, lon, h = R.geodetic(r)
            up = r / np.linalg.norm(r)
            side = us @ np.cross(up, v / np.linalg.norm(v))
            east = np.array([-np.sin(np.radians(lon)), np.cos(np.radians(lon)), 0.0])
            hdg = float(np.degrees(np.arctan2(v @ east, v @ np.cross(up, east))) % 360)
            dist = ang(tc) * 6371.0
            if dist <= limit_km:
                out.append(dict(closest_utc=R.iso(tc), cross_track_km=round(float(np.sign(side) * dist), 1),
                                subpoint=[round(float(lat), 3), round(float(lon), 3)], height_km=round(float(h), 1),
                                heading_deg=round(hdg, 1)))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--supgp', default=str(ROOT / 'model' / 'elements' / 'css_supgp_2026-11-11.tle'))
    ap.add_argument('--dates', nargs='+', default=['2026-11-29'], help='UTC dates of the landing')
    ap.add_argument('--id', default='sz23')
    ap.add_argument('--name', default='Shenzhou-23')
    ap.add_argument('--norad', type=int, default=69180)
    ap.add_argument('--intl', default='26113A')
    ap.add_argument('--template', default=str(ROOT / 'model' / 'missions' / 'sz20.json'))
    ap.add_argument('--no-missions', action='store_true', help='forecast only, write no mission files')
    a = ap.parse_args()

    segs = load_segments(a.supgp)
    k0 = after_last_manoeuvre(segs)
    used = segs[k0:]
    print(f'{len(segs)} segments {R.iso(segs[0]["epoch"])} to {R.iso(segs[-1]["epoch"] + timedelta(hours=SEGMENT_H))}')
    if k0:
        print(f'manoeuvre inside {segs[k0 - 1]["name"]} ({R.iso(segs[k0 - 1]["epoch"])} + {SEGMENT_H:.0f} h): mean motion '
              f'{segs[k0 - 2]["n"]:.5f} -> {segs[k0]["n"]:.5f} rev/day; fitting the {len(used)} segments after it')
    x, epoch, sat_of, stats = fit(used, a.norad)
    l1, l2 = make_tle(a.norad, a.intl, epoch, x)
    sat = Satrec.twoline2rv(l1, l2)
    a_km = (R.MU / (x[0] / 60.0)**2) ** (1 / 3)
    print(f'fitted set, epoch {R.iso(epoch)}: n {x[0] * 1440 / (2 * np.pi):.6f} rev/day, B* {x[6]:.3e}, fit RMS (R, T, N) {stats["rms_rtn_km"]} km')
    print(l1)
    print(l2)

    site_cfg = json.loads(Path(a.template).read_text())
    rep = site_cfg['reported']
    site, h_site = (rep['landing_lat'], rep['landing_lon']), rep['landing_alt_km']
    d0 = min(R.utc(d + 'T00:00:00Z') for d in a.dates)
    d1 = max(R.utc(d + 'T00:00:00Z') for d in a.dates) + timedelta(days=1)
    allp = passes(sat, d0 - timedelta(hours=1), d1 + timedelta(hours=1), site, h_site)
    # drag sensitivity: the same passes with B* 30 % lower and higher
    sens = {}
    for f in (0.7, 1.3):
        y = x.copy()
        y[6] *= f
        sens[f] = passes(sat_of(y), d0 - timedelta(hours=1), d1 + timedelta(hours=1), site, h_site)
    for i, p in enumerate(allp):
        p['landing_estimate_utc'] = R.iso(R.utc(p['closest_utc']) + timedelta(seconds=LANDING_AFTER_PASS_S))
        p['drag_30pct'] = dict(time_s=[round((R.utc(sens[f][i]['closest_utc']) - R.utc(p['closest_utc'])).total_seconds(), 1) for f in (0.7, 1.3)],
                               cross_track_km=[sens[f][i]['cross_track_km'] for f in (0.7, 1.3)]) if len(sens[0.7]) == len(allp) == len(sens[1.3]) else None
    print(f'\npasses of the ground track within 400 km of {rep["landing_name"]} ({site[0]:.3f} N {site[1]:.3f} E):')
    print('  closest approach UTC   Beijing        cross-track   heading   B* -30%/+30%: time, cross-track')
    for p in allp:
        t = R.utc(p['closest_utc'])
        s = p['drag_30pct']
        print(f"  {p['closest_utc'][:19]}    {(t + timedelta(hours=8)).strftime('%d %b %H:%M')}   {p['cross_track_km']:+8.1f} km   {p['heading_deg']:6.1f}    "
              + (f"{s['time_s'][0]:+.0f} / {s['time_s'][1]:+.0f} s,  {s['cross_track_km'][0]:+.1f} / {s['cross_track_km'][1]:+.1f} km" if s else ''))

    chosen = {}
    for d in a.dates:
        day = [p for p in allp if p['landing_estimate_utc'][:10] == d]
        if day:
            chosen[d] = min(day, key=lambda p: abs(p['cross_track_km']))
    out = ROOT / 'out'
    out.mkdir(exist_ok=True)
    src = Path(a.supgp)
    forecast = dict(
        object=dict(name='CSS (Tianhe)', norad=48274, used_for=a.name),
        source=dict(file=str(src.relative_to(ROOT)) if src.is_relative_to(ROOT) else src.name,
                    url='https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?CATNR=48274&FORMAT=tle',
                    note='CelesTrak supplemental GP (data source CSS-E): 6 h segments fitted to the ephemeris published by CMSA.'),
        segments=[dict(name=s['name'], epoch=R.iso(s['epoch']), mean_motion_rev_day=round(s['n'], 8)) for s in segs],
        manoeuvre=dict(segment=segs[k0 - 1]['name'], window_utc=[R.iso(segs[k0 - 1]['epoch']), R.iso(segs[k0 - 1]['epoch'] + timedelta(hours=SEGMENT_H))],
                       mean_motion_before=round(segs[k0 - 2]['n'], 6), mean_motion_after=round(segs[k0]['n'], 6)) if k0 else None,
        fit=dict(epoch=R.iso(epoch), line1=l1, line2=l2, bstar=float(x[6]), mean_motion_rev_day=float(x[0] * 1440 / (2 * np.pi)),
                 mean_altitude_km=round(float(a_km - R.A_E), 1), **stats),
        site=dict(name=rep['landing_name'], lat=site[0], lon=site[1], alt_km=h_site),
        passes=allp, chosen={d: p['closest_utc'] for d, p in chosen.items()})
    (out / f'{a.id}_orbit_forecast.json').write_text(json.dumps(forecast, indent=1))
    print('wrote', f'out/{a.id}_orbit_forecast.json')
    if a.no_missions:
        return

    for d, p in chosen.items():
        mid = f"{a.id}-{d[5:7]}{d[8:10]}"
        tc = R.utc(p['closest_utc'])
        cfg = dict(
            id=mid, name=a.name, date=d, kind='prediction',
            description=(f"Predicted return of the {a.name} spacecraft from the China Space Station to the Dongfeng landing site on the pass of "
                         f"{d} {p['closest_utc'][11:16]} UTC, {abs(p['cross_track_km']):.0f} km from the site."),
            tle=dict(name=f'CSS forecast ({a.name} docked)', line1=l1, line2=l2,
                     source=(f"One SGP4 set fitted to the {len(used)} CelesTrak supplemental GP segments of the CSS (NORAD 48274, from the CMSA ephemeris) after the "
                             f"reboost of {segs[k0 - 1]['epoch'].strftime('%d %b %Y')}: {stats['span_utc'][0][:16]} to {stats['span_utc'][1][:16]} UTC, "
                             f"fit RMS {stats['rms_rtn_km'][1]:.1f} km along track; propagated {((tc - epoch).total_seconds() / 86400):.1f} days with its fitted B*.")),
            target=dict(landing_lat=site[0], landing_lon=site[1], landing_alt_km=h_site, landing_name=rep['landing_name'],
                        landing_estimate_utc=p['landing_estimate_utc'],
                        sources=['Landing point of Shenzhou-20 (41 39 13 N 100 45 13 E), taken as the aim point of the Dongfeng landing site.',
                                 'Terrain height about 1.0 km; assumption.']),
            **{'pass': p},
            design=site_cfg['design'], vehicle=site_cfg['vehicle'],
            solver=dict(mode='prediction', t_ign_utc=R.iso(tc - timedelta(seconds=IGNITION_BEFORE_PASS_S)),
                        t_ign_note='First guess: the Shenzhou-20 interval between ignition and the closest pass of the orbit to the site. The solver moves it.',
                        dv_ms=138.8, sigma_deg=47.0,
                        template_note='Burn delta-v and bank magnitude are the values solved for Shenzhou-20 (19 Jan 2026); the ignition time and the bank reversal are solved for the landing point.',
                        t_rev_after_ei_guess_s=250.0, weights=dict(position_km=1.0)))
        (ROOT / 'model' / 'missions' / f'{mid}.json').write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + '\n')
        print(f"wrote model/missions/{mid}.json   pass {p['closest_utc']}  cross-track {p['cross_track_km']:+.1f} km")


if __name__ == '__main__':
    main()
