# aside-acp

Wrap the [Aside](https://aside.so) browser agent as an **ACP** (Agent Client
Protocol) server, so [Paseo](https://paseo.sh) can drive it remotely — from
the CLI, the desktop app, or the Hub (phone/anywhere via Paseo's relay).

Built by adapting the proven mechanics of
[aside-telegram-bridge](https://github.com/SaiAmartya/aside-telegram-bridge):
`aside exec` per turn, `messages.jsonl` polling for streaming, the
`[[QUESTION]]`/`[[APPROVAL]]` soft-confirm protocol, full-access sessions.
The difference: instead of Telegram buttons, approvals surface through
**Paseo's native Approve/Deny UI** (`session/request_permission`).

## How it works

```
Paseo daemon ──spawn──> node server.js  (ACP over stdio, ND-JSON)
                             │
                             ├─ aside exec -m <provider/model> [--session <sid>] [--effort <lvl>] <prompt>
                             │     └─ polls ~/.aside/u/<n>/sessions/<sid>/messages.jsonl
                             │        (new assistant text → session/update agent_message_chunk)
                             ├─ aside repl aside.sessions.update('<sid>', {permissionMode:'full-access'})
                             └─ [[APPROVAL]] block → session/request_permission → inject grant → continue
```

- Sessions are lazy: `session/new` returns a UUID; the aside session is
  created (persona bootstrap) on the first `session/prompt`.
- Model enumeration comes from `~/.aside/u/<n>/models.json`, so every entry
  in Paseo's model picker is a valid `provider/model` id for `aside exec -m`.
- The aside session runs **full-access** (aside's CLI has no
  non-interactive confirmation path) — the soft protocol is the gate.

## Install / run

```bash
cd ~/Dev/aside-acp
npm install
node test/client.mjs      # E2E against real aside (initialize→prompt→cancel)
node test/approval.mjs    # approval translation flow (simulated action)
```

Config: `~/.aside-acp.json` (optional). Fields: `aside_cli`, `account`,
`owner_name`, `default_model`, `default_effort`, `exec_timeout_seconds`,
`style` (formal|casual), `grant_full_access`, `approved_models`.

## Register as a Paseo provider

```bash
node scripts/register-paseo-provider.mjs   # adds agents.providers.aside to ~/.paseo/config.json
launchctl unload ~/Library/LaunchAgents/com.paseo.daemon.plist
launchctl load -w ~/Library/LaunchAgents/com.paseo.daemon.plist
paseo run --provider aside "Open https://example.com and tell me the page title"
# remove: node scripts/register-paseo-provider.mjs --remove
```

## Pitfalls learned (all fixed here)

1. `aside exec --session` wants the **id suffix** (`66LMoOymEbb153gS`), not
   the full `<date>_<id>` dir name — and it exits 0 with
   "Session not found" on stderr. Silent failure trap.
2. `messages.jsonl` contains multi-byte chars; slice it as a **Buffer by
   byte offset**, never `string.slice(offset)`, or JSON lines corrupt.
   Also handle compaction rewrites (size shrinks) by full re-scan + dedupe.
3. `requestPermission` resolves `{ outcome: { outcome, optionId } }` —
   check the nested object.
4. SDK `ndJsonStream(output, input)` — writable FIRST, readable second
   (the official examples name them misleadingly).
5. Paseo probes ACP providers with throwaway connections — make
   `session/new` lazy or probes burn real aside sessions.

## Known minor issue

Paseo logs a non-fatal zod warning (`compactSnapshot … models … label`)
while rendering some timeline entries; agents still complete and render
correctly. Investigate if the timeline ever shows garbled model info.
