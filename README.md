# T3 Studio by Shiryu Studios

T3 Studio is an open, agent-native development workspace for directing coding agents from desktop, web, and mobile. It evolves the original T3 Code control surface into a studio for individual agent sessions and coordinated Swarms while preserving the fast, remote-ready workflow that existing users rely on.

T3 Studio works with your existing Codex, Claude Code, Cursor, Grok Build, and OpenCode subscriptions. Install and authenticate the provider CLIs on the machine running the server; T3 Studio coordinates them without requiring a separate model subscription.

## What T3 Studio adds

The main workspace supports two complementary ways of working:

- **Chat** for focused work with one provider session.
- **Swarm** for planning, delegating, monitoring, and recombining a larger body of work across specialized agents.

A Swarm is led by an orchestrator that turns an objective into a dependency graph. Independent tasks can run in parallel, dependent tasks run sequentially, and real projects can mix both patterns—for example, schema design first, API and UI work in parallel, then review and integration.

### Swarm execution modes

- **Auto** lets the orchestrator plan the graph, assign workers, execute it, and integrate the result.
- **Hybrid** starts from an orchestrated plan but keeps agent allocation and important transitions visible and adjustable.
- **Manual** provides native controls to launch workers, message them, stop them, and decide when their work should move into review or recombination.

Each Swarm supports up to **15 active agents**, including its orchestrator. Workers expose status and dependency information in the main view rather than hiding orchestration in a transcript. When isolation is useful, a worker can operate in its own Git worktree so concurrent changes do not collide.

Completion is more than waiting for the last worker to stop. The orchestrator gathers worker results, handles dependency failures and conflicts, verifies the combined work, and produces a recombined outcome. Finished runs are cleaned out of the active workspace and remain available under **Previous Swarms** for inspection.

## Product principles

- **Open at the core:** the source, architecture, and development workflow remain available to fork and adapt.
- **Provider-agnostic:** Swarm orchestration is a T3 Studio capability, not a feature tied to one model provider.
- **Mixed execution:** parallel and sequential work are both first-class and are selected from actual dependencies.
- **Remote-ready:** the same server can be controlled locally or from another T3 Studio client.
- **Multi-surface:** web, Electron desktop, and mobile clients share the same environment and session model.
- **Restart-resilient:** provider bindings, resume cursors, conversation context, workspace paths, and agent activity are persisted. After an unexpected desktop or server restart, T3 Studio proactively re-adopts resumable sessions and asks interrupted active agents to continue their remaining work.
- **Performance-conscious:** orchestration state stays structured and observable without turning the workspace into a constantly repainting dashboard.

## Installation

> [!IMPORTANT]
> Install and authenticate at least one supported provider before starting T3 Studio:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it without installing the desktop app

The compatibility-preserving CLI package and command remain `t3`. Node.js `^22.16 || ^23.11 || >=24.10` is required.

```bash
npx t3@latest
```

This starts the T3 Studio server and its local web client. Run `npx t3@latest --help` for the complete CLI reference.

### Desktop app

Existing distribution identifiers are retained for upgrade compatibility. Install from [GitHub Releases](https://github.com/pingdotgg/t3code/releases) or a supported package registry.

Windows:

```bash
winget install T3Tools.T3Code
```

macOS:

```bash
brew install --cask t3-code
```

Arch Linux stable or nightly:

```bash
yay -S t3code-bin
yay -S t3code-nightly-bin
```

The AUR definitions live under [`packaging/aur`](./packaging/aur).

## Using a Swarm

1. Open the Swarm workspace and describe the outcome in the floating composer.
2. Select Auto, Hybrid, or Manual based on how much direct control you want.
3. Review the orchestrator plan, worker assignments, dependencies, and optional isolated-worktree choices.
4. Start the run. Ready branches execute in parallel; dependency-bound branches wait for their prerequisites.
5. Message or stop any live worker directly when intervention is needed. Hybrid and Manual additionally let you launch workers yourself.
6. Let the orchestrator recombine and verify the completed worker results.
7. Revisit completed runs in Previous Swarms after the active workspace is cleaned up.

The 15-agent ceiling is intentional: it bounds local resource use and keeps the orchestration graph understandable. Provider capabilities vary, so a worker may expose fewer controls when its provider cannot support a native operation.

### Restart recovery

Agent recovery is global rather than limited to the Swarm screen. T3 Studio persists each provider session's durable resume cursor together with its model, runtime mode, working directory or worktree, and projected activity. On startup it first adopts any session still exposed by the provider, then reopens other resumable conversations. A session that was actively working receives a continuation instruction to inspect its persisted conversation and current files, avoid repeating completed work, finish the remaining task, and rerun verification.

Exact mid-token continuation depends on the provider and cannot be guaranteed after the underlying provider process has exited. The durable guarantee is recovery of conversation context, workspace state, agent identity and activity history, followed by safe continuation from the last persisted state. Sessions without valid provider resume data are marked with an actionable recovery error instead of being reported as live.

## Architecture

T3 Studio is a monorepo with typed contracts between every surface:

- `apps/server` owns WebSocket/RPC handling, projects, provider adapters, orchestration, Git operations, and persisted state.
- `apps/web` contains the React/Vite workspace, including the main Swarm view and composer.
- `apps/desktop` wraps the web client in Electron and manages local backend startup and desktop integration.
- `apps/mobile` provides remote control from iOS and Android.
- `packages/contracts` defines data crossing IPC, RPC, and WebSocket boundaries.
- `packages/client-runtime` contains shared client state and runtime behavior.

Swarm state crosses the same typed boundary as ordinary sessions. The server owns authoritative lifecycle and provider operations; clients render the orchestrator, workers, dependency state, controls, history, and recombination progress.

## Development setup

This repository is a pnpm monorepo. The versions declared by the checkout are the source of truth:

- Node.js: `^24.13.1` (use Node 24; Node 25/26 does not satisfy the repository engine constraint)
- pnpm: `11.10.0`
- Vite+: provided by the repository as a development dependency, so a separate global `vp` install is not required when you use the pnpm scripts below

### Windows PowerShell

From a fresh PowerShell window, switch to the repository and make sure the required pnpm version is available:

```powershell
cd I:\t3code
npm install --global pnpm@11.10.0
pnpm --version
```

Install dependencies once, and repeat this after pulling changes that modify `package.json` or `pnpm-lock.yaml`:

```powershell
pnpm install
```

Run the normal server + web development environment:

```powershell
pnpm dev
```

The development runner prints the actual server/web ports it selected. Keep that terminal open while developing.

### Run the desktop app from source

For normal desktop development, use this command from the repository root:

```powershell
cd I:\t3code
pnpm dev:desktop
```

`dev:desktop` is the correct source-development entry point. It builds/watches the Electron main/preload bundles, runs the web development surface, and launches **T3 Studio (Alpha)** through Electron. Leave the terminal running; changes continue to rebuild while the development process is active.

If the Electron bundle has already been built and you only want to launch that existing build without starting the watchers, use:

```powershell
pnpm start:desktop
```

If `dist-electron` is missing or stale, build first:

```powershell
pnpm build:desktop
pnpm start:desktop
```

#### Verified direct Windows launch

When a parent shell or process manager is terminating Electron as soon as the launch command returns, launch the rebuilt desktop bundle directly and clear `ELECTRON_RUN_AS_NODE` first. That environment variable makes Electron behave like Node when it leaks into the child process.

From **Command Prompt**:

```cmd
cd /d I:\t3code
set ELECTRON_RUN_AS_NODE=
start "" "apps\desktop\node_modules\electron\dist\electron.exe" "apps\desktop\dist-electron\main.cjs"
```

From **PowerShell**:

```powershell
cd I:\t3code
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath ".\apps\desktop\node_modules\electron\dist\electron.exe" -ArgumentList ".\apps\desktop\dist-electron\main.cjs" -WorkingDirectory "I:\t3code"
```

Use this direct launch only after `pnpm build:desktop` has produced a current `apps\desktop\dist-electron\main.cjs`. For normal development, `pnpm dev:desktop` remains the preferred command because it keeps the watchers and development server running.

### Build a Windows desktop installer

To create the Windows NSIS desktop artifact from source:

```powershell
pnpm dist:desktop:win:x64
```

Use `pnpm dist:desktop:win` for the repository's default Windows target, or `pnpm dist:desktop:win:arm64` for Windows on ARM.

### Optional direct Vite+ commands

If you intentionally install Vite+ globally, the equivalent commands remain `vp run dev` and `vp run dev:desktop`. The pnpm commands above are preferred because they use the repository-pinned tooling and do not depend on `vp` being globally available on `PATH`.

Compatibility identifiers such as the `t3` package, `@t3tools/*` packages, `T3CODE_*` environment variables, `.t3` state directory, and `t3code://` links remain unchanged.

## Verification

Use focused checks while developing, then validate every affected surface before release:

```bash
vp test run path/to/changed.test.ts
vp run --filter @t3tools/contracts typecheck
vp run --filter @t3tools/client-runtime typecheck
vp run --filter t3 typecheck
vp run --filter @t3tools/web typecheck
vp run --filter @t3tools/desktop typecheck
vp run --filter @t3tools/web build
vp run --filter t3 build:bundle
vp run build:desktop
vp run --filter @t3tools/desktop smoke-test
```

Changes to contracts or orchestration should include focused tests for server behavior and client projection. User-facing Swarm work should also be verified in the real web or desktop workspace, including dependency transitions, manual controls, cleanup/history, and recombination.

## Documentation and support

More documentation lives in [`docs/`](./docs):

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access](./docs/user/remote-access.md)
- [Keeping clients and servers in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) and [Claude](./docs/user/providers-claude.md)
- [Background service](./docs/user/background-service.md)
- [Internal architecture](./docs/internals/overview.md)

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a pull request. Feature proposals belong in [Ideas discussions](https://github.com/pingdotgg/t3code/discussions/categories/ideas), and community support is available on [Discord](https://discord.gg/jn4EGJjrvv).
