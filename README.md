# Aside ACP provider for Paseo (unofficial)

<img src="icon.png" width="64" alt="Aside logo">

Unofficial community integration. Not affiliated with or endorsed by Aside.

Use [Aside](https://aside.com)'s browser agent from [Paseo](https://paseo.sh). Select **Aside** when creating an agent, choose a model, thinking effort, permission mode and Final confirm, then send browser tasks from desktop or mobile.

The same project also provides an ACP server over stdio for other ACP clients.

The separately packaged Paseo plugin is [paseo-aside-provider](https://github.com/JasprW/paseo-aside-provider). It pins a released revision of this bridge and is the recommended GitHub installation:

```sh
paseo plugin install git:JasprW/paseo-aside-provider
```

Use only one Aside provider installation at a time. This repository retains its local plugin entry for development and compatibility.

## Requirements

- Paseo 0.11.2, with trusted plugins enabled.
- Aside running and signed in on the daemon machine, with its CLI installed.
- Aside local daemon 1.26.1011.1437 or newer with native suspension IDs and the CLI authentication helper.
- Aside CLI 1.26.1010.1739 or newer. This bridge uses `session resume`, `session stop`, and session model updates.
- Node.js 20 or newer for the standalone server and development tools.

The current integration is verified on macOS with a local Aside browser profile.

## Install locally

```sh
cd ~/Dev/aside-acp
npm ci
npm run typecheck
npm run test:unit           # protocol regressions; no live account needed
node scripts/install-paseo-plugin.mjs
```

The installer backs up `~/.paseo/config.json`, migrates this project's old `agents.providers.aside` ACP registration, and installs or reloads the plugin. It uses hot reload; a daemon restart is unnecessary. It refuses to overwrite a different custom provider or plugin source.

If you have never registered the old bridge, you can install directly:

```sh
paseo plugin install /absolute/path/to/aside-acp
```

Plugin ID: `aside-acp`. Provider ID: `aside`.

```sh
paseo provider diagnostic aside
paseo run --provider aside "Open https://example.com and tell me the page title. Read only."
paseo plugin reload aside-acp
paseo plugin remove aside-acp
```

Create a new Paseo agent after migrating. Legacy custom-provider agents use a different Paseo persistence format. Their underlying Aside sessions and bridge mapping files are retained.

## Import Aside history

Open Paseo’s **Import Sessions**, choose **Aside**, and select a native chat. Use **Show all directories** if the current workspace differs from the chat’s stored directory. Import resumes the existing Aside ID and its browser context; it does not create or prime another chat. Model and thinking choices follow Paseo’s composer controls.

Discovery reads the selected account’s `state.db` through macOS’s `/usr/bin/sqlite3` in read-only mode. It includes visible, non-archived root chats and excludes incognito, ephemeral and child sessions. Titles, directory and last activity are listed, with search and already-imported session filtering.

Import copies user, assistant and reasoning text from `messages.jsonl` into replay history. Tool results and attachments are omitted. The transcript is captured on first import, then bridge replies are appended. Missing/deleted chats or unavailable transcripts produce an explicit error. Listing and import do not run a model turn or change Aside’s database.

## Configuration

Copy `aside-acp.example.json` to `~/.aside-acp.json` if you need to customize the bridge. Existing configuration remains compatible.

| Field | Purpose |
| --- | --- |
| `aside_cli` | CLI executable path; otherwise resolved from PATH and Aside's installation |
| `account` | Local Aside account number; otherwise the current account |
| `default_model` | Qualified `provider/model` ID; otherwise Aside's default |
| `default_effort` | Thinking level, default `medium` |
| `approved_models` | Optional list of allowed model IDs or model provider IDs |
| `exec_timeout_seconds` | Maximum time per turn, default 1200 seconds |
| `style` | Bridge persona, `formal` or `casual` |
| `owner_name` | Name used in the bridge persona |
| `default_confirmation` | New-chat Final confirm: `ask-first` (default) or `skip-confirmation`; Read only always disables it |
| `default_permission` | Initial mode for new chats: `read-only`, `guard` or `full-access` |
| `grant_full_access` | Legacy fallback when `default_permission` is absent: `true` means Full access, `false` means Guard; defaults to `true` |

Environment overrides: `ASIDE_ACP_CONFIG` selects the configuration file, `ASIDE_ACP_CLI` selects the executable, and `ASIDE_HOME` selects Aside's data directory. `ASIDE_ACP_LOG_FILE` optionally records bridge diagnostics. Reload the plugin after changing daemon environment variables. Per-agent Paseo environment overrides are not forwarded by the in-process ACP connector.

Models are read from the selected account's `models.json` and cached model catalog. Availability in the picker does not guarantee that an upstream model subscription has quota.

## How it works

```text
Paseo provider API → official runAcpProvider shim → ACP object streams
                                                   ↓
                                              Aside bridge
                                                   ↓
                             aside exec / session resume → Aside browser
```

The plugin bundles the bridge, so no project-specific Node path or separately installed `aside-acp` executable is needed. The official Paseo ACP shim handles model controls and timeline conversion; the native permission wrapper relays Aside suspensions into Paseo approval UI.

The bridge creates Aside sessions lazily on the first prompt, tails Aside CLI’s live `--log-dump` events for text and thinking deltas, and stores session mappings plus replayable conversation text in `~/.aside-acp/sessions`. Reloading an agent resumes the same Aside session. Model and thinking changes are applied to that session through Aside's session API.

The provider relays native approvals, action confirmations and interactive questions into Paseo UI. The standalone stdio ACP server exposes settings and legacy approvals; native suspension forms require the Paseo wrapper or Aside desktop UI. Standalone `[[QUESTION]]` requests become forms when the ACP client supports elicitation; otherwise they remain text questions. Cancellation terminates the CLI turn, whose SIGTERM handler cancels the native Aside task.

## Permission modes and Final confirm

The two controls are independent. The mode controls Aside's file/tool access policy; **Final confirm** controls confirmation before externally visible, destructive or paid actions such as sending, paying, deleting and submitting.

| Mode | Native access policy | Final confirm |
| --- | --- | --- |
| Read only | Work within this task's folder; no access to other folders | Disabled, matching Aside |
| Guard | Task folder, Documents and Downloads; ask before accessing other folders | Switching into Guard defaults to Ask first; can then select Skip confirmation |
| Full access | Read and write anywhere on this computer | Ask first or Skip confirmation; switching into this mode preserves the current choice |

Select **Ask first** or **Skip confirmation** under **Final confirm** in Paseo's session settings. Skip confirmation does not bypass Guard's access boundaries. Full access does not itself disable final-action confirmation. For new bridge chats, confirmation defaults to Ask first (except Read only); `default_confirmation: "skip-confirmation"` changes this default. Selecting the same mode again preserves an explicit confirmation choice.

Both settings are committed through Aside's native session API, with a read-back before reporting success. Imports/reconnects restore native settings, and native choices are refreshed before each task. Failed setting changes report an error rather than silently escalating access. The bridge does not continuously mirror idle desktop selector changes. Older `Auto` modes preserve native permissions.

The Paseo provider relays real Aside `approval` and `action-confirmation` suspensions into its standard permission UI:

- File/tool access: Allow once, Reject, and Always allow this permission when supported. Forwarded subagent approvals offer no permanent grant.
- Final action: Confirm or Cancel for the exact proposed action, including the original message and draft/artifact data for review. Screenshot artifacts are shown as metadata/path, not an embedded Aside screenshot viewer.
- Decisions resolve the original native suspension, so the same paused tool continues. Native request IDs and the current scope are checked before replying. Expired requests, failures, cancellation and plugin teardown never imply approval.
- Requests handled in Aside are withdrawn from Paseo. A pending request is discovered again on reconnect. Native authentication/polling errors appear as a session notice; approval is never synthesized to recover from an error.

Aside enforces its native access restrictions. Final confirm uses Aside's own model instructions and confirmation tool; it is not an OS-level interception of every possible side effect. Old `[[APPROVAL]]` blocks remain a compatibility fallback only while Ask first is enabled. New prompts use the native confirmation tool, avoiding a second bridge prompt after choosing Skip confirmation.

Aside CLI creates headless sessions: Guard requests that normally require approval are denied directly, and native question/final-confirm tools are omitted. The bridge creates an acknowledgement-only session, applies the selected settings, then uses Aside's supported branch API before the first user task. The branch preserves transcript, model, concrete permission grants, runtime settings and browser binding, and supports native interactive suspensions. Existing CLI chats migrate on their next task; the source chat remains intact and Paseo keeps its current agent and replay history. Completed interactive chats need no migration. A busy/incomplete source or failed migration stops the task without changing access policy. Imported chats restore the saved branch on reconnect.

The bridge authenticates to the **local loopback Aside daemon** by launching the signed Aside CLI's read-only `account status` command through a temporary loopback authentication relay. The CLI uses its own native helper and Keychain entitlements; Paseo never loads that native addon. The relay forwards only authentication and read-only account routes, closes immediately after the command, and never changes session settings. Session tokens stay in memory; keys/tokens are not copied into config, mappings or diagnostics. Only the selected account and bound session are addressed. Updating confirmation alone preserves Aside's remembered permission grants. This integration uses inspected native daemon APIs and requires a daemon exposing suspension IDs (inspected in 1.26.1011.1437). Remote Aside daemons are unsupported.

## Interactive questions

The interactive branch exposes Aside's native question tool, whose suspensions use the existing Paseo form. The plugin also accepts streamed `[[QUESTION]]` blocks as a compatibility fallback, converts complete valid blocks to the same form, and keeps protocol JSON out of the displayed reply. The form appears while the response streams; the bridge waits for an actual answer before continuing the original Aside conversation. No native tool is claimed or injected into Aside's tool list.

Single choice, multiple choice, multiple questions, descriptions and custom text answers are supported. Submit continues the same chat with the owner's answers; Dismiss passes a declined-question result. Interrupting a task or unloading the plugin cancels pending forms without inventing an answer. Each form has a unique request ID, and answers are validated against the original questions. Duplicate/empty headers retain distinct display labels and are restored on reply.

For sessions that really expose native `ask_user_question`, the original native suspension relay remains available, with discovery every 600 ms. Those answers return to the original native paused tool; requests answered in Aside are withdrawn from Paseo. CLI fallback forms continue the chat through a new CLI turn and do not fabricate a native suspension. Standalone ACP clients retain their capability-negotiated form/text fallback.

The current local development version is pending user verification and has not been released.

## Limits and permissions

- The legacy default remains Full access unless `default_permission` or `grant_full_access` selects another mode. Native permissions and final-action confirmation are handled by Aside, with requests relayed to Paseo.
- Upstream errors are reported once with their specific reason and request ID when supplied. Content-filter rejections are not automatically retried.
- Assistant text streams while it is generated. Thinking streams into Paseo’s reasoning rows when the model exposes it. Browser tool calls are not individually rendered.
- The bridge uses the CLI’s hidden `--log-dump` option, inspected in Aside CLI 1.26.1010.1739. It tails real events every 40 ms, deduplicates final snapshots, and falls back to completed transcripts for missing final text. Intermediate assistant commentary may appear before the final answer.
- Raw events are written to private temporary files and removed after the CLI exits. Text and reasoning history are saved in `~/.aside-acp/sessions`.
- Image/audio prompts and MCP servers are unsupported.
- The connector uses the daemon's local configuration and Aside browser profile. Remote Aside hosts are not configured by this plugin.
- Conversation text is stored locally for replay. Diagnostic logs can contain prompts and model errors.

## Development and verification

```sh
npm run typecheck
npm test                    # real browser: example.com, controls, cancellation
npm run test:resume          # ACP disconnect/reconnect and native session reuse
node test/approval.mjs       # simulated approval; no email is sent
npm run test:plugin          # real Paseo plugin, reload, resume, cancel, errors
```

Live tests require a signed-in Aside account and can consume model quota. They operate on public pages or simulated tasks. The plugin test creates and archives its own Paseo test agent.

Structure:

- `index.server.ts`: Paseo provider registration.
- `server/connector.ts`: ACP object-stream connection and cleanup.
- `server/history.ts`: conversation replay supplement for Paseo 0.11.2.
- `server/agent.js`, `server/lib/`: shared bridge implementation.
- `server.js`: standalone stdio entry.
- `lib/`: compatibility exports for existing ACP consumers.
- `scripts/install-paseo-plugin.mjs`: local installation and legacy migration.
- `test/`: live ACP and Paseo integration tests.

See [verification results](docs/verification.md) and [contributing](CONTRIBUTING.md).

## Embedded bridge API

Consumers can import `connectAsideAgent` from `aside-acp/agent` and supply ACP object streams. It returns the SDK connection plus an async `dispose()` function. Configuration is loaded once for each connection. The standalone `aside-acp` executable remains available.

The persona and soft confirmation convention were adapted from [aside-telegram-bridge](https://github.com/SaiAmartya/aside-telegram-bridge).

Aside branding identifies the integration and is not covered by this repository’s code license. See [third-party notices](THIRD_PARTY_NOTICES.md).
