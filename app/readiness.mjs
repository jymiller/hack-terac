const Z = 1.959963984540054;

/** Wilson score interval. Returns [lower, upper]; [0, 0] at n = 0. */
export function wilson(x, n, z = Z) {
  if (n <= 0) return [0, 0];
  const p = x / n;
  const d = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / d;
  const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

/**
 * The licensed agreement rate: the 95% lower bound, not the observed rate. Monotone in
 * evidence, and exactly 0 at n = 0, so an unmeasured process reports zero by construction
 * rather than by discipline.
 */
export const thetaLicensed = (x, n) => wilson(x, n)[0];

/** Judgments are nested in workers and in claims; n is the count of independent claims. */
export function label({ x, n, floor }) {
  if (n === 0) return "UNMEASURED";
  const [lo, hi] = wilson(x, n);
  if (hi < floor) return "RULED OUT";
  if (lo >= floor) return "LICENSED";
  return "NOT YET DISTINGUISHED";
}

/** Claims needed to license a floor, assuming perfect agreement: n = z^2 * f / (1 - f). */
export const nMin = (floor) => Math.ceil((Z * Z * floor) / (1 - floor));
