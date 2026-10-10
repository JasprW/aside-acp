Use Aside's browser agent in Paseo with your local Aside account and browser profile. The provider exposes model and thinking effort choices, streams assistant replies, and resumes existing sessions.

Requires Paseo 0.11.2 and an installed, signed-in Aside CLI on the daemon machine. Aside's local macOS browser installation is required. Configure the account, default model and bridge behavior in `~/.aside-acp.json`, or select a config file with `ASIDE_ACP_CONFIG`.

The bridge reads Aside's model catalog and session transcripts from `~/.aside`, launches `aside exec`, and stores session mappings in `~/.aside-acp/sessions`. Prompts and browser tasks run through your Aside account. No browser credentials are copied into Paseo.

Aside runs with full access by default. The bridge asks the model to request approval before external actions, translating those requests into Paseo's approval UI. This is a prompt-based convention, not an enforced sandbox. Image prompts and MCP servers are not supported. Only assistant text is streamed; individual browser tool calls and thinking are not exposed.
