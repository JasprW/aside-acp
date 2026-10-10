# Contributing

Use Node.js 22 and `npm ci`. Run `npm run typecheck` and `npm run test:unit` before opening a pull request.

Live tests require a local signed-in Aside installation and consume model quota. Run them explicitly using the commands in the README. Keep test prompts read-only or simulated; never send real messages or make purchases in tests.

Changes to the bridge belong in `server/agent.js` and `server/lib/`. Keep the stdio entry and embedded `aside-acp/agent` API compatible. The dedicated Paseo integration lives in [paseo-aside-provider](https://github.com/JasprW/paseo-aside-provider).

Do not commit account settings, transcripts, session mappings or diagnostic logs. Report bugs with redacted version information, reproduction steps and the smallest relevant error message.
