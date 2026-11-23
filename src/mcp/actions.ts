/**
 * The `act` verbs behind the MCP server.
 *
 * Contract for every verb: do ONE thing, never block longer than the budget,
 * and answer with a result line followed by the screen (what can be clicked
 * next). The caller never needs a second call just to read the page.
 *
 *   OK click 9 -> PASS, page changed (dialog/menu) 412ms
 *   PAGE … | …
 *   OPTIONS n
 *   <ref> <role> "<name>"
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPage } from '../types.js';
import { preciseClick, preciseTargets, type PreciseTargetsResult } from '../browser/precise.js';
import { describeUpload, smartUpload, type SmartUploadResult } from '../browser/upload.js';
import { renderScreen } from './screen.js';
import { describeEach, runEach } from '../browser/each.js';
import { hintFor, PLAYBOOK, readLog } from './troubleshoot.js';

export const VERBS = ['open', 'look', 'click', 'type', 'key', 'upload', 'wait', 'scroll', 'read', 'images', 'save', 'shot', 'each', 'queue', 'done', 'help', 'debug'] as const;
export type Verb = typeof VERBS[number];

export interface ActInput {
  do: Verb;
  session?: string;
  /** click/type/upload/read/save: ref number, CSS selector, or "x,y". */
  target?: string | number;
  url?: string;
  text?: string;
  /** type: press Enter after typing. */
  submit?: boolean;
  key?: string;
  files?: string[];
  /** wait: text that must appear / disappear, or a CSS selector that must match. */
  until?: string;
  gone?: string;
  selector?: string;
  /** wait: maximum seconds (default 30, cap 300). */
  seconds?: number;
  direction?: 'up' | 'down';
  /** look: filter options by text. */
  find?: string;
  /** save/shot: output file path. */
  path?: string;
  /** upload: allow a real clipboard paste (replaces the system clipboard). */
  clipboard?: boolean;
  /** upload: convert images first. */
  convert?: 'png' | 'jpeg';
  /** upload: downscale images to this longest side in px. */
  max_px?: number;
  /** click: JS that must be truthy afterwards. */
  expect?: string;
  force?: boolean;
  /** Maximum option lines in the answer (default 40). */
  max?: number;
  /** "task": keep the foreground lease across calls until do=done (or 2 min without a call). */
  lease?: 'task';
  /** each: stop after this many items. */
  limit?: number;
  /** each: minimum milliseconds between two items (default 300). */
  min_interval_ms?: number;
  /** each: seconds this call may run (default 100); continue with resume=true. */
  time_budget?: number;
  /** each: continue the previous run instead of starting over. */
  resume?: boolean;
  /** each: file for the full data (JSON lines). */
  save?: string;
  /** each: ignore the cached recipe and discover the list again. */
  rediscover?: boolean;
  /** each: "list" only reports the rows (name, date, snippet) and opens nothing; default opens each item. */
  mode?: 'open' | 'list';
  /** look: skip this many options (paging). */
  offset?: number;
}

export interface ActPlan {
  steps: ActInput[];
  session?: string;
  max?: number;
}

export interface ActOutput {
  ok: boolean;
  text: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function fail(message: string, next?: string): ActOutput {
  return { ok: false, text: `ERR ${message}\nNEXT ${next ?? hintFor(message)}` };
}

/** Validate raw tool arguments. Returns an error string or the typed input. */
export function parseActInput(raw: unknown): ActInput | ActPlan | string {
  if (!raw || typeof raw !== 'object') return 'arguments must be an object';
  const a = raw as Record<string, unknown>;
  if (a.steps !== undefined) {
    if (!Array.isArray(a.steps) || a.steps.length === 0 || a.steps.length > 20) return 'steps must be an array of 1 to 20 actions';
    if (a.session !== undefined && typeof a.session !== 'string') return 'session must be a string';
    const steps: ActInput[] = [];
    for (let i = 0; i < a.steps.length; i++) {
      const one = parseActInput(a.steps[i]);
      if (typeof one === 'string') return `steps[${i}]: ${one}`;
      if ('steps' in one) return `steps[${i}]: steps cannot be nested`;
      steps.push(one);
    }
    return { steps, session: a.session as string | undefined, max: typeof a.max === 'number' ? a.max : undefined };
  }
  if (typeof a.do !== 'string' || !(VERBS as readonly string[]).includes(a.do)) return `do must be one of: ${VERBS.join(', ')}`;
  const str = (k: string) => (a[k] === undefined || typeof a[k] === 'string' ? null : `${k} must be a string`);
  for (const k of ['session', 'url', 'text', 'key', 'until', 'gone', 'selector', 'find', 'path', 'expect']) {
    const e = str(k);
    if (e) return e;
  }
  if (a.target !== undefined && typeof a.target !== 'string' && typeof a.target !== 'number') return 'target must be a ref number, a CSS selector or "x,y"';
  if (a.files !== undefined && !(Array.isArray(a.files) && a.files.every((f) => typeof f === 'string'))) return 'files must be an array of file paths';
  if (a.seconds !== undefined && !(typeof a.seconds === 'number' && a.seconds >= 0)) return 'seconds must be a number >= 0';
  if (a.max !== undefined && !(typeof a.max === 'number' && a.max >= 1)) return 'max must be a number >= 1';
  if (a.direction !== undefined && a.direction !== 'up' && a.direction !== 'down') return 'direction must be up or down';
  if (a.convert !== undefined && a.convert !== 'png' && a.convert !== 'jpeg') return 'convert must be png or jpeg';
  if (a.max_px !== undefined && !(typeof a.max_px === 'number' && a.max_px >= 16)) return 'max_px must be a number >= 16';
  if (a.lease !== undefined && a.lease !== 'task') return 'lease must be "task"';
  if (a.mode !== undefined && a.mode !== 'open' && a.mode !== 'list') return 'mode must be open or list';
  if (a.offset !== undefined && !(typeof a.offset === 'number' && a.offset >= 0)) return 'offset must be a number >= 0';
  for (const k of ['limit', 'min_interval_ms', 'time_budget']) {
    if (a[k] !== undefined && !(typeof a[k] === 'number' && (a[k] as number) >= 0)) return `${k} must be a number >= 0`;
  }
  if (a.save !== undefined && a.do === 'each' && typeof a.save !== 'string') return 'save must be a file path';
  const need = (k: string) => (a[k] === undefined || a[k] === '' ? `do=${String(a.do)} needs ${k}` : null);
  const required: Record<string, string[]> = {
    open: ['url'], click: ['target'], type: ['target', 'text'], key: ['key'], upload: ['files'], save: ['target'],
  };
  for (const k of required[a.do] ?? []) {
    const e = need(k);
    if (e) return e;
  }
  if (a.do === 'wait' && a.until === undefined && a.gone === undefined && a.selector === undefined && a.seconds === undefined) {
    return 'do=wait needs one of: until, gone, selector, seconds';
  }
  return a as unknown as ActInput;
}

async function screen(page: IPage, input: ActInput): Promise<string> {
  // find looks at every clickable element of the page, also those scrolled out of view.
  const find = input.do === 'each' || input.do === 'wait' ? undefined : input.find;
  const map = await preciseTargets(page, { max: 1000, all: !!find });
  return renderScreen(map, { max: input.max, find, offset: input.do === 'look' ? input.offset : undefined });
}

/** Poll until the page has clickable elements and the count stopped changing, or the budget ends. */
async function settle(page: IPage, budgetMs: number): Promise<{ map: PreciseTargetsResult | null; loading: boolean }> {
  const end = Date.now() + budgetMs;
  let last = -1;
  let map: PreciseTargetsResult | null = null;
  while (Date.now() < end) {
    try {
      map = await preciseTargets(page, {});
      if (map.count > 0 && map.count === last) return { map, loading: false };
      last = map.count;
    } catch {
      // The document is still being replaced; try again within the budget.
    }
    await sleep(250);
  }
  return { map, loading: true };
}

const IMAGES_JS = `
  (() => Array.from(document.images)
    .map((img, i) => ({ i, src: img.currentSrc || img.src, w: img.naturalWidth, h: img.naturalHeight, alt: (img.alt || '').slice(0, 60), r: img.getBoundingClientRect() }))
    .filter((x) => x.w >= 256 && x.h >= 256 && x.src)
    .map((x) => ({ i: x.i, src: x.src, w: x.w, h: x.h, alt: x.alt, visible: x.r.bottom > 0 && x.r.top < window.innerHeight })))()
`;

function fetchImageJs(index: number): string {
  return `
    (async () => {
      const img = document.images[${index}];
      if (!img) return { error: 'no image with that index' };
      const src = img.currentSrc || img.src;
      try {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        const data = await new Promise((resolve, reject) => { const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = () => reject(fr.error); fr.readAsDataURL(blob); });
        return { data, type: blob.type, src };
      } catch (e) {
        try {
          const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext('2d').drawImage(img, 0, 0);
          return { data: c.toDataURL('image/png'), type: 'image/png', src };
        } catch (e2) { return { error: String(e && e.message || e), src }; }
      }
    })()
  `;
}

function waitConditionJs(input: ActInput): string {
  return `
    (() => {
      const text = (document.body && document.body.innerText) || '';
      const until = ${JSON.stringify(input.until ?? null)}, gone = ${JSON.stringify(input.gone ?? null)}, selector = ${JSON.stringify(input.selector ?? null)};
      if (until !== null && !text.includes(until)) return false;
      if (gone !== null && text.includes(gone)) return false;
      if (selector !== null) { try { if (!document.querySelector(selector)) return false; } catch (e) { return false; } }
      return true;
    })()
  `;
}

/** Scroll the target's scrollable region, or the region in the middle of the window when the page itself cannot scroll. */
/** Page-side: mark the region (list, pane) whose aria-label or title matches, return a selector for it. */
function regionByLabelJs(label: string): string {
  return `
    (() => {
      const want = ${JSON.stringify(label.replace(/^[a-z]+:/i, '').trim().toLowerCase())};
      const name = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).trim().toLowerCase();
      const all = Array.from(document.querySelectorAll('[aria-label],[title]')).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 40 && r.height > 40; });
      const hit = all.find((el) => name(el) === want) || all.find((el) => name(el).includes(want));
      if (!hit) return null;
      for (const el of document.querySelectorAll('[data-aira-region]')) el.removeAttribute('data-aira-region');
      hit.setAttribute('data-aira-region', '1');
      return '[data-aira-region="1"]';
    })()
  `;
}

function scrollJs(target: string | undefined, dir: 'up' | 'down'): string {
  return `
    (() => {
      const t = ${JSON.stringify(target ?? null)}, sign = ${dir === 'up' ? -1 : 1};
      const can = (el) => {
        if (!el || el === document.body || el === document.documentElement) return false;
        let oy = ''; try { oy = getComputedStyle(el).overflowY; } catch (e) {}
        return (oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight + 20;
      };
      const up = (el) => { for (let a = el; a; a = a.parentElement) if (can(a)) return a; return null; };
      const doc = document.scrollingElement || document.documentElement;
      const pageCan = doc.scrollHeight > window.innerHeight + 20;
      let el = null, why = '';
      if (t !== null) {
        let start = null;
        const xy = /^(\\d+)\\s*,\\s*(\\d+)$/.exec(t);
        if (xy) start = document.elementFromPoint(Number(xy[1]), Number(xy[2]));
        else if (/^\\d+$/.test(t)) start = document.querySelector('[data-opencli-ref="' + t + '"]');
        else { try { start = document.querySelector(t); } catch (e) {} }
        if (!start) return { error: 'target not found: ' + t };
        el = up(start);
        if (!el && !pageCan) return { error: 'nothing around target ' + t + ' can scroll' };
        why = el ? 'region of the target' : 'target is not in a scrollable region, so the page scrolled';
      } else if (!pageCan) {
        el = up(document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2));
        why = 'the page itself cannot scroll, so the region in the middle of the window was scrolled';
        if (!el) {
          let best = 0;
          for (const c of document.querySelectorAll('*')) { if (!can(c)) continue; const r = c.getBoundingClientRect(); const a = r.width * r.height; if (a > best) { best = a; el = c; } }
          why = 'the page itself cannot scroll, so its largest scrollable region was scrolled';
        }
        if (!el) return { error: 'nothing on this page can scroll' };
      }
      const rows = (root) => { let n = 0; for (const r of root.querySelectorAll('li,[role="listitem"],[role="row"],[role="option"],article')) { const b = r.getBoundingClientRect(); if (b.height > 8 && (r.textContent || '').trim().length > 1) n++; } return n; };
      const label = (e) => e.tagName.toLowerCase() + (e.getAttribute('aria-label') ? ' "' + e.getAttribute('aria-label').slice(0, 40) + '"' : e.getAttribute('role') ? ' [' + e.getAttribute('role') + ']' : e.id ? '#' + e.id : '');
      const node = el || doc;
      const before = node.scrollTop, n0 = rows(el || document.body);
      const step = Math.round((el ? el.clientHeight : window.innerHeight) * 0.85) * sign;
      if (el) { el.scrollTop = before + step; el.dispatchEvent(new Event('scroll', { bubbles: true })); } else window.scrollBy(0, step);
      window.__aira_scrolled = { el, rows };
      return { region: el ? label(el) : 'page', why, before, n0 };
    })()
  `;
}

const SCROLL_AFTER_JS = `
  (() => {
    const s = window.__aira_scrolled || {};
    const node = s.el || document.scrollingElement || document.documentElement;
    return { after: node.scrollTop, n1: s.rows ? s.rows(s.el || document.body) : 0, max: node.scrollHeight - node.clientHeight };
  })()
`;

function readJs(target: string | undefined, limit: number): string {
  return `
    (() => {
      const t = ${JSON.stringify(target ?? null)};
      let el = document.body;
      if (t !== null) {
        el = /^\\d+$/.test(t) ? document.querySelector('[data-opencli-ref="' + t + '"]') : document.querySelector(t);
        if (!el) return null;
      }
      const text = (el.innerText || el.textContent || '').replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
      const label = el.getAttribute('aria-label') || el.getAttribute('role') || '';
      const region = t === null ? 'the whole page' : el.tagName.toLowerCase() + (label ? ' "' + label.slice(0, 40) + '"' : '');
      return { text: text.length > ${limit} ? '…' + text.slice(-${limit}) : text, total: text.length, region };
    })()
  `;
}

/**
 * Resolve `label:<text>` to a ref at execution time, so a multi-step plan does
 * not depend on ref numbers that only exist after an earlier step.
 * `label:button:Send` narrows by role. Exact name wins over "contains".
 */
let lastUploadDetail = '';

/** Why a page reports hidden: its tab is not the active one, or the whole window is covered / minimised. */
async function hiddenWhy(page: IPage): Promise<string> {
  try {
    const tabs = await (page as unknown as { tabs?: () => Promise<Array<{ active?: boolean; url?: string }>> }).tabs?.();
    const url = String(await page.evaluate('location.href'));
    const mine = tabs?.find((t) => t.url === url);
    if (mine && mine.active === false) return 'tab inactive: another tab is in front in its Chrome window';
    if (mine && mine.active === true) return 'window occluded: the tab is active but another app covers the Chrome window, or the window is minimised';
  } catch { /* fall through */ }
  return 'tab inactive, or the Chrome window is covered by another app or minimised';
}

/** Upload answer for the agent: verdict and count on success, the per-strategy lines only on failure. */
export function uploadLine(r: SmartUploadResult): string {
  if (r.verdict !== 'PASS') return describeUpload(r);
  return `PASS attached ${r.files.length} of ${r.files.length}${r.already ? ` (the page already showed ${r.already} image or attachment preview(s) before this call: check for duplicates)` : ''}`;
}

/** Screenshots go next to the logs, a place the calling agent can read. */
export function shotPath(given: string | undefined): string {
  if (given) return path.resolve(given.replace(/^~(?=\/)/, os.homedir()));
  const dir = path.join(process.env.OPENCLI_MCP_LOG_DIR || path.join(os.homedir(), '.opencli', 'aira-mcp'), 'shots');
  return path.join(dir, `shot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
}

function isHidden(err: unknown): boolean {
  return /Native input requires a visible/i.test(String((err as Error)?.message ?? err));
}

/** Page-side: insert text into the focused field without trusted input. */
function domTypeJs(text: string): string {
  return `
    (() => {
      const el = document.activeElement;
      if (!el || el === document.body) return false;
      if (document.execCommand && document.execCommand('insertText', false, ${JSON.stringify(text)})) return true;
      if ('value' in el) {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const set = Object.getOwnPropertyDescriptor(proto, 'value');
        if (set && set.set) set.set.call(el, (el.value || '') + ${JSON.stringify(text)}); else el.value += ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      }
      return false;
    })()
  `;
}

/** Trusted key press, or on a hidden tab an in-page key event (untrusted; some sites ignore it). */
async function pressKeyAnyway(page: IPage, key: string): Promise<string> {
  // Chrome drops trusted key events on a hidden page: watch whether the key arrives.
  let hidden = false;
  try {
    hidden = await page.evaluate(`(() => {
      if (document.visibilityState === 'visible') return false;
      window.__airaKey = 0;
      window.addEventListener('keydown', (e) => { if (e.isTrusted) window.__airaKey = 1; }, { capture: true, once: true });
      return true;
    })()`) === true;
  } catch { /* treat as visible */ }
  try {
    await page.pressKey(key);
    if (!hidden) return '';
    for (let i = 0; i < 4; i++) {
      if (await page.evaluate('window.__airaKey === 1')) return ' (hidden page)';
      await sleep(80);
    }
    throw new Error('Native input requires a visible browser page; the key did not arrive.');
  } catch (err) {
    if (!isHidden(err)) throw err;
    await page.evaluate(`
      (() => {
        const el = document.activeElement || document.body;
        const key = ${JSON.stringify(key)};
        const init = { key, code: key.length === 1 ? 'Key' + key.toUpperCase() : key, bubbles: true, cancelable: true, composed: true, keyCode: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0, which: key === 'Enter' ? 13 : key === 'Escape' ? 27 : 0 };
        el.dispatchEvent(new KeyboardEvent('keydown', init));
        el.dispatchEvent(new KeyboardEvent('keypress', init));
        el.dispatchEvent(new KeyboardEvent('keyup', init));
      })()
    `);
    return ' via dom key event (hidden page: the site\'s own key handlers run, built-in effects such as deleting text or submitting a form do not; click the button instead)';
  }
}

export async function resolveLabel(page: IPage, raw: string): Promise<string | { error: string; next: string }> {
  const m = /^([a-z]+):(.+)$/i.exec(raw.trim());
  const role = m ? m[1].toLowerCase() : null;
  const want = (m ? m[2] : raw).trim().toLowerCase();
  const map = await preciseTargets(page, {});
  const pool = map.targets.filter((t) => !t.noise && (!role || (t.role || t.tag) === role));
  const exact = pool.filter((t) => t.name.toLowerCase() === want);
  const hits = exact.length > 0 ? exact : pool.filter((t) => t.name.toLowerCase().includes(want));
  if (hits.length === 1) return String(hits[0].ref);
  if (exact.length > 1) {
    // Same exact name several times (menu + toolbar copies): take the one a person would click.
    const rank = (t: PreciseTargetsResult['targets'][number]) => (t.in_viewport ? 0 : 4) + (t.covered_by ? 2 : 0) + (t.disabled ? 1 : 0);
    const best = [...exact].sort((a, b) => rank(a) - rank(b) || a.y - b.y || a.x - b.x || a.ref - b.ref)[0];
    return String(best.ref);
  }
  if (hits.length === 0) return { error: `no option labelled "${raw}"`, next: 'Call do=look and use a ref or an exact label from OPTIONS.' };
  return {
    error: `${hits.length} options match "${raw}": ${hits.slice(0, 6).map((t) => `${t.ref} ${t.role || t.tag} "${t.name}"`).join(' | ')}`,
    next: 'Use the ref number, or label:<role>:<exact name>.',
  };
}

/**
 * Run a plan: steps execute in order without re-reading the page between
 * them, stop at the first ERR, and the screen is rendered once at the end.
 */
export async function actSteps(page: IPage, steps: ActInput[], common: { session?: string; max?: number } = {}): Promise<ActOutput> {
  const lines: string[] = [];
  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const out = await act(page, { ...steps[i], session: common.session }, { screen: false });
    lines.push(`${i + 1}/${steps.length} ${out.text}`);
    if (!out.ok) { ok = false; lines.push(`STOPPED at step ${i + 1}; steps ${i + 2}..${steps.length} were not run.`); break; }
  }
  const map = await preciseTargets(page, {}).catch(() => null);
  if (map) lines.push(renderScreen(map, { max: common.max }));
  return { ok, text: lines.join('\n') };
}

/** Run one verb against a page. Never throws; errors come back as `ERR …` text. */
export async function act(page: IPage, input: ActInput, opts: { screen?: boolean } = {}): Promise<ActOutput> {
  // Hard ceiling: an action may fail, it may never hang the caller.
  const budget = input.do === 'each' ? (Math.min(Math.max(input.time_budget ?? 100, 5), 3600) + 30) * 1000 : input.do === 'wait' ? (Math.min(input.seconds ?? 30, 300) + 15) * 1000 : input.do === 'upload' ? 120_000 : 45_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ActOutput>((resolve) => {
    timer = setTimeout(() => resolve(fail(`${input.do} failed: no answer from the browser within ${budget / 1000}s`,
      'The page or the bridge is stuck. Call do=look; if that also times out, do=open the url again.')), budget);
  });
  try {
    return await Promise.race([actInner(page, input, opts), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function actInner(page: IPage, input: ActInput, opts: { screen?: boolean } = {}): Promise<ActOutput> {
  const started = Date.now();
  const ms = () => `${Date.now() - started}ms`;
  const tail = async () => (opts.screen === false ? '' : `\n${await screen(page, input)}`);
  let target = input.target === undefined ? undefined : String(input.target);
  try {
    if (target !== undefined && /^label:/i.test(target) && input.do !== 'save') {
      const found = await resolveLabel(page, target.slice(6));
      if (typeof found === 'string') target = found;
      else if (input.do === 'scroll') {
        // A list or pane is not a clickable option: find it by its accessible name instead.
        const sel = await page.evaluate(regionByLabelJs(target.slice(6))) as string | null;
        if (!sel) return fail(`no option or region labelled "${target.slice(6)}"`, 'Call do=scroll without target (the list under the middle of the screen scrolls), or pass the ref of any row inside the list.');
        target = sel;
      } else return fail(found.error, found.next);
    }
    switch (input.do) {
      case 'open': {
        // Streaming single-page apps never reach "idle": cap the navigation wait and go on.
        const nav = page.goto(input.url as string, { waitUntil: 'none' }).then(() => 'done' as const, (e: unknown) => e);
        const first = await Promise.race([nav, sleep(12_000).then(() => 'slow' as const)]);
        if (first !== 'done' && first !== 'slow') throw first;
        const { map, loading: unsettled } = await settle(page, 5000);
        const loading = unsettled || first === 'slow';
        const body = map ? renderScreen(map, { max: input.max }) : 'PAGE (not ready)';
        return { ok: true, text: `OK open${loading ? ' (STILL LOADING: call look or wait)' : ''} ${ms()}\n${body}` };
      }
      case 'look':
        return { ok: true, text: `OK look ${ms()}${await tail()}` };
      case 'click': {
        const r = await preciseClick(page, target as string, { expect: input.expect, force: input.force, session: input.session });
        const good = r.verdict === 'PASS' || r.verdict === 'NO_CHANGE';
        const detail = [
          r.changed?.length ? `changed: ${r.changed.join(', ')}` : '',
          r.covered_by ? `covered by ${r.covered_by}` : '',
          r.verdict === 'MISSED' && r.landed_on ? `landed on ${r.landed_on}` : '',
          r.message ?? '',
        ].filter(Boolean).join('; ');
        const via = r.click_method === 'dom' ? ' [in-page click: the page is hidden]' : '';
        const seen = r.changed ?? [];
        const effect = r.verdict === 'PASS'
          ? (seen.every((c) => c === 'focus')
            ? 'PASS, clicked; only the focus moved, the page content looks the same (it may already have been in that state)'
            : `PASS, page changed (${seen.join(', ')})`)
          : r.verdict === 'NO_CHANGE' ? 'clicked, no change seen' : r.verdict;
        const extra = r.verdict === 'PASS' ? '' : detail;
        const head = `${good ? 'OK' : 'ERR'} click ${target} -> ${effect}${extra ? ` (${extra})` : ''}${via} ${ms()}`;
        return { ok: good, text: `${head}${r.verdict === 'PASS' ? '' : `\nNEXT ${hintFor(`${r.verdict} ${detail}`, r.next)}`}${await tail()}` };
      }
      case 'type': {
        const pre = await preciseClick(page, target as string, { session: input.session, settleMs: 150 });
        if (!pre.clicked) return { ok: false, text: `ERR type ${target} -> ${pre.verdict}\nNEXT ${hintFor(`${pre.verdict} ${pre.covered_by ? 'covered by' : ''}`, pre.next)}${await tail()}` };
        let how = '';
        try {
          await page.typeText(target as string, input.text as string);
        } catch (err) {
          if (!isHidden(err)) throw err;
          const typed = await page.evaluate(domTypeJs(input.text as string));
          if (typed !== true) throw err;
          how = ' via dom (hidden tab, untrusted)';
        }
        if (input.submit) how += await pressKeyAnyway(page, 'Enter');
        await sleep(input.submit ? 400 : 100);
        return { ok: true, text: `OK type ${target} (${(input.text as string).length} chars${input.submit ? ', Enter' : ''})${how} ${ms()}${await tail()}` };
      }
      case 'key': {
        const how = await pressKeyAnyway(page, input.key as string);
        await sleep(250);
        return { ok: true, text: `OK key ${input.key}${how} ${ms()}${await tail()}` };
      }
      case 'upload': {
        const r = await smartUpload(page, input.files as string[], {
          target, clipboard: input.clipboard, convert: input.convert, maxPx: input.max_px,
        });
        const ok = r.verdict === 'PASS';
        lastUploadDetail = describeUpload(r);
        return { ok, text: `${ok ? 'OK' : 'ERR'} upload ${uploadLine(r)} ${ms()}${ok ? '' : `\nNEXT ${r.next}`}${await tail()}` };
      }
      case 'wait': {
        const limit = Math.min(Math.max(input.seconds ?? 30, 0), 300) * 1000;
        const conditional = input.until !== undefined || input.gone !== undefined || input.selector !== undefined;
        if (!conditional) {
          await sleep(limit);
          return { ok: true, text: `OK wait ${ms()}${await tail()}` };
        }
        const end = Date.now() + limit;
        let met = false;
        while (Date.now() < end) {
          try { met = (await page.evaluate(waitConditionJs(input))) === true; } catch { met = false; }
          if (met) break;
          await sleep(400);
        }
        const head = met ? `OK wait met ${ms()}` : `ERR wait timed out after ${ms()}\nNEXT The condition is still false. Call wait again, or look to see the page.`;
        return { ok: met, text: `${head}${await tail()}` };
      }
      case 'scroll': {
        const dir = input.direction ?? 'down';
        const a = await page.evaluate(scrollJs(target, dir)) as { error?: string; region: string; why: string; before: number; n0: number };
        if (a.error) return fail(`scroll ${dir}: ${a.error}`, 'Pass target=<ref of an element inside the list or pane to scroll> (see OPTIONS), or omit target to scroll the region in the middle of the window.');
        await sleep(350);
        const b = await page.evaluate(SCROLL_AFTER_JS) as { after: number; n1: number; max: number };
        const moved = Math.round(b.after - a.before);
        if (moved === 0) {
          return fail(`scroll ${dir}: nothing scrolled (${a.region} is already at its ${dir === 'down' ? 'end' : 'top'}, at ${Math.round(b.after)} of ${Math.round(b.max)} px)`,
            `To scroll another region pass target=<ref of an element inside it>. To read or search every row of a list or inbox use do=each mode=list (it scrolls by itself).`);
        }
        return { ok: true, text: `OK scroll ${dir}: ${a.region} ${moved > 0 ? '+' : ''}${moved} px (now at ${Math.round(b.after)} of ${Math.round(b.max)}), ${a.n0} -> ${b.n1} rows${a.why ? ` [${a.why}]` : ''} ${ms()}${await tail()}` };
      }
      case 'read': {
        const limit = Math.min(Math.max(input.max ?? 1500, 100), 8000);
        const got = await page.evaluate(readJs(target, limit)) as { text: string; total: number; region: string } | null;
        if (got === null) return fail(`read target not found: ${target}`, 'Call look for fresh refs.');
        const part = got.total > limit ? `the LAST ${limit} of ${got.total} chars (max=<n> up to 8000 shows more)` : `${got.total} chars`;
        const hint = target === undefined
          ? ' No target was given, so this is all visible text of the page in reading order; on a list/detail page it ends with the open detail pane. One region: target=<ref or CSS selector>. The rows of a list or inbox: do=each mode=list.'
          : '';
        return { ok: true, text: `OK read ${got.region}: ${part}.${hint} ${ms()}\n${got.text}` };
      }
      case 'images': {
        const list = await page.evaluate(IMAGES_JS) as Array<{ i: number; src: string; w: number; h: number; alt: string; visible: boolean }>;
        const lines = list.slice(-(input.max ?? 12)).map((x) => `${x.i} ${x.w}x${x.h}${x.visible ? '' : ' OFFSCREEN'} "${x.alt}" ${x.src.slice(0, 90)}`);
        return { ok: true, text: `OK images ${list.length} (newest last; save with do=save target=<index>) ${ms()}\n${lines.join('\n') || '(no images of 256px or more)'}` };
      }
      case 'save': {
        const index = Number(target);
        if (!Number.isInteger(index) || index < 0) return fail('save target must be an image index from do=images', 'Call do=images first.');
        const got = await page.evaluate(fetchImageJs(index)) as { data?: string; type?: string; src?: string; error?: string };
        if (!got.data) return fail(`could not read image: ${got.error ?? 'unknown'}`, `Open the image url directly: ${got.src ?? ''}`);
        const m = /^data:([^;]+);base64,(.*)$/s.exec(got.data);
        if (!m) return fail('image came back in an unknown encoding', 'Use do=shot instead.');
        const ext = m[1].includes('jpeg') ? 'jpg' : m[1].includes('webp') ? 'webp' : 'png';
        const out = path.resolve((input.path ?? path.join(os.tmpdir(), `aira-image-${Date.now()}.${ext}`)).replace(/^~(?=\/)/, os.homedir()));
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, Buffer.from(m[2], 'base64'));
        return { ok: true, text: `OK save ${out} (${fs.statSync(out).size} bytes) ${ms()}` };
      }
      case 'shot': {
        const out = shotPath(input.path);
        await (page as unknown as { takeForeground?: (c: string) => Promise<void> }).takeForeground?.('shot');
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const capture = (page.annotatedScreenshot ?? page.screenshot).bind(page);
        const b64 = await capture({ format: 'png', path: out });
        if (!fs.existsSync(out) && b64) fs.writeFileSync(out, Buffer.from(b64, 'base64'));
        return { ok: true, text: `OK shot ${out} (numbers on the image are the refs) ${ms()}` };
      }
      case 'each': {
        // Read-only walk over a list: opens items in-page, never types or submits, needs no foreground.
        const r = await runEach(page, {
          target: input.target === undefined ? undefined : String(input.target), detail: input.selector,
          mode: input.mode, find: input.find, until: input.until,
          limit: input.limit, minIntervalMs: input.min_interval_ms, timeBudgetS: input.time_budget,
          resume: input.resume, save: input.save, rediscover: input.rediscover,
        });
        const text = `each ${describeEach(r, input.max ?? 25)}`;
        return r.ok ? { ok: true, text: `OK ${text}\nNEXT ${r.next}` } : fail(text, r.next);
      }
      case 'help':
        return { ok: true, text: PLAYBOOK };
      case 'debug': {
        // Live state first, so the answer is more than a replay of the last error.
        let state = 'STATE unknown (page did not answer)';
        try {
          const s = await page.evaluate(`({ v: document.visibilityState, f: document.hasFocus(), u: location.href, r: document.readyState })`) as { v: string; f: boolean; u: string; r: string };
          state = `STATE tab ${s.v}${s.f ? ', focused' : ''}, ${s.r} | ${s.u.slice(0, 120)}\n`
            + (s.v === 'visible'
              ? 'INPUT trusted clicks and typing reach this tab.'
              : `INPUT page is hidden (${await hiddenWhy(page)}). Nothing is brought to the front. Clicks run inside the page (marked "[in-page click]", untrusted, effect still verified); typed text arrives; keys are sent as in-page events, so click the Send/OK button instead of pressing Enter. If a site insists on a real click, the user can start the server with --window foreground.`);
        } catch { /* keep the default line */ }
        return { ok: true, text: `${state}${lastUploadDetail ? `\nLAST UPLOAD ${lastUploadDetail}` : ''}\n${readLog(input.max ?? 10)}` };
      }
      default:
        return fail(`unknown verb ${String(input.do)}`, `Use one of: ${VERBS.join(', ')}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(`${input.do} failed: ${message.slice(0, 300)} ${ms()}`);
  }
}
