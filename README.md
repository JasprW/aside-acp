# Aside ACP provider for Paseo

Use [Aside](https://aside.com)'s browser agent from [Paseo](https://paseo.sh). Select **Aside** when creating an agent, choose a model and thinking effort, then send browser tasks from desktop or mobile.

The same project also provides an ACP server over stdio for other ACP clients.

The separately packaged Paseo plugin is [paseo-aside-provider](https://github.com/JasprW/paseo-aside-provider). It pins a released revision of this bridge and is the recommended GitHub installation:

```sh
paseo plugin install git:JasprW/paseo-aside-provider
```

Use only one Aside provider installation at a time. This repository retains its local plugin entry for development and compatibility.

## Requirements

- Paseo 0.11.2, with trusted plugins enabled.
- Aside running and signed in on the daemon machine, with its CLI installed.
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
| `grant_full_access` | Run Aside sessions with full access; default `true` |

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

The plugin bundles the bridge, so no project-specific Node path or separately installed `aside-acp` executable is needed. The official Paseo ACP shim handles model controls, approval UI and timeline conversion.

The bridge creates Aside sessions lazily on the first prompt, tails Aside CLI’s live `--log-dump` events for text and thinking deltas, and stores session mappings plus replayable conversation text in `~/.aside-acp/sessions`. Reloading an agent resumes the same Aside session. Model and thinking changes are applied to that session through Aside's session API.

Approvals use the existing `[[APPROVAL]]` convention and appear as Paseo permission requests. `[[QUESTION]]` requests become forms when the ACP client supports elicitation; otherwise they remain text questions. Cancellation terminates the CLI turn, whose SIGTERM handler cancels the native Aside task.

## Limits and permissions

- Full access is enabled by default. The model is instructed to ask before external actions. This convention is prompt based and is not an enforced permission boundary.
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
