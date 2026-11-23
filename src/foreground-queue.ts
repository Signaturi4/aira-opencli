/**
 * Foreground queue (AIRA): one FIFO lane per Chrome profile for everything
 * that needs the visible tab (native click, typing, keys, upload, screenshot).
 *
 * It lives in the daemon because every CLI and MCP process goes through it.
 * A session takes the lease, does its action or plan, releases; others wait
 * in order. DOM-only work (look, read, eval, wait) never takes it.
 *
 * A lease ends when it is released, when its holder process is gone, or when
 * the holder sent no command for the idle time. So a crashed agent cannot
 * block the lane.
 */

export type FgMode = 'action' | 'task';

export interface FgHolder {
  session: string;
  pid: number;
  /** True when the lease must end with the process (MCP server, one CLI call). */
  pidBound: boolean;
  mode: FgMode;
  command: string;
  since: number;
  touched: number;
}

export interface FgGrant {
  ok: true;
  waitedMs: number;
  /** Session that held the lane while this one waited. */
  waitedFor?: string;
  mode: FgMode;
}

export interface FgBusy {
  ok: false;
  errorCode: 'foreground_busy';
  error: string;
  errorHint: string;
}

export interface FgRequest {
  session: string;
  pid: number;
  pidBound?: boolean;
  mode?: FgMode;
  command?: string;
  waitMs?: number;
}

interface Waiter extends FgRequest {
  since: number;
  deadline: number;
  waitedFor?: string;
  reply(result: FgGrant | FgBusy): void;
  done: boolean;
}

interface Lane {
  holder?: FgHolder;
  waiters: Waiter[];
}

export interface FgStatusLane {
  profile: string;
  holder: (FgHolder & { heldMs: number; idleMs: number }) | null;
  waiters: Array<{ session: string; pid: number; command: string; waitingMs: number }>;
}

export interface FgOptions {
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  /** An action lease ends after this long without a command from its holder. */
  actionIdleMs?: number;
  /** A task lease ends after this long without a command from its holder. */
  taskIdleMs?: number;
  /** How often waiting lanes are re-checked. 0 disables the timer (tests call sweep()). */
  sweepMs?: number;
}

export const FG_WAIT_DEFAULT_MS = 60_000;
export const FG_WAIT_MAX_MS = 600_000;

function defaultPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class ForegroundQueue {
  private lanes = new Map<string, Lane>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private now: () => number;
  private pidAlive: (pid: number) => boolean;
  private actionIdleMs: number;
  private taskIdleMs: number;
  private sweepMs: number;

  constructor(opts: FgOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.pidAlive = opts.pidAlive ?? defaultPidAlive;
    this.actionIdleMs = opts.actionIdleMs ?? 20_000;
    this.taskIdleMs = opts.taskIdleMs ?? 120_000;
    this.sweepMs = opts.sweepMs ?? 250;
  }

  private lane(profile: string): Lane {
    let lane = this.lanes.get(profile);
    if (!lane) { lane = { waiters: [] }; this.lanes.set(profile, lane); }
    return lane;
  }

  /** Why the current holder no longer counts, or null when it is alive. */
  private deadReason(holder: FgHolder): string | null {
    if (holder.pidBound && !this.pidAlive(holder.pid)) return 'its process is gone';
    const idle = this.now() - holder.touched;
    const limit = holder.mode === 'task' ? this.taskIdleMs : this.actionIdleMs;
    return idle > limit ? `idle for ${Math.round(idle / 1000)} s` : null;
  }

  /**
   * Ask for the lane. `reply` is called once: at once when the lane is free
   * or already ours, later when our turn comes, or with a busy error when the
   * wait runs out. Returns a cancel function for a caller that went away.
   */
  acquire(profile: string, req: FgRequest, reply: (result: FgGrant | FgBusy) => void): () => void {
    const lane = this.lane(profile);
    const now = this.now();
    const mode: FgMode = req.mode ?? 'action';
    if (lane.holder && this.deadReason(lane.holder)) lane.holder = undefined;
    if (lane.holder && lane.holder.session === req.session) {
      // Re-entrant: the same session keeps its lease; a task lease is never downgraded by a single action.
      lane.holder.touched = now;
      lane.holder.pid = req.pid;
      lane.holder.pidBound = req.pidBound === true;
      if (mode === 'task') lane.holder.mode = 'task';
      if (req.command) lane.holder.command = req.command;
      reply({ ok: true, waitedMs: 0, mode: lane.holder.mode });
      return () => undefined;
    }
    if (!lane.holder && lane.waiters.length === 0) {
      lane.holder = { session: req.session, pid: req.pid, pidBound: req.pidBound === true, mode, command: req.command ?? 'input', since: now, touched: now };
      reply({ ok: true, waitedMs: 0, mode });
      return () => undefined;
    }
    const waitMs = Math.min(Math.max(req.waitMs ?? FG_WAIT_DEFAULT_MS, 0), FG_WAIT_MAX_MS);
    const waiter: Waiter = { ...req, mode, since: now, deadline: now + waitMs, waitedFor: lane.holder?.session, reply, done: false };
    lane.waiters.push(waiter);
    this.startTimer();
    this.sweep();
    return () => {
      if (waiter.done) return;
      waiter.done = true;
      lane.waiters = lane.waiters.filter((w) => w !== waiter);
    };
  }

  /** Release by session. Returns false when that session did not hold the lane. */
  release(profile: string, session: string): boolean {
    const lane = this.lanes.get(profile);
    if (!lane?.holder || lane.holder.session !== session) return false;
    lane.holder = undefined;
    this.sweep();
    return true;
  }

  /** Any command from the holding session keeps its lease alive. */
  touch(profile: string, session: string | undefined): void {
    const holder = this.lanes.get(profile)?.holder;
    if (holder && session && holder.session === session) holder.touched = this.now();
  }

  /** Drop dead holders, time out waiters, hand the lane to the next in line. */
  sweep(): void {
    const now = this.now();
    let waiting = 0;
    for (const lane of this.lanes.values()) {
      if (lane.holder && lane.waiters.length > 0 && this.deadReason(lane.holder)) lane.holder = undefined;
      for (const w of [...lane.waiters]) {
        if (w.done || now < w.deadline) continue;
        w.done = true;
        lane.waiters = lane.waiters.filter((x) => x !== w);
        const h = lane.holder;
        const who = h ? `session "${h.session}" (${h.mode} lease, ${h.command}, pid ${h.pid}, held ${Math.round((now - h.since) / 1000)} s)` : 'another session';
        w.reply({
          ok: false,
          errorCode: 'foreground_busy',
          error: `Foreground busy: waited ${((now - w.since) / 1000).toFixed(1)} s, ${who} still holds the visible tab.`,
          errorHint: h?.mode === 'task'
            ? `Session "${h.session}" runs a multi-step task. Retry later, or end it with do=done session=${h.session} (CLI: browser queue --release ${h.session}) if it is finished.`
            : 'Retry in a few seconds. do=queue (CLI: browser queue) shows who holds the lane and who waits.',
        });
      }
      if (!lane.holder && lane.waiters.length > 0) {
        const next = lane.waiters.shift() as Waiter;
        next.done = true;
        lane.holder = { session: next.session, pid: next.pid, pidBound: next.pidBound === true, mode: next.mode ?? 'action', command: next.command ?? 'input', since: now, touched: now };
        const waitedMs = now - next.since;
        next.reply({ ok: true, waitedMs, mode: lane.holder.mode, ...(next.waitedFor ? { waitedFor: next.waitedFor } : {}) });
      }
      waiting += lane.waiters.length;
    }
    if (waiting === 0) this.stopTimer();
  }

  status(): FgStatusLane[] {
    const now = this.now();
    const out: FgStatusLane[] = [];
    for (const [profile, lane] of this.lanes) {
      if (lane.holder && this.deadReason(lane.holder)) lane.holder = undefined;
      if (!lane.holder && lane.waiters.length === 0) continue;
      out.push({
        profile,
        holder: lane.holder ? { ...lane.holder, heldMs: now - lane.holder.since, idleMs: now - lane.holder.touched } : null,
        waiters: lane.waiters.map((w) => ({ session: w.session, pid: w.pid, command: w.command ?? 'input', waitingMs: now - w.since })),
      });
    }
    return out;
  }

  private startTimer(): void {
    if (this.timer || this.sweepMs <= 0) return;
    this.timer = setInterval(() => this.sweep(), this.sweepMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

/** One or two lines for `act do=queue` and `browser queue`. */
export function describeForeground(lanes: FgStatusLane[]): string {
  if (lanes.length === 0) return 'QUEUE free (no session holds the visible tab, nobody waits)';
  return lanes.map((l) => {
    const h = l.holder
      ? `HOLDER session "${l.holder.session}" ${l.holder.mode} lease, ${l.holder.command}, pid ${l.holder.pid}, held ${(l.holder.heldMs / 1000).toFixed(1)} s, idle ${(l.holder.idleMs / 1000).toFixed(1)} s`
      : 'HOLDER none';
    const w = l.waiters.length
      ? l.waiters.map((x, i) => `  ${i + 1}. session "${x.session}" ${x.command}, waiting ${(x.waitingMs / 1000).toFixed(1)} s`).join('\n')
      : '  (nobody waits)';
    return `QUEUE profile ${l.profile}\n${h}\nWAITERS ${l.waiters.length}\n${w}`;
  }).join('\n');
}
