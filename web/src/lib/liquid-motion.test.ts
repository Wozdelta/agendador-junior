import { describe, expect, it } from 'vitest';
import {
  clampPill,
  LEADING,
  TRAILING,
  loopGeometry,
  loopTouch,
  spring,
  tabGeometry,
} from './liquid-motion';

describe('motor Liquid Stretch compartilhado', () => {
  it('corresponde à resposta analítica especificada para uma mola inicialmente parada', () => {
    for (const { omega, zeta } of [LEADING, TRAILING])
      for (const t of [0, 0.05, 0.15, 0.3, 0.8]) {
        const wd = omega * Math.sqrt(1 - zeta ** 2);
        const x =
          1 -
          Math.exp(-zeta * omega * t) *
            (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
        expect(spring({ position: 0, velocity: 0 }, 1, t, omega, zeta).position).toBeCloseTo(x, 10);
      }
  });
  it('usa 86 px de repouso e centros corretos na barra de 410 px', () => {
    const first = tabGeometry(410, 0),
      last = tabGeometry(410, 3);
    expect(first.right - first.left).toBe(86);
    expect(first.center).toBe(51.25);
    expect(last.center).toBe(358.75);
  });
  it('estica no salto de três abas e mantém largura positiva nos extremos responsivos', () => {
    expect(loopGeometry(0.15, 410).right - loopGeometry(0.15, 410).left).toBeGreaterThan(130);
    for (const width of [280, 300, 320, 390, 410, 500, 540]) {
      for (let frame = 0; frame < 12 * 120; frame++) {
        const p = loopGeometry(frame / 120, width),
          margin = tabGeometry(width, 0).margin;
        expect(p.left).toBeGreaterThanOrEqual(margin);
        expect(p.right).toBeLessThanOrEqual(width - margin);
        expect(p.right - p.left).toBeGreaterThanOrEqual(8);
      }
    }
  });
  it('preserva posição e velocidade ao inverter o alvo durante o movimento', () => {
    const current = spring({ position: 0, velocity: 0 }, 300, 0.1, LEADING.omega, LEADING.zeta);
    const retargeted = spring(current, 0, 0, TRAILING.omega, TRAILING.zeta);
    expect(retargeted).toEqual(current);
    const next = spring(current, 0, 0.00001, TRAILING.omega, TRAILING.zeta);
    expect(Math.abs(next.position - current.position)).toBeLessThan(0.1);
    expect(clampPill(300, 500, -300).right - clampPill(300, 500, -300).left).toBeGreaterThan(0);
  });
  it('mantém continuidade na virada e repete a geometria por mais de dois ciclos', () => {
    const atZero = loopGeometry(0, 410),
      beforeZero = loopGeometry(4 - 0.000001, 410);
    expect(atZero.left).toBeCloseTo(beforeZero.left, 3);
    expect(atZero.right).toBeCloseTo(beforeZero.right, 3);
    for (const t of [0.05, 0.8, 1.2, 2.3, 3.85]) {
      expect(loopGeometry(t + 4, 410).left).toBeCloseTo(loopGeometry(t, 410).left, 8);
      expect(loopGeometry(t + 8, 410).right).toBeCloseTo(loopGeometry(t, 410).right, 8);
    }
  });
  it('ancora o toque nas abas 4, 2, 3 e 1 e antecipa o ciclo seguinte', () => {
    expect([0, 1, 2, 3].map((t) => loopTouch(t)?.index)).toEqual([3, 1, 2, 0]);
    expect(loopTouch(3.8)?.index).toBe(3);
    expect(loopTouch(0)?.scale).toBeCloseTo(0.8);
    expect(loopTouch(0.2)?.scale).toBeCloseTo(1);
    expect(loopTouch(0.38)?.opacity).toBe(0);
    expect(loopTouch(0.15)?.ringScale).toBeGreaterThan(1);
    expect(loopTouch(0.5)).toBeNull();
  });
});
