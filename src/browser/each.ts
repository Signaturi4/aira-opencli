/**
 * `each` (AIRA): go through every item of a list and read it, on any site,
 * without hand-written selectors.
 *
 *   1. find the list: the largest group of similar, clickable siblings;
 *   2. find the detail region: open two items and see which region changes
 *      (a pane in the same page, or a full navigation);
 *   3. derive selectors from ids, roles, ARIA and structure, and return them;
 *   4. loop: open the next unseen item, wait until the detail is stable,
 *      extract title + body, scroll for more until nothing new shows up;
 *   5. cache the recipe per origin + path pattern and re-verify it on use.
 *
 * Read-only: it only opens items (in-page click, works on a hidden tab).
 * It never types or submits. The loop is driven from this process in short
 * evaluations, because page timers are throttled on hidden tabs and one long
 * evaluation is fragile.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPage } from '../types.js';

export interface EachRecipe {
  version: 1;
  origin: string;
  path_pattern: string;
  /** pane: the detail opens in the same page. navigate: every item is its own page. */
  mode: 'pane' | 'navigate';
  /** Selector of the list container. */
  list: string;
  /** Selector matching every item. */
  item: string;
  /** Scroll container of the list; empty = the window. */
  scroll: string;
  /** Selector of the detail region; empty in navigate mode = largest main/article. */
  detail: string;
  /** How items are told apart. */
  key: 'href' | 'text';
  created: string;
}

export interface EachOptions {
  /** List container or item selector, when the guess is wrong. */
  target?: string;
  /** Detail region selector, when the guess is wrong. */
  detail?: string;
  limit?: number;
  /** Minimum time between two items. Default 300 ms. */
  minIntervalMs?: number;
  /** Seconds this call may run. Default 100. */
  timeBudgetS?: number;
  resume?: boolean;
  save?: string;
  rediscover?: boolean;
  /** Characters of body kept per item. Default 4000. */
  maxChars?: number;
  /** Scroll rounds without a new item before the list counts as finished. Default 3. */
  emptyRounds?: number;
  /** Directory for recipes and run state. Default ~/.opencli/aira-mcp. */
  dir?: string;
}

export interface EachItem {
  i: number;
  key: string;
  list_title: string;
  title: string;
  url: string;
  unread: boolean;
  chars: number;
  ms: number;
  /** How the wait for the detail ended: stable, same (nothing changed), timeout. */
  settle?: string;
  body: string;
}

export interface EachTiming {
  list_load_ms: number;
  items: number;
  median_ms: number;
  p90_ms: number;
  max_ms: number;
  items_per_min: number;
  total_ms: number;
}

export interface EachResult {
  ok: boolean;
  verdict: 'DONE' | 'CUT_TIME' | 'CUT_LIMIT' | 'NO_LIST' | 'NO_DETAIL' | 'FAILED';
  message?: string;
  recipe?: EachRecipe;
  recipe_source?: 'cached' | 'discovered';
  recipe_file?: string;
  items: Array<Omit<EachItem, 'body'>>;
  items_n: number;
  resumed_from: number;
  unread_n: number;
  timing?: EachTiming;
  save?: string;
  next: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Page-side library, installed once per document as window.__ae.
 * Plain JS in a raw string: no template placeholders, no backticks.
 */
const PAGE_LIB = String.raw`
if (!window.__ae) { window.__ae = (() => {
  const S = { seen: new Set(), last: 0, lastD: 0, n: 0, detailSel: '', marks: null, cur: null, keyMode: 'href', clickAt: 0, reqs: [], token: Math.random().toString(36).slice(2) };
  const now = () => performance.now();
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const hash = (s) => { let h = 5381; const n = Math.min(s.length, 20000); for (let i = 0; i < n; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h + ':' + s.length; };
  const q = (sel) => { try { return sel ? document.querySelector(sel) : null; } catch (e) { return null; } };
  const qa = (sel) => { try { return sel ? Array.from(document.querySelectorAll(sel)) : []; } catch (e) { return []; } };
  const box = (el) => el.getBoundingClientRect();
  const rendered = (el) => { const r = box(el); return r.height > 8 && r.width > 8 && clean(el.textContent).length >= 2; };

  new MutationObserver((ms) => {
    const t = now(); S.last = t; S.n++;
    const d = S.detailSel ? q(S.detailSel) : null;
    if (!d) { S.lastD = t; return; }
    const p = d.parentElement, pp = p ? p.parentElement : null;
    for (const m of ms) { const x = m.target; if (d.contains(x) || x === p || x === pp) { S.lastD = t; break; } }
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

  // Requests started after the last click, so "stable" can wait for the data.
  const track = () => { const r = { t: now(), done: false }; S.reqs.push(r); if (S.reqs.length > 200) S.reqs.splice(0, 100); return r; };
  try {
    const of = window.fetch;
    if (of) window.fetch = function () { const r = track(); const p = of.apply(this, arguments); const end = () => { r.done = true; }; p.then(end, end); return p; };
    const os = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () { const r = track(); this.addEventListener('loadend', () => { r.done = true; }); return os.apply(this, arguments); };
  } catch (e) {}
  // Only requests started within a second of the click count: later ones are background traffic.
  const pending = () => { const t = now(); let n = 0; for (const r of S.reqs) if (!r.done && r.t >= S.clickAt && r.t - S.clickAt < 1000 && t - r.t < 4000) n++; return n; };

  const goodClass = (c) => /^[a-zA-Z][a-zA-Z_-]*$/.test(c) && c.length >= 3 && c.length <= 40
    && !/^(css|sc|jsx|ember|ng|svelte)(-|_|$)/i.test(c) && !/(active|selected|unread|focus|current|open|expanded|collapsed|hover|visible|hidden|loading)/i.test(c)
    && !/[a-z][A-Z][a-z]*[A-Z]/.test(c)
    // one bare word must look like a word: hashed names (cfskdm, cfsayy) have almost no vowels
    && (/[-_]/.test(c) || (c.match(/[aeiou]/gi) || []).length / c.length >= 0.25);
  const goodId = (id) => !!id && /^[a-zA-Z][a-zA-Z_-]*$/.test(id) && id.length <= 40 && !/^ember/i.test(id);
  const seg = (el, o) => {
    const tag = el.tagName.toLowerCase();
    if (goodId(el.id)) return '#' + CSS.escape(el.id);
    const role = el.getAttribute('role');
    if (role && /^[a-z]+$/.test(role)) return tag + '[role="' + role + '"]';
    for (const a of ['data-testid', 'data-test-id', 'data-test', 'data-qa']) { const v = el.getAttribute(a); if (v && /^[\w-]{2,50}$/.test(v) && !/\d{3,}/.test(v)) return tag + '[' + a + '="' + v + '"]'; }
    const al = el.getAttribute('aria-label');
    if (!(o && o.noLabel) && al && al.length <= 40 && !/[\d"\\]/.test(al)) return tag + '[aria-label="' + al + '"]';
    const cls = Array.from(el.classList).filter(goodClass).slice(0, 2);
    return tag + cls.map((c) => '.' + CSS.escape(c)).join('');
  };
  const selFor = (el, o) => {
    const parts = []; let cur = el;
    for (let hop = 0; cur && cur.nodeType === 1 && cur !== document.documentElement && hop < 6; hop++) {
      parts.unshift(seg(cur, o));
      const s = parts.join(' > '); const m = qa(s);
      if (m.length === 1 && m[0] === el) return s;
      cur = cur.parentElement;
    }
    const full = []; cur = el;
    for (let hop = 0; cur && cur.nodeType === 1 && cur !== document.documentElement && hop < 12; hop++) {
      let s = seg(cur, o);
      if (s[0] !== '#' && cur.parentElement) { const same = Array.from(cur.parentElement.children).filter((c) => c.tagName === cur.tagName); if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'; }
      full.unshift(s);
      const j = full.join(' > '); const m = qa(j);
      if (m.length === 1 && m[0] === el) return j;
      cur = cur.parentElement;
    }
    return full.join(' > ');
  };

  // The element inside an item that opens it: the biggest link / pointer area, never a small button.
  const opener = (item) => {
    const ia = box(item); const area = Math.max(1, ia.width * ia.height);
    let best = null, bestScore = 0;
    const cands = [item].concat(Array.from(item.querySelectorAll('*')).slice(0, 80));
    for (const c of cands) {
      const r = box(c); const a = r.width * r.height;
      if (a < area * 0.3) continue;
      const tag = c.tagName; const role = c.getAttribute('role') || '';
      let ok = tag === 'A' && c.hasAttribute('href');
      if (!ok) ok = /^(link|button|option|row|tab|listitem|gridcell)$/.test(role) && (c !== item || role !== 'listitem') || c.hasAttribute('onclick') || c.hasAttribute('jsaction') || (c.hasAttribute('tabindex') && c.getAttribute('tabindex') !== '-1');
      if (!ok) { try { ok = getComputedStyle(c).cursor === 'pointer'; } catch (e) {} }
      if (!ok) continue;
      const score = a + (tag === 'A' ? area : 0);
      if (score > bestScore) { best = c; bestScore = score; }
    }
    return best;
  };
  // Card lists: no big clickable area, but a title link. Only trusted when the list's links are unique per item.
  const titleLink = (item) => {
    const links = Array.from(item.querySelectorAll('a[href]')).filter((a) => clean(a.textContent).length > 1 && !/^javascript:/i.test(a.getAttribute('href') || ''));
    return links.length ? links[0] : null;
  };
  // Click like a person: the deepest element under a point of the opener, so handlers on inner
  // nodes fire too (a click on a wrapper does not reach them). Small inner controls are avoided.
  const openItem = (item, op) => {
    const ob = box(op); const ia = box(item); const area = Math.max(1, ia.width * ia.height);
    let target = op, x = ob.left + ob.width / 2, y = ob.top + ob.height / 2;
    for (const p of [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]]) {
      const px = ob.left + ob.width * p[0], py = ob.top + ob.height * p[1];
      const t = document.elementFromPoint(px, py);
      if (!t || !item.contains(t)) continue;
      const inner = t.closest('a[href],button,[role="button"],input,select,textarea,label');
      if (inner && inner !== op && item.contains(inner) && !inner.contains(op)) { const b = box(inner); if (b.width * b.height < area * 0.3) continue; }
      target = t; x = px; y = py; break;
    }
    const o = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0 };
    try {
      target.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 }, o)));
      target.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, o)));
      target.dispatchEvent(new PointerEvent('pointerup', Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, o)));
      target.dispatchEvent(new MouseEvent('mouseup', o));
    } catch (e) {}
    target.click();
    return target.tagName.toLowerCase();
  };
  const hrefOf = (item) => {
    const op = opener(item) || titleLink(item);
    const a = op && op.tagName === 'A' ? op : (op && op.querySelector && op.querySelector('a[href]')) || item.querySelector('a[href]');
    const h = a && a.href ? a.href : '';
    return h && /^https?:/i.test(h) ? h.split('#')[0] : '';
  };
  const textKey = (item) => 't:' + clean(item.textContent).replace(/\d+/g, '#').slice(0, 160);
  const keyOf = (item, mode) => {
    if ((mode || S.keyMode) === 'href') { const h = hrefOf(item); if (h) return 'u:' + h; }
    for (const n of ['data-id', 'data-key', 'data-item-id', 'data-urn', 'data-entity-urn', 'data-thread-id', 'data-conversation-id']) { const v = item.getAttribute(n); if (v) return 'd:' + v; }
    return textKey(item);
  };
  const titleOf = (item) => { const t = (item.innerText || item.textContent || '').split('\n').map(clean).filter((x) => x.length > 1); return (t[0] || '').slice(0, 80); };
  const unreadOf = (item) => {
    if (/\bunread\b|new notification/i.test(item.textContent || '')) return true;
    const els = Array.from(item.querySelectorAll('*')).slice(0, 120);
    for (const e of els) {
      const s = (typeof e.className === 'string' ? e.className : '') + ' ' + (e.getAttribute('aria-label') || '');
      if (/unread/i.test(s)) { const r = box(e); if (r.width > 0 && r.height > 0) return true; }
    }
    return false;
  };

  const scrollerOf = (el) => {
    for (let a = el; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
      let oy = ''; try { oy = getComputedStyle(a).overflowY; } catch (e) {}
      if ((oy === 'auto' || oy === 'scroll') && a.scrollHeight > a.clientHeight + 20) return a;
    }
    return null;
  };

  const discover = (target) => {
    const groups = [];
    const consider = (parent) => {
      if (parent.childElementCount < 5) return;
      const by = {};
      for (const c of parent.children) { const k = c.tagName + '|' + (c.getAttribute('role') || ''); (by[k] = by[k] || []).push(c); }
      for (const k in by) {
        const all = by[k]; if (all.length < 5 || /^(SCRIPT|STYLE|OPTION|BR|TD|TH)\|/.test(k)) continue;
        const live = all.filter(rendered); if (live.length < 3) continue;
        const sample = live.slice(0, 12);
        let strict = 0, soft = 0, area = 0, text = 0; const hs = [], heights = [];
        for (const it of sample) {
          const r = box(it); area += r.width * r.height; heights.push(r.height); text += Math.min(200, clean(it.textContent).length);
          if (opener(it)) strict++; else if (titleLink(it)) soft++;
          const h = hrefOf(it); if (h) hs.push(h);
        }
        area /= sample.length; text /= sample.length;
        if (area < 600 || text < 4) continue;
        // Links that repeat across items (author links in a message list) do not open the item.
        const unique = hs.length >= sample.length * 0.9 && new Set(hs).size >= hs.length * 0.9;
        const share = (strict + (unique ? soft : 0)) / sample.length;
        // List rows look alike; the messages of a thread or the sections of an article do not.
        const mean = heights.reduce((a, b) => a + b, 0) / heights.length;
        const cv = Math.sqrt(heights.reduce((a, b) => a + (b - mean) * (b - mean), 0) / heights.length) / Math.max(1, mean);
        const score = Math.min(all.length, 60) * (0.05 + share) * (unique ? 1.3 : 1) * Math.pow(area, 0.3) * (text >= 12 ? 1 : 0.5) / (1 + 3 * cv);
        groups.push({ parent, all, live, score, share, cv, sig: k });
      }
    };
    let directItems = null;
    if (target) {
      const t = /^\d+$/.test(target) ? qa('[data-opencli-ref="' + target + '"]') : qa(target);
      if (t.length === 0) return { ok: false, reason: 'target matches nothing: ' + target };
      if (t.length >= 3) directItems = t;
      else { consider(t[0]); for (const el of t[0].querySelectorAll('*')) consider(el); if (!groups.length && t[0].parentElement) consider(t[0].parentElement); }
    } else {
      consider(document.body);
      for (const el of document.body.querySelectorAll('*')) consider(el);
    }
    let parent, itemSel, live, total;
    if (directItems) {
      parent = directItems[0].parentElement; itemSel = target; live = directItems.filter(rendered); total = directItems.length;
    } else {
      if (!groups.length) return { ok: false, reason: 'no group of 5 or more similar, visible siblings on this page' };
      groups.sort((a, b) => b.score - a.score);
      const g = groups[0]; parent = g.parent; live = g.live; total = g.all.length;
      const parts = g.sig.split('|');
      itemSel = selFor(parent) + ' > ' + parts[0].toLowerCase() + (parts[1] ? '[role="' + parts[1] + '"]' : '');
    }
    const sc = scrollerOf(parent);
    const hrefs = live.map(hrefOf).filter(Boolean);
    const key = hrefs.length >= live.length * 0.9 && new Set(hrefs).size >= hrefs.length * 0.9 ? 'href' : 'text';
    S.keyMode = key;
    return {
      ok: true, list: selFor(parent), item: itemSel, scroll: sc ? selFor(sc) : '', key, total, live: live.length,
      sample: live.slice(0, 3).map(titleOf),
      others: groups.slice(0, 6).map((g) => selFor(g.parent) + ' > ' + g.sig + ' n=' + g.all.length + ' live=' + g.live.length + ' share=' + g.share.toFixed(2) + ' cv=' + g.cv.toFixed(2) + ' score=' + Math.round(g.score)),
    };
  };

  const verify = (r) => { S.keyMode = r.key; const items = qa(r.item); return { total: items.length, live: items.filter(rendered).length, scrollOk: !r.scroll || !!q(r.scroll), token: S.token, url: location.href }; };

  // Mark the first unseen rendered item as seen and (optionally) open it.
  const step = (r, add, doOpen) => {
    S.keyMode = r.key;
    if (add) for (const k of add) S.seen.add(k);
    const items = qa(r.item); let liveN = 0;
    for (const it of items) {
      if (!rendered(it)) continue; liveN++;
      const k = keyOf(it); if (S.seen.has(k)) continue;
      S.seen.add(k); S.cur = it;
      const out = { key: k, title: titleOf(it), unread: unreadOf(it), href: hrefOf(it), live: liveN, total: items.length };
      if (doOpen) { it.scrollIntoView({ block: 'center' }); const op = opener(it) || (r.key === 'href' ? titleLink(it) : null) || it; S.clickAt = now(); out.opened = openItem(it, op); }
      return out;
    }
    return { none: true, live: liveN, total: items.length };
  };
  // Navigate mode: every unseen rendered item at once.
  const collect = (r, add) => {
    S.keyMode = r.key;
    if (add) for (const k of add) S.seen.add(k);
    const out = [];
    for (const it of qa(r.item)) {
      if (!rendered(it)) continue;
      const k = keyOf(it); if (S.seen.has(k)) continue;
      S.seen.add(k);
      const href = hrefOf(it); if (!href) continue;
      out.push({ key: k, title: titleOf(it), unread: unreadOf(it), href });
    }
    return out;
  };
  const scrollMore = (r) => {
    const sc = q(r.scroll);
    const before = sc ? sc.scrollTop : window.scrollY;
    S.clickAt = now();
    if (sc) { sc.scrollTop = Math.min(sc.scrollTop + sc.clientHeight * 0.9, sc.scrollHeight); sc.dispatchEvent(new Event('scroll', { bubbles: true })); }
    else window.scrollBy(0, window.innerHeight * 0.9);
    const after = sc ? sc.scrollTop : window.scrollY;
    return { moved: Math.abs(after - before) > 2 };
  };
  // A new run: forget what was seen and go back to the top of the list.
  const reset = (r) => {
    S.seen = new Set(); S.cur = null;
    const sc = r ? q(r.scroll) : null;
    if (sc) { sc.scrollTop = 0; sc.dispatchEvent(new Event('scroll', { bubbles: true })); } else if (r) window.scrollTo(0, 0);
    return true;
  };

  const state = (sel) => {
    if (sel !== undefined && sel !== null) S.detailSel = sel;
    const d = S.detailSel ? q(S.detailSel) : document.body;
    const t = d ? (d.textContent || '') : '';
    return {
      now: now(), last: S.detailSel && d ? S.lastD : S.last, clickAt: S.clickAt, len: t.trim().length, head: hash(t), url: location.href,
      busy: !!(d && d.querySelector('[aria-busy="true"],[role="progressbar"]')), pending: pending(), ready: document.readyState, found: !!d, token: S.token,
    };
  };

  const mark = (listSel) => {
    const list = q(listSel); const m = new Map();
    for (const el of document.body.querySelectorAll('*')) { if (list && list.contains(el)) continue; const t = el.textContent || ''; if (t.length) m.set(el, hash(t)); }
    S.marks = m; return m.size;
  };
  const diff = (listSel) => {
    const list = q(listSel); const m = S.marks || new Map(); const changed = new Set();
    for (const el of document.body.querySelectorAll('*')) {
      if (list && (list.contains(el) || el.contains(list))) continue;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TITLE|TEMPLATE)$/.test(el.tagName)) continue;
      const t = el.textContent || ''; if (!t.trim().length) continue;
      if (m.get(el) !== hash(t)) changed.add(el);
    }
    const tops = [];
    for (const el of changed) { if (changed.has(el.parentElement)) continue; const r = box(el); if (r.width < 40 || r.height < 20) continue; tops.push({ el, len: clean(el.textContent).length }); }
    if (!tops.length) return { ok: false, regions: 0 };
    tops.sort((a, b) => b.len - a.len);
    let best = tops[0].el;
    // Several changed regions (header + body of one pane): take their common ancestor when it stays clear of the list.
    const big = tops.filter((t) => t.len >= 10).slice(0, 6);
    if (big.length > 1) {
      let lca = big[0].el;
      for (const t of big) { while (lca && !lca.contains(t.el)) lca = lca.parentElement; }
      if (lca && lca !== document.body && lca !== document.documentElement && !(list && lca.contains(list))) best = lca;
    }
    return { ok: true, detail: selFor(best, { noLabel: true }), len: clean(best.textContent).length, regions: tops.length };
  };

  const extract = (sel, cap, auto) => {
    let d = q(sel);
    if (!d && auto) {
      let bl = 0;
      for (const c of qa('main,[role="main"],article,#content,#main')) { const l = (c.textContent || '').length; if (l > bl) { d = c; bl = l; } }
      if (!d) d = document.body;
    }
    if (!d) return { ok: false };
    const h = d.querySelector('h1,h2,[role="heading"],h3');
    const body = (d.innerText || d.textContent || '').replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    if (S.cur && S.cur.isConnected && rendered(S.cur)) S.seen.add(keyOf(S.cur));
    return {
      ok: true, title: clean(h ? h.textContent : '').slice(0, 120) || clean(document.title).slice(0, 120),
      body: body.slice(0, cap), chars: body.length, url: location.href, sel: sel || (auto && d !== document.body ? selFor(d, { noLabel: true }) : ''),
    };
  };

  return { discover, verify, step, collect, scrollMore, reset, state, mark, diff, extract, token: () => S.token };
})(); }
`;

function call(fn: string, ...args: unknown[]): string {
  return `(() => { ${PAGE_LIB}\n return window.__ae.${fn}(${args.map((a) => JSON.stringify(a ?? null)).join(', ')}); })()`;
}

async function ev<T>(page: IPage, fn: string, ...args: unknown[]): Promise<T> {
  return await page.evaluate(call(fn, ...args)) as T;
}

interface PageState {
  now: number; last: number; clickAt: number; len: number; head: string; url: string;
  busy: boolean; pending: number; ready: string; found: boolean; token: string;
}

/**
 * Wait until the watched region changed after the last click and then stayed
 * quiet: no DOM change for `quietMs`, no request in flight, no busy marker.
 * Polled from here (page timers are throttled on hidden tabs).
 */
async function waitStable(
  page: IPage,
  detail: string | null,
  prev: { head: string } | null,
  opts: { capMs: number; quietMs?: number; needChange?: boolean },
): Promise<{ state: PageState | null; how: 'stable' | 'same' | 'timeout'; ms: number }> {
  const started = Date.now();
  const quiet = opts.quietMs ?? 180;
  let state: PageState | null = null;
  for (;;) {
    try {
      state = await ev<PageState>(page, 'state', detail);
    } catch {
      state = null; // navigating: the document is being replaced
    }
    const elapsed = Date.now() - started;
    if (process.env.OPENCLI_EACH_TRACE && state) process.stderr.write(`[each] ${elapsed}ms quiet=${Math.round(state.now - state.last)} pending=${state.pending} busy=${state.busy} len=${state.len} changed=${!prev || state.head !== prev.head} touched=${state.last >= state.clickAt}\n`);
    if (state) {
      const calm = state.now - state.last;
      // Quiet with nothing in flight, or quiet for long enough that a slow background request no longer matters.
      const settled = ((calm >= quiet && state.pending === 0) || calm >= Math.max(450, quiet * 2)) && !state.busy && state.ready !== 'loading';
      const changed = !prev || state.head !== prev.head;
      const touched = state.last >= state.clickAt;
      if (settled && state.len > 0 && changed && (touched || !opts.needChange)) return { state, how: 'stable', ms: elapsed };
      if (settled && !changed && elapsed >= 1500) return { state, how: 'same', ms: elapsed };
    }
    if (elapsed >= opts.capMs) return { state, how: 'timeout', ms: elapsed };
    await sleep(40);
  }
}

export function pathPattern(pathname: string): string {
  const parts = pathname.split('/').map((p) => (p && (/\d/.test(p) || p.length > 24) ? '*' : p));
  return parts.join('/').replace(/\/+$/, '') || '/';
}

export function recipeFile(dir: string, url: string): string {
  const u = new URL(url);
  const name = `${u.host}${pathPattern(u.pathname)}`.replace(/[^a-zA-Z0-9.*-]+/g, '_').replace(/\*/g, 'x').slice(0, 120);
  return path.join(dir, 'recipes', `${name}.json`);
}

function baseDir(opts: EachOptions): string {
  return opts.dir || process.env.OPENCLI_MCP_LOG_DIR || path.join(os.homedir(), '.opencli', 'aira-mcp');
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function timingOf(ms: number[], listLoadMs: number, loopMs: number, totalMs: number): EachTiming {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0);
  return {
    list_load_ms: Math.round(listLoadMs), items: s.length, median_ms: at(0.5), p90_ms: at(0.9), max_ms: s.length ? s[s.length - 1] : 0,
    items_per_min: loopMs > 0 ? Math.round((s.length / loopMs) * 60_000 * 10) / 10 : 0, total_ms: Math.round(totalMs),
  };
}

interface RunState { seen: string[]; save: string; n: number; unread: number; updated: string }

const NEXT_OVERRIDE = 'Wrong list or detail? Call again with target=<list or item selector> and/or selector=<detail selector> and rediscover=true.';

/** Run `each` on the page that is open in `page`. Never throws for an expected failure. */
export async function runEach(page: IPage, opts: EachOptions = {}): Promise<EachResult> {
  const t0 = Date.now();
  const budgetMs = Math.min(Math.max(opts.timeBudgetS ?? 100, 5), 3600) * 1000;
  const deadline = t0 + budgetMs;
  const limit = Math.max(1, opts.limit ?? 100_000);
  const minInterval = Math.max(0, opts.minIntervalMs ?? 300);
  const cap = Math.min(Math.max(opts.maxChars ?? 4000, 200), 100_000);
  const rounds = Math.max(1, opts.emptyRounds ?? 3);
  const dir = baseDir(opts);
  const empty = (verdict: EachResult['verdict'], message: string, next: string): EachResult => ({
    ok: false, verdict, message, items: [], items_n: 0, resumed_from: 0, unread_n: 0, next,
  });

  let listUrl: string;
  try {
    listUrl = String(await page.evaluate('location.href'));
  } catch (err) {
    return empty('FAILED', `the page did not answer: ${err instanceof Error ? err.message : String(err)}`, 'Open the list page first (do=open url=…), then call each again.');
  }
  const file = recipeFile(dir, listUrl);
  const u = new URL(listUrl);

  // ── recipe: cached and still valid, or discovered now ─────────────────
  let recipe: EachRecipe | null = null;
  let source: 'cached' | 'discovered' = 'discovered';
  if (!opts.rediscover && !opts.target) {
    const cached = readJson<EachRecipe>(file);
    if (cached?.version === 1 && cached.item) {
      const v = await ev<{ live: number; scrollOk: boolean }>(page, 'verify', cached);
      if (v.live >= 3 && v.scrollOk) { recipe = cached; source = 'cached'; }
    }
  }
  if (recipe && opts.detail) recipe = { ...recipe, detail: opts.detail };

  if (!recipe) {
    const d = await ev<{ ok: boolean; reason?: string; list: string; item: string; scroll: string; key: 'href' | 'text'; total: number; live: number; others?: string[] }>(page, 'discover', opts.target ?? null);
    if (!d.ok) return empty('NO_LIST', d.reason ?? 'no list found', 'Scroll the list into view or pass target=<selector of the list container or of the items>.');
    const draft: EachRecipe = {
      version: 1, origin: u.origin, path_pattern: pathPattern(u.pathname), mode: 'pane',
      list: d.list, item: d.item, scroll: d.scroll, detail: opts.detail ?? '', key: d.key, created: new Date().toISOString(),
    };
    // Open the first item: does the page survive (pane) or is it replaced (navigate)?
    const token = await ev<string>(page, 'token');
    const before = await ev<PageState>(page, 'state', '');
    const first = await ev<{ none?: boolean; href?: string }>(page, 'step', draft, null, true);
    if (first.none) return empty('NO_LIST', 'the list has no rendered item to open', NEXT_OVERRIDE);
    await sleep(60);
    await waitStable(page, '', before, { capMs: 6000, quietMs: 250, needChange: true });
    let alive = false;
    try {
      const v = await ev<{ live: number; token: string }>(page, 'verify', draft);
      alive = v.token === token && v.live >= 2;
    } catch { alive = false; }
    if (!alive) {
      if (!first.href || d.key !== 'href') {
        await page.goto(listUrl, { waitUntil: 'none' }).catch(() => undefined);
        return empty('NO_DETAIL', `opening an item of ${d.item} replaced the page and the items have no link of their own`, `That was probably not the list you meant. Pass target=<selector of the list or its items>${d.others?.length ? `; other candidates: ${d.others.slice(1, 4).join(' | ')}` : ''}.`);
      }
      draft.mode = 'navigate';
      draft.key = 'href';
      await page.goto(listUrl, { waitUntil: 'none' }).catch(() => undefined);
      await waitStable(page, '', null, { capMs: 8000, quietMs: 250 });
    } else if (!draft.detail) {
      await ev(page, 'mark', draft.list);
      const mid = await ev<PageState>(page, 'state', '');
      const second = await ev<{ none?: boolean }>(page, 'step', draft, null, true);
      if (second.none) return empty('NO_DETAIL', 'only one item is rendered, so the detail region cannot be told apart', 'Pass selector=<detail region selector>.');
      await sleep(60);
      await waitStable(page, '', mid, { capMs: 6000, quietMs: 250, needChange: true });
      const found = await ev<{ ok: boolean; detail?: string }>(page, 'diff', draft.list);
      if (!found.ok || !found.detail) return empty('NO_DETAIL', 'opening two items changed no region outside the list', 'Pass selector=<detail region selector>, or target=<another list>.');
      draft.detail = found.detail;
    }
    recipe = draft;
    writeJson(file, recipe);
  }
  if (!opts.resume) {
    await ev(page, 'reset', recipe).catch(() => undefined);
    await waitStable(page, '', null, { capMs: 1500, quietMs: 200 });
  }
  const listLoadMs = Date.now() - t0;

  // ── run state (resume) and output file ────────────────────────────────
  const stateFile = file.replace(/\.json$/, '.state.json').replace(`${path.sep}recipes${path.sep}`, `${path.sep}each${path.sep}`);
  const prior = opts.resume ? readJson<RunState>(stateFile) : null;
  const seen = new Set<string>(prior?.seen ?? []);
  const resumedFrom = prior?.n ?? 0;
  const save = path.resolve((opts.save ?? prior?.save ?? path.join(dir, 'each', `${u.host}-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`)).replace(/^~(?=\/)/, os.homedir()));
  fs.mkdirSync(path.dirname(save), { recursive: true });
  if (!prior) fs.writeFileSync(save, '', { mode: 0o600 });
  let n = resumedFrom;
  let unread = prior?.unread ?? 0;
  const items: Array<Omit<EachItem, 'body'>> = [];
  const perItem: number[] = [];
  const persist = () => writeJson(stateFile, { seen: [...seen], save, n, unread, updated: new Date().toISOString() } satisfies RunState);
  const record = (item: EachItem) => {
    fs.appendFileSync(save, `${JSON.stringify(item)}\n`);
    const { body: _body, ...line } = item;
    items.push(line);
    perItem.push(item.ms);
    if (item.unread) unread++;
  };

  let verdict: EachResult['verdict'] = 'DONE';
  let message: string | undefined;
  const loopStart = Date.now();
  const taken = () => items.length;
  const pace = async (itemStart: number) => {
    const left = minInterval - (Date.now() - itemStart);
    if (left > 0) await sleep(left);
  };

  try {
    if (recipe.mode === 'pane') {
      let seed: string[] | null = seen.size ? [...seen] : null;
      let prevHead = (await ev<PageState>(page, 'state', recipe.detail)).head;
      const seenUrls = new Set<string>();
      let idle = 0;
      let moves = 0;
      for (;;) {
        if (taken() >= limit) { verdict = 'CUT_LIMIT'; break; }
        if (Date.now() >= deadline) { verdict = 'CUT_TIME'; break; }
        const itemStart = Date.now();
        const s = await ev<{ none?: boolean; key: string; title: string; unread: boolean; live: number }>(page, 'step', recipe, seed, true);
        seed = null;
        if (s.none) {
          // Scrolling past items already read (resume) is progress; only a list that stops moving counts as empty.
          const m = await ev<{ moved: boolean }>(page, 'scrollMore', recipe);
          await waitStable(page, '', null, { capMs: 1500, quietMs: 200 });
          if (m?.moved && ++moves < 2000) continue;
          if (++idle >= rounds) break;
          continue;
        }
        idle = 0;
        seen.add(s.key);
        await sleep(30);
        const w = await waitStable(page, recipe.detail, { head: prevHead }, { capMs: 6000, needChange: true });
        const x = await ev<{ ok: boolean; title: string; body: string; chars: number; url: string }>(page, 'extract', recipe.detail, cap, false);
        if (!x.ok) {
          if (source === 'cached' && taken() === 0) throw new RecipeStale();
          message = `the detail region ${recipe.detail} disappeared at item ${n + 1}`;
          verdict = 'FAILED';
          break;
        }
        prevHead = w.state?.head ?? prevHead;
        const duplicate = x.url !== listUrl && seenUrls.has(x.url);
        seenUrls.add(x.url);
        if (!duplicate) {
          n++;
          record({ i: n, key: s.key, list_title: s.title, title: x.title, url: x.url, unread: s.unread, chars: x.chars, ms: Date.now() - itemStart, settle: `${w.how} ${w.ms}ms`, body: x.body });
        }
        if (n % 10 === 0) persist();
        await pace(itemStart);
      }
    } else {
      // navigate: collect the links first (scrolling for more), then visit each.
      const queue: Array<{ key: string; title: string; unread: boolean; href: string }> = [];
      let seed: string[] | null = seen.size ? [...seen] : null;
      let idle = 0;
      while (queue.length < limit && Date.now() < deadline) {
        const got = await ev<typeof queue>(page, 'collect', recipe, seed);
        seed = null;
        queue.push(...got);
        const m = await ev<{ moved: boolean }>(page, 'scrollMore', recipe);
        await waitStable(page, '', null, { capMs: 1500, quietMs: 200 });
        if (got.length > 0) idle = 0;
        else if (!m?.moved && ++idle >= rounds) break;
      }
      for (const it of queue) {
        if (taken() >= limit) { verdict = 'CUT_LIMIT'; break; }
        if (Date.now() >= deadline) { verdict = 'CUT_TIME'; break; }
        const itemStart = Date.now();
        const nav = page.goto(it.href, { waitUntil: 'none' }).then(() => 'done', () => 'failed');
        await Promise.race([nav, sleep(12_000)]);
        await waitStable(page, '', null, { capMs: 8000, quietMs: 250 });
        const x = await ev<{ ok: boolean; title: string; body: string; chars: number; url: string; sel: string }>(page, 'extract', recipe.detail, cap, true);
        if (x.ok && !recipe.detail && x.sel) { recipe.detail = x.sel; writeJson(file, recipe); }
        seen.add(it.key);
        n++;
        record({ i: n, key: it.key, list_title: it.title, title: x.ok ? x.title : '', url: it.href, unread: it.unread, chars: x.ok ? x.chars : 0, ms: Date.now() - itemStart, body: x.ok ? x.body : '' });
        if (n % 10 === 0) persist();
        await pace(itemStart);
      }
      if (verdict === 'DONE' && queue.length >= limit) verdict = 'CUT_LIMIT';
      await page.goto(listUrl, { waitUntil: 'none' }).catch(() => undefined);
    }
  } catch (err) {
    if (err instanceof RecipeStale) {
      try { fs.renameSync(file, `${file}.stale`); } catch { /* nothing cached */ }
      return runEach(page, { ...opts, rediscover: true, timeBudgetS: Math.max(5, Math.round((deadline - Date.now()) / 1000)) });
    }
    verdict = 'FAILED';
    message = err instanceof Error ? err.message : String(err);
  }
  persist();
  const loopMs = Date.now() - loopStart;
  const cut = verdict === 'CUT_TIME' || verdict === 'CUT_LIMIT';
  return {
    ok: verdict !== 'FAILED',
    verdict,
    ...(message ? { message } : {}),
    recipe, recipe_source: source, recipe_file: file,
    items, items_n: items.length, resumed_from: resumedFrom, unread_n: unread,
    timing: timingOf(perItem, listLoadMs, loopMs, Date.now() - t0),
    save,
    next: verdict === 'FAILED'
      ? `Read the message. ${NEXT_OVERRIDE}`
      : cut
        ? 'More items are left: call again with resume=true (same page) to continue where this stopped.'
        : `Finished: no new item after ${rounds} scroll rounds. Full text is in the save file. ${NEXT_OVERRIDE}`,
  };
}

class RecipeStale extends Error {}

/** Compact text for the `act` answer: selectors, one line per item, timing, file. */
export function describeEach(r: EachResult, maxLines = 25): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  if (!r.recipe) return `${r.verdict}: ${r.message ?? ''}`;
  const t = r.timing as EachTiming;
  const head = `${r.verdict} ${r.items_n} item(s)${r.resumed_from ? ` (+${r.resumed_from} before, resumed)` : ''} in ${(t.total_ms / 1000).toFixed(1)}s, recipe ${r.recipe_source}${r.message ? ` - ${r.message}` : ''}`;
  const lines = [
    head,
    `LIST   ${r.recipe.item}${r.recipe.scroll ? `   scroll ${r.recipe.scroll}` : ''}`,
    `DETAIL ${r.recipe.detail || '(largest main/article of each page)'}   mode ${r.recipe.mode}, key ${r.recipe.key}`,
    ...r.items.slice(0, maxLines).map((it) => `${it.i} "${clip(it.list_title, 40)}" -> "${clip(it.title, 40)}" ${it.chars} chars ${it.ms}ms${it.unread ? ' UNREAD' : ''}`),
  ];
  if (r.items.length > maxLines) lines.push(`… ${r.items.length - maxLines} more in the file`);
  if (r.unread_n > 0) lines.push(`UNREAD ${r.unread_n} item(s) showed an unread marker; opening them marked them as read on the site.`);
  lines.push(`TIMING list load ${t.list_load_ms}ms | per item median ${t.median_ms}ms p90 ${t.p90_ms}ms max ${t.max_ms}ms | ${t.items_per_min} items/min`);
  lines.push(`SAVED  ${r.save}`);
  lines.push(`RECIPE ${r.recipe_file}`);
  return lines.join('\n');
}
