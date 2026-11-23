import { describe, expect, it } from 'vitest';
import type { IPage } from '../types.js';
import { diffFingerprints, parsePoint, preciseClick, type PreciseTargetsResult } from '../browser/precise.js';
import { parseActInput, resolveLabel, shotPath, uploadLine } from './actions.js';
import { NativeInputVisibilityError } from '../browser/base-page.js';
import { acceptAllows, describeUpload, mimeOf, smartUpload } from '../browser/upload.js';
import { renderScreen } from './screen.js';
import { ACT_TOOL, createMcpHandler } from './server.js';
import { compactInput, hintFor } from './troubleshoot.js';

process.env.OPENCLI_MCP_LOG = 'off';
process.env.OPENCLI_PRECISE_LOG = 'off';

function target(ref: number, role: string, name: string, extra: Record<string, unknown> = {}) {
  return { ref, tag: 'button', role, name, x: 10, y: 10 * ref, w: 80, h: 20, cx: 50, cy: 10 * ref + 10, in_viewport: true, ...extra };
}

const MAP: Omit<PreciseTargetsResult, 'next'> = {
  url: 'https://example.test/app',
  title: 'Example',
  viewport: { w: 1200, h: 800, dpr: 2, scroll_x: 0, scroll_y: 0 },
  count: 3,
  truncated: false,
  targets: [
    target(1, 'button', 'New chat'),
    target(2, 'textbox', 'Ask anything'),
    target(3, 'button', 'Send', { covered_by: 'div.modal' }),
  ],
};

/** Page double: `evaluate` answers from a queue, in call order. */
function fakePage(queue: unknown[], calls: string[] = []): IPage {
  return {
    snapshot: async () => { calls.push('snapshot'); return {}; },
    evaluate: async () => { calls.push('evaluate'); return queue.shift(); },
    nativeClick: async (x: number, y: number) => { calls.push(`nativeClick ${x},${y}`); },
    goto: async (url: string) => { calls.push(`goto ${url}`); },
  } as unknown as IPage;
}

const fp = (over: Record<string, unknown> = {}) => ({
  url: 'u', title: 't', focus: 'body', nodes: 10, text: '5:1', dialogs: 0, scroll: '0,0', target: 'a', ...over,
});

describe('screen', () => {
  it('renders one line per option with the ref first', () => {
    const text = renderScreen({ ...MAP, next: '' });
    expect(text.split('\n')).toEqual([
      'PAGE Example | https://example.test/app',
      'OPTIONS 3',
      '1 button "New chat"',
      '2 textbox "Ask anything"',
      '3 button "Send" COVERED by div.modal',
    ]);
  });

  it('filters by find and caps the list', () => {
    expect(renderScreen({ ...MAP, next: '' }, { find: 'send' })).toContain('OPTIONS 1 matching "send"');
    expect(renderScreen({ ...MAP, next: '' }, { max: 1 })).toContain('OPTIONS 1 of 3');
  });
});

describe('precise click', () => {
  it('parses x,y targets only', () => {
    expect(parsePoint('120, 44.5')).toEqual({ x: 120, y: 44.5 });
    expect(parsePoint('12')).toBeNull();
    expect(parsePoint('.btn')).toBeNull();
  });

  it('names what changed', () => {
    expect(diffFingerprints(fp(), fp({ dialogs: 1, nodes: 14 }))).toEqual(['dom', 'dialog/menu']);
    expect(diffFingerprints(fp(), fp())).toEqual([]);
  });

  it('refuses a covered target without clicking', async () => {
    const calls: string[] = [];
    const page = fakePage([
      { ok: true, matches_n: 1 },
      { x: 50, y: 40, w: 80, h: 20, visible: true, hit: 'other' },
      { x: 50, y: 40, found: true, element: 'div.modal' },
      'button "Send"',
    ], calls);
    const r = await preciseClick(page, '3', {});
    expect(r.verdict).toBe('REFUSED_COVERED');
    expect(r.clicked).toBe(false);
    expect(r.covered_by).toBe('div.modal');
    expect(calls.some((c) => c.startsWith('nativeClick'))).toBe(false);
  });

  it('passes when the click lands on the target and the page changes', async () => {
    const calls: string[] = [];
    const page = fakePage([
      { ok: true, matches_n: 1 },
      { x: 50, y: 40, w: 80, h: 20, visible: true, hit: 'target' },
      { x: 50, y: 40, found: true, element: 'button "Send"' },
      'button "Send"',
      fp(),
      fp({ text: '9:2', landing: { x: 50, y: 40, trusted: true, on: 'button "Send"', on_target: true } }),
    ], calls);
    const r = await preciseClick(page, '3', { settleMs: 0 });
    expect(r.verdict).toBe('PASS');
    expect(r.changed).toEqual(['text']);
    expect(calls).toContain('nativeClick 50,40');
  });

  it('reports MISSED when another element received the click', async () => {
    const page = fakePage([
      { ok: true, matches_n: 1 },
      { x: 50, y: 40, w: 80, h: 20, visible: true, hit: 'target' },
      { x: 50, y: 40, found: true, element: 'button "Send"' },
      'button "Send"',
      fp(),
      fp({ landing: { x: 50, y: 40, trusted: true, on: 'div.toast', on_target: false } }),
    ]);
    const r = await preciseClick(page, '3', { settleMs: 0 });
    expect(r.verdict).toBe('MISSED');
    expect(r.landed_on).toBe('div.toast');
  });
});

describe('act input', () => {
  it('rejects unknown verbs and missing fields', () => {
    expect(parseActInput({ do: 'dance' })).toMatch(/do must be one of/);
    expect(parseActInput({ do: 'click' })).toBe('do=click needs target');
    expect(parseActInput({ do: 'wait' })).toMatch(/needs one of/);
    expect(parseActInput({ steps: [{ do: 'click' }] })).toBe('steps[0]: do=click needs target');
  });

  it('accepts a plan', () => {
    const plan = parseActInput({ steps: [{ do: 'click', target: 'label:Send' }, { do: 'wait', seconds: 1 }] });
    expect(typeof plan).toBe('object');
    expect((plan as { steps: unknown[] }).steps).toHaveLength(2);
  });

  it('resolves labels, exact match first, and reports ambiguity', async () => {
    expect(await resolveLabel(fakePage([MAP]), 'send')).toBe('3');
    expect(await resolveLabel(fakePage([MAP]), 'textbox:ask')).toBe('2');
    const two = { ...MAP, targets: [target(1, 'button', 'Save'), target(2, 'button', 'Save as')] };
    expect(await resolveLabel(fakePage([two]), 'Save')).toBe('1');
    const dup = { ...MAP, targets: [target(1, 'button', 'Save draft'), target(2, 'button', 'Save as')] };
    expect(await resolveLabel(fakePage([dup]), 'Save')).toMatchObject({ error: expect.stringContaining('2 options match') });
  });
});

describe('agent-proofing', () => {
  it('picks the visible, uncovered, topmost option when several share the exact name', async () => {
    const dup = { ...MAP, targets: [
      target(4, 'button', 'New chat', { in_viewport: false }),
      target(7, 'button', 'New chat', { covered_by: 'div.menu' }),
      target(9, 'button', 'New chat'),
      target(8, 'button', 'New chat'),
    ] };
    expect(await resolveLabel(fakePage([dup]), 'New chat')).toBe('8');
    const hidden = { ...MAP, targets: [target(4, 'button', 'New chat', { in_viewport: false }), target(5, 'button', 'New chat', { in_viewport: false })] };
    expect(await resolveLabel(fakePage([hidden]), 'New chat')).toBe('4');
  });

  it('falls back to an in-page click on a hidden tab and says so', async () => {
    const calls: string[] = [];
    const page = fakePage([
      { ok: true, matches_n: 1 },
      { x: 50, y: 40, w: 80, h: 20, visible: true, hit: 'target' },
      { x: 50, y: 40, found: true, element: 'button "Send"' },
      'button "Send"',
      fp(),
      { ok: true },
      fp({ text: '9:2', landing: { x: 50, y: 40, trusted: false, on: 'button "Send"', on_target: true } }),
    ], calls);
    (page as unknown as { nativeClick: unknown }).nativeClick = async () => { throw new NativeInputVisibilityError('activated the tab'); };
    const r = await preciseClick(page, '3', { settleMs: 0 });
    expect(r.verdict).toBe('PASS');
    expect(r.click_method).toBe('dom');
    expect(r.trusted).toBe(false);
  });

  it('prints only the verdict and count for a successful upload', () => {
    const ok = { verdict: 'PASS', strategy: 'capture', files: ['/a.png', '/b.png'], evidence: 'image previews +4', attempts: [{ strategy: 'input', ok: false, detail: 'Chrome refused' }], next: '' };
    expect(uploadLine(ok as never)).toBe('PASS attached 2 of 2');
    const bad = { ...ok, verdict: 'FAILED', strategy: undefined };
    expect(uploadLine(bad as never)).toContain('input: no - Chrome refused');
  });

  it('saves screenshots where the agent can read them', () => {
    expect(shotPath(undefined)).toMatch(/aira-mcp[\\/]shots[\\/]shot-.*\.png$/);
    expect(shotPath('/x/y.png')).toBe('/x/y.png');
  });
});

describe('mcp handler', () => {
  const deps = (page: IPage) => ({ version: '0.0.0-test', getPage: async () => page });

  it('answers initialize, tools/list and ignores notifications', async () => {
    const handle = createMcpHandler(deps(fakePage([])));
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init?.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'aira-opencli' } });
    const list = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual([ACT_TOOL.name]);
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect((await handle({ jsonrpc: '2.0', id: 3, method: 'nope' }))?.error?.code).toBe(-32601);
  });

  it('look returns the result line and the options in one answer', async () => {
    const handle = createMcpHandler(deps(fakePage([MAP])));
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'act', arguments: { do: 'look' } } });
    const out = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(out.isError).toBe(false);
    const lines = out.content[0].text.split('\n');
    expect(lines[0]).toMatch(/^OK look \d+ms$/);
    expect(lines[1]).toBe('PAGE Example | https://example.test/app');
    expect(lines[3]).toBe('1 button "New chat"');
  });

  it('returns bad input as a tool error, not a protocol error', async () => {
    const handle = createMcpHandler(deps(fakePage([])));
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'act', arguments: { do: 'type', target: 2 } } });
    const out = res?.result as { content: Array<{ text: string }>; isError: boolean };
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('ERR bad input: do=type needs text');
  });

  it('a plan stops at the first failing step and still shows the screen', async () => {
    // step 1: label lookup (map) -> covered target -> refused; then final screen (map).
    const page = fakePage([
      MAP,
      { ok: true, matches_n: 1 },
      { x: 50, y: 40, w: 80, h: 20, visible: true, hit: 'other' },
      { x: 50, y: 40, found: true, element: 'div.modal' },
      'button "Send"',
      MAP,
    ]);
    const handle = createMcpHandler(deps(page));
    const res = await handle({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'act', arguments: { steps: [{ do: 'click', target: 'label:Send' }, { do: 'key', key: 'Enter' }] } },
    });
    const text = (res?.result as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('1/2 ERR click 3 -> REFUSED_COVERED');
    expect(text).toContain('STOPPED at step 1; steps 2..2 were not run.');
    expect(text).toContain('OPTIONS 3');
  });
});

describe('troubleshooting', () => {
  it('maps known failures to one concrete next step', () => {
    expect(hintFor('REFUSED_COVERED covered by div.modal')).toContain('Escape');
    expect(hintFor('Extension not connected')).toContain('opencli doctor');
    expect(hintFor('something new')).toContain('do=debug');
  });

  it('shortens long inputs before logging', () => {
    const out = compactInput({ do: 'type', text: 'x'.repeat(500) }) as { text: string };
    expect(out.text.length).toBeLessThan(220);
    expect(out.text.endsWith('(500)')).toBe(true);
  });

  it('help works without a browser', async () => {
    const handle = createMcpHandler({ version: 't', getPage: async () => { throw new Error('no browser'); } });
    const res = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'act', arguments: { do: 'help' } } });
    expect((res?.result as { content: Array<{ text: string }> }).content[0].text).toContain('WHEN IT FAILS');
    const down = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'act', arguments: { do: 'look' } } });
    expect((down?.result as { content: Array<{ text: string }> }).content[0].text).toContain('ERR cannot reach the browser');
  });
});

describe('smart upload', () => {
  it('matches accept lists', () => {
    expect(mimeOf('/a/b.PNG')).toBe('image/png');
    expect(acceptAllows('image/*,video/*', 'x.jpg')).toBe(true);
    expect(acceptAllows('.pdf,application/msword', 'x.jpg')).toBe(false);
    expect(acceptAllows('', 'x.bin')).toBe(true);
  });

  it('reports a missing file without touching the page', async () => {
    const calls: string[] = [];
    const r = await smartUpload(fakePage([], calls), ['/definitely/not/here.png']);
    expect(r.verdict).toBe('FAILED');
    expect(r.attempts[0].detail).toContain('file not found');
    expect(calls).toEqual([]);
  });

  it('passes on the input strategy when a preview appears', async () => {
    const file = new URL(import.meta.url).pathname;
    const sig = (over = {}) => ({ held: 0, blobs: 0, previews: 0, named: 0, ...over });
    const page = fakePage([
      sig(),
      { found: true, total: 1, accept: '', multiple: true, visible: false, accepts_all: true },
      sig({ previews: 1 }),
      undefined,
    ]);
    const sets: unknown[] = [];
    (page as unknown as { setFileInput: unknown }).setFileInput = async (files: string[], selector: string) => { sets.push([files.length, selector.startsWith('[data-aira-upload=')]); };
    const r = await smartUpload(page, [file], { only: ['input'] });
    expect(r.verdict).toBe('PASS');
    expect(r.strategy).toBe('input');
    expect(sets).toEqual([[1, true]]);
    expect(describeUpload(r)).toContain('PASS via input');
  });

  it('explains the Chrome "Not allowed" refusal in plain words', async () => {
    const file = new URL(import.meta.url).pathname;
    const page = fakePage([
      { held: 0, blobs: 0, previews: 0, named: 0 },
      { found: true, total: 1, accept: '', multiple: true, visible: true, accepts_all: true },
      undefined,
    ]);
    (page as unknown as { setFileInput: unknown }).setFileInput = async () => { throw new Error('{"code":-32000,"message":"Not allowed"}'); };
    const r = await smartUpload(page, [file], { only: ['input'] });
    expect(r.verdict).toBe('FAILED');
    expect(r.attempts[0].detail).toContain('file-chooser interception');
    expect(r.next).toContain('extension must be reloaded');
  });
});
