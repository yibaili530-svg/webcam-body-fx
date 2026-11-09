// Source-level contract for the six effect targets in src/style.css. No browser runs here, so this
// reads the stylesheet text (comments removed) instead of computed styles. It fails if a target rule
// would hide the box entirely, or if a state selector would paint something on a target again.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
  selector: selector.trim(),
  body: body.replace(/\s+/g, ' ').trim(),
}));
// Rules that select a target directly. `button:not(.target):hover` styles the bar buttons and is excluded.
const targetRules = rules.filter((r) => /^(\.running )?\.target\b/.test(r.selector));
const base = rules.find((r) => r.selector === '.target');

describe('effect target styles', () => {
  it('keeps the hit region at the same size: width and height from --r', () => {
    expect(base.body).toMatch(/width: calc\(2 \* var\(--r, 40px\)\)/);
    expect(base.body).toMatch(/height: calc\(2 \* var\(--r, 40px\)\)/);
  });

  it('is transparent by opacity, never by display:none or visibility:hidden', () => {
    expect(base.body).toMatch(/opacity: 0;/);
    for (const r of targetRules) {
      expect(r.body, r.selector).not.toMatch(/display:\s*none/);
      expect(r.body, r.selector).not.toMatch(/visibility:\s*hidden/);
    }
  });

  it('paints no background, label colour or ring on the target in any state', () => {
    expect(base.body).toMatch(/background: transparent;/);
    expect(base.body).toMatch(/color: transparent;/);
    const label = rules.find((r) => r.selector === '.target .label');
    expect(label.body).toMatch(/color: transparent;/);
    expect(rules.some((r) => /::before/.test(r.selector) && /\.target/.test(r.selector))).toBe(false);
    expect(css).not.toMatch(/--dwell/);
  });

  it('has no running, current, occupied, disabled or hover state rules left to paint', () => {
    for (const r of targetRules) {
      expect(r.selector, r.selector).not.toMatch(/data-(current|occupied|enabled)/);
      expect(r.selector, r.selector).not.toMatch(/:hover/);
      expect(r.body, r.selector).not.toMatch(/transition:/);
    }
  });

  it('keeps targets clickable and focusable while the camera runs', () => {
    expect(rules.find((r) => r.selector === '.running .target').body).toMatch(/pointer-events: auto;/);
  });

  it('shows keyboard focus as the only visible affordance', () => {
    const focus = rules.find((r) => r.selector === '.target:focus-visible');
    expect(focus.body).toMatch(/opacity: 1;/);
    expect(focus.body).toMatch(/outline: 2px solid/);
  });
});
