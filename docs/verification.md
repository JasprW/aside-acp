# Verification

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
