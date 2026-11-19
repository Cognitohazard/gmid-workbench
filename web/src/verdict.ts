// How a verdict looks on screen: one class, one glyph and one map pattern for each verdict, so the
// four verdicts (and a value that was not calculated) are told apart at a glance, also without
// colour. The words themselves come from the core's text module; this file holds no word.
import type { DesignVerdict, HeldVerdict } from '@gmid/mostab-core';

/** A design verdict or a held verdict. */
export type AnyVerdict = DesignVerdict | HeldVerdict;

/** The look of one verdict: its CSS class, the glyph shown before its word, and the fill pattern
 *  of its cell on a map. */
export interface VerdictLook {
  readonly cls: string;
  readonly glyph: string;
  readonly pattern: MapPattern;
}

/** A map cell's fill pattern: plain, dotted, hatched (one diagonal) or cross-hatched. */
export type MapPattern = 'plain' | 'dots' | 'hatch' | 'cross';

/** The four looks. A held verdict shares the look of the design verdict it stands beside:
 *  compliant with feasible, no operating point with infeasible (both are proved). */
export const LOOK: Readonly<Record<AnyVerdict, VerdictLook>> = {
  feasible: { cls: 'v-ok', glyph: '✓', pattern: 'plain' },
  compliant: { cls: 'v-ok', glyph: '✓', pattern: 'plain' },
  'non-compliant': { cls: 'v-fail', glyph: '✗', pattern: 'dots' },
  infeasible: { cls: 'v-proved', glyph: '⊘', pattern: 'cross' },
  'no-operating-point': { cls: 'v-proved', glyph: '⊘', pattern: 'cross' },
  undetermined: { cls: 'v-open', glyph: '?', pattern: 'hatch' },
};

/** The look of a value or a point that was not calculated: no verdict, an em dash, dimmed. */
export const NOT_CALCULATED_LOOK = { cls: 'v-none', glyph: '—' } as const;

/** The look of a verdict, or the not-calculated look where there is none. */
export const lookOf = (v: AnyVerdict | null | undefined): { cls: string; glyph: string } =>
  v ? LOOK[v] : NOT_CALCULATED_LOOK;

/** Draws a map cell's pattern over its fill: `ink` is the pattern's colour. Plain draws nothing.
 *  The spacing is in device pixels, so the pattern stays legible at any cell size. */
export function drawPattern(
  ctx: CanvasRenderingContext2D,
  pattern: MapPattern,
  x: number,
  y: number,
  w: number,
  h: number,
  ink: string,
  step = 6,
): void {
  if (pattern === 'plain') return;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineWidth = 1;
  if (pattern === 'dots') {
    // Anchored to the canvas, not the cell, so neighbouring cells line up into one field.
    const x0 = Math.floor(x / step) * step;
    const y0 = Math.floor(y / step) * step;
    for (let py = y0 + step / 2; py < y + h; py += step)
      for (let px = x0 + step / 2; px < x + w; px += step)
        ctx.fillRect(px - 0.75, py - 0.75, 1.5, 1.5);
  } else {
    const diag = (dir: 1 | -1) => {
      ctx.beginPath();
      // Lines x - dir*y = c, anchored to the canvas.
      const span = w + h;
      const c0 = Math.floor((dir === 1 ? x - y - h : x + y) / step) * step;
      for (let c = c0; c <= c0 + span + step; c += step) {
        if (dir === 1) {
          ctx.moveTo(c + y, y);
          ctx.lineTo(c + y + h, y + h);
        } else {
          ctx.moveTo(c - y, y);
          ctx.lineTo(c - y - h, y + h);
        }
      }
      ctx.stroke();
    };
    diag(1);
    if (pattern === 'cross') diag(-1);
  }
  ctx.restore();
}
