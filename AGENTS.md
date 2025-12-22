# OpenChamber - AI Agent & Contributor Reference

Technical reference for AI coding agents and human contributors working on this project.

## Core Purpose

Web and desktop interface for OpenCode AI coding agent. Provides cross-device continuity, remote accessibility, and a unified chat interface using the OpenCode API backend.

## Tech Stack

- **React 19.1.1**: Modern React with concurrent features
- **TypeScript 5.8.3**: Full type safety
- **Vite 7.1.2**: Build tool with HMR and proxy
- **Tailwind CSS v4.0.0**: Latest `@import` syntax
- **Zustand 5.0.8**: State management with persistence
- **@opencode-ai/sdk**: Official OpenCode SDK with typed endpoints and SSE
- **@remixicon/react**: Icon system
- **@radix-ui primitives**: Accessible component foundations

## Architecture Overview (Monorepo)

Workspaces:
- `packages/ui` - Shared UI components and stores
- `packages/web` - Web runtime, Express server, CLI
- `packages/desktop` - Tauri desktop app with native APIs
- `packages/vscode` - VS Code extension with webview UI

### Core Components (UI)
In `packages/ui/src/components/chat/`: ChatContainer, ChatEmptyState, ChatErrorBoundary, ChatInput, ChatMessage, FileAttachment, MarkdownRenderer, MessageList, ModelControls, PermissionCard, PermissionRequest, ServerFilePicker, StreamingTextDiff, AgentMentionAutocomplete, CommandAutocomplete, FileMentionAutocomplete.
In `packages/ui/src/components/chat/message/`: MessageBody, MessageHeader, ToolOutputDialog, DiffViewToggle, FadeInOnReveal; parts/ (AssistantTextPart, ReasoningPart, ToolPart, UserTextPart, etc.)
In `packages/ui/src/components/layout/`: MainLayout, Header, Sidebar, SidebarContextSummary, SettingsDialog, VSCodeLayout.
In `packages/ui/src/components/sections/`: AgentsPage, CommandsPage, GitIdentitiesPage, ProvidersPage, SettingsPage (with subsections for agents/, commands/, git-identities/, providers/, settings/).
In `packages/ui/src/components/session/`: DirectoryTree, DirectoryExplorerDialog, SessionDialogs, SessionSidebar.
In `packages/ui/src/components/ui/`: CommandPalette, HelpDialog, ConfigUpdateOverlay, ContextUsageDisplay, ErrorBoundary, MemoryDebugPanel, MobileOverlayPanel, FireworksAnimation, OpenChamberLogo, OpenCodeIcon, ProviderLogo, ScrollShadow, OverlayScrollbar, plus Radix-based primitives (button, dialog, input, select, etc.)
In `packages/ui/src/components/views/`: ChatView, GitView, DiffView, PierreDiffViewer, TerminalView.
In `packages/ui/src/components/terminal/`: TerminalViewport
In `packages/ui/src/components/onboarding/`: OnboardingScreen
In `packages/ui/src/components/providers/`: ThemeProvider

### State Management (UI)
In `packages/ui/src/stores/`: contextStore, fileStore, messageStore, permissionStore, sessionStore, useAgentsStore, useCommandsStore, useConfigStore, useDirectoryStore, useFileSearchStore, useGitIdentitiesStore, useGitStore, useSessionStore, useTerminalStore, useUIStore

### OpenCode SDK Integration (UI)
In `packages/ui/src/lib/opencode/`: client.ts wrapper around `@opencode-ai/sdk` with directory-aware API calls, SDK methods (session.*, message.*, agent.*, provider.*, config.*, project.*, path.*), AsyncGenerator SSE streaming (2 retry attempts, 500ms->8s backoff), automatic directory parameter injection.

In `packages/ui/src/hooks/`: useEventStream.ts for real-time SSE connection management.

### Web Runtime (server/CLI)
Express server and CLI in `packages/web`: API adapters in `packages/web/src/api`, server in `packages/web/server/index.js` (git/terminal/config), UI bundle imported from `@openchamber/ui`.

### Desktop Runtime (Tauri)
Native desktop app in `packages/desktop`: Tauri backend in `src-tauri/` (Rust), frontend API adapters in `src/api/` (settings, permissions, diagnostics, files, git, terminal, notifications, tools, updater), bridge layer in `src/lib/` for Tauri IPC communication.

### VS Code Extension Runtime
Extension in `packages/vscode`: Extension entry in `src/` (ChatViewProvider, bridge, theme), webview API adapters in `webview/api/` (bridge, editor, files, permissions, settings, tools), webview components in `webview/components/` (ChatPanel, SessionsListView, VSCodeLayout).

## Development Commands

**This project uses Bun as the package manager and runtime. Do NOT use pnpm/npm/yarn.**

### Code Validation
Always validate changes:

```bash
bun run type-check             # TypeScript validation (root)
bun run lint                   # ESLint checks
bun run build                  # Production build
```

### Building
```bash
bun run build                  # Build all packages
bun run desktop:build          # Build desktop app
bun run vscode:build           # Build VS Code extension
```

### Cleaning
```bash
bun run clean                  # Clean all dist/build artifacts
```

### Running Dev Server
```bash
bun run dev                    # Start dev server with HMR
# Or directly:
cd packages/web && bun run bin/cli.ts serve --port 3001
```

## Communication & Output Discipline (MANDATORY)
- Default to brevity. Responses must be as short as possible (until you suggesting plan) while remaining correct.
- Do not narrate internal reasoning, step-by-step thinking, or deliberation.

## Key Patterns

### Section-Based Navigation
Modular section architecture with dedicated pages and sidebars. Sections: Agents, Commands, Git Identities, Providers, Sessions, Settings. Independent state management and routing.

### File Attachments
Drag-and-drop upload with 10MB limit (`FileAttachment.tsx`), Data URL encoding, type validation with fallbacks, integrated via `useFileStore.addAttachedFile()`.

### Theme System
In `packages/ui/src/lib/theme/`: TypeScript-based themes (Flexoki Light and Dark), CSS variable generation, component-specific theming, Tailwind CSS v4 integration.

### Typography System
In `packages/ui/src/lib/`: Semantic typography with 6 CSS variables, theme-independent scales. **CRITICAL**: Always use semantic typography classes, never hardcoded font sizes.

### Streaming Architecture
SDK-managed SSE with AsyncGenerator, temp->real session ID swap (optimistic UI), pendingAssistantParts buffering, empty-response detection via `window.__opencodeDebug`.

## Development Guidelines

### Lint & Type Safety

- Never land code that introduces new ESLint or TypeScript errors
- Run `pnpm run lint` and `pnpm run type-check` before finalizing changes
- Adding `eslint-disable` requires justification in a comment explaining why typing is impossible
- Do **not** use `any` or `unknown` casts as escape hatches; build narrow adapter interfaces instead
- Refactors or new features must keep existing lint/type baselines green

### Theme Integration

- Check theme definitions before adding colors or font sizes to new components
- Always use theme-defined typography classes, never hardcoded font sizes
- Reference existing theme colors instead of adding new ones
- Ensure new components support both light and dark themes
- Use theme-generated CSS variables for dynamic styling

### Code Standards

- **Functional components**: Exclusive use of function components with hooks
- **Custom hooks**: Extract logic for reusability
- **Type-first development**: Comprehensive TypeScript usage
- **Component composition**: Prefer composition over inheritance

## Feature Implementation Map

### Directory & File System
`packages/ui/src/components/session/`: DirectoryTree, DirectoryExplorerDialog
`packages/ui/src/stores/`: DirectoryStore
Backend: `packages/web/server/index.js` with `listLocalDirectory()`, `getFilesystemHome()`

### Session Switcher
`SessionSwitcherDialog.tsx`: Collapsible date groups, mobile parity with MobileOverlayPanel, Git worktree and shared session chips, streaming indicators.

### Settings & Configuration
`packages/ui/src/components/sections/`: AgentsPage, CommandsPage, GitIdentitiesPage, ProvidersPage, SessionsPage, SettingsPage
Related stores: useAgentsStore, useCommandsStore, useConfigStore, useGitIdentitiesStore

### Git Operations
`packages/ui/src/components/views/`: GitView, DiffView
`packages/ui/src/stores/`: useGitIdentitiesStore
Backend: `packages/ui/src/lib/gitApi.ts` + `packages/web/server/index.js` (simple-git wrapper)

### Terminal
`packages/ui/src/components/views/`: TerminalView
`packages/ui/src/components/terminal/`: TerminalViewport (Xterm.js with FitAddon)
`packages/ui/src/stores/`: useTerminalStore
Backend: `packages/web/server/src/routes/terminal.ts` (bun-pty with SSE)

#### Terminal Architecture
The terminal uses native PTY sessions via `@skitee3000/bun-pty` (NOT tmux, NOT node-pty).

**Session lifecycle:**
1. Client calls `POST /api/terminal/create` with `{ cwd, cols, rows }`
2. Server spawns PTY via `spawn('bash', [], { name: 'xterm-256color', cols, rows, cwd })`
3. PTY output is buffered (last 1000 lines) and streamed via SSE
4. Client connects to `GET /api/terminal/stream/:sessionId/:paneIndex` for SSE
5. Client sends input via `POST /api/terminal/write/:sessionId/:paneIndex`

**SSE event format (client expects):**
```json
{ "type": "connected" }
{ "type": "data", "data": "terminal output..." }
{ "type": "exit", "exitCode": 0, "signal": null }
```

**Key implementation details:**
- Sessions stored in `Map<sessionId, Session>` (in-memory, survives reconnects but not server restart)
- Output buffer: last 1000 lines sent to reconnecting clients
- SSE uses `ReadableStream` with `controller.enqueue()` (non-blocking)
- `Bun.serve()` configured with `idleTimeout: 0` to prevent SSE timeout

**Terminal API endpoints:**
- `POST /api/terminal/create` - Create new PTY session
- `POST /api/terminal/reset` - Kill and recreate session
- `GET /api/terminal/stream/:sessionId/:paneIndex` - SSE output stream
- `POST /api/terminal/write/:sessionId/:paneIndex` - Send input to PTY
- `POST /api/terminal/resize/:sessionId/:paneIndex` - Resize PTY
- `POST /api/terminal/kill/:sessionId/:paneIndex` - Kill session
- `GET /api/terminal/sessions` - List all sessions
- `GET /api/terminal/session/:sessionId` - Get session info

### Theme System
`packages/ui/src/lib/theme/`: themes (2 definitions), cssGenerator, syntaxThemeGenerator
`packages/ui/src/components/providers/`: ThemeProvider

### Mobile & UX
`packages/ui/src/components/ui/`: MobileOverlayPanel
`packages/ui/src/hooks/`: useEdgeSwipe, useChatScrollManager
