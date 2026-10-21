import numpy as np
from dataclasses import dataclass
from datetime import datetime, timezone, timedelta
from math import sin, cos, tan, atan2, acos, sqrt, pi
from sgp4.api import Satrec, jday
from scipy.optimize import least_squares

# ===================== Input =====================
CSS_TLE_LINE1 = "1 48274U 21035A   26017.75917748  .00020114  00000+0  23896-3 0  9998"
CSS_TLE_LINE2 = "2 48274  41.4657 157.7848 0011173 305.0077  54.9713 15.60612084269659"
BURN_ISO_UTC = "2026-01-19T00:48:00Z"  # Deorbit burn time (UTC)

# Set this to force the initial circular-orbit altitude (km).
# Otherwise, None uses the geocentric distance |r0| from the TLE at t0.
H0_OVERRIDE_KM = None

# Target constraints (relative to the deorbit burn time)
DT1_MIN, H_AT_DT1 = 21.0, 145.0
DT2_MIN, H_AT_DT2 = 25.0, 80.0
GAMMA_DEG_TARGET = 1.6   # Entry angle is negative; enter a positive magnitude here.
GAMMA_TOL_DEG = 0.01     # Required angular accuracy
# =================================================

MU = 398600.4418  # km^3/s^2
RE = 6378.135  # km


def norm(v):
    return np.linalg.norm(v)


def sgp4_rv_at(tle1, tle2, t):
    s = Satrec.twoline2rv(tle1, tle2)
    jd, fr = jday(t.year, t.month, t.day, t.hour, t.minute, t.second + t.microsecond * 1e-6)
    e, r, v = s.sgp4(jd, fr)
    if e != 0:
        raise RuntimeError(f"SGP4 error {e}")
    return np.array(r), np.array(v)


def node_u_from_rv(r, v, eps=1e-12):
    r = np.asarray(r, float)
    v = np.asarray(v, float)
    k = np.array([0.0, 0.0, 1.0])

    h = np.cross(r, v)
    H = norm(h)
    if H == 0:
        raise ValueError("h=0: r and v are collinear")

    i = np.arccos(np.clip(h[2] / H, -1.0, 1.0))
    n = np.cross(k, h)
    N = norm(n)

    if N > eps:
        raan = np.arctan2(n[1], n[0]) % (2 * np.pi)
        n_hat = n / N
        h_hat = h / H
        m_hat = np.cross(h_hat, n_hat)  # Key correction: positive 90-degree direction within the orbital plane
        r_hat = r / norm(r)
        u = np.arctan2(np.dot(r_hat, m_hat), np.dot(r_hat, n_hat)) % (2 * np.pi)
    else:
        # Near-equatorial degeneracy: RAAN is undefined; set RAAN=0 and use true longitude for u.
        raan = 0.0
        u = np.arctan2(r[1], r[0]) % (2 * np.pi)

    return i, raan, u


def kepler_E_from_M(M, e, tol=1e-13, itmax=60):
    M = (M + pi) % (2 * pi) - pi
    E = M if e < 0.8 else pi
    for _ in range(itmax):
        f = E - e * np.sin(E) - M
        fp = 1 - e * np.cos(E)
        dE = -f / fp
        E += dE
        if abs(dE) < tol:
            break
    return E


def true_from_E(E, e):
    return 2 * atan2(sqrt(1 + e) * sin(E / 2), sqrt(1 - e) * cos(E / 2))


def gamma_from_E(E, e):
    nu = true_from_E(E, e)
    return atan2(e * sin(nu), 1 + e * cos(nu))  # radians


def rv_from_coe(a, e, i, raan, argp, E):
    r_pqw = np.array([a * (cos(E) - e), a * sqrt(1 - e**2) * sin(E), 0.0])
    fac = sqrt(MU * a) / norm(r_pqw)
    v_pqw = fac * np.array([-sin(E), sqrt(1 - e**2) * cos(E), 0.0])

    def R1(x):
        cx, sx = cos(x), sin(x)
        return np.array([[1, 0, 0], [0, cx, sx], [0, -sx, cx]])

    def R3(z):
        cz, sz = cos(z), sin(z)
        return np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])

    Q = R3(raan) @ R1(i) @ R3(argp)
    return Q @ r_pqw, Q @ v_pqw


def make_tle(i, raan, argp, e, a, M0, epoch, satnum=99921, intl="25921A", revnum=1):
    i_deg, raan_deg = np.degrees(i) % 360, np.degrees(raan) % 360
    argp_deg, M_deg = np.degrees(argp) % 360, np.degrees(M0) % 360
    e_str = f"{e:.7f}".split(".")[1][:7]
    n_revday = sqrt(MU / a**3) * 86400.0 / (2 * pi)
    year2 = epoch.year % 100
    doy0 = datetime(epoch.year, 1, 1, tzinfo=timezone.utc)
    doy = (epoch - doy0).total_seconds() / 86400.0 + 1.0
    epoch_field = f"{year2:02d}{doy:012.8f}"

    def checksum(line):
        s = 0
        for ch in line[:-1]:
            if ch.isdigit():
                s += int(ch)
            elif ch == '-':
                s += 1
        return str(s % 10)

    l1 = f"1 {satnum:05d}U {intl:<8} {epoch_field} 0.000000    00000-0  00000-0 0  9999"
    l1 = l1[:68] + checksum(l1)
    l2 = f"2 {satnum:05d} {i_deg:8.4f} {raan_deg:8.4f} {e_str:>7s} {argp_deg:8.4f} {M_deg:8.4f} {n_revday:11.8f}    {revnum:05d}"
    l2 = l2[:68] + checksum(l2)
    return l1, l2


def solve_fit_ae_strong_gamma():
    if "PASTE" in CSS_TLE_LINE1:
        raise SystemExit("Paste the two CSS TLE lines into CSS_TLE_LINE1/2")

    t0 = datetime.fromisoformat(BURN_ISO_UTC.replace("Z", "+00:00"))
    r0, v0 = sgp4_rv_at(CSS_TLE_LINE1, CSS_TLE_LINE2, t0)
    R0 = norm(r0) if H0_OVERRIDE_KM is None else (RE + float(H0_OVERRIDE_KM))
    i0, raan0, u0 = node_u_from_rv(r0, v0)

    dt1, dt2 = DT1_MIN * 60.0, DT2_MIN * 60.0
    R1, R2 = RE + H_AT_DT1, RE + H_AT_DT2
    R120 = RE + 120.0
    gamma_target = -np.deg2rad(GAMMA_DEG_TARGET)

    def residuals(x, w_gamma):
        a, e = x
        # Valid parameter domain
        if not (RE * 0.5 < a < 100000 and 1e-5 < e < 0.99):
            return np.array([1e6, 1e6, 1e6])
        # Same position: solve r(t0)=R0 for E0 (descending branch).
        cosE0 = (1 - R0 / a) / e
        if abs(cosE0) > 1.0:
            return np.array([1e6, 1e6, 1e6])
        E0 = -abs(acos(cosE0))
        M0 = E0 - e * sin(E0)
        n = sqrt(MU / a**3)

        # Radii at 21 and 25 minutes
        def r_from_dt(dt):
            M = M0 + n * dt
            E = kepler_E_from_M(M, e)
            return a * (1 - e * cos(E))

        r1 = r_from_dt(dt1)
        r2 = r_from_dt(dt2)

        # Flight-path angle at 120 km altitude
        cosE120 = (1 - R120 / a) / e
        if abs(cosE120) > 1.0:
            return np.array([1e6, 1e6, 1e6])
        E120 = -abs(acos(cosE120))
        g120 = gamma_from_E(E120, e)
        return np.array([r1 - R1, r2 - R2, w_gamma * (g120 - gamma_target)])

    # Initial guess: perigee altitude around 90-100 km
    rp_guess = RE + 15.0
    a0 = 0.5 * (R0 + rp_guess)
    e0 = 1 - rp_guess / a0
    x0 = np.array([a0, e0])

    # Adaptive weighting: increase gamma's weight until |delta gamma| <= 0.01 degrees.
    w = 5_000.0  # Initial km/rad weight (angular error expressed as equivalent km)
    w_max = 5e7
    best = None
    for _ in range(10):
        sol = least_squares(
            lambda x: residuals(x, w), x0,
            bounds=([RE * 0.99, 1e-4], [1e5, 0.99]),
            xtol=1e-12, ftol=1e-12, gtol=1e-12, max_nfev=2000,
        )
        a, e = sol.x
        # Evaluate the current gamma error.
        cosE0 = (1 - R0 / a) / e
        if abs(cosE0) >= 1.0:
            gamma_err_deg = 1e9
        else:
            E0 = -abs(acos(cosE0))
            M0 = E0 - e * sin(E0)
            n = sqrt(MU / a**3)
            cosE120 = (1 - R120 / a) / e
            if abs(cosE120) >= 1.0:
                gamma_err_deg = 1e9
            else:
                E120 = -abs(acos(cosE120))
                g120 = gamma_from_E(E120, e)
                gamma_err_deg = abs(np.degrees(g120 - gamma_target))
        best = (a, e, gamma_err_deg)
        if gamma_err_deg <= GAMMA_TOL_DEG:  # Satisfies 0.01-degree tolerance
            break
        w = min(w * 5.0, w_max)  # Increase gamma's weight.
        x0 = sol.x  # Use the previous solution as the next initial guess.

    # Recover the remaining orbital elements and generate the TLE.
    a, e, err_deg = best
    cosE0 = (1 - R0 / a) / e
    E0 = -abs(acos(cosE0))
    M0 = (E0 - e * sin(E0)) % (2 * pi)
    nu0 = true_from_E(E0, e)
    argp = (u0 - nu0) % (2 * pi)

    # Verify both radii and the flight-path angle gamma.
    n = sqrt(MU / a**3)

    def r_at(dt):
        M = (M0 + n * dt) % (2 * pi)
        E = kepler_E_from_M(M, e)
        return a * (1 - e * cos(E))

    r1, r2 = r_at(DT1_MIN * 60), r_at(DT2_MIN * 60)
    cosE120 = (1 - R120 / a) / e
    E120 = -abs(acos(cosE120))
    gamma120 = gamma_from_E(E120, e)

    # Delta-v and angular deviation from a pure retrograde (180-degree) burn.
    i0, raan0, u0_chk = node_u_from_rv(r0, v0)  # u0_chk approximately equals u0.
    r_new, v_new = rv_from_coe(a, e, i0, raan0, argp, E0)
    dv_vec = v_new - v0
    dv_mag = norm(dv_vec)
    angle_off_180 = np.degrees(
        np.arccos(np.clip(np.dot(-v0 / norm(v0), dv_vec / norm(dv_vec)), -1, 1))
    )

    tle1, tle2 = make_tle(i0, raan0, argp, e, a, M0, t0)

    print("=== Solution (fit a, e; gamma strongly weighted to 0.01 degrees) ===")
    print(f"a = {a:.6f} km,  e = {e:.9f}")
    print(f"i = {np.degrees(i0):.6f} deg,  RAAN = {np.degrees(raan0):.6f} deg,  argp = {np.degrees(argp):.6f} deg")
    print(f"M0(epoch) = {np.degrees(M0):.6f} deg  at {BURN_ISO_UTC}")
    print(f"r(t0+{DT1_MIN}min) = {r1:.3f} km (target {RE + H_AT_DT1:.3f})")
    print(f"r(t0+{DT2_MIN}min) = {r2:.3f} km (target {RE + H_AT_DT2:.3f})")
    print(f"gamma@120 km = {np.degrees(gamma120):.6f} deg (target {-GAMMA_DEG_TARGET:.6f} deg)  |delta gamma|={abs(np.degrees(gamma120) + GAMMA_DEG_TARGET):.5f} deg")
    print(f"delta-v = {dv_mag * 1000:.2f} m/s,  deviation from pure retrograde = {angle_off_180:.4f} deg")
    print("\n--- Synthetic Reentry TLE (at deorbit burn) ---")
    print(tle1)
    print(tle2)


if __name__ == "__main__":
    solve_fit_ae_strong_gamma()
