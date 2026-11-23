/**
 * AIRA MCP server: one tool, `act`, over stdio (JSON-RPC 2.0, one JSON per line).
 *
 * Why it is fast: the process stays alive, keeps one page object per session
 * (no CLI start-up and no bridge handshake per step), and every answer already
 * contains the next clickable options, so the model never spends a turn on
 * reading the page.
 *
 * No SDK dependency on purpose: start-up stays in the tens of milliseconds and
 * the protocol surface used here is four methods.
 */

import * as readline from 'node:readline';
import type { IPage } from '../types.js';
import { hintFor, logEvent, PLAYBOOK, readLog } from './troubleshoot.js';
import { act, actSteps, parseActInput, VERBS, type ActInput, type ActPlan } from './actions.js';

export const PROTOCOL_VERSION = '2024-11-05';

export const ACT_TOOL = {
  name: 'act',
  description: [
    'Drive the user\'s real Chrome. ONE action per call. Every answer is:',
    'line 1 = result (OK/ERR, verdict), then PAGE, then OPTIONS: one line per clickable element as `<ref> <role> "<name>"`.',
    'Use the ref number as `target` in the next call. You never need a separate call to read the page.',
    'Verbs: open(url) | look(find?) | click(target) | type(target,text,submit?) | key(key) | upload(files,target?) |',
    'wait(until|gone|selector|seconds) | scroll(direction) | read(target?) | images | save(target=image index,path?) | shot(path?).',
    'target may also be `label:<name>` or `label:<role>:<name>` (resolved when the step runs).',
    'To go fast, send a whole plan as `steps`: [{do,…},{do,…}]; they run in order, stop at the first ERR, and you get one line per step plus the final screen.',
    'On ERR follow the NEXT line. Never repeat a failed click without looking first. do=help prints the playbook, do=debug the last calls.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    properties: {
      do: { type: 'string', enum: [...VERBS], description: 'The action.' },
      session: { type: 'string', description: 'Browser session name; keep the same one for a task. Default "main".' },
      target: { type: ['string', 'number'], description: 'Ref number from OPTIONS, CSS selector, or "x,y" in CSS px. For save: image index.' },
      url: { type: 'string' },
      text: { type: 'string', description: 'Text to type.' },
      submit: { type: 'boolean', description: 'type: press Enter afterwards.' },
      key: { type: 'string', description: 'Key name, e.g. Enter, Escape, Tab.' },
      files: { type: 'array', items: { type: 'string' }, description: 'upload: absolute paths, http(s) URLs or data: URIs. The tool finds the right way to attach them and reports which one worked.' },
      clipboard: { type: 'boolean', description: 'upload: also allow a real clipboard paste (replaces the system clipboard).' },
      convert: { type: 'string', enum: ['png', 'jpeg'], description: 'upload: convert images first.' },
      max_px: { type: 'number', description: 'upload: downscale images to this longest side.' },
      until: { type: 'string', description: 'wait: text that must appear.' },
      gone: { type: 'string', description: 'wait: text that must disappear.' },
      selector: { type: 'string', description: 'wait: CSS selector that must match.' },
      seconds: { type: 'number', description: 'wait: maximum seconds (default 30, cap 300).' },
      direction: { type: 'string', enum: ['up', 'down'] },
      find: { type: 'string', description: 'look: only options containing this text.' },
      path: { type: 'string', description: 'save/shot: output file.' },
      expect: { type: 'string', description: 'click: JS expression that must be truthy afterwards.' },
      force: { type: 'boolean', description: 'click: click even when covered. Use on purpose only.' },
      max: { type: 'number', description: 'Maximum option lines (default 40).' },
      steps: { type: 'array', maxItems: 20, items: { type: 'object' }, description: 'A plan: several actions (same fields as above) run in order in one call. Use instead of `do`.' },
    },
    additionalProperties: false,
  },
} as const;

export interface McpServerDeps {
  getPage(session: string): Promise<IPage>;
  version: string;
  log?(line: string): void;
}

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type RpcResponse = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export function createMcpHandler(deps: McpServerDeps) {
  const pages = new Map<string, IPage>();
  // One action at a time per session: a second call waits instead of racing the first.
  const queues = new Map<string, Promise<unknown>>();

  async function runAct(input: ActInput | ActPlan): Promise<{ ok: boolean; text: string }> {
    const session = input.session?.trim() || 'main';
    // help and debug must work even when the browser is unreachable.
    if (!('steps' in input) && input.do === 'help') return { ok: true, text: PLAYBOOK };
    if (!('steps' in input) && input.do === 'debug') return { ok: true, text: readLog(input.max ?? 10) };
    let page = pages.get(session);
    if (!page) {
      try {
        page = await deps.getPage(session);
        pages.set(session, page);
      } catch (err) {
        const message = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        return { ok: false, text: `ERR cannot reach the browser: ${message}\nNEXT ${hintFor(`not connected ${message}`)}` };
      }
    }
    const out = 'steps' in input
      ? await actSteps(page, input.steps, { session, max: input.max })
      : await act(page, { ...input, session });
    // A failed step may mean the page object went stale; reconnect on the next call.
    if (!out.ok && /failed:/.test(out.text)) pages.delete(session);
    return out;
  }

  return async function handle(req: RpcRequest): Promise<RpcResponse | null> {
    const id = req.id ?? null;
    const isNotification = req.id === undefined;
    const reply = (result: unknown): RpcResponse => ({ jsonrpc: '2.0', id, result });
    const error = (code: number, message: string): RpcResponse => ({ jsonrpc: '2.0', id, error: { code, message } });

    switch (req.method) {
      case 'initialize':
        return reply({
          protocolVersion: typeof req.params?.protocolVersion === 'string' ? req.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'aira-opencli', version: deps.version },
          instructions: 'Call act. Read line 1 for the result, pick the next ref from OPTIONS, call act again. Keep one session per task.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: [ACT_TOOL] });
      case 'tools/call': {
        if (req.params?.name !== ACT_TOOL.name) return error(-32602, `Unknown tool: ${String(req.params?.name)}`);
        const parsed = parseActInput(req.params?.arguments);
        if (typeof parsed === 'string') {
          return reply({ content: [{ type: 'text', text: `ERR bad input: ${parsed}\nNEXT Fix the arguments and call act again.` }], isError: true });
        }
        const session = parsed.session?.trim() || 'main';
        const previous = queues.get(session) ?? Promise.resolve();
        const current = previous.then(() => runAct(parsed), () => runAct(parsed));
        queues.set(session, current.catch(() => undefined));
        const started = Date.now();
        const out = await current;
        logEvent({
          session, input: parsed, ok: out.ok, ms: Date.now() - started,
          head: out.text.split('\n')[0], ...(out.ok ? {} : { answer: out.text.slice(0, 2000) }),
        });
        deps.log?.(`${'steps' in parsed ? `plan(${parsed.steps.length})` : parsed.do} ${session} -> ${out.text.split('\n')[0]}`);
        return reply({ content: [{ type: 'text', text: out.text }], isError: !out.ok });
      }
      default:
        if (isNotification) return null;
        return error(-32601, `Method not found: ${String(req.method)}`);
    }
  };
}

/** Serve MCP on stdin/stdout until stdin closes. stdout carries protocol lines only. */
export async function serveMcpStdio(deps: McpServerDeps): Promise<void> {
  const handle = createMcpHandler(deps);
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Set<Promise<void>>();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed) as RpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const task = handle(req)
      .then((res) => { if (res) process.stdout.write(`${JSON.stringify(res)}\n`); })
      .catch((err) => {
        process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })}\n`);
      });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }
  await Promise.all(pending);
}
