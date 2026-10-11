# Changelog

## 0.3.1

- Expose native Read only, Guard and Full access in Paseo’s mode selector.
- Apply changes through Aside’s session API and read back committed permission state.
- Preserve native permissions on import/resume and handle older placeholder Auto modes.
- Check the selected permission before each task; configure new-chat defaults with `default_permission` and retain legacy configuration compatibility.
- Initialize Read only chats with Guard, then apply Read only before the first user task; report update failures explicitly.

## 0.3.0

- Use Aside’s official brand assets for plugin and provider icons; label the integration unofficial.

- List native Aside history through ACP `session/list` and Paseo Import Sessions.
- Read titles, working directories and activity from Aside’s index in read-only mode.
- Apply search and directory filtering before limiting; reuse existing persistence IDs for deduplication.
- Bind imported sessions to their native IDs and replay user/assistant/reasoning text without a new bootstrap turn.
- Keep account boundaries and reject missing/deleted native sessions explicitly.

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
