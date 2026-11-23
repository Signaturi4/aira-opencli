# Benchmarks

Measured on 2026-11-23, macOS, Chrome profile `htxmh4he`, branch `aira/precise-click-mcp`. Timings only; page contents are not stored here.

## LinkedIn inbox walk with `each`

| Metric | Value |
|---|---|
| Conversations opened and read | 247 |
| Run time (5 calls, `resume`) | 465 s (7 min 45 s) |
| Rate | about 32 per minute |
| Per item, median / p90 / max | 1.7 s / 2.5 s / 5.1 s |
| List load, discovered / cached recipe | 4.6 s / 0.3 s |
| `min_interval_ms` | 300 |

Per-item time is mostly the site loading the thread.

## Fresh agent, only the `act` tool, Sonnet

| Task | Build | `act` calls | Time | Cost | Result |
|---|---|---|---|---|---|
| Gemini: attach 2 images, send prompt, save render | `4a3a852` and earlier | 3 to 17 | 43 to 46 s | $0.05 to $0.15 | failed (hidden page, then upload) |
| Gemini: same | `6c42543` | 17 | 338 s | $0.29 | image saved |
| LinkedIn: read the newest 2025 message | `4a3a852` | 8 | 48 s | $0.12 | failed (`each` not advertised) |
| LinkedIn: same | `ee3e9e1` | 4 | 53 s | $0.13 | found and read |

## Latency per step

| Step | Time |
|---|---|
| Node start | 17 ms |
| Daemon round trip | 6 ms |
| MCP `look` / `read` (server already running) | 6 to 33 ms |
| One CLI command (`browser eval`) | 256 ms |
| `click` with verification, median | 1.4 s |
| `type`, median | 3.1 s |
| `open`, median | 5.6 s |
| `upload`, median | 5.7 s |
| Model turn between calls (fresh agent) | about 2.7 s |
