Use Aside's browser agent in Paseo with your local Aside account and browser profile. The provider exposes model and thinking effort choices, streams assistant replies and model reasoning, and resumes existing sessions.

Aside’s existing visible chats are available in Import Sessions, with title, directory and last activity. Import resumes the original Aside session and replays user, assistant and reasoning text. Choose Show all directories when the chat belongs to another directory. Discovery reads the local Aside session index with macOS’s SQLite CLI in read-only mode; no model turn is started.

Requires Paseo 0.11.2 and an installed, signed-in Aside CLI on the daemon machine. Aside's local macOS browser installation is required. Configure the account, default model and bridge behavior in `~/.aside-acp.json`, or select a config file with `ASIDE_ACP_CONFIG`.

The bridge reads Aside's model catalog and session transcripts from `~/.aside`, launches the Aside CLI and reads its live text/thinking event log, and stores session mappings in `~/.aside-acp/sessions`. Prompts and browser tasks run through your Aside account. No browser credentials are copied into Paseo.

Aside runs with full access by default. The bridge asks the model to request approval before external actions, translating those requests into Paseo's approval UI. This is a prompt-based convention, not an enforced sandbox. Image prompts and MCP servers are not supported. Browser tool calls are not individually exposed. Live event files are private and removed after the CLI exits; text and reasoning history are retained for replay. Requires Aside CLI 1.26.1010.1739 with its hidden raw-event option.
