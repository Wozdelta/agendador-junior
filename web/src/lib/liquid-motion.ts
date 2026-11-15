export interface SpringState {
  position: number;
  velocity: number;
}
export const LEADING = { omega: 19, zeta: 0.55 };
export const TRAILING = { omega: 11, zeta: 0.72 };
export function spring(
  from: SpringState,
  target: number,
  seconds: number,
  omega: number,
  zeta: number,
): SpringState {
  if (seconds <= 0) return from;
  const d = zeta * omega,
    wd = omega * Math.sqrt(1 - zeta * zeta);
  const a = from.position - target,
    b = (from.velocity + d * a) / wd;
  const e = Math.exp(-d * seconds),
    c = Math.cos(wd * seconds),
    s = Math.sin(wd * seconds);
  return {
    position: target + e * (a * c + b * s),
    velocity: e * (-d * (a * c + b * s) - a * wd * s + b * wd * c),
  };
}
export function tabGeometry(width: number, index: number, count = 4) {
  const step = width / count,
    margin = Math.max(4, 6 * Math.min(1, width / 410));
  const pill = Math.min(step - margin * 2, (86 * width) / 410),
    center = step * (index + 0.5);
  return { left: center - pill / 2, right: center + pill / 2, center, margin, step };
}
export function clampPill(width: number, left: number, right: number) {
  const { margin } = tabGeometry(width, 0);
  left = Math.max(margin, Math.min(width - margin - 8, left));
  right = Math.min(width - margin, Math.max(left + 8, right));
  return { left, right };
}
export const LOOP_ORDER = [3, 1, 2, 0];
/** Sample prior cycles too: frame zero retains the previous tap's spring tail. */
export function loopGeometry(seconds: number, width: number) {
  const phase = ((seconds % 4) + 4) % 4;
  let left: SpringState = { position: tabGeometry(width, 0).left, velocity: 0 };
  let right: SpringState = { position: tabGeometry(width, 0).right, velocity: 0 };
  let last = 0;
  for (let event = -24; event <= Math.floor(phase); event++) {
    const index = LOOP_ORDER[((event % 4) + 4) % 4],
      target = tabGeometry(width, index);
    const direction = index > last ? 1 : -1,
      a = direction > 0 ? TRAILING : LEADING,
      b = direction > 0 ? LEADING : TRAILING;
    const t = Math.min(1, phase - event);
    left = spring(left, target.left, t, a.omega, a.zeta);
    right = spring(right, target.right, t, b.omega, b.zeta);
    last = index;
  }
  return { ...clampPill(width, left.position, right.position), index: last, phase };
}
export function loopTouch(seconds: number) {
  const phase = ((seconds % 4) + 4) % 4;
  for (let event = -1; event <= 4; event++) {
    const age = phase - event;
    if (age < -0.42 || age > 0.4) continue;
    const ease = (t: number) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;
    const scale =
      age < -0.1
        ? 1.25 - 0.25 * ease((age + 0.42) / 0.32)
        : age < 0
          ? 1 - (0.2 * (age + 0.1)) / 0.1
          : 0.8 + 0.2 * ease(age / 0.2);
    const opacity =
      age < -0.24 ? (age + 0.42) / 0.18 : age <= 0.12 ? 1 : Math.max(0, 1 - (age - 0.12) / 0.25);
    return {
      index: LOOP_ORDER[((event % 4) + 4) % 4],
      scale,
      opacity,
      ringScale: 1 + ((29 / 23) * Math.max(0, age)) / 0.4,
      ringOpacity: age >= 0 ? 0.7 * (1 - age / 0.4) : 0,
    };
  }
  return null;
}
