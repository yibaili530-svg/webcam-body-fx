// Hideable info bar. The bottom bar holds the start and reset buttons, the hint and the status.
// H (or the ⓘ button) hides it, and the choice is kept in localStorage. CSS only hides the bar
// while the camera runs (#stage.info-hidden.running), so Start and permission prompts stay
// reachable whenever the camera is off.

export const INFO_KEY = 'gateway.infoHidden';
const LABEL_HIDE = 'Hide info';
const LABEL_SHOW = 'Show info';

// Storage can be missing or throw (private mode, blocked cookies). A failure reads as "shown" and is not fatal.
export function readInfoHidden(storage) {
  try {
    return storage?.getItem(INFO_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeInfoHidden(storage, hidden) {
  try {
    storage?.setItem(INFO_KEY, hidden ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

function isEditable(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toLowerCase();
  return tag === 'input' || tag === 'select' || tag === 'textarea' || target.isContentEditable === true;
}

// A bare H or h (no ctrl, meta or alt) that is not typed into a form field toggles the bar.
export function shouldToggleForKey(event) {
  if (!event || (event.key !== 'h' && event.key !== 'H')) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  return !isEditable(event.target);
}

// The stage class drives the CSS. aria-pressed is true while hidden. The label names the next action.
export function applyInfoHidden({ stage, button }, hidden) {
  stage.classList.toggle('info-hidden', hidden);
  button.setAttribute('aria-pressed', String(hidden));
  const label = hidden ? LABEL_SHOW : LABEL_HIDE;
  button.setAttribute('aria-label', label);
  button.title = label;
}

function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

// Wires the toggle button and the H key. Returns the state, so callers can read or set it.
export function installInfoToggle({ stage, button, target = globalThis.window, storage = defaultStorage() }) {
  let hidden = readInfoHidden(storage);
  const set = (next) => {
    hidden = next;
    applyInfoHidden({ stage, button }, hidden);
    writeInfoHidden(storage, hidden);
  };
  applyInfoHidden({ stage, button }, hidden);
  button.addEventListener('click', () => set(!hidden));
  target.addEventListener('keydown', (event) => {
    if (event.repeat || !shouldToggleForKey(event)) return;
    event.preventDefault();
    set(!hidden);
  });
  return { isHidden: () => hidden, set };
}
