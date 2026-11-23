# AIRA OpenCLI: what this fork adds

Fork of [jackwener/opencli](https://github.com/jackwener/opencli) (Apache-2.0), base v2.0.3. Upstream behaviour is unchanged; the additions are below.

| Addition | Where | Use |
|---|---|---|
| Precise click (port of the `precise-click` skill's `pclick`) | `src/browser/precise.ts` | `opencli browser <s> targets`, `at <x> <y>`, `pclick <target>`, `pclick-log` |
| Smart file upload | `src/browser/upload.ts` | `opencli browser <s> attach <files...>` |
| MCP server with one tool, `act` | `src/mcp/` | `opencli mcp` |
| `open` no longer waits forever | `src/commands/browser.ts` | `opencli browser <s> open <url> --timeout 15` |

Diagram of the agent loop: [act-loop.drawio](./act-loop.drawio) (open at app.diagrams.net).

## Install and register

```bash
git clone https://github.com/Signaturi4/aira-opencli && cd aira-opencli
npm ci --ignore-scripts && npm run build
claude mcp add aira-browser -- node "$PWD/dist/src/main.js" --profile <chrome-profile-id> mcp
```

Without a build: `claude mcp add aira-browser -- npx --prefix "$PWD" tsx "$PWD/src/main.ts" --profile <id> mcp`.

## The `act` tool

One tool, one call per step. The model never reads the page: every answer already lists what can be clicked.

```
OK click 14 "Send" PASS (url changed) 212ms
PAGE Gemini | https://gemini.google.com/app/abc
OPTIONS 23
3 button "New chat"
7 textbox "Ask Gemini"
9 button "Upload" COVERED by div.overlay
```

- Line 1: `OK` or `ERR`, the verb, the verdict and the time. After `ERR` comes `NEXT <what to do>`.
- `OPTIONS`: `<ref> <role> "<name>"` with `DISABLED`, `COVERED by ...` or `OFFSCREEN` when it matters.
- Targets: a ref number, `label:<name>`, `label:<role>:<name>`, a CSS selector or `x,y`.

| `do` | Fields | Result |
|---|---|---|
| `open` | `url` | navigates, waits at most 12 s + 5 s, marks `STILL LOADING` instead of hanging |
| `look` | `find`, `max` | the options list only |
| `click` | `target`, `expect`, `force` | one trusted click with a verdict |
| `type` | `target`, `text`, `submit` | types, optionally presses Enter |
| `key` | `key` | one key press |
| `upload` | `files`, `target`, `clipboard`, `convert`, `max_px` | attaches files, says which strategy worked |
| `wait` | `until`, `gone`, `selector`, `seconds` | waits for text or an element |
| `scroll` | `direction` | scrolls one screen |
| `read` | `selector` | visible text |
| `images` / `save` | `target`, `path` | lists large images, saves one to disk |
| `shot` | `path` | annotated screenshot |
| `help` / `debug` | `max` | playbook, recent log lines (no browser needed) |

A whole plan in one call: `{"steps":[{"do":"click","target":"label:New chat"},{"do":"type","target":"label:textbox:Ask Gemini","text":"...","submit":true}]}`.
Steps run in order with no model round trip in between; the run stops at the first `ERR` and says which steps were not run.

## Read every item of a list: `act do=each` / `browser each`

Open a page with a list (inbox, search results, catalogue) and call `do=each`. No selectors are needed.

1. **List**: the largest group of 5 or more similar siblings that can be opened, with its scroll container.
2. **Detail**: it opens two items and takes the region that changed (a pane in the same page), or switches to navigate mode when opening an item replaces the page.
3. **Selectors** come from ids, roles, `data-testid`, ARIA labels and structure, not generated class names. The answer prints them (`LIST`, `DETAIL`); override with `target=` (list or items) and `selector=` (detail) plus `rediscover=true`.
4. **Loop**: first unseen rendered item (seen-set by link or text, never by index, so virtualized lists work), in-page click, wait until the detail changed and stayed quiet (DOM, requests in flight, busy markers; no fixed sleeps), save title + text, scroll for more, stop after 3 rounds without a new item.
5. **Recipe** is cached per origin + path pattern in `~/.opencli/aira-mcp/recipes/` and re-verified on use; a stale one is discovered again.

Options: `limit`, `time_budget` (seconds, default 100; continue with `resume=true`), `min_interval_ms` (default 300, the floor between two items), `save=<file>` (JSON lines, one item per line; default under `~/.opencli/aira-mcp/each/`).

The answer is one line per item, a `TIMING` block (list load, per item median / p90 / max, items per minute) and the file path. It is read-only: it only opens items and never types or submits. It works on a hidden tab and does not take the foreground queue. On sites with unread markers, opening an item marks it read; the answer says how many.

## Foreground queue and hidden pages

- One session per Chrome profile uses the visible tab at a time (click, type, key, upload, shot). Others wait in the daemon queue; the answer then says `waited 3.2 s for session X`. `do=queue` / `browser queue` shows holder and waiters; `lease:"task"` keeps the lane across calls until `do=done`. A lease ends when its process dies or after 20 s (action) / 120 s (task) without a command.
- A page is `hidden` when its tab is not the active one **or** when another app covers the Chrome window (macOS occlusion). Nothing is raised by default: clicks then run in the page (`via dom (hidden page, untrusted)`), text goes through `insertText`, keys are checked and fall back to in-page events. `--window foreground` (or `OPENCLI_WINDOW=foreground`) opts into activating the tab and raising Chrome; `OPENCLI_INPUT_GUARD=strict` refuses instead.
- `OPTIONS` leaves out unnamed wrappers and inner copies of one control; `browser targets` still lists them with `noise: true`.

## Click verdicts

`PASS`, `NO_CHANGE` (clicked, nothing changed), `EXPECT_FAILED`, `MISSED` (another element got the click), `REFUSED_COVERED`, `REFUSED_NOT_CLICKABLE`, `REFUSED_NOT_VISIBLE`, `NOT_FOUND`, `NO_NATIVE_CLICK`.
A refusal means nothing was clicked. `force` clicks through a cover.

## Upload strategies

Tried in this order; each is checked on the page (preview image, attachment element, file name, or files held by a visible input) before the next one runs.

1. `input`: sets the files on the `<input type=file>` whose `accept` fits. Images are converted to PNG when the input rejects their type (macOS `sips`).
2. `capture`: presses the site's upload button with file-chooser calls intercepted, so no native dialog opens, then sets the files on the input the site reached for. Follows up to three menu levels.
3. `drop`: a drop with real `File` objects on the editor or drop zone.
4. `paste`: a paste event with the same files.
5. `clipboard` (only with `clipboard: true`, macOS): puts the image on the system clipboard and sends a real paste. It replaces the clipboard.

A strategy passes only when the page visibly shows every file: a visible preview image, a visible chip that holds an image or the file name, or the file name in the page text, still there 0.7 s later. Files held by a hidden input do not count.

When Chrome or an old extension refuses the native file set (`Not allowed`), `input` and `capture` put real `File` objects on the input in the page and fire `change` (at most 12 MB).

Checked live on gemini.google.com/app (2026-11-23): `capture` and `drop` both attach; a script `paste` is ignored.

Files can be local paths, `http(s)` URLs or `data:` URIs. Drop and paste carry at most 12 MB.

Known limits: `drop` and `paste` are script events, not trusted ones; sites that check `isTrusted` ignore them. A trusted drag needs `Input.dispatchDragEvent` added to the extension's CDP allowlist (`extension/src/background.ts`), which means loading this fork's extension.

`{"code":-32000,"message":"Not allowed"}` comes from Chrome refusing `DOM.setFileInputFiles` over `chrome.debugger` (crbug 928255). The extension has to use file-chooser interception; an old CLI or extension does not. Fix: update the CLI and reload the extension so both match. "Allow access to file URLs" is not known to be required.

## Logs

| Log | Path | Off switch |
|---|---|---|
| Every `act` call (input, ok, ms, first line) | `~/.opencli/aira-mcp/log-YYYY-MM-DD.jsonl` | `OPENCLI_MCP_LOG=off`, move with `OPENCLI_MCP_LOG_DIR` |
| Every precise click | `~/.opencli/precise-click/log.jsonl` | `OPENCLI_PRECISE_LOG=off` |

`act do=debug` returns the last lines; `opencli browser <s> pclick-log` shows click history.

## When a command seems to hang on the owner's Mac

Check `~/.claude/ram-guard/logs/watchdog-*.jsonl` for `SIGSTOP`. Under memory pressure the ram-guard watchdog pauses jobs started through `heavy-guard2`, and a paused `opencli` looks like a page that never loads. The MCP server is one long-lived process started by the MCP host, so it is not paused this way.

## Daemon security and switching from the stock CLI

The daemon in this fork has the same three rules as the owner's `opencli-hardening v1` patch, now in the source (`src/daemon.ts`): loopback `Host` only, an extension allowlist (Web Store id, `OPENCLI_EXTENSION_IDS`, `~/.opencli/allowed-extensions`) and a per-start token in `~/.opencli/daemon.token` that the CLI sends as `X-OpenCLI-Token`. `OPENCLI_HARDENING=off` is for tests.

The first command run from this fork sees a daemon of another version as stale and replaces it (upstream behaviour). Do that when no other session is using the stock CLI, otherwise the two CLIs keep restarting each other's daemon.

## Not in this fork

- No Rust rewrite: the time goes to the browser round trip, not to Node.
- No built-in model: the MCP host's model (for example Haiku) calls `act`.
