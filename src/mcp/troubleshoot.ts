/**
 * Debugging for the MCP `act` tool.
 *
 *   - every call is appended to a daily JSONL file (on by default) so failed
 *     runs can be studied later and turned into fixes;
 *   - known error messages are mapped to one concrete next step, so the model
 *     gets a workaround instead of a stack trace;
 *   - `do=help` prints the playbook, `do=debug` prints the last log lines.
 *
 * Log file: ~/.opencli/aira-mcp/log-YYYY-MM-DD.jsonl
 * Turn off with OPENCLI_MCP_LOG=off, move with OPENCLI_MCP_LOG_DIR=<dir>.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

interface Rule {
  when: RegExp;
  next: string;
}

/** First matching rule wins. Order: most specific first. */
const RULES: Rule[] = [
  { when: /extension.*not connected|no extension|not connected|ECONNREFUSED|daemon/i, next: 'The browser bridge is down. Ask the user to open Chrome with the OpenCLI extension enabled, then run `opencli doctor`. Do not retry before that.' },
  { when: /page not found|stale|target closed|no tab|detached|session.*(lost|expired|missing)/i, next: 'The tab is gone. Call do=open with the url again; the session is re-attached automatically.' },
  { when: /javascript dialog|alert|beforeunload/i, next: 'A browser dialog is blocking the page. Ask the user to dismiss it in Chrome, then call do=look.' },
  { when: /REFUSED_COVERED|covered by/i, next: 'Something is on top of the target. Try do=key key=Escape, or click the close button of the overlay named in the message, then repeat the click once.' },
  { when: /REFUSED_NOT_VISIBLE/i, next: 'The target has no visible box. Open the menu or section that contains it, or do=scroll, then do=look for a fresh ref.' },
  { when: /NOT_FOUND|no option labelled|not found/i, next: 'The ref or label no longer exists. Call do=look (optionally with find) and use a ref from the new OPTIONS.' },
  { when: /options match/i, next: 'The label is ambiguous. Use the ref number, or label:<role>:<exact name>.' },
  { when: /Native input requires a visible/i, next: 'The page is hidden (tab inactive or window covered) and the strict input guard is on. Call do=debug to see which; ask the user to unset OPENCLI_INPUT_GUARD or bring the Chrome window to the front.' },
  { when: /Foreground busy/i, next: 'Another session is using the visible tab. Call do=queue to see who; wait a few seconds and repeat the step once. If the holder is a finished task, do=done with its session name frees it.' },
  { when: /MISSED/i, next: 'Another element took the click. Call do=look, close what is in the way, then click the ref again once.' },
  { when: /NO_CHANGE/i, next: 'The click landed but nothing changed. The control may need hover or focus first, or the page is still busy: do=wait seconds=1, then do=look.' },
  { when: /file not found/i, next: 'Pass absolute paths of files that exist on this machine.' },
  { when: /Not allowed|too old|reload the OpenCLI extension/i, next: 'Stop and tell the user: the OpenCLI Chrome extension must be reloaded/updated to match this CLI (Chrome only accepts files through file-chooser interception).' },
  { when: /file input|upload/i, next: 'Call do=upload with target=<ref of the site\'s upload button or drop zone>. Do not click the upload button yourself first: a native file dialog would open (if one did, do=key key=Escape).' },
  { when: /timed out|timeout/i, next: 'It is taking longer than the budget. Call do=wait with until/gone/selector for the thing you expect, or do=look to see the current state.' },
  { when: /could not read image|tainted|cors/i, next: 'The image cannot be read from the page. Use do=shot to capture the screen, or click the site\'s own download button.' },
  { when: /typeText|type failed|not editable/i, next: 'Typing was rejected. Click the field first (do=click), then do=type again; for rich editors type without submit and press do=key key=Enter.' },
];

export function hintFor(message: string, fallback = 'Call do=look to see the page, then retry once. If it fails again call do=debug.'): string {
  for (const rule of RULES) {
    if (rule.when.test(message)) return rule.next;
  }
  return fallback;
}

export const PLAYBOOK = [
  'HOW TO USE act',
  '1. do=open url=… → read OPTIONS.',
  '2. Pick a ref (or label:<name>) and act: click / type / upload / key.',
  '3. Every answer already lists the new OPTIONS; do not call look after an OK answer.',
  '4. For known flows send one plan: steps=[{do:click,target:"label:Add files"},{do:upload,files:[…]},{do:type,target:"label:textbox:Ask",text:"…",submit:true},{do:wait,gone:"Stop",seconds:120},{do:images}].',
  '5. Long work (generation, upload): do=wait with until / gone / selector, never a fixed sleep.',
  '6. Result files: do=images then do=save target=<index> path=<file>.',
  '',
  'QUEUE',
  'Only one session per Chrome profile uses the visible tab at a time (click, type, key, upload, shot). Others wait in line; the result then says "waited 3.2 s for session X". look, read, wait, images and each never wait. For a multi-step task that must not be interleaved, add lease="task" to the first call and finish with do=done. do=queue shows holder and waiters.',
  'WHEN IT FAILS',
  '- ERR … covered by X      → do=key key=Escape, or close X, then click once more.',
  '- ERR … NOT_FOUND / label → do=look find=<word>, use the new ref.',
  '- ERR … NO_CHANGE         → do=wait seconds=1, do=look; the control may need hover/focus.',
  '- ERR … MISSED            → do=look, close what took the click.',
  '- ERR cannot reach browser → stop; the user must open Chrome with the extension (opencli doctor).',
  '- ERR upload FAILED       → read the per-strategy lines; pass target=<ref of upload button>, then clipboard=true as a last resort.',
  '- OPTIONS is empty        → the page is loading: do=wait selector=<css> or seconds=2.',
  '- Wrong page / tab gone   → do=open again.',
  '- Screenshots are rarely needed: OPTIONS already lists what can be clicked and do=read gives the text. do=shot saves a PNG under ~/.opencli/aira-mcp/shots/ and prints the path.',
  '- Hidden page (Chrome covered by another app, or tab not active): nothing is brought to the front. Clicks run inside the page and are marked "via dom"; typing works; real key presses are not delivered, so click the Send/OK button instead of pressing Enter.',
  '- Same error twice        → do=debug, report the last lines to the user; do not loop.',
].join('\n');

function logDir(): string | null {
  const flag = process.env.OPENCLI_MCP_LOG;
  if (flag === 'off' || flag === '0' || flag === 'false') return null;
  return process.env.OPENCLI_MCP_LOG_DIR || path.join(os.homedir(), '.opencli', 'aira-mcp');
}

export function logFile(date = new Date()): string | null {
  const dir = logDir();
  return dir ? path.join(dir, `log-${date.toISOString().slice(0, 10)}.jsonl`) : null;
}

/** Shorten long strings so typed text and prompts do not bloat the log. */
export function compactInput(input: unknown): unknown {
  if (typeof input === 'string') return input.length > 200 ? `${input.slice(0, 200)}…(${input.length})` : input;
  if (Array.isArray(input)) return input.map(compactInput);
  if (input && typeof input === 'object') {
    return Object.fromEntries(Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, compactInput(v)]));
  }
  return input;
}

export interface LogEntry {
  session: string;
  input: unknown;
  ok: boolean;
  ms: number;
  /** First line of the answer. */
  head: string;
  /** Full answer, kept only for failures. */
  answer?: string;
}

export function logEvent(entry: LogEntry): void {
  const file = logFile();
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, ...entry, input: compactInput(entry.input) })}\n`);
  } catch {
    // Logging must never break an action.
  }
}

export function readLog(n = 10): string {
  const file = logFile();
  if (!file) return 'Logging is off (OPENCLI_MCP_LOG=off).';
  if (!fs.existsSync(file)) return `No calls logged today. File: ${file}`;
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-Math.max(1, Math.min(n, 50)));
  const rows = lines.map((line) => {
    try {
      const e = JSON.parse(line) as LogEntry & { ts: string };
      return `${e.ts.slice(11, 19)} ${e.ok ? 'OK ' : 'ERR'} ${String(e.ms).padStart(5)}ms ${e.session} ${JSON.stringify(e.input).slice(0, 110)} => ${e.head.slice(0, 120)}`;
    } catch {
      return line.slice(0, 200);
    }
  });
  return `LOG ${file}\n${rows.join('\n')}`;
}
