# orq – project instructions

## Two interfaces: keep them in sync

orq has **two user interfaces over the same core**:

- **TUI** (`orq`): Ink/React in `src/ui/`.
- **Web** (`orq web`): Bun HTTP + SSE server in `src/web/server.ts`, state in `src/web/snapshot.ts`, React client in `src/web/client/`.

**Every user-facing change (new feature, changed behavior, label, option, flow, fix) must be applied to BOTH interfaces**, or the PR must state explicitly why one is excluded (e.g. terminal-only feature such as embedded tmux terminals).

Rules:
- Put logic in the shared core (`src/hq.ts`, `src/session.ts`, `src/runs.ts`, `src/library.ts`…), never only inside a UI. The TUI's `AppProvider` and the web `Session`/`perform()` must call the same functions (e.g. `teamOf`, `alertsOf`).
- New data the web needs goes into `Snapshot` (`src/web/snapshot.ts`); new user actions into `perform()` (`src/web/server.ts`) and the client.
- Keep Spanish UI texts identical in both interfaces.
- Add or update tests for both: `src/ui/*.test.ts` and `src/web/web.test.ts`.
- Web security: server binds to 127.0.0.1 only, every `/api` call needs the per-launch token and a localhost `Host`. Do not weaken this.

Known web gaps (TUI-only for now): Roles editor, auto-team by stack/area, embedded terminals (Terminales tab).

## Commands

- `bun test` · `bun run typecheck`
- `orq web [--port N]` – web UI. For smoke runs use an isolated home: `cd <fixture> && ORQ_SAFE=1 ORQ_HOME=$(mktemp -d) orq web`; never resume/stop real runs.
