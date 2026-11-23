/**
 * Client side of the daemon's foreground queue (see ../foreground-queue.ts).
 *
 * Native input calls `ensureForeground` first; the lease is taken lazily, so
 * DOM-only work never queues. The caller releases after its action or plan.
 */

import { sendCommand } from './daemon-client.js';

export interface FgRoute {
  session: string;
  contextId?: string;
  preferredContextId?: string;
}

interface Held { at: number; route: FgRoute }

const held = new Map<string, Held>();
const tasks = new Set<string>();
let unsupported = false;
let note = '';

const RECHECK_MS = 5_000;

function off(): boolean {
  return unsupported || process.env.OPENCLI_FG_QUEUE === 'off';
}

function route(r: FgRoute): Record<string, unknown> {
  return {
    session: r.session,
    ...(r.contextId && { contextId: r.contextId }),
    ...(r.preferredContextId && { preferredContextId: r.preferredContextId }),
  };
}

/** Take (or confirm) the foreground lease for this session. Waits in line; throws when the wait runs out. */
export async function ensureForeground(r: FgRoute, command = 'input'): Promise<void> {
  if (off()) return;
  const mine = held.get(r.session);
  if (mine && Date.now() - mine.at < RECHECK_MS) return;
  const waitMs = Number(process.env.OPENCLI_FG_WAIT_MS) > 0 ? Number(process.env.OPENCLI_FG_WAIT_MS) : 60_000;
  try {
    const got = await sendCommand('fg-acquire', {
      ...route(r), pid: process.pid, pidBound: true, lease: tasks.has(r.session) ? 'task' : 'action', command, waitMs, timeoutMs: waitMs + 5_000,
    } as never) as { waitedMs?: number; waitedFor?: string } | undefined;
    held.set(r.session, { at: Date.now(), route: r });
    if (got?.waitedFor && (got.waitedMs ?? 0) >= 100) note = `waited ${((got.waitedMs ?? 0) / 1000).toFixed(1)} s for session ${got.waitedFor}`;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Foreground busy/i.test(message)) throw err;
    // A daemon without the queue (older build): work as before, without ordering.
    unsupported = true;
  }
}

/** Give the lane back after an action or plan. A task lease stays until `endTask`. */
export async function releaseForeground(session: string, opts: { force?: boolean; route?: FgRoute } = {}): Promise<boolean> {
  const mine = held.get(session);
  if (!opts.force && (!mine || tasks.has(session))) return false;
  held.delete(session);
  tasks.delete(session);
  if (off()) return false;
  try {
    const r = await sendCommand('fg-release', route(mine?.route ?? opts.route ?? { session }) as never) as { released?: boolean } | undefined;
    return r?.released === true;
  } catch {
    return false;
  }
}

/** Hold the lane across calls (`lease: "task"`), until `releaseForeground(session, { force: true })`. */
export async function startTask(r: FgRoute): Promise<void> {
  tasks.add(r.session);
  held.delete(r.session);
  await ensureForeground(r, 'task');
}

export function holdsTask(session: string): boolean {
  return tasks.has(session);
}

/** "waited 3.2 s for session li1", once. Empty when there was no wait. */
export function takeWaitNote(): string {
  const out = note;
  note = '';
  return out;
}

export async function foregroundStatus(r: Partial<FgRoute> = {}): Promise<unknown[]> {
  if (off()) return [];
  try {
    const got = await sendCommand('fg-status', route({ session: r.session ?? 'queue', ...r }) as never) as { lanes?: unknown[] } | undefined;
    return got?.lanes ?? [];
  } catch {
    return [];
  }
}

/** Release every action lease of this process (CLI exit path). */
export async function releaseAllForeground(): Promise<void> {
  for (const session of [...held.keys()]) await releaseForeground(session);
}
