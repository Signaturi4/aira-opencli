import { describe, expect, it } from 'vitest';
import { describeForeground, ForegroundQueue, type FgBusy, type FgGrant } from './foreground-queue.js';

function setup(over: { alive?: Set<number> } = {}) {
  const clock = { t: 1_000 };
  const alive = over.alive ?? new Set([1, 2, 3]);
  const q = new ForegroundQueue({ now: () => clock.t, pidAlive: (pid) => alive.has(pid), sweepMs: 0 });
  const got: Record<string, FgGrant | FgBusy> = {};
  const ask = (session: string, pid: number, extra: Record<string, unknown> = {}) =>
    q.acquire('p1', { session, pid, pidBound: true, ...extra }, (r) => { got[session] = r; });
  return { q, clock, alive, got, ask };
}

describe('foreground queue', () => {
  it('lets two sessions on one profile run one after the other, in order', () => {
    const { q, clock, got, ask } = setup();
    ask('li1', 1, { command: 'click' });
    ask('gem', 2, { command: 'type' });
    ask('third', 3);
    expect(got.li1).toMatchObject({ ok: true, waitedMs: 0 });
    expect(got.gem).toBeUndefined();
    clock.t += 3200;
    expect(q.release('p1', 'li1')).toBe(true);
    expect(got.gem).toMatchObject({ ok: true, waitedMs: 3200, waitedFor: 'li1' });
    expect(got.third).toBeUndefined();
    q.release('p1', 'gem');
    expect(got.third).toMatchObject({ ok: true });
    q.release('p1', 'third');
    expect(q.status()).toEqual([]);
  });

  it('is re-entrant for the holder and separate per profile', () => {
    const { q, got, ask } = setup();
    ask('a', 1);
    ask('a', 1);
    expect(got.a).toMatchObject({ ok: true, waitedMs: 0 });
    let other: FgGrant | FgBusy | undefined;
    q.acquire('p2', { session: 'b', pid: 2 }, (r) => { other = r; });
    expect(other).toMatchObject({ ok: true, waitedMs: 0 });
  });

  it('frees the lane when the holder process dies mid-lease', () => {
    const { q, clock, alive, got, ask } = setup();
    ask('crashed', 1);
    ask('waiter', 2);
    expect(got.waiter).toBeUndefined();
    alive.delete(1);
    clock.t += 300;
    q.sweep();
    expect(got.waiter).toMatchObject({ ok: true, waitedFor: 'crashed' });
  });

  it('frees an idle holder but keeps one that still sends commands', () => {
    const { q, clock, got, ask } = setup();
    ask('slow', 1);
    ask('waiter', 2);
    clock.t += 15_000;
    q.touch('p1', 'slow');
    clock.t += 15_000;
    q.sweep();
    expect(got.waiter).toBeUndefined();
    clock.t += 21_000;
    q.sweep();
    expect(got.waiter).toMatchObject({ ok: true });
  });

  it('holds a task lease across calls until done or the long idle time', () => {
    const { q, clock, got, ask } = setup();
    q.acquire('p1', { session: 'agent', pid: 1, mode: 'task' }, () => undefined);
    ask('other', 2, { waitMs: 200_000 });
    clock.t += 60_000;
    q.sweep();
    expect(got.other).toBeUndefined();
    q.release('p1', 'agent');
    expect(got.other).toMatchObject({ ok: true, waitedMs: 60_000, waitedFor: 'agent' });
  });

  it('times out a waiter with an error that names the holder and the next step', () => {
    const { q, clock, got, ask } = setup();
    ask('li1', 1, { command: 'each' });
    ask('gem', 2, { waitMs: 5_000 });
    clock.t += 5_100;
    q.touch('p1', 'li1');
    q.sweep();
    expect(got.gem).toMatchObject({ ok: false, errorCode: 'foreground_busy' });
    expect((got.gem as FgBusy).error).toContain('session "li1"');
    expect((got.gem as FgBusy).errorHint).toContain('do=queue');
    expect(describeForeground(q.status())).toContain('HOLDER session "li1"');
  });

  it('drops a waiter whose caller went away', () => {
    const { q, got, ask } = setup();
    ask('a', 1);
    const cancel = ask('b', 2);
    ask('c', 3);
    cancel();
    q.release('p1', 'a');
    expect(got.b).toBeUndefined();
    expect(got.c).toMatchObject({ ok: true });
  });
});
