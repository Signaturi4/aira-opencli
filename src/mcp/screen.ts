/**
 * Screen renderer for the MCP `act` tool.
 *
 * Turns the precise-click target map into a few lines of text a small model
 * can act on without a separate "read the page" step:
 *
 *   PAGE Gemini | https://gemini.google.com/app
 *   OPTIONS 4
 *   3 button "New chat"
 *   7 textbox "Ask Gemini"
 *   9 button "Upload files" COVERED by div.modal
 *
 * The number at the start of a line is what `click` / `type` take as `target`.
 */

import type { PreciseTarget, PreciseTargetsResult } from '../browser/precise.js';

export interface ScreenOptions {
  /** Maximum option lines. Default 40. */
  max?: number;
  /** Keep only options whose role or name contains this text (case-insensitive). */
  find?: string;
  /** Skip this many options (paging). */
  offset?: number;
}

function clip(text: string, n: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean;
}

export function renderOption(t: PreciseTarget): string {
  const kind = t.role || t.tag;
  const name = t.name ? ` "${clip(t.name, 60)}"` : ` (no label, at ${t.cx},${t.cy})`;
  const flags = [
    t.disabled ? ' DISABLED' : '',
    t.covered_by ? ` COVERED by ${clip(t.covered_by, 40)}` : '',
    t.in_viewport ? '' : ' OFFSCREEN',
  ].join('');
  return `${t.ref} ${kind}${name}${flags}`;
}

export function renderScreen(map: PreciseTargetsResult, opts: ScreenOptions = {}): string {
  const max = Math.max(1, opts.max ?? 40);
  const needle = opts.find?.trim().toLowerCase();
  const all = map.targets.filter((t) => !t.noise);
  const pool = needle ? all.filter((t) => `${t.role} ${t.tag} ${t.name}`.toLowerCase().includes(needle)) : all;
  const start = Math.min(Math.max(0, Math.floor(opts.offset ?? 0)), pool.length);
  const shown = pool.slice(start, start + max);
  const end = start + shown.length;
  const whole = start === 0 && end === pool.length;
  const count = needle && pool.length === 0
    ? `0 matches of ${all.length} for "${needle}"`
    : `${whole ? pool.length : `${start + 1}-${end} of ${pool.length}`}${needle ? ` matching "${needle}"` : ''}`;
  const lines = [
    `PAGE ${clip(map.title || '(untitled)', 60)} | ${clip(map.url, 120)}`,
    `OPTIONS ${count}`,
    ...shown.map(renderOption),
  ];
  if (end < pool.length) lines.push(`MORE do=look offset=${end}${needle ? ` find="${needle}"` : ''}${opts.max ? ` max=${max}` : ''} shows the next ones; find=<word> narrows. For the rows of a list or inbox use do=each mode=list.`);
  if (pool.length === 0) lines.push(needle ? '(find only looks at names of clickable elements; try a shorter word, or do=each mode=list find=<text> for list rows, or do=read for page text)' : '(no clickable elements yet; wait or scroll)');
  return lines.join('\n');
}
