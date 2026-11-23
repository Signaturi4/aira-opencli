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
  const pool = needle
    ? map.targets.filter((t) => `${t.role} ${t.tag} ${t.name}`.toLowerCase().includes(needle))
    : map.targets.filter((t) => !t.noise);
  const shown = pool.slice(0, max);
  const lines = [
    `PAGE ${clip(map.title || '(untitled)', 60)} | ${clip(map.url, 120)}`,
    `OPTIONS ${shown.length}${pool.length > shown.length || map.truncated ? ` of ${Math.max(pool.length, map.count)} (use find or scroll)` : ''}${needle ? ` matching "${needle}"` : ''}`,
    ...shown.map(renderOption),
  ];
  if (shown.length === 0) lines.push(needle ? '(nothing matches; call look without find)' : '(no clickable elements yet; wait or scroll)');
  return lines.join('\n');
}
