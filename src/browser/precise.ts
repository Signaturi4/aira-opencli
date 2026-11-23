/**
 * Precise click (AIRA fork).
 *
 * A direct port of the `pclick` protocol into the browser layer:
 *
 *   targets  — where the clickable things are: ref, role, name, box, centre,
 *              and what covers them. One flat list an agent can read top-down.
 *   at       — what is at a CSS-pixel point.
 *   click    — aim, pre-check, ONE trusted CDP click, observe where it really
 *              landed, diff the page before/after, return a verdict.
 *
 * Differences from `page.click()`:
 *   - never falls back to a synthetic `el.click()` through an overlay; a covered
 *     target is refused with the name of what covers it (use `force` on purpose);
 *   - reports the element that actually received the click, not the hope;
 *   - supports `x,y` targets, checked against the element under the point;
 *   - optional `expect` JS decides PASS vs EXPECT_FAILED.
 *
 * All coordinates are CSS pixels in the viewport (screenshot px / devicePixelRatio).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPage } from '../types.js';
import { NativeInputVisibilityError } from './base-page.js';
import { boundingRectResolvedJs, resolveTargetJs, type ResolveOptions } from './target-resolver.js';

export type PreciseVerdict =
  | 'PASS'
  | 'NO_CHANGE'
  | 'EXPECT_FAILED'
  | 'MISSED'
  | 'REFUSED_COVERED'
  | 'REFUSED_NOT_CLICKABLE'
  | 'REFUSED_NOT_VISIBLE'
  | 'NOT_FOUND'
  | 'NO_NATIVE_CLICK';

export interface PreciseTarget {
  ref: number;
  tag: string;
  role: string;
  name: string;
  /** Box in viewport CSS px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Centre in viewport CSS px — the point a click would use. */
  cx: number;
  cy: number;
  in_viewport: boolean;
  /** Present when another element is on top of the centre. */
  covered_by?: string;
  disabled?: boolean;
}

export interface PreciseViewport {
  w: number;
  h: number;
  dpr: number;
  scroll_x: number;
  scroll_y: number;
}

export interface PreciseTargetsResult {
  url: string;
  title: string;
  viewport: PreciseViewport;
  count: number;
  truncated: boolean;
  targets: PreciseTarget[];
  next: string;
}

export interface PreciseAtResult {
  x: number;
  y: number;
  found: boolean;
  element?: string;
  clickable?: string;
  ref?: number;
  role?: string;
  name?: string;
  rect?: { x: number; y: number; w: number; h: number };
  centre?: { x: number; y: number };
  next: string;
}

export interface PreciseClickOptions extends ResolveOptions {
  /** JS expression evaluated in the page after the click; truthy = PASS. */
  expect?: string;
  /** Click even when the pre-check would refuse. */
  force?: boolean;
  /** Free text stored in the log. */
  note?: string;
  /** Milliseconds to wait before reading the page again. Default 350. */
  settleMs?: number;
  /** Session name, only used for the log line. */
  session?: string;
}

export interface PreciseClickResult {
  verdict: PreciseVerdict;
  clicked: boolean;
  target: string;
  point?: { x: number; y: number };
  aimed_at?: string;
  landed_on?: string;
  /** cdp = trusted browser-level click; dom = in-page events + el.click() on a hidden tab (untrusted). */
  click_method?: 'cdp' | 'dom';
  trusted?: boolean;
  hit?: string;
  covered_by?: string;
  changed?: string[];
  expect?: { js: string; ok: boolean; error?: string };
  matches_n?: number;
  message?: string;
  next: string;
}

const LANDING_KEY = '__opencli_precise_landing';

/** Shared page-side helpers, inlined into every snippet. */
const HELPERS_JS = `
  const __clip = (s, n) => { s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
  const __role = (el) => {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button' || t === 'summary') return 'button';
    if (t === 'select') return 'combobox';
    if (t === 'textarea') return 'textbox';
    if (t === 'input') {
      const ty = (el.getAttribute('type') || 'text').toLowerCase();
      if (ty === 'checkbox' || ty === 'radio') return ty;
      if (ty === 'submit' || ty === 'button' || ty === 'reset') return 'button';
      return 'textbox';
    }
    return '';
  };
  const __name = (el) => {
    const g = (a) => (el.getAttribute && el.getAttribute(a)) || '';
    let n = g('aria-label');
    if (!n && g('aria-labelledby')) {
      n = g('aria-labelledby').split(/\\s+/).map((id) => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' ');
    }
    if (!n) n = el.innerText || el.textContent || '';
    if (!__clip(n, 5)) n = g('title') || g('placeholder') || g('alt') || g('value') || g('name') || g('data-tooltip') || '';
    if (!__clip(n, 5)) { const img = el.querySelector && el.querySelector('img[alt],svg[aria-label]'); if (img) n = img.getAttribute('alt') || img.getAttribute('aria-label') || ''; }
    return __clip(n, 80);
  };
  const __desc = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const t = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
    const r = __role(el);
    const n = __name(el);
    return t + id + cls + (r ? ' [' + r + ']' : '') + (n ? ' "' + __clip(n, 40) + '"' : '');
  };
  const __clickable = (el) => {
    let a = el, hops = 0;
    while (a && a.nodeType === 1 && hops < 6) {
      const t = a.tagName.toLowerCase();
      if (['a', 'button', 'input', 'select', 'textarea', 'label', 'summary', 'option'].includes(t)) return a;
      const r = a.getAttribute('role');
      if (r && ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'checkbox', 'radio', 'switch', 'combobox', 'textbox'].includes(r)) return a;
      if (a.hasAttribute('onclick') || a.hasAttribute('jsaction') || a.hasAttribute('data-opencli-ref') || a.isContentEditable) return a;
      try { if (window.getComputedStyle(a).cursor === 'pointer') return a; } catch (e) {}
      a = a.parentElement; hops++;
    }
    return null;
  };
`;

/** JS that lists every `data-opencli-ref` element with its box and cover state. */
export function listTargetsJs(opts: { max?: number; all?: boolean } = {}): string {
  const max = Math.max(1, Math.min(opts.max ?? 150, 1000));
  const all = opts.all === true;
  return `
    (() => {
      ${HELPERS_JS}
      const vw = window.innerWidth, vh = window.innerHeight;
      const out = [];
      let total = 0;
      for (const el of document.querySelectorAll('[data-opencli-ref]')) {
        const ref = Number(el.getAttribute('data-opencli-ref'));
        if (!Number.isFinite(ref)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;
        const inView = r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
        if (!inView && !${all}) continue;
        total++;
        if (out.length >= ${max}) continue;
        const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
        const item = {
          ref, tag: el.tagName.toLowerCase(), role: __role(el), name: __name(el),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
          cx, cy, in_viewport: inView,
        };
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') item.disabled = true;
        if (inView && cx >= 0 && cy >= 0 && cx < vw && cy < vh) {
          const top = document.elementFromPoint(cx, cy);
          if (top && top !== el && !el.contains(top) && !top.contains(el)) item.covered_by = __desc(top);
        }
        out.push(item);
      }
      out.sort((a, b) => (a.y - b.y) || (a.x - b.x));
      return {
        url: location.href, title: document.title,
        viewport: { w: vw, h: vh, dpr: window.devicePixelRatio || 1, scroll_x: Math.round(window.scrollX), scroll_y: Math.round(window.scrollY) },
        count: total, truncated: total > out.length, targets: out,
      };
    })()
  `;
}

/** JS that describes the element (and its clickable owner) at a viewport point. */
export function elementAtJs(x: number, y: number, opts: { mark?: boolean } = {}): string {
  return `
    (() => {
      ${HELPERS_JS}
      const x = ${Number(x)}, y = ${Number(y)};
      const el = document.elementFromPoint(x, y);
      if (!el) return { x, y, found: false };
      const c = __clickable(el);
      const box = (c || el).getBoundingClientRect();
      const refAttr = (c || el).getAttribute('data-opencli-ref');
      if (${opts.mark === true}) window.__resolved = c || el;
      return {
        x, y, found: true,
        element: __desc(el),
        ...(c ? { clickable: __desc(c), role: __role(c), name: __name(c) } : {}),
        ...(refAttr != null && Number.isFinite(Number(refAttr)) ? { ref: Number(refAttr) } : {}),
        rect: { x: Math.round(box.left), y: Math.round(box.top), w: Math.round(box.width), h: Math.round(box.height) },
        centre: { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) },
      };
    })()
  `;
}

/** JS that snapshots what a click could change, and arms the landing probe. */
function fingerprintJs(arm: boolean): string {
  return `
    (() => {
      ${HELPERS_JS}
      const el = window.__resolved;
      const g = (a) => (el && el.getAttribute ? el.getAttribute(a) : null);
      const text = (document.body && document.body.innerText) || '';
      let hash = 5381;
      for (let i = 0; i < Math.min(text.length, 40000); i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
      const state = {
        url: location.href,
        title: document.title,
        focus: __desc(document.activeElement),
        nodes: document.getElementsByTagName('*').length,
        text: text.length + ':' + hash,
        dialogs: document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]').length,
        scroll: Math.round(window.scrollX) + ',' + Math.round(window.scrollY),
        target: el && el.isConnected
          ? [g('aria-expanded'), g('aria-pressed'), g('aria-checked'), g('aria-selected'), el.checked === true, el.value == null ? '' : String(el.value).slice(0, 60), typeof el.className === 'string' ? el.className : '', el.disabled === true].join('|')
          : 'gone',
      };
      if (${arm}) {
        window[${JSON.stringify(LANDING_KEY)}] = null;
        const handler = (e) => {
          const t = e.target;
          const aim = window.__resolved;
          window[${JSON.stringify(LANDING_KEY)}] = {
            x: Math.round(e.clientX), y: Math.round(e.clientY), trusted: e.isTrusted === true,
            on: __desc(t),
            on_target: !!(aim && t && (t === aim || (aim.contains && aim.contains(t)) || (t.contains && t.contains(aim)) || (e.composedPath && e.composedPath().includes(aim)))),
          };
        };
        window.addEventListener('pointerdown', handler, { capture: true, once: true });
      } else {
        state.landing = window[${JSON.stringify(LANDING_KEY)}] || null;
        try { delete window[${JSON.stringify(LANDING_KEY)}]; } catch (e) {}
      }
      return state;
    })()
  `;
}

type Fingerprint = Record<string, string | number> & {
  landing?: { x: number; y: number; trusted: boolean; on: string; on_target: boolean } | null;
};

const CHANGE_LABELS: Record<string, string> = {
  url: 'url',
  title: 'title',
  focus: 'focus',
  nodes: 'dom',
  text: 'text',
  dialogs: 'dialog/menu',
  scroll: 'scroll',
  target: 'target state',
};

export function diffFingerprints(before: Fingerprint, after: Fingerprint): string[] {
  const changed: string[] = [];
  for (const key of Object.keys(CHANGE_LABELS)) {
    if (String(before[key]) !== String(after[key])) changed.push(CHANGE_LABELS[key]);
  }
  return changed;
}

export function parsePoint(target: string): { x: number; y: number } | null {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(target);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null;
}

function logPath(): string | null {
  const raw = process.env.OPENCLI_PRECISE_LOG;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  return raw || path.join(os.homedir(), '.opencli', 'precise-click', 'log.jsonl');
}

function writeLog(entry: Record<string, unknown>): void {
  const file = logPath();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // The log is a convenience; a read-only home must not fail the click.
  }
}

const NEXT: Record<PreciseVerdict, string> = {
  PASS: 'Click landed on the target and the page reacted. Continue.',
  NO_CHANGE: 'Click landed on the target but nothing observable changed. Look at the page (state or screenshot) before clicking again; do not repeat blindly.',
  EXPECT_FAILED: 'Click landed but the expect check is false. Inspect the page; the control may need another step (hover, focus, wait).',
  MISSED: 'The click was received by another element (see landed_on). Re-run targets, close what is in the way, then re-aim.',
  REFUSED_COVERED: 'Nothing was clicked: the target is covered (see covered_by). Close or scroll past the overlay, or pass force on purpose.',
  REFUSED_NOT_CLICKABLE: 'Nothing was clicked: there is no clickable element at that point. Run targets and click a ref instead.',
  REFUSED_NOT_VISIBLE: 'Nothing was clicked: the target has no visible box. Open the menu/section that contains it first.',
  NOT_FOUND: 'Nothing was clicked: the target did not resolve. Run targets to get fresh refs.',
  NO_NATIVE_CLICK: 'This backend cannot send a trusted click. Use browser click instead.',
};

function finish(result: Omit<PreciseClickResult, 'next'>, opts: PreciseClickOptions): PreciseClickResult {
  const full: PreciseClickResult = { ...result, next: NEXT[result.verdict] };
  writeLog({
    session: opts.session,
    verdict: full.verdict,
    target: full.target,
    point: full.point,
    aimed_at: full.aimed_at,
    landed_on: full.landed_on,
    covered_by: full.covered_by,
    changed: full.changed,
    expect: full.expect,
    note: opts.note,
  });
  return full;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Refresh refs and return the clickable map of the current viewport. */
export async function preciseTargets(page: IPage, opts: { max?: number; all?: boolean } = {}): Promise<PreciseTargetsResult> {
  await page.snapshot({ source: 'dom', viewportExpand: opts.all ? undefined : 0 } as Parameters<IPage['snapshot']>[0]);
  const raw = await page.evaluate(listTargetsJs(opts)) as Omit<PreciseTargetsResult, 'next'>;
  return {
    ...raw,
    next: raw.targets.length === 0
      ? 'No clickable elements found in the viewport. Scroll, wait for the page, or open the page first.'
      : 'Click with: browser <session> pclick <ref>. Targets with covered_by cannot be clicked until that element is closed.',
  };
}

/** Describe what is at a viewport point (CSS px). */
export async function preciseAt(page: IPage, x: number, y: number): Promise<PreciseAtResult> {
  const raw = await page.evaluate(elementAtJs(x, y)) as Omit<PreciseAtResult, 'next'>;
  return {
    ...raw,
    next: !raw.found
      ? 'The point is outside the viewport or over nothing.'
      : raw.clickable
        ? (raw.ref != null ? `Clickable. Click with: pclick ${raw.ref}` : `Clickable. Click with: pclick ${x},${y}`)
        : 'Not clickable here. Run targets to find the control.',
  };
}

/** Page-side: an untrusted click at a point, for hidden tabs where trusted input cannot be delivered. */
export function domClickJs(x: number, y: number): string {
  return `
    (() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return { ok: false };
      const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: ${x}, clientY: ${y}, button: 0, buttons: 1 };
      const ptr = { ...init, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      el.dispatchEvent(new PointerEvent('pointerover', ptr));
      el.dispatchEvent(new MouseEvent('mouseover', init));
      el.dispatchEvent(new PointerEvent('pointerdown', ptr));
      el.dispatchEvent(new MouseEvent('mousedown', init));
      const focusable = el.closest('a,button,input,textarea,select,[tabindex],[contenteditable]');
      if (focusable && focusable.focus) focusable.focus();
      el.dispatchEvent(new PointerEvent('pointerup', { ...ptr, buttons: 0 }));
      el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
      el.click();
      return { ok: true };
    })()
  `;
}

/** Aim, pre-check, one trusted click, verify. Never throws for a refusal. */
export async function preciseClick(page: IPage, target: string, opts: PreciseClickOptions = {}): Promise<PreciseClickResult> {
  const force = opts.force === true;
  if (typeof page.nativeClick !== 'function') {
    return finish({ verdict: 'NO_NATIVE_CLICK', clicked: false, target }, opts);
  }

  let point: { x: number; y: number };
  let aimedAt: string | undefined;
  let hit: string | undefined;
  let matchesN: number | undefined;

  const xy = parsePoint(target);
  if (xy) {
    const at = await page.evaluate(elementAtJs(xy.x, xy.y, { mark: true })) as Omit<PreciseAtResult, 'next'>;
    if (!at.found) {
      return finish({ verdict: 'REFUSED_NOT_CLICKABLE', clicked: false, target, point: xy, message: 'Point is outside the viewport.' }, opts);
    }
    if (!at.clickable && !force) {
      return finish({ verdict: 'REFUSED_NOT_CLICKABLE', clicked: false, target, point: xy, aimed_at: at.element }, opts);
    }
    point = xy;
    aimedAt = at.clickable ?? at.element;
    hit = 'target';
  } else {
    const resolution = await page.evaluate(resolveTargetJs(target, opts)) as
      | { ok: true; matches_n: number }
      | { ok: false; message: string; hint?: string; matches_n?: number };
    if (!resolution.ok) {
      return finish({
        verdict: 'NOT_FOUND', clicked: false, target, matches_n: resolution.matches_n,
        message: [resolution.message, resolution.hint].filter(Boolean).join(' '),
      }, opts);
    }
    matchesN = resolution.matches_n;
    const rect = await page.evaluate(boundingRectResolvedJs({ forClick: true })) as
      { x: number; y: number; w: number; h: number; visible: boolean; hit?: string } | null;
    const here = rect
      ? await page.evaluate(elementAtJs(rect.x, rect.y)) as Omit<PreciseAtResult, 'next'>
      : null;
    aimedAt = await page.evaluate(`(() => { ${HELPERS_JS} return __desc(window.__resolved); })()`) as string;
    if (!rect || !rect.visible) {
      return finish({ verdict: 'REFUSED_NOT_VISIBLE', clicked: false, target, aimed_at: aimedAt, matches_n: matchesN }, opts);
    }
    point = { x: Math.round(rect.x), y: Math.round(rect.y) };
    hit = rect.hit;
    if (hit !== 'target' && hit !== 'ancestor' && !force) {
      return finish({
        verdict: 'REFUSED_COVERED', clicked: false, target, point, aimed_at: aimedAt, hit,
        covered_by: here?.element ?? 'nothing (off-screen)', matches_n: matchesN,
      }, opts);
    }
  }

  const before = await page.evaluate(fingerprintJs(true)) as Fingerprint;
  let clickMethod: 'cdp' | 'dom' = 'cdp';
  try {
    await page.nativeClick(point.x, point.y);
  } catch (err) {
    if (!(err instanceof NativeInputVisibilityError) && !/Native input requires a visible/i.test(String((err as Error)?.message))) throw err;
    // Hidden tab and no way to deliver trusted input: click inside the page instead.
    const done = await page.evaluate(domClickJs(point.x, point.y)) as { ok: boolean } | undefined;
    if (!done?.ok) throw err;
    clickMethod = 'dom';
  }
  await sleep(Math.max(0, opts.settleMs ?? 350));

  let after: Fingerprint;
  try {
    after = await page.evaluate(fingerprintJs(false)) as Fingerprint;
  } catch {
    // The document was replaced mid-read: that is a navigation, i.e. a change.
    await sleep(400);
    after = await page.evaluate(fingerprintJs(false)) as Fingerprint;
  }
  const changed = diffFingerprints(before, after);
  const navigated = changed.includes('url');
  const landing = after.landing ?? null;

  let expect: PreciseClickResult['expect'];
  if (opts.expect) {
    try {
      const ok = await page.evaluate(`(() => { try { return !!(${opts.expect}); } catch (e) { return { __error: String(e && e.message || e) }; } })()`) as
        boolean | { __error: string };
      expect = typeof ok === 'object' ? { js: opts.expect, ok: false, error: ok.__error } : { js: opts.expect, ok };
    } catch (err) {
      expect = { js: opts.expect, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  const base = {
    clicked: true, click_method: clickMethod, trusted: clickMethod === 'cdp', target, point, aimed_at: aimedAt, hit, changed, matches_n: matchesN,
    ...(landing ? { landed_on: landing.on } : {}),
    ...(expect ? { expect } : {}),
  };

  // A navigation wipes the probe; the url change itself proves the click worked.
  if (!navigated && (!landing || !landing.on_target)) {
    return finish({
      ...base, verdict: 'MISSED',
      message: landing ? 'Another element received the click.' : 'No pointer event was observed on the page.',
    }, opts);
  }
  if (expect) return finish({ ...base, verdict: expect.ok ? 'PASS' : 'EXPECT_FAILED' }, opts);
  return finish({ ...base, verdict: changed.length > 0 ? 'PASS' : 'NO_CHANGE' }, opts);
}

/** Read the last n lines of the precise-click log. */
export function readPreciseLog(n = 20): unknown[] {
  const file = logPath();
  if (!file || !fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
  return lines.slice(-Math.max(1, n)).map((line) => {
    try { return JSON.parse(line) as unknown; } catch { return { raw: line }; }
  });
}
