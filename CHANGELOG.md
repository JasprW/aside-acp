# Changelog

## 0.2.2

- Preserve upstream error reasons and request IDs in ACP failures.
- Report failures once through Paseo’s error UI instead of adding an assistant error message followed by a generic failure.
- Surface CLI and timeout details; content-filter rejections remain failures and are not automatically retried.

## 0.2.1

- Forward real text and thinking deltas from Aside CLI’s live raw-event log.
- Deduplicate message snapshots and final transcripts; retain partial UTF-8 JSONL records.
- Replay reasoning separately from assistant replies, batch history writes and bound disconnected notifications.
- Remove private per-turn event files after CLI exit and surface transcript provider errors.

## 0.2.0

- Register Aside as a Paseo provider plugin through the official ACP shim.
- Bundle the ACP bridge with an in-process connector while retaining the stdio CLI.
- Migrate the legacy local provider registration with a backup and hot reload.
- Support the current Aside CLI session resume and permission arguments.
- Fix ACP configuration option names, full option updates and error responses.
- Persist replayable messages with stable IDs; release pending requests on disconnect.
- Cancel native CLI tasks and stop active sessions when unloading the plugin.

## 0.1.0

- Standalone Aside ACP bridge with streamed replies, model choices and approvals.
