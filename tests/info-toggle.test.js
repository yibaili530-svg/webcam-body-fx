// Info bar toggle: pure helpers with fake storage and fake DOM nodes (no jsdom). The CSS and markup
// checks read the source files, because no browser runs here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INFO_KEY, applyInfoHidden, installInfoToggle, readInfoHidden, shouldToggleForKey, writeInfoHidden,
} from '../src/info-toggle.js';
import { TARGETS, TARGET_RADIUS } from '../src/gesture.js';

const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
  };
}

const throwingStorage = {
  getItem() { throw new Error('denied'); },
  setItem() { throw new Error('denied'); },
};

function fakeClassList() {
  const set = new Set();
  return {
    set,
    toggle(name, force) {
      const on = force ?? !set.has(name);
      if (on) set.add(name); else set.delete(name);
      return on;
    },
    contains: (name) => set.has(name),
  };
}

function fakeNode() {
  const attrs = {};
  const listeners = {};
  return {
    attrs,
    listeners,
    classList: fakeClassList(),
    title: '',
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return attrs[k] ?? null; },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
}

const fakeEvent = (over = {}) => ({
  key: 'h', ctrlKey: false, metaKey: false, altKey: false, repeat: false,
  target: { tagName: 'BUTTON' }, preventDefault() { this.prevented = true; }, ...over,
});

describe('readInfoHidden / writeInfoHidden', () => {
  it('reads "1" as hidden and anything else as shown', () => {
    expect(readInfoHidden(memoryStorage({ [INFO_KEY]: '1' }))).toBe(true);
    expect(readInfoHidden(memoryStorage({ [INFO_KEY]: '0' }))).toBe(false);
    expect(readInfoHidden(memoryStorage())).toBe(false);
    expect(readInfoHidden(undefined)).toBe(false);
  });

  it('a throwing storage (private mode) reads as shown and never throws', () => {
    expect(readInfoHidden(throwingStorage)).toBe(false);
  });

  it('writes "1" or "0" under the gateway.infoHidden key and reports success', () => {
    const s = memoryStorage();
    expect(writeInfoHidden(s, true)).toBe(true);
    expect(s.data.get('gateway.infoHidden')).toBe('1');
    expect(writeInfoHidden(s, false)).toBe(true);
    expect(s.data.get('gateway.infoHidden')).toBe('0');
    expect(INFO_KEY).toBe('gateway.infoHidden');
  });

  it('a throwing storage write is swallowed and reported as failure', () => {
    expect(() => writeInfoHidden(throwingStorage, true)).not.toThrow();
    expect(writeInfoHidden(throwingStorage, true)).toBe(false);
    expect(writeInfoHidden(undefined, true)).toBe(true);
  });
});

describe('shouldToggleForKey', () => {
  it('accepts h and H with no modifiers on a non-field target', () => {
    expect(shouldToggleForKey(fakeEvent({ key: 'h' }))).toBe(true);
    expect(shouldToggleForKey(fakeEvent({ key: 'H' }))).toBe(true);
    expect(shouldToggleForKey(fakeEvent({ key: 'h', target: null }))).toBe(true);
  });

  it('rejects other keys and missing events', () => {
    expect(shouldToggleForKey(fakeEvent({ key: 'j' }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ key: 'Enter' }))).toBe(false);
    expect(shouldToggleForKey(null)).toBe(false);
  });

  it('rejects ctrl, meta and alt combinations', () => {
    expect(shouldToggleForKey(fakeEvent({ ctrlKey: true }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ metaKey: true }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ altKey: true }))).toBe(false);
  });

  it('rejects keys typed into input, select, textarea and contenteditable', () => {
    expect(shouldToggleForKey(fakeEvent({ target: { tagName: 'INPUT' } }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ target: { tagName: 'select' } }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ target: { tagName: 'TEXTAREA' } }))).toBe(false);
    expect(shouldToggleForKey(fakeEvent({ target: { tagName: 'DIV', isContentEditable: true } }))).toBe(false);
  });
});

describe('applyInfoHidden', () => {
  it('shows the stage class, aria-pressed, the action label and the title for hidden', () => {
    const stage = fakeNode();
    const button = fakeNode();
    applyInfoHidden({ stage, button }, true);
    expect(stage.classList.contains('info-hidden')).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');
    expect(button.attrs['aria-label']).toBe('显示信息');
    expect(button.title).toBe('显示信息');
  });

  it('clears them when shown', () => {
    const stage = fakeNode();
    const button = fakeNode();
    applyInfoHidden({ stage, button }, true);
    applyInfoHidden({ stage, button }, false);
    expect(stage.classList.contains('info-hidden')).toBe(false);
    expect(button.attrs['aria-pressed']).toBe('false');
    expect(button.attrs['aria-label']).toBe('隐藏信息');
    expect(button.title).toBe('隐藏信息');
  });
});

describe('installInfoToggle', () => {
  function setup(storage = memoryStorage()) {
    const stage = fakeNode();
    const button = fakeNode();
    const target = fakeNode();
    const info = installInfoToggle({ stage, button, target, storage });
    return { stage, button, target, storage, info };
  }

  it('applies the stored preference on install', () => {
    const { stage, button, info } = setup(memoryStorage({ [INFO_KEY]: '1' }));
    expect(info.isHidden()).toBe(true);
    expect(stage.classList.contains('info-hidden')).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');
  });

  it('H toggles the bar, persists the choice and prevents the default', () => {
    const { stage, target, storage, info } = setup();
    const ev = fakeEvent({ key: 'h' });
    target.listeners.keydown(ev);
    expect(info.isHidden()).toBe(true);
    expect(stage.classList.contains('info-hidden')).toBe(true);
    expect(storage.data.get(INFO_KEY)).toBe('1');
    expect(ev.prevented).toBe(true);
    target.listeners.keydown(fakeEvent({ key: 'H' }));
    expect(info.isHidden()).toBe(false);
    expect(storage.data.get(INFO_KEY)).toBe('0');
  });

  it('ignores ignored keys: modifiers, editable targets and key repeat', () => {
    const { target, info } = setup();
    target.listeners.keydown(fakeEvent({ key: 'h', ctrlKey: true }));
    target.listeners.keydown(fakeEvent({ key: 'h', target: { tagName: 'INPUT' } }));
    target.listeners.keydown(fakeEvent({ key: 'h', repeat: true }));
    expect(info.isHidden()).toBe(false);
  });

  it('the ⓘ button click toggles the same state', () => {
    const { button, info } = setup();
    button.listeners.click();
    expect(info.isHidden()).toBe(true);
    expect(button.attrs['aria-pressed']).toBe('true');
    button.listeners.click();
    expect(info.isHidden()).toBe(false);
  });

  it('still toggles when storage throws (the choice just is not kept)', () => {
    const { stage, target, info } = setup(throwingStorage);
    expect(info.isHidden()).toBe(false);
    target.listeners.keydown(fakeEvent({ key: 'h' }));
    expect(info.isHidden()).toBe(true);
    expect(stage.classList.contains('info-hidden')).toBe(true);
  });
});

describe('CSS: hiding is gated on the running state, with the error exception', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({
    selector: selector.trim(),
    body: body.replace(/\s+/g, ' ').trim(),
  }));
  const hiding = rules.filter((r) => r.selector.includes('info-hidden'));

  it('every hiding rule requires the running class as well', () => {
    expect(hiding.length).toBeGreaterThan(0);
    for (const r of hiding) expect(r.selector, r.selector).toMatch(/#stage\.info-hidden\.running/);
  });

  it('the child-hiding rule keeps the toggle and an error status visible', () => {
    const hide = hiding.find((r) => r.selector.includes('> :not'));
    expect(hide).toBeDefined();
    expect(hide.selector).toContain(':not(.info-toggle)');
    expect(hide.selector).toContain(':not(.status[data-kind="error"])');
    expect(hide.body).toMatch(/display: none;/);
  });

  it('the bar gradient is removed while hidden', () => {
    const bar = hiding.find((r) => r.selector.endsWith('.bar'));
    expect(bar.body).toMatch(/background: none;/);
  });

  it('never hides #video or uses visibility to hide', () => {
    for (const r of hiding) {
      expect(r.selector).not.toContain('#video');
      expect(r.body).not.toMatch(/visibility:\s*hidden/);
    }
  });

  it('the toggle is low-opacity and brightens on hover and keyboard focus', () => {
    const base = rules.find((r) => r.selector === '.info-toggle');
    expect(base.body).toMatch(/opacity: 0\.35;/);
    expect(base.body).not.toMatch(/display:\s*none/);
    const focus = rules.find((r) => r.selector.includes(':focus-visible') && r.selector.includes('.info-toggle'));
    expect(focus.selector).toContain(':hover');
    expect(focus.body).toMatch(/opacity: 1;/);
  });

  it('the toggle is fixed in the bottom-right corner', () => {
    const base = rules.find((r) => r.selector === '.info-toggle');
    expect(base.body).toMatch(/position: fixed;/);
    expect(base.body).toMatch(/right: 12px;/);
    expect(base.body).toMatch(/bottom: calc\(12px \+ env\(safe-area-inset-bottom\)\);/);
  });
});

describe('index.html and wiring', () => {
  it('has the #info-toggle button inside the bar, controlling the bar', () => {
    expect(html).toMatch(/<button[^>]*id="info-toggle"[^>]*aria-controls="info-bar"/);
    expect(html).toMatch(/<div class="bar" id="info-bar">[\s\S]*id="info-toggle"/);
    expect(html).toMatch(/id="info-toggle"[^>]*aria-pressed="false"/);
  });

  it('the hint mentions the H key and the toggle, keeping the original text', () => {
    expect(html).toContain('（按 H 或 ⓘ 隐藏/显示信息）');
    expect(html).toContain('右下“取消”恢复画面');
  });

  it('main.js wires the installer to the stage and the toggle', () => {
    expect(mainSrc).toContain("import { installInfoToggle } from './info-toggle.js';");
    expect(mainSrc).toContain("installInfoToggle({ stage, button: document.querySelector('#info-toggle') });");
  });
});

describe('toggle geometry: it never overlaps the 取消 hit circle', () => {
  // Mirrors style.css: the toggle is 28px, 12px from the right and bottom edges. The 取消 target is at
  // (0.92, 0.78) with radius TARGET_RADIUS of the short side (see gesture.js and the --r custom property).
  const cancel = TARGETS.find((t) => t.mode === 'camera');
  const SIZE = 28;
  const OFFSET = 12;
  const overlaps = (w, h) => {
    const cx = cancel.x * w;
    const cy = cancel.y * h;
    const r = TARGET_RADIUS * Math.min(w, h);
    const left = w - OFFSET - SIZE;
    const top = h - OFFSET - SIZE;
    const nx = Math.min(Math.max(cx, left), w - OFFSET);
    const ny = Math.min(Math.max(cy, top), h - OFFSET);
    return Math.hypot(cx - nx, cy - ny) < r;
  };

  it('the 取消 target is the bottom-right one', () => {
    expect(cancel.x).toBeCloseTo(0.92, 9);
    expect(cancel.y).toBeCloseTo(0.78, 9);
  });

  it('no overlap for any viewport whose short side is at least 280px', () => {
    for (let w = 280; w <= 2600; w += 40) {
      for (let h = 280; h <= 1600; h += 40) {
        expect(overlaps(w, h), `${w}x${h}`).toBe(false);
      }
    }
  });
});
