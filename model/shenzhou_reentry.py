#!/usr/bin/env python3
"""Shenzhou return: deorbit burn, coast, service-module separation, lifting capsule entry, parachutes, touchdown.

3-DOF point-mass simulation in the Earth-fixed rotating frame (WGS-84 ellipsoid, J2 gravity, Coriolis and
centrifugal terms), a co-rotating atmosphere (NRLMSIS 2.1 column or US76), a finite constant-acceleration
retrograde deorbit burn, capsule drag and lift with Mach-dependent coefficients and bank-angle steering with one
reversal, then drogue and main parachutes to the terrain height of the landing site. The orbit before the burn is
SGP4 from the spacecraft's own element set.

Free parameters, solved against the reported landing point and time (least squares) for a given burn ignition
time (the reported orbital-module separation minute plus the attitude slew):
    dv       burn delta-v                         -> landing time (the entry angle follows)
    sigma    bank-angle magnitude                 -> down-range
    t_rev    time of the single bank reversal     -> cross-range

    python model/shenzhou_reentry.py --mission model/missions/sz20.json --solve [--atmo msis|us76]
    python model/shenzhou_reentry.py --mission model/missions/sz20.json --export     # from the cached solution
    python model/shenzhou_reentry.py ... --solve --tign 00:45:00 --tag _0045   # other ignition times
    python model/shenzhou_reentry.py ... --nominal --tign 00:46:00 --dv 120 --sigma 45 --trev 2000

Outputs (out/<id>_*): solution JSON (parameters, events, diagnostics) and a 1 s trajectory CSV."""
import sys, json, argparse, csv
from pathlib import Path
from datetime import datetime, timezone, timedelta
import numpy as np
from scipy.integrate import solve_ivp
from scipy.optimize import least_squares
from sgp4.api import Satrec, jday

sys.path.insert(0, str(Path(__file__).resolve().parent))
from atmo import Atmosphere

ROOT = Path(__file__).resolve().parents[1]
MU, J2, OM = 398600.4418, 1.08262668e-3, 7.2921159e-5          # km^3/s^2, -, rad/s
A_E, E2 = 6378.137, 0.00669437999014                           # WGS-84
G0 = 9.80665
W = np.array([0.0, 0.0, OM])


# ---------------------------------------------------------------- frames and geometry
def utc(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).astimezone(timezone.utc)


def iso(t):
    return (t + timedelta(microseconds=500000)).strftime('%Y-%m-%dT%H:%M:%SZ')     # rounded to the second


def gmst_rad(t):
    """IAU-82 Greenwich mean sidereal time, UTC taken as UT1 (error < 1 s of time, ~0.004 deg)."""
    jd = 2440587.5 + t.timestamp() / 86400.0
    T = (jd - 2451545.0) / 36525.0
    g = 67310.54841 + (876600.0 * 3600 + 8640184.812866) * T + 0.093104 * T**2 - 6.2e-6 * T**3
    return np.radians((g % 86400.0) / 240.0)


def teme_to_ecef(r, v, t):
    g = gmst_rad(t)
    c, s = np.cos(g), np.sin(g)
    R = np.array([[c, s, 0.0], [-s, c, 0.0], [0.0, 0.0, 1.0]])
    re = R @ np.asarray(r)
    return re, R @ np.asarray(v) - np.cross(W, re)


def geodetic(r):
    """ECEF km -> (lat deg, lon deg, h km) above WGS-84 (Bowring)."""
    x, y, z = r
    p = np.hypot(x, y)
    b = A_E * np.sqrt(1 - E2)
    ep2 = E2 / (1 - E2)
    th = np.arctan2(z * A_E, p * b)
    lat = np.arctan2(z + ep2 * b * np.sin(th)**3, p - E2 * A_E * np.cos(th)**3)
    N = A_E / np.sqrt(1 - E2 * np.sin(lat)**2)
    return np.degrees(lat), np.degrees(np.arctan2(y, x)), p / np.cos(lat) - N


def ecef(lat, lon, h):
    la, lo = np.radians(lat), np.radians(lon)
    N = A_E / np.sqrt(1 - E2 * np.sin(la)**2)
    return np.array([(N + h) * np.cos(la) * np.cos(lo), (N + h) * np.cos(la) * np.sin(lo), (N * (1 - E2) + h) * np.sin(la)])


def gravity(r):
    x, y, z = r
    rr = np.linalg.norm(r)
    k = 1.5 * J2 * MU * A_E**2 / rr**5
    zz = 5 * z * z / rr**2
    return -MU * r / rr**3 + k * np.array([x * (zz - 1), y * (zz - 1), z * (zz - 3)])


def offsets_km(lat, lon, lat_t, lon_t):
    """(north, east) km of (lat, lon) from the target."""
    dn = (lat - lat_t) * 111.2
    de = ((lon - lon_t + 540) % 360 - 180) * 111.2 * np.cos(np.radians(lat_t))
    return dn, de


def great_circle_km(lat1, lon1, lat2, lon2):
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dl = np.radians(lon2 - lon1)
    a = np.sin((p2 - p1) / 2)**2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2)**2
    return 2 * 6371.0 * np.arcsin(np.sqrt(a))


# ---------------------------------------------------------------- vehicle aerodynamics
def capsule_aero(M, ld_hyp, cd_hyp):
    """(C_D, L/D) of the trimmed capsule vs Mach. Hypersonic values from the mission file; a supersonic drag
    rise and a subsonic drop typical of Soyuz-class blunt capsules; the trim lift fades through transonic flight."""
    cd = cd_hyp * np.interp(M, [0.6, 0.9, 1.2, 2.0, 4.0], [0.81, 0.92, 1.08, 1.09, 1.0])
    ld = ld_hyp * np.interp(M, [0.8, 1.2, 2.0, 6.0], [0.0, 0.33, 0.67, 1.0])
    return cd, ld


class Mission:
    def __init__(self, path):
        self.path = Path(path)
        self.cfg = json.loads(self.path.read_text())
        c = self.cfg
        self.id, self.name = c['id'], c['name']
        self.sat = Satrec.twoline2rv(c['tle']['line1'], c['tle']['line2'])
        rep, des, veh = c['reported'], c['design'], c['vehicle']
        self.t_land_rep = utc(rep['landing_utc'])
        self.t_omsep_rep = utc(rep['om_separation_utc'])
        self.site = (rep['landing_lat'], rep['landing_lon'])
        self.h_site = rep['landing_alt_km']
        self.gamma_ref, self.gamma_ref_km = des['gamma_ref_deg'], des['gamma_ref_km']
        self.burn_dur = des['burn_duration_s']
        self.h_sep, self.h_trim, self.h_ei = des['h_sm_separation_km'], des['h_trim_km'], des['h_ei_km']
        self.h_black = des['h_blackout_km']
        self.h_chute, self.h_main, self.h_shield = des['h_chute_km'], des['h_main_km'], des['h_shield_km']
        self.m_rm, self.m_shield, self.m_sm = veh['rm_mass_kg'], veh['shield_mass_kg'], veh['sm_mass_kg']
        self.S = np.pi * veh['diameter_m']**2 / 4
        self.ld_hyp, self.cd_hyp = veh['ld_hypersonic'], veh['cd_hypersonic']
        self.rn = veh['nose_radius_m']
        self.cds_drogue, self.cds_main = veh['drogue_cds_m2'], veh['main_cds_m2']
        self.t_ref = utc(c['solver']['t_ign_utc'])                # ignition; a run may offset it by t_ign seconds


class Sim:
    """One descent. Parameters: t_ign (s after mission.t_ref), dv (m/s), sigma (deg), t_rev (s after ignition)."""

    def __init__(self, mission, atmo, t_ign, dv, sigma, t_rev):
        self.m, self.atmo = mission, atmo
        self.t_ign, self.dv, self.sigma, self.t_rev = float(t_ign), float(dv), float(sigma), float(t_rev)
        self.t0 = mission.t_ref + timedelta(seconds=self.t_ign)   # ignition UTC; MET is measured from it
        self.segments = []

    # ---- state on the pre-burn orbit (SGP4 from the spacecraft's element set) at MET s
    def orbit_state(self, met):
        t = self.t0 + timedelta(seconds=float(met))
        jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
        e, r, v = self.m.sat.sgp4(jd, fr)
        if e != 0:
            raise RuntimeError(f'SGP4 error {e}')
        return teme_to_ecef(r, v, t)

    # ---- aerodynamics per phase: returns (CdS m^2, L/D, mass kg)
    def aero(self, phase, M, t):
        m = self.m
        cd, ld = capsule_aero(M, m.ld_hyp, m.cd_hyp)
        if phase == 'coast':                      # RM + SM stack, blunt end first after the burn; negligible above 145 km
            return cd * m.S, 0.0, m.m_rm + m.m_sm
        if phase == 'entry':
            return cd * m.S, ld, m.m_rm
        if phase == 'drogue':                      # pilot + drogue inflate over 2 s
            return cd * m.S + m.cds_drogue * min(1.0, (t - self.t_chute) / 2.0), 0.0, m.m_rm
        if phase in ('main', 'main2'):             # drogue released; main reefed 8 s, then full, each over ~2-3 s
            tau = t - self.t_main
            cds = m.cds_main * (0.35 * min(1.0, tau / 2.0) + 0.65 * np.clip((tau - 8.0) / 3.0, 0, 1))
            return cds, 0.0, m.m_rm - (m.m_shield if phase == 'main2' else 0.0)
        raise ValueError(phase)

    def bank(self, t):
        return np.radians(self.sigma if t < self.t_rev else -self.sigma)

    def accel(self, t, y, phase, diag=False):
        r, v = y[:3], y[3:]
        a = gravity(r) - 2 * np.cross(W, v) - np.cross(W, np.cross(W, r))
        if phase == 'coast' and 0.0 <= t < self.m.burn_dur:
            vi = v + np.cross(W, r)
            a = a - (self.dv / 1000.0 / self.m.burn_dur) * vi / np.linalg.norm(vi)
        lat, lon, h = geodetic(r)
        aero = np.zeros(3)
        rho = Mach = q = 0.0
        if h < 300.0:
            rho, T, c = self.atmo(h)
            V = np.linalg.norm(v) * 1000.0
            Mach = V / c
            cds, ld, mass = self.aero(phase, Mach, t)
            D = 0.5 * rho * V * V * cds / mass / 1000.0           # km/s^2
            vh = v / np.linalg.norm(v)
            up = r / np.linalg.norm(r)
            l0 = up - (up @ vh) * vh
            l0 /= np.linalg.norm(l0)
            side = np.cross(vh, l0)
            s = self.bank(t) if phase == 'entry' else 0.0
            aero = -D * vh + ld * D * (np.cos(s) * l0 + np.sin(s) * side)
            q = 0.5 * rho * V * V
            a = a + aero
        if diag:
            return a, dict(aero=aero, rho=rho, mach=Mach, q=q, h=h, lat=lat, lon=lon)
        return a

    def rhs(self, phase):
        return lambda t, y: np.r_[y[3:], self.accel(t, y, phase)]

    def _segment(self, phase, t_start, y0, h_stop, max_step, t_max=7200.0):
        def stop(t, y):
            return geodetic(y[:3])[2] - h_stop
        stop.terminal, stop.direction = True, -1
        sol = solve_ivp(self.rhs(phase), (t_start, t_start + t_max), y0, method='DOP853', rtol=1e-9, atol=1e-9,
                        max_step=max_step, dense_output=True, events=[stop])
        if not len(sol.t_events[0]):
            return None
        self.segments.append((phase, t_start, float(sol.t_events[0][0]), sol))
        return float(sol.t_events[0][0]), sol.y_events[0][0]

    def run(self):
        m = self.m
        self.segments = []
        self.ok = False
        r0, v0 = self.orbit_state(0.0)
        out = self._segment('coast', 0.0, np.r_[r0, v0], m.h_sep, 10.0)
        if out is None:
            return self
        self.t_sep, y = out
        out = self._segment('entry', self.t_sep, y, m.h_chute, 2.0)
        if out is None:
            return self
        self.t_chute, y = out
        out = self._segment('drogue', self.t_chute, y, m.h_main, 0.5)
        if out is None:
            return self
        self.t_main, y = out
        out = self._segment('main', self.t_main, y, m.h_shield, 0.5)
        if out is None:
            return self
        self.t_shield, y = out
        out = self._segment('main2', self.t_shield, y, m.h_site, 0.5, t_max=3600.0)
        if out is None:
            return self
        self.t_land, y = out
        self.land = geodetic(y[:3])
        self.ok = True
        return self

    # ---- sampling
    def state(self, t):
        for phase, ta, tb, sol in self.segments:
            if t <= tb or (phase, ta, tb, sol) is self.segments[-1]:
                y = sol.sol(min(max(t, ta), tb))
                return phase, y
        raise ValueError(t)

    def sample(self, t):
        """Full diagnostic record at MET t."""
        phase, y = self.state(t)
        r, v = y[:3], y[3:]
        a, d = self.accel(t, y, phase, diag=True)
        vi = v + np.cross(W, r)
        up = r / np.linalg.norm(r)
        V = np.linalg.norm(v)
        gam_rel = np.degrees(np.arcsin(np.clip((v @ up) / V, -1, 1)))
        gam_in = np.degrees(np.arcsin(np.clip((vi @ up) / np.linalg.norm(vi), -1, 1)))
        g = np.linalg.norm(d['aero']) * 1000.0 / G0
        qdot = 1.7415e-4 * np.sqrt(d['rho'] / self.m.rn) * (V * 1000.0)**3 / 1e4    # Sutton-Graves, W/cm^2
        dr = great_circle_km(d['lat'], d['lon'], *self.m.site)
        return dict(met=t, phase=phase, lat=d['lat'], lon=d['lon'], alt=d['h'], v_rel=V, v_in=np.linalg.norm(vi),
                    mach=d['mach'], fpa_rel=gam_rel, fpa_in=gam_in, g=g, q=d['q'] / 1000.0, qdot=qdot,
                    bank=np.degrees(self.bank(t)) if phase == 'entry' else 0.0, range_km=dr, rho=d['rho'])

    def crossing(self, h, t_lo=None, t_hi=None):
        """MET of the first downward crossing of altitude h within [t_lo, t_hi] (dense solutions, bisection)."""
        lo = self.segments[0][1] if t_lo is None else t_lo
        hi = self.segments[-1][2] if t_hi is None else t_hi
        f = lambda t: geodetic(self.state(t)[1][:3])[2] - h
        tt = np.linspace(lo, hi, 400)
        vals = np.array([f(t) for t in tt])
        idx = np.where((vals[:-1] > 0) & (vals[1:] <= 0))[0]
        if not len(idx):
            return None
        a, b = tt[idx[0]], tt[idx[0] + 1]
        for _ in range(50):
            c = 0.5 * (a + b)
            if f(c) > 0:
                a = c
            else:
                b = c
        return 0.5 * (a + b)

    def deorbit_perigee(self):
        """Osculating perigee height (above the equatorial radius) just after the burn."""
        _, y = self.state(self.m.burn_dur + 1.0)
        r, v = y[:3], y[3:] + np.cross(W, y[:3])
        rr = np.linalg.norm(r)
        a = 1 / (2 / rr - (v @ v) / MU)
        e = np.linalg.norm(np.cross(v, np.cross(r, v)) / MU - r / rr)
        return a * (1 - e) - A_E, a, e


# ---------------------------------------------------------------- solving
def residuals(x, mission, atmo, t_ign, verbose=False):
    s = Sim(mission, atmo, t_ign, *x).run()
    if not s.ok:
        return np.array([1e3, 1e3, 1e3])
    dn, de = offsets_km(s.land[0], s.land[1], *mission.site)
    dt_land = (s.t0 + timedelta(seconds=s.t_land) - mission.t_land_rep).total_seconds()
    w = mission.cfg['solver']['weights']
    res = np.array([dn / w['position_km'], de / w['position_km'], dt_land / w['time_s']])
    if verbose:
        print(f'  x={np.round(x, 3)}  miss N {dn:+.2f} km E {de:+.2f} km  dt_land {dt_land:+.1f} s', flush=True)
    return res


def solve(mission, atmo, t_ign):
    """Solve (dv, bank, reversal time) for the landing point and time at a fixed ignition time (s after t_ref)."""
    sv = mission.cfg['solver']
    s = Sim(mission, atmo, t_ign, sv['dv_guess_ms'], 0.0, 9e9).run()
    if not s.ok:
        raise RuntimeError('nominal run failed')
    t_ei = s.crossing(mission.h_ei, s.t_sep, s.t_chute)
    best = None
    for sig0 in (sv['sigma_guess_deg'], -sv['sigma_guess_deg']):
        x = np.array([sv['dv_guess_ms'], sig0, t_ei + sv['t_rev_after_ei_guess_s']])
        r = least_squares(residuals, x, args=(mission, atmo, t_ign), x_scale=[5.0, 10.0, 60.0],
                          bounds=([60.0, -89.0, 600.0], [250.0, 89.0, 3000.0]),
                          diff_step=[2e-3, 2e-2, 2e-2], max_nfev=150, xtol=1e-6, ftol=1e-8)
        print(f'  start sigma {sig0:+.0f}: dv {r.x[0]:.2f} m/s  bank {r.x[1]:+.2f} deg  reversal T+{r.x[2]:.0f} s  cost {r.cost:.4g}  residuals {np.round(r.fun, 3)}', flush=True)
        if best is None or r.cost < best.cost:
            best = r
    return best.x


# ---------------------------------------------------------------- export
def events_and_diag(s, mission, atmo_name):
    m = mission
    t_ei = s.crossing(m.h_ei, s.t_sep, s.t_chute)
    t_trim = s.crossing(m.h_trim, s.t_sep, s.t_chute)
    t_b0 = s.crossing(m.h_black[0], s.t_sep, s.t_chute)
    t_b1 = s.crossing(m.h_black[1], s.t_sep, s.t_chute)
    tt = np.arange(s.t_sep, s.t_chute, 0.5)
    rec = [s.sample(t) for t in tt]
    G = np.array([r['g'] for r in rec]); Q = np.array([r['qdot'] for r in rec]); Mh = np.array([r['mach'] for r in rec])
    i_g, i_q = int(np.argmax(G)), int(np.argmax(Q))
    below = lambda lev: float(tt[np.argmax(Mh < lev)]) if np.any(Mh < lev) else None
    ei = s.sample(t_ei)
    gref = s.sample(s.crossing(m.gamma_ref_km, s.t_sep, s.t_chute))
    land = s.sample(s.t_land)
    burn_end = s.sample(m.burn_dur)
    ign = s.sample(0.0)
    rp, a, e = s.deorbit_perigee()
    dn, de = offsets_km(s.land[0], s.land[1], *m.site)
    t_land_utc = s.t0 + timedelta(seconds=s.t_land)
    ev = [
        ('ignition', 0.0, 'Deorbit burn ignition'),
        ('burn_end', m.burn_dur, 'Deorbit burn cutoff'),
        ('sm_separation', s.t_sep, f'Service module separation, {m.h_sep:.0f} km'),
        ('trim', t_trim, f'Trim attitude, heat shield forward, {m.h_trim:.0f} km'),
        ('entry_interface', t_ei, f'Entry interface, {m.h_ei:.0f} km'),
        ('blackout_start', t_b0, f'Plasma blackout begins, {m.h_black[0]:.0f} km'),
        ('peak_heating', float(tt[i_q]), 'Peak heating'),
        ('max_g', float(tt[i_g]), f'Maximum deceleration, {G[i_g]:.1f} g'),
        ('blackout_end', t_b1, f'Blackout ends, {m.h_black[1]:.0f} km'),
        ('mach1', below(1.0), 'Subsonic, Mach 1'),
        ('chute', s.t_chute, f'Parachute cover off, pilot and drogue chutes, {m.h_chute:.0f} km'),
        ('main', s.t_main, f'Main parachute, {m.h_main:.0f} km'),
        ('shield', s.t_shield, f'Heat shield jettison, {m.h_shield:.0f} km'),
        ('landing', s.t_land, 'Touchdown'),
    ]
    events = [dict(key=k, met=round(float(t), 1), utc=iso(s.t0 + timedelta(seconds=float(t))), label=lbl)
              for k, t, lbl in ev if t is not None]
    m0 = m.m_rm + m.m_sm
    diag = dict(
        atmosphere=atmo_name,
        t_ign_utc=iso(s.t0), dv_ms=round(s.dv, 2), burn_s=m.burn_dur,
        thrust_implied_kN=round(m0 * s.dv / m.burn_dur / 1000.0, 2), mass_at_burn_kg=m0,
        burn_point=[round(ign['lat'], 3), round(ign['lon'], 3), round(ign['alt'], 1)],
        deorbit_perigee_km=round(float(rp), 1), deorbit_a_km=round(float(a), 2), deorbit_e=round(float(e), 6),
        v_after_burn_kms=round(burn_end['v_in'], 4),
        ei_point=[round(ei['lat'], 3), round(ei['lon'], 3)], ei_v_inertial_kms=round(ei['v_in'], 4),
        ei_v_relative_kms=round(ei['v_rel'], 4), ei_fpa_inertial_deg=round(ei['fpa_in'], 3),
        ei_fpa_relative_deg=round(ei['fpa_rel'], 3), ei_range_to_site_km=round(ei['range_km'], 1),
        gamma_ref_km=m.gamma_ref_km, gamma_at_ref_deg=round(gref['fpa_in'], 3), gamma_target_deg=m.gamma_ref,
        bank_deg=round(s.sigma, 2), bank_reversal_met=round(s.t_rev, 1),
        max_g=round(float(G[i_g]), 2), max_g_alt_km=round(rec[i_g]['alt'], 1), max_g_mach=round(rec[i_g]['mach'], 1),
        peak_heating_Wcm2=round(float(Q[i_q]), 1), peak_heating_alt_km=round(rec[i_q]['alt'], 1), peak_heating_mach=round(rec[i_q]['mach'], 1),
        blackout_s=round(t_b1 - t_b0, 1) if t_b0 and t_b1 else None,
        v_at_chute_ms=round(s.sample(s.t_chute)['v_rel'] * 1000, 1),
        v_at_main_ms=round(s.sample(s.t_main)['v_rel'] * 1000, 1),
        v_touchdown_ms=round(land['v_rel'] * 1000, 2),
        chute_descent_s=round(s.t_land - s.t_chute, 1), entry_to_chute_s=round(s.t_chute - t_ei, 1),
        burn_to_ei_s=round(t_ei, 1),
        landing=[round(s.land[0], 5), round(s.land[1], 5)], landing_utc=iso(t_land_utc),
        target=list(m.site), target_utc=iso(m.t_land_rep),
        miss_north_km=round(float(dn), 3), miss_east_km=round(float(de), 3),
        landing_time_error_s=round((t_land_utc - m.t_land_rep).total_seconds(), 1),
        ignition_after_om_separation_s=round((s.t0 - m.t_omsep_rep).total_seconds(), 1),
        om_separation_reported_utc=iso(m.t_omsep_rep),
    )
    return events, diag


def write_csv(s, path, dt=1.0):
    cols = ['time_utc', 'met_s', 'phase', 'lon_deg', 'lat_deg', 'alt_km', 'v_rel_kms', 'v_inertial_kms', 'mach',
            'fpa_inertial_deg', 'fpa_relative_deg', 'g_load', 'dyn_pressure_kPa', 'heating_Wcm2', 'bank_deg', 'range_to_site_km', 'rho_kgm3']
    grid = np.arange(0.0, s.t_land, dt)
    if s.t_land - grid[-1] > 1e-6:
        grid = np.r_[grid, s.t_land]
    with open(path, 'w', newline='') as f:
        w = csv.writer(f)
        w.writerow(cols)
        for t in grid:
            r = s.sample(t)
            w.writerow([iso(s.t0 + timedelta(seconds=float(t))) if abs(t - round(t)) < 1e-6 else (s.t0 + timedelta(seconds=float(t))).strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + 'Z',
                        f'{t:.1f}', r['phase'], f"{r['lon']:.5f}", f"{r['lat']:.5f}", f"{r['alt']:.4f}", f"{r['v_rel']:.5f}", f"{r['v_in']:.5f}",
                        f"{r['mach']:.3f}", f"{r['fpa_in']:.4f}", f"{r['fpa_rel']:.4f}", f"{r['g']:.3f}", f"{r['q']:.4f}", f"{r['qdot']:.2f}",
                        f"{r['bank']:.1f}", f"{r['range_km']:.2f}", f"{r['rho']:.4e}"])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--mission', default=str(ROOT / 'model' / 'missions' / 'sz20.json'))
    ap.add_argument('--atmo', default='msis', choices=['msis', 'us76'])
    ap.add_argument('--solve', action='store_true')
    ap.add_argument('--export', action='store_true')
    ap.add_argument('--nominal', action='store_true', help='single run with --tign/--dv/--sigma/--trev, no solving')
    ap.add_argument('--tign', help='ignition HH:MM:SS UTC (overrides the mission file)')
    ap.add_argument('--dv', type=float, help='m/s (nominal)')
    ap.add_argument('--sigma', type=float, default=0.0)
    ap.add_argument('--trev', type=float, default=9e9, help='bank reversal MET s (nominal)')
    ap.add_argument('--tag', default='', help='suffix for output files')
    a = ap.parse_args()
    mission = Mission(a.mission)
    atmo = Atmosphere(a.atmo, site=mission.site, epoch=mission.cfg['reported']['landing_utc'],
                      cache=ROOT / 'model' / f'atmo_msis_{mission.id}.json')
    print('atmosphere:', atmo.describe)
    out = ROOT / 'out'
    out.mkdir(exist_ok=True)
    sol_path = out / f'{mission.id}_solution{a.tag}.json'
    t_ign = (utc(f"{mission.cfg['date']}T{a.tign}Z") - mission.t_ref).total_seconds() if a.tign else 0.0
    if a.nominal:
        x = [a.dv or mission.cfg['solver']['dv_guess_ms'], a.sigma, a.trev]
    elif a.solve:
        x = solve(mission, atmo, t_ign)
    else:
        prev = json.loads(sol_path.read_text())
        x, t_ign = prev['x'], prev['t_ign_s_from_ref']
    s = Sim(mission, atmo, t_ign, *x).run()
    if not s.ok:
        raise SystemExit('run failed (no touchdown)')
    events, diag = events_and_diag(s, mission, atmo.describe)
    print(f"ignition {diag['t_ign_utc']} ({diag['ignition_after_om_separation_s']:+.0f} s after reported OM separation)  dv {diag['dv_ms']} m/s  "
          f"bank {diag['bank_deg']:+.1f} deg reversing at T+{diag['bank_reversal_met']:.0f} s  perigee {diag['deorbit_perigee_km']} km")
    print(f"EI {events[[e['key'] for e in events].index('entry_interface')]['utc']} gamma {diag['ei_fpa_inertial_deg']} deg (rel {diag['ei_fpa_relative_deg']})  "
          f"v {diag['ei_v_inertial_kms']} km/s  range to site {diag['ei_range_to_site_km']} km")
    print(f"max g {diag['max_g']} at {diag['max_g_alt_km']} km  peak heating {diag['peak_heating_Wcm2']} W/cm2 at {diag['peak_heating_alt_km']} km  blackout {diag['blackout_s']} s")
    print(f"chute at {diag['v_at_chute_ms']} m/s, main at {diag['v_at_main_ms']} m/s, touchdown {diag['v_touchdown_ms']} m/s; chute descent {diag['chute_descent_s']} s")
    print(f"landing {diag['landing_utc']} at {diag['landing']}  miss N {diag['miss_north_km']:+.2f} E {diag['miss_east_km']:+.2f} km  time error {diag['landing_time_error_s']:+.1f} s")
    for e in events:
        print(f"  T+{e['met']:7.1f}  {e['utc'][11:19]}  {e['label']}")
    if a.solve or a.export or a.nominal:
        sol = dict(mission=mission.id, x=[float(v) for v in x], t_ign_s_from_ref=float(t_ign),
                   parameters=dict(t_ign_utc=iso(s.t0), dv_ms=x[0], sigma_deg=x[1], t_rev_met_s=x[2]),
                   events=events, diag=diag, inputs=mission.cfg)
        sol_path.write_text(json.dumps(sol, indent=1))
        csv_path = out / f'{mission.id}_trajectory{a.tag}.csv'
        write_csv(s, csv_path)
        print('wrote', sol_path.name, csv_path.name)


if __name__ == '__main__':
    main()
