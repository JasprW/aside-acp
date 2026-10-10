# Changelog

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
