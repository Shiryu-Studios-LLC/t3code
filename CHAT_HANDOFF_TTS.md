# T3Code TTS Chat Handoff

## Project / workspace

- Repository: `I:\t3code`
- Branch: `main`
- Remote: `origin -> https://github.com/Shiryu-Studios-LLC/t3code.git`
- Existing DevSpace workspace id used in this chat: `ws_392c4ffe64`

## TTS requirements agreed with the user

1. Read only the assistant's final response.
2. Support both manual playback and automatic playback via a toggle.
3. Support local/offline and cloud/API TTS providers, selectable by the user.
4. Balance natural voice quality, latency, and resource use.
5. Use one global customizable voice.
6. Do not read code literally; summarize code blocks for speech.
7. Basic playback controls only: play, pause/resume, stop.
8. Desktop only for V1.
9. Speech should play on the device currently being used, even for remote T3Code sessions.
10. End goal is response read-aloud, not a full STT/wake-word voice assistant.

## Architecture decision

Keep TTS client/desktop-local and out of the agent/server orchestration path:

`Final assistant response -> speech text processor -> selected TTS provider -> desktop audio playback`

This keeps remote sessions correct because audio is generated/played on the active desktop client.

## Provider decision

- First cloud provider chosen during implementation: OpenAI.
- Provider abstraction should remain generic so more providers can be added later.
- Local/system speech synthesis is also part of V1 groundwork.

## Files already modified / created for TTS

Working tree currently contains TTS-related changes in these paths (verify with git status before continuing):

- `packages/contracts/src/settings.ts`
  - Added client-local TTS settings including enabled, auto-read, provider, voice, and rate.
- `packages/contracts/src/ipc.ts`
  - Added desktop bridge typing for speech synthesis.
- `apps/desktop/src/ipc/channels.ts`
  - Added TTS IPC channel.
- `apps/desktop/src/ipc/DesktopIpcHandlers.ts`
  - Registered TTS IPC handler.
- `apps/desktop/src/preload.ts`
  - Exposed desktop speech synthesis through `window.desktopBridge`.
- `apps/desktop/src/ipc/methods/textToSpeech.ts`
  - New OpenAI cloud TTS IPC implementation/foundation.
- `apps/web/src/tts/speechText.ts`
  - New speech preprocessing layer.
  - Strips/normalizes markdown for natural speech.
  - Summarizes code blocks instead of reading code literally.
- `apps/web/src/tts/ttsController.ts`
  - New desktop/client TTS controller.
  - Local/system speech synthesis support.
  - OpenAI provider path via desktop bridge.
  - Play/pause/resume/stop and auto-read transition tracking.
- `apps/web/src/components/chat/MessagesTimeline.tsx`
  - TTS controls and assistant-message integration were partially/mostly wired.

## What was completed conceptually

- Desktop-local TTS settings contract.
- Desktop bridge + IPC plumbing.
- OpenAI cloud TTS adapter foundation.
- Local/system TTS path.
- Markdown-to-speech preprocessing.
- Code-block speech summarization.
- Play/pause/stop controls wired into completed assistant messages.
- Auto-read logic wired to trigger after a streaming assistant response becomes final.

## What is still incomplete

- Finish/verify the Settings UI for:
  - Enable TTS
  - Auto-read final responses
  - Provider selector
  - Global voice selector/input
  - Speech rate
  - Optional preview voice button if useful
- Review `MessagesTimeline.tsx` integration for correctness and UI polish.
- Add focused tests for speech preprocessing and TTS UI/controller behavior where appropriate.
- Run targeted typechecks/tests and fix all TTS integration errors.
- Do not run broad repo-wide checks unless necessary; the repository's AGENTS instructions prefer focused verification.

## DevSpace timeout/disconnect issue discovered during verification

The original verification command was:

`pnpm --filter @t3tools/contracts typecheck`

Observed behavior before the DevSpace repair attempt:

- DevSpace was healthy before the command.
- `pnpm` dependency/linking work completed successfully.
- The command reached `tsgo --noEmit`.
- During/after the long typecheck phase, the MCP connection dropped.
- Tiny commands then also returned `Connection failed`.
- At one point the DevSpace admin health path also returned 502 upstream errors.

This pointed to a DevSpace long-running shell timeout/cancellation/process-cleanup issue rather than a T3Code/TTS problem.

The user used Work mode to repair DevSpace, then reconnected it. The previous `bash` tool registration was temporarily inconsistent: the schema exposed `bash`, but invoking it returned `Tool bash not found`.

## Latest DevSpace state at end of this chat

After the user's most recent reconnect, the DevSpace tool surface changed and now exposes a newer command API including:

- `exec_command`
- `write_stdin`
- `apply_patch`
- `read`

This is a good sign and should be used in the next chat instead of relying on the old `bash` path.

## Critical next steps for the new chat

1. Open/reuse `I:\t3code` with DevSpace and read the root/project `AGENTS.md` instructions.
2. Run `git status -sb` (or equivalent DevSpace status tool) and confirm the TTS changes listed above are still present and uncommitted.
3. Verify the DevSpace fix first using the new long-running process API:
   - Run a tiny command through `exec_command`.
   - Run `pnpm --filter @t3tools/contracts typecheck` with `exec_command`.
   - If it returns a running session id, poll it using `write_stdin` until completion instead of depending on one long blocking call.
   - After completion, run another tiny command and verify DevSpace remains responsive.
4. If DevSpace stays healthy, continue TTS implementation:
   - Finish Settings -> Text-to-Speech UI.
   - Inspect and fix `MessagesTimeline.tsx` TTS controls/auto-read behavior.
   - Run focused contracts/web/desktop typechecks/tests.
5. Do not discard or reset the current TTS working tree.
6. Do not commit or push unless the user explicitly asks in the new chat.

## Useful product behavior to preserve

- TTS only speaks final assistant responses, never thoughts/tool/status activity.
- Auto-read should trigger exactly once when a streaming assistant response becomes final.
- Manual playback should work for historical final assistant messages.
- New manual playback should stop/replace existing speech rather than create overlapping audio.
- Local/system provider should use the desktop/browser speech synthesis voices.
- Cloud-generated audio should stay client-local/temporary; no need to persist audio in thread history for V1.
- Code blocks should become short natural summaries for speech, not raw token-by-token code narration.

## Suggested first prompt for the next chat

"Continue the T3Code TTS work from `I:\t3code\CHAT_HANDOFF_TTS.md`. First verify the DevSpace long-command fix using the new `exec_command`/`write_stdin` flow, then finish and test the TTS implementation."
