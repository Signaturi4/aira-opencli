/**
 * Smart file upload (AIRA fork).
 *
 * One call that attaches local files to a page and says which way worked.
 * Strategies, in order; each is verified before the next is tried:
 *
 *   input     — set the files on the best matching <input type=file>. The
 *               extension does this through file-chooser interception, the
 *               only route Chrome accepts over chrome.debugger (crbug 928255;
 *               a raw DOM.setFileInputFiles answers "-32000 Not allowed").
 *   capture   — for inputs the site creates or wires up only after its own
 *               upload button is pressed: catch the input the site reaches
 *               for (no native dialog opens), then set the files on it.
 *   drop      — a DataTransfer drop on the drop zone / editor.
 *   paste     — a DataTransfer paste into the editor.
 *   clipboard — opt-in, macOS: put the image on the system clipboard and send
 *               a real paste. Replaces the user's clipboard, so off by default.
 *
 * Files may be local paths, http(s) URLs or data: URIs. Images are converted
 * (macOS `sips`) when the chosen input does not accept their type, or when
 * `convert` / `maxPx` ask for it.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { IPage } from '../types.js';
import { preciseClick, preciseTargets, type PreciseTarget } from './precise.js';

const run = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export type UploadStrategy = 'input' | 'capture' | 'drop' | 'paste' | 'clipboard';

export interface SmartUploadOptions {
  /** Ref / CSS selector of the file input, the site's upload button, or the drop zone. */
  target?: string;
  /** Allow the clipboard strategy (replaces the system clipboard). */
  clipboard?: boolean;
  /** Convert images before upload. */
  convert?: 'png' | 'jpeg';
  /** Downscale images so the longest side is at most this many pixels. */
  maxPx?: number;
  /** Only run these strategies, in this order. */
  only?: UploadStrategy[];
  /** Milliseconds to wait for the page to show the attachment. Default 6000. */
  verifyMs?: number;
}

export interface SmartUploadAttempt {
  strategy: UploadStrategy;
  ok: boolean;
  detail: string;
}

export interface SmartUploadResult {
  verdict: 'PASS' | 'FAILED';
  strategy?: UploadStrategy;
  files: string[];
  attempts: SmartUploadAttempt[];
  /** What changed on the page, e.g. "previews +2". */
  evidence?: string;
  next: string;
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  heic: 'image/heic', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', md: 'text/markdown',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', wav: 'audio/wav',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', zip: 'application/zip',
};

export function mimeOf(file: string): string {
  return MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** Does an `accept` attribute allow this file? Empty accept allows everything. */
export function acceptAllows(accept: string, file: string): boolean {
  const parts = accept.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0) return true;
  const mime = mimeOf(file);
  const ext = path.extname(file).toLowerCase();
  return parts.some((p) => (p.startsWith('.') ? p === ext : p.endsWith('/*') ? mime.startsWith(p.slice(0, -1)) : p === mime));
}

function uploadDir(): string {
  const dir = path.join(os.homedir(), '.opencli', 'aira-mcp', 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Turn a path, URL or data: URI into an absolute local file path. */
export async function materializeFile(spec: string, index = 0): Promise<string> {
  const data = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(spec);
  if (data) {
    const ext = Object.entries(MIME).find(([, m]) => m === (data[1] ?? ''))?.[0] ?? 'bin';
    const out = path.join(uploadDir(), `upload-${Date.now()}-${index}.${ext}`);
    fs.writeFileSync(out, data[2] ? Buffer.from(data[3], 'base64') : decodeURIComponent(data[3]));
    return out;
  }
  if (/^https?:\/\//i.test(spec)) {
    const res = await fetch(spec, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status}): ${spec}`);
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    const urlExt = path.extname(new URL(spec).pathname).slice(1).toLowerCase();
    const ext = MIME[urlExt] ? urlExt : Object.entries(MIME).find(([, m]) => m === type)?.[0] ?? 'bin';
    const out = path.join(uploadDir(), `upload-${Date.now()}-${index}.${ext}`);
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  }
  const abs = path.resolve(spec.replace(/^~(?=\/)/, os.homedir()));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error(`file not found: ${abs}`);
  return abs;
}

/** Convert / downscale an image with macOS `sips`. Returns the original path when nothing can be done. */
export async function convertImage(file: string, opts: { format?: 'png' | 'jpeg'; maxPx?: number }): Promise<string> {
  if (process.platform !== 'darwin' || !mimeOf(file).startsWith('image/')) return file;
  if (!opts.format && !opts.maxPx) return file;
  const ext = opts.format === 'jpeg' ? 'jpg' : opts.format ?? path.extname(file).slice(1);
  const out = path.join(uploadDir(), `${path.basename(file, path.extname(file))}-${Date.now()}.${ext}`);
  const args = [
    ...(opts.format ? ['-s', 'format', opts.format] : []),
    ...(opts.maxPx ? ['-Z', String(Math.round(opts.maxPx))] : []),
    file, '--out', out,
  ];
  try {
    await run('sips', args, { timeout: 30_000 });
    return fs.existsSync(out) ? out : file;
  } catch {
    return file;
  }
}

/** Page-side: what on the page would show that files were attached. */
function signalJs(names: string[]): string {
  return `
    (() => {
      const names = ${JSON.stringify(names.map((n) => n.toLowerCase()))};
      const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
      const held = [];
      for (const el of inputs) { try { for (const f of el.files) held.push(String(f.name).toLowerCase()); } catch (e) {} }
      const text = ((document.body && document.body.innerText) || '').toLowerCase();
      const attrs = Array.from(document.querySelectorAll('[alt],[title],[aria-label]'))
        .map((el) => ((el.getAttribute('alt') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase()).join(' ');
      return {
        held: names.filter((n) => held.includes(n)).length,
        blobs: document.querySelectorAll('img[src^="blob:"],img[src^="data:image"],video[src^="blob:"]').length,
        previews: document.querySelectorAll('[class*="preview" i],[class*="attachment" i],[class*="thumbnail" i],[class*="file-chip" i],[class*="uploaded" i],[data-test-id*="file" i],[data-testid*="attachment" i],[data-testid*="file" i]').length,
        named: names.filter((n) => text.includes(n) || attrs.includes(n)).length,
      };
    })()
  `;
}

interface Signal { held: number; blobs: number; previews: number; named: number }

function evidence(before: Signal, after: Signal): string {
  const parts: string[] = [];
  if (after.blobs > before.blobs) parts.push(`image previews +${after.blobs - before.blobs}`);
  if (after.previews > before.previews) parts.push(`attachment elements +${after.previews - before.previews}`);
  if (after.named > before.named) parts.push(`file names shown +${after.named - before.named}`);
  if (after.held > before.held) parts.push(`input holds ${after.held} file(s)`);
  return parts.join(', ');
}

/** Visible on the page (preview / name), not just held by an input. */
function shown(before: Signal, after: Signal): boolean {
  return after.blobs > before.blobs || after.previews > before.previews || after.named > before.named;
}

async function waitForSignal(page: IPage, names: string[], before: Signal, ms: number): Promise<Signal> {
  const end = Date.now() + ms;
  let after = before;
  while (Date.now() < end) {
    try { after = await page.evaluate(signalJs(names)) as Signal; } catch { /* page busy */ }
    if (shown(before, after)) return after;
    await sleep(350);
  }
  return after;
}

const MARK = 'data-aira-upload';

/** Page-side: pick the best file input for these files and mark it. */
function pickInputJs(token: string, mimes: string[], exts: string[], count: number, hint: string | null): string {
  return `
    (() => {
      const mimes = ${JSON.stringify(mimes)}, exts = ${JSON.stringify(exts)}, hint = ${JSON.stringify(hint)};
      const allows = (accept, i) => {
        const parts = (accept || '').split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
        if (parts.length === 0) return true;
        return parts.some((p) => p[0] === '.' ? p === exts[i] : p.slice(-2) === '/*' ? mimes[i].indexOf(p.slice(0, -1)) === 0 : p === mimes[i]);
      };
      let pool = Array.from(document.querySelectorAll('input[type="file"]'));
      if (hint) {
        let el = null;
        try { el = /^\\d+$/.test(hint) ? document.querySelector('[data-opencli-ref="' + hint + '"]') : document.querySelector(hint); } catch (e) {}
        if (el) {
          const own = el.matches('input[type="file"]') ? el
            : el.querySelector('input[type="file"]')
            || (el.tagName === 'LABEL' && el.htmlFor ? document.getElementById(el.htmlFor) : null);
          pool = own && own.matches && own.matches('input[type="file"]') ? [own] : [];
        }
      }
      let best = null, bestScore = -1;
      for (const el of pool) {
        if (el.disabled) continue;
        const accept = el.getAttribute('accept') || '';
        let ok = true;
        for (let i = 0; i < mimes.length; i++) if (!allows(accept, i)) { ok = false; break; }
        const score = (ok ? 4 : 0) + (accept ? 1 : 0) + (el.multiple || ${count} === 1 ? 2 : 0);
        if (score > bestScore) { best = el; bestScore = score; }
      }
      if (!best) return { found: false, total: pool.length };
      best.setAttribute(${JSON.stringify(MARK)}, ${JSON.stringify(token)});
      const r = best.getBoundingClientRect();
      const cs = window.getComputedStyle(best);
      return {
        found: true, total: pool.length, accept: best.getAttribute('accept') || '', multiple: !!best.multiple,
        visible: r.width > 4 && r.height > 4 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05,
        accepts_all: bestScore >= 4,
      };
    })()
  `;
}

const unmarkJs = `(() => { for (const el of document.querySelectorAll('[${MARK}]')) el.removeAttribute('${MARK}'); })()`;
const clearMarkedJs = (token: string) => `(() => { const el = document.querySelector('[${MARK}="${token}"]'); if (el) { try { el.value = ''; } catch (e) {} } })()`;

/**
 * Page-side: while armed, any attempt by the site to open a file chooser is
 * recorded instead of opening the native dialog.
 */
const ARM_JS = `
  (() => {
    if (window.__aira_fc) return true;
    const P = HTMLInputElement.prototype;
    const st = { click: P.click, showPicker: P.showPicker, input: null, onClick: null };
    P.click = function () { if (this.type === 'file') { st.input = this; return; } return st.click.apply(this, arguments); };
    if (st.showPicker) P.showPicker = function () { if (this.type === 'file') { st.input = this; return; } return st.showPicker.apply(this, arguments); };
    st.onClick = (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      let input = t.matches && t.matches('input[type="file"]') ? t : null;
      if (!input) {
        const label = t.closest('label');
        if (label) input = (label.htmlFor && document.getElementById(label.htmlFor)) || label.querySelector('input[type="file"]');
      }
      if (input && input.type === 'file') { st.input = input; e.preventDefault(); }
    };
    document.addEventListener('click', st.onClick, true);
    window.__aira_fc = st;
    return true;
  })()
`;

const disarmJs = (token: string) => `
  (() => {
    const st = window.__aira_fc;
    if (!st) return { captured: false };
    const P = HTMLInputElement.prototype;
    P.click = st.click;
    if (st.showPicker) P.showPicker = st.showPicker;
    document.removeEventListener('click', st.onClick, true);
    const input = st.input;
    delete window.__aira_fc;
    if (!input) return { captured: false };
    if (!input.isConnected) { input.style.display = 'none'; document.body.appendChild(input); }
    input.setAttribute(${JSON.stringify(MARK)}, ${JSON.stringify(token)});
    return { captured: true, accept: input.getAttribute('accept') || '', multiple: !!input.multiple };
  })()
`;

const capturedJs = `(() => !!(window.__aira_fc && window.__aira_fc.input))()`;

const UPLOAD_WORDS = /upload|attach|add (a )?(file|photo|image|picture|media)|choose file|browse|select file|from (computer|device)|insert (image|file)|paperclip|add files|photos?$|загруз|прикреп|файл/i;

function uploadControls(targets: PreciseTarget[], exclude = new Set<number>()): PreciseTarget[] {
  return targets
    .filter((t) => t.in_viewport && !t.disabled && !t.covered_by && !exclude.has(t.ref) && UPLOAD_WORDS.test(t.name))
    .sort((a, b) => Number(/upload|attach|file/i.test(b.name)) - Number(/upload|attach|file/i.test(a.name)));
}

/** Page-side: dispatch a drop or paste carrying real File objects. */
function transferJs(kind: 'drop' | 'paste', files: Array<{ name: string; type: string; b64: string }>, hint: string | null): string {
  return `
    (async () => {
      const files = ${JSON.stringify(files)}, hint = ${JSON.stringify(hint)};
      const dt = new DataTransfer();
      for (const f of files) {
        const bin = atob(f.b64); const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        dt.items.add(new File([bytes], f.name, { type: f.type }));
      }
      let el = null;
      if (hint) { try { el = /^\\d+$/.test(hint) ? document.querySelector('[data-opencli-ref="' + hint + '"]') : document.querySelector(hint); } catch (e) {} }
      if (!el) el = document.querySelector('[contenteditable="true"],[contenteditable=""],textarea,[role="textbox"]');
      if (!el && ${JSON.stringify(kind)} === 'drop') el = document.querySelector('[class*="dropzone" i],[class*="drop-zone" i],[class*="upload" i]') || document.body;
      if (!el) return { ok: false, why: 'no editor or drop zone found' };
      if (${JSON.stringify(kind)} === 'paste') {
        el.focus();
        const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
        el.dispatchEvent(ev);
        return { ok: true, handled: ev.defaultPrevented };
      }
      const r = el.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new DragEvent('dragenter', init));
      el.dispatchEvent(new DragEvent('dragover', init));
      await new Promise((res) => setTimeout(res, 120));
      const target = document.elementFromPoint(init.clientX, init.clientY) || el;
      const drop = new DragEvent('drop', init);
      target.dispatchEvent(drop);
      return { ok: true, handled: drop.defaultPrevented };
    })()
  `;
}

const MAX_INLINE_BYTES = 12 * 1024 * 1024;

function inlineFiles(files: string[]): Array<{ name: string; type: string; b64: string }> | string {
  const total = files.reduce((sum, f) => sum + fs.statSync(f).size, 0);
  if (total > MAX_INLINE_BYTES) return `files are ${Math.round(total / 1048576)} MB together; drop/paste carries at most ${MAX_INLINE_BYTES / 1048576} MB (pass max_px to downscale images)`;
  return files.map((f) => ({ name: path.basename(f), type: mimeOf(f), b64: fs.readFileSync(f).toString('base64') }));
}

function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/Not allowed/i.test(message)) {
    return 'Chrome refused to set files through the debugger ("Not allowed", crbug 928255). The extension must use file-chooser interception: reload the OpenCLI extension from this fork (or update it) so CLI and extension match.';
  }
  if (/fileChooserOpened not received/i.test(message)) return 'the input did not open a file chooser when clicked (it is not wired up yet)';
  if (/No element found matching selector/i.test(message)) return 'the file input disappeared before the files could be set';
  if (/no count|not supported/i.test(message)) return 'the connected extension is too old for file upload; update or reload it';
  return message.slice(0, 200);
}

/** Attach files to the page, trying each strategy until the page shows them. */
export async function smartUpload(page: IPage, specs: string[], opts: SmartUploadOptions = {}): Promise<SmartUploadResult> {
  const attempts: SmartUploadAttempt[] = [];
  const done = (ok: boolean, strategy: UploadStrategy | undefined, files: string[], ev?: string): SmartUploadResult => ({
    verdict: ok ? 'PASS' : 'FAILED',
    ...(strategy ? { strategy } : {}),
    files,
    attempts,
    ...(ev ? { evidence: ev } : {}),
    next: ok
      ? 'Files are attached. Continue with the task.'
      : attempts.some((a) => /Not allowed|too old|reload/i.test(a.detail))
        ? 'Stop and tell the user: the OpenCLI Chrome extension must be reloaded/updated to match this CLI.'
        : `No strategy made the page show the files. Pass target=<ref of the site's upload button or drop zone>${opts.clipboard ? '' : ', or clipboard=true to allow a real paste (replaces the clipboard)'}, or use do=shot to look at the page.`,
  });

  let files: string[];
  try {
    files = [];
    for (let i = 0; i < specs.length; i++) {
      const local = await materializeFile(specs[i], i);
      files.push(opts.convert || opts.maxPx ? await convertImage(local, { format: opts.convert, maxPx: opts.maxPx }) : local);
    }
  } catch (err) {
    attempts.push({ strategy: 'input', ok: false, detail: err instanceof Error ? err.message : String(err) });
    return { ...done(false, undefined, []), next: 'Fix the file list (absolute paths, http(s) URLs or data: URIs) and call again.' };
  }
  if (files.length === 0) return { ...done(false, undefined, []), next: 'Pass at least one file.' };

  const verifyMs = opts.verifyMs ?? 6000;
  const order = opts.only ?? (['input', 'capture', 'drop', 'paste', ...(opts.clipboard ? ['clipboard' as const] : [])] as UploadStrategy[]);
  const hint = opts.target ?? null;
  const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const selector = `[${MARK}="${token}"]`;
  let names = files.map((f) => path.basename(f));
  let before = await page.evaluate(signalJs(names)) as Signal;

  const setOnMarked = async (multiple: boolean): Promise<void> => {
    if (typeof page.setFileInput !== 'function') throw new Error('not supported by this browser backend');
    if (multiple || files.length === 1) { await page.setFileInput(files, selector); return; }
    for (const f of files) { await page.setFileInput([f], selector); await sleep(700); }
  };

  try {
    for (const strategy of order) {
      try {
        if (strategy === 'input') {
          const pick = await page.evaluate(pickInputJs(token, files.map(mimeOf), files.map((f) => path.extname(f).toLowerCase()), files.length, hint)) as
            { found: boolean; total: number; accept?: string; multiple?: boolean; visible?: boolean; accepts_all?: boolean };
          if (!pick.found) { attempts.push({ strategy, ok: false, detail: `no file input on the page${hint ? ' for that target' : ''}` }); continue; }
          if (!pick.accepts_all && process.platform === 'darwin' && !opts.convert) {
            // The input rejects a type: convert images to PNG once and go on with those.
            const converted = await Promise.all(files.map((f) => (acceptAllows(pick.accept ?? '', f) ? f : convertImage(f, { format: 'png', maxPx: opts.maxPx }))));
            if (converted.some((f, i) => f !== files[i])) {
              files = converted; names = files.map((f) => path.basename(f));
              before = await page.evaluate(signalJs(names)) as Signal;
            }
          }
          await setOnMarked(pick.multiple === true);
          const after = await waitForSignal(page, names, before, pick.visible ? 1500 : verifyMs);
          if (shown(before, after)) { attempts.push({ strategy, ok: true, detail: evidence(before, after) }); return done(true, strategy, files, evidence(before, after)); }
          if (pick.visible && after.held > before.held) {
            attempts.push({ strategy, ok: true, detail: evidence(before, after) });
            return done(true, strategy, files, `${evidence(before, after)} (plain form field, no preview)`);
          }
          // A hidden input took the files but the page did not react: it is not wired up. Undo and go on.
          await page.evaluate(clearMarkedJs(token)).catch(() => undefined);
          attempts.push({ strategy, ok: false, detail: `files were set on a hidden input (accept="${pick.accept ?? ''}") but the page showed nothing` });
          continue;
        }

        if (strategy === 'capture') {
          await page.evaluate(ARM_JS);
          let captured = false;
          const clicked: string[] = [];
          try {
            const seen = new Set<number>();
            for (let depth = 0; depth < 3 && !captured; depth++) {
              let control: string | null = null;
              if (depth === 0 && hint) control = hint;
              else {
                const map = await preciseTargets(page, {});
                const pick = uploadControls(map.targets, seen)[0];
                if (pick) { control = String(pick.ref); seen.add(pick.ref); clicked.push(`"${pick.name}"`); }
              }
              if (!control) break;
              const r = await preciseClick(page, control, { settleMs: 450 });
              if (!r.clicked) { clicked.push(`(${r.verdict})`); if (depth === 0 && hint) continue; break; }
              captured = (await page.evaluate(capturedJs)) === true;
            }
          } finally {
            const res = await page.evaluate(disarmJs(token)) as { captured: boolean; multiple?: boolean };
            captured = res.captured;
            if (captured) {
              await setOnMarked(res.multiple === true);
            }
          }
          if (!captured) {
            attempts.push({ strategy, ok: false, detail: clicked.length ? `clicked ${clicked.join(' then ')} but the site did not reach for a file input` : 'no upload button found (pass target=<ref>)' });
            await page.pressKey('Escape').catch(() => undefined);
            continue;
          }
          const after = await waitForSignal(page, names, before, verifyMs);
          const ok = shown(before, after) || after.held > before.held;
          attempts.push({ strategy, ok, detail: ok ? evidence(before, after) : 'files were set on the site\'s own input but the page showed nothing' });
          if (ok) return done(true, strategy, files, evidence(before, after));
          continue;
        }

        if (strategy === 'drop' || strategy === 'paste') {
          const inline = inlineFiles(files);
          if (typeof inline === 'string') { attempts.push({ strategy, ok: false, detail: inline }); continue; }
          const res = await page.evaluate(transferJs(strategy, inline, hint)) as { ok: boolean; why?: string; handled?: boolean };
          if (!res.ok) { attempts.push({ strategy, ok: false, detail: res.why ?? 'could not dispatch' }); continue; }
          const after = await waitForSignal(page, names, before, res.handled ? verifyMs : 2500);
          const ok = shown(before, after);
          attempts.push({ strategy, ok, detail: ok ? evidence(before, after) : res.handled ? 'the page took the event but showed nothing' : 'the page ignored the event' });
          if (ok) return done(true, strategy, files, evidence(before, after));
          continue;
        }

        if (strategy === 'clipboard') {
          if (process.platform !== 'darwin') { attempts.push({ strategy, ok: false, detail: 'clipboard paste is implemented for macOS only' }); continue; }
          if (typeof page.cdp !== 'function') { attempts.push({ strategy, ok: false, detail: 'this backend cannot send a real key press' }); continue; }
          let pasted = 0;
          for (const f of files) {
            if (!mimeOf(f).startsWith('image/')) continue;
            const png = mimeOf(f) === 'image/png' ? f : await convertImage(f, { format: 'png' });
            await run('osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(png)}) as «class PNGf»)`], { timeout: 15_000 });
            await page.evaluate(`(() => { const el = ${hint ? `document.querySelector(${JSON.stringify(/^\d+$/.test(hint) ? `[data-opencli-ref="${hint}"]` : hint)})` : 'null'} || document.querySelector('[contenteditable="true"],[contenteditable=""],textarea,[role="textbox"]'); if (el) el.focus(); return !!el; })()`);
            const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: 4 };
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...key, commands: ['paste'] });
            await page.cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
            pasted++;
            await sleep(900);
          }
          if (pasted === 0) { attempts.push({ strategy, ok: false, detail: 'clipboard paste handles images only' }); continue; }
          const after = await waitForSignal(page, names, before, verifyMs);
          const ok = shown(before, after);
          attempts.push({ strategy, ok, detail: ok ? `${evidence(before, after)} (system clipboard was replaced)` : 'pasted but the page showed nothing (Chrome may need to be the front window)' });
          if (ok) return done(true, strategy, files, evidence(before, after));
        }
      } catch (err) {
        attempts.push({ strategy, ok: false, detail: explain(err) });
      }
    }
  } finally {
    await page.evaluate(unmarkJs).catch(() => undefined);
  }
  return done(false, undefined, files);
}

/** One line per attempt, for CLI and MCP answers. */
export function describeUpload(result: SmartUploadResult): string {
  const head = result.verdict === 'PASS'
    ? `PASS via ${result.strategy} (${result.files.length} file(s); ${result.evidence ?? 'attached'})`
    : `FAILED (${result.files.length} file(s))`;
  const tried = result.attempts.map((a) => `  ${a.strategy}: ${a.ok ? 'ok' : 'no'} - ${a.detail}`).join('\n');
  return tried ? `${head}\n${tried}` : head;
}
