# Verification

## 0.4.1 Electron authentication fix

The user-reported missing-helper error was reproduced as a code-signing failure in Paseo Helper (Electron 44.2.0, Node 24.20.0): macOS rejects Aside's native addon because its Team ID differs from Paseo's. The file exists, and standalone Node can load it, but signing then fails with SecItemCopyMatching -34018 because Node lacks Aside's Keychain entitlement. Updating the installed CLI was not the remedy.

Authentication now runs through the signed Aside CLI's normal account-status command using a temporary loopback relay limited to daemon authentication and read-only account-summary routes. A diagnostic from the exact Paseo Helper runtime completed authentication and read an existing native session successfully. It printed only success booleans, not session contents or tokens. Type/syntax/diff checks passed. No automated tests, model turns, permission mutations or approval UI exercises were run; approval decisions remain for manual testing.

## 0.4.0 native permissions and Final confirm

Static type/syntax/diff checks and plugin installation status only. No automated tests, model turns, native permission mutations or approval UI exercises were run for this update. Existing config-option count expectation was updated for the additional setting. Prior verification results below apply to their stated versions, not this new native relay.

Contracts were inspected from Aside CLI 1.26.1010.1739, daemon 1.26.1011.1437, current desktop selector code and Paseo 0.11.2. Native mode defaults, CLI's forced `finalConfirm: false`, authenticated local tRPC, persisted suspensions and ID-checked reply schemas were read directly from the installed runtime. Runtime helpers use those contracts; actual authentication, native mutations and UI behavior remain for manual testing.

Manual checks: change each mode and Final confirm choice; import/reconnect a chat; trigger a Guard folder-access request and allow/reject it; review a simulated final-action confirmation and cancel it without taking an external action; answer in Aside and confirm the Paseo buttons disappear; interrupt/reload with a pending request; verify Skip confirmation retains Guard access checks. No successful live approval is claimed by the static checks.

## 0.3.1 native permission modes

Static type/syntax checks only. Aside CLI help, built-in Aside skill, desktop permission schemas/templates and the local session index were inspected read-only. No automated tests, permission mutations, model turns or visual UI checks were run for this update. Mode switching, Read only initialization and native confirmation UI remain for manual testing.

## 0.3.0 native history import

Static type/syntax checks only; no automated tests, imports or new agent turns were run. The discovery, ACP list and replay contracts were read from Paseo 0.11.2. Aside session metadata and transcript layouts were inspected read-only on the local installation. Import UI rendering and continuation remain for manual testing.

## 0.2.2 error reporting

Static type/syntax checks only; no new agent turns or UI tests. Existing user-run logs show a successful streamed turn followed by an upstream `Output blocked by content filtering policy` error. This update preserves that cause instead of replacing it with `Aside turn failed`.

## 0.2.1 streaming update

Static type and syntax checks only. The live event contract was inspected in the installed Aside CLI 1.26.1010.1739: `--log-dump` writes `message_update` text/thinking deltas and flushes before successful exit. No new agent turns or UI tests were run for this update. Browser tool calls remain unrendered.

## Earlier 0.2.0 checks

Verified locally on 2026-10-11 (Asia/Singapore) with Paseo 0.11.2, Aside CLI 1.26.1010.1739 and a signed-in macOS Aside account.

| Check | Result |
| --- | --- |
| Protocol regressions (`npm run test:unit`) | 6/6 |
| Standalone ACP (`npm test`) | 9/9 |
| ACP process restart and native session resume | 11/11 |
| Simulated approval handling | 5/5 |
| Paseo provider integration | 14/14 |

Integration checks cover a real browser visit to example.com, model and thinking selection, history replay, native context retention, approval denial, cancellation followed by another turn, explicit invalid-model errors, error recovery and unloading/reloading during an active turn. Test agents are archived afterward.

These results verify the provider protocol and running local daemon. Individual browser tool calls and thinking details are not rendered, and no visual client audit was performed. Other operating systems and later Paseo releases have not been verified.
