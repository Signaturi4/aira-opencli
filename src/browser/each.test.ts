import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IPage } from '../types.js';
import { describeEach, pathPattern, recipeFile, runEach, timingOf, type EachRecipe } from './each.js';

describe('each: recipe keys and timing', () => {
  it('turns id-like path segments into a pattern', () => {
    expect(pathPattern('/messaging/thread/2-abc123/')).toBe('/messaging/thread/*');
    expect(pathPattern('/')).toBe('/');
    expect(pathPattern('/catalogue/page-2.html')).toBe('/catalogue/*');
  });

  it('keeps one recipe file per origin and path pattern', () => {
    const a = recipeFile('/d', 'https://www.linkedin.com/messaging/thread/2-abc123/');
    const b = recipeFile('/d', 'https://www.linkedin.com/messaging/thread/2-zzz999/?x=1');
    expect(a).toBe(b);
    expect(a).toBe(path.join('/d', 'recipes', 'www.linkedin.com_messaging_thread_x.json'));
  });

  it('reports median, p90, max and items per minute', () => {
    const t = timingOf([400, 300, 500, 900, 350], 1200, 3000, 4200);
    expect(t).toMatchObject({ list_load_ms: 1200, items: 5, median_ms: 400, p90_ms: 900, max_ms: 900, items_per_min: 100, total_ms: 4200 });
  });
});

/** A scripted page: answers window.__ae calls by name, in the way the page library would. */
function fakePage(handlers: Record<string, (args: unknown[]) => unknown>): IPage & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async evaluate(js: string) {
      if (js === 'location.href') return 'https://example.test/inbox/';
      const m = /window\.__ae\.(\w+)\(([^\n]*)\); \}\)\(\)$/.exec(js);
      if (!m) throw new Error('unexpected script');
      calls.push(m[1]);
      return handlers[m[1]]?.(JSON.parse(`[${m[2]}]`));
    },
    async goto() { /* not used in pane mode */ },
  } as unknown as IPage & { calls: string[] };
}

function withRecipe(recipe: EachRecipe): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'each-'));
  const file = recipeFile(dir, 'https://example.test/inbox/');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(recipe));
  return dir;
}

describe('each: loop', () => {
  const recipe: EachRecipe = {
    version: 1, origin: 'https://example.test', path_pattern: '/inbox', mode: 'pane',
    list: 'ul', item: 'ul > li', scroll: '', detail: 'main', key: 'text', created: 'x',
  };

  it('uses a cached recipe, opens each unseen item once, saves full text and stops after empty scroll rounds', async () => {
    const dir = withRecipe(recipe);
    const list = ['Ann', 'Bob', 'Cy'];
    let opened = -1;
    let clock = 0;
    const page = fakePage({
      verify: () => ({ live: 3, total: 3, scrollOk: true, token: 't' }),
      step: () => (opened + 1 < list.length
        ? { key: `t:${list[++opened]}`, title: list[opened], unread: opened === 1, live: 3, total: 3, scanned: 1, date: '', full: '', snippet: '' }
        : { none: true, live: 3, total: 3, scanned: 0 }),
      state: () => ({ now: (clock += 1000), last: 0, clickAt: 0, len: 10, head: `h${opened}`, url: 'https://example.test/inbox/', busy: false, pending: 0, ready: 'complete', found: true, token: 't' }),
      extract: () => ({ ok: true, title: `Chat with ${list[opened]}`, body: `hello from ${list[opened]}`, chars: 14, url: 'https://example.test/inbox/' }),
      scrollMore: () => ({ moved: false }),
      unseen: () => 0,
      reset: () => true,
    });
    const r = await runEach(page, { dir, minIntervalMs: 0, emptyRounds: 2 });
    expect(r).toMatchObject({ ok: true, verdict: 'DONE', recipe_source: 'cached', items_n: 3, unread_n: 1 });
    expect(page.calls).not.toContain('discover');
    const rows = fs.readFileSync(r.save as string, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((x) => x.body)).toEqual(['hello from Ann', 'hello from Bob', 'hello from Cy']);
    const text = describeEach(r);
    expect(text).toContain('DONE OPENED 3 item(s)');
    expect(text).toContain('recipe cached');
    expect(text).toContain('TIMING list load');
    expect(text).toContain('UNREAD 1 item(s)');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('stops at the limit and tells the caller to resume', async () => {
    const dir = withRecipe(recipe);
    let n = 0;
    let clock = 0;
    const page = fakePage({
      verify: () => ({ live: 5, total: 5, scrollOk: true, token: 't' }),
      step: () => ({ key: `t:${++n}`, title: `item ${n}`, unread: false, live: 5, total: 5, scanned: 1, date: '', full: '', snippet: '' }),
      reset: () => true,
      state: () => ({ now: (clock += 1000), last: 0, clickAt: 0, len: 10, head: `h${n}`, url: 'u', busy: false, pending: 0, ready: 'complete', found: true, token: 't' }),
      extract: () => ({ ok: true, title: `T${n}`, body: 'b', chars: 1, url: 'https://example.test/inbox/' }),
    });
    const r = await runEach(page, { dir, minIntervalMs: 0, limit: 2 });
    expect(r).toMatchObject({ verdict: 'CUT_LIMIT', items_n: 2 });
    expect(r.next).toContain('resume=true');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('list mode returns the rows with dates and opens nothing', async () => {
    const dir = withRecipe(recipe);
    let clock = 0;
    let served = false;
    const page = fakePage({
      verify: () => ({ live: 3, total: 3, scrollOk: true, token: 't' }),
      reset: () => true,
      state: () => ({ now: (clock += 1000), last: 0, clickAt: 0, len: 10, head: 'h', url: 'u', busy: false, pending: 0, ready: 'complete', found: true, token: 't' }),
      listItems: () => {
        if (served) return { items: [], scanned: 0, stop: false };
        served = true;
        return {
          items: [
            { key: 't:Ann', title: 'Ann', date: 'Dec 10, 2025', full: '', snippet: 'see you then', unread: true, href: '' },
            { key: 't:Bob', title: 'Bob', date: 'Nov 3', full: '2026-11-03', snippet: 'thanks', unread: false, href: '' },
          ],
          scanned: 9, stop: false,
        };
      },
      scrollMore: () => ({ moved: false }),
      unseen: () => 0,
    });
    const r = await runEach(page, { dir, mode: 'list', find: 'x', emptyRounds: 1 });
    expect(r).toMatchObject({ ok: true, verdict: 'DONE', opened: false, items_n: 2, scanned: 9 });
    expect(page.calls).not.toContain('step');
    expect(page.calls).not.toContain('extract');
    const text = describeEach(r);
    expect(text).toContain('LISTED 2 item(s), nothing opened, nothing marked read');
    expect(text).toContain('[Dec 10, 2025]');
    expect(text).toContain('2026-11-03');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('answers NO_LIST with a next step when the page has no list', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'each-'));
    const page = fakePage({ discover: () => ({ ok: false, reason: 'no group of 5 or more similar, visible siblings on this page' }) });
    const r = await runEach(page, { dir });
    expect(r).toMatchObject({ ok: false, verdict: 'NO_LIST' });
    expect(r.next).toContain('target=');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
