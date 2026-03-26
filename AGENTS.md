# AGENTS.md

## Purpose
Build and maintain a local-first AI Twitch moderator bot for one Twitch channel and one bot account.

The bot should:
- run locally
- use official Twitch APIs and supported patterns only
- read chat continuously
- speak rarely but usefully
- moderate conservatively and audibly
- support both local and remote LLM backends behind one narrow interface

## Product Intent

This is a moderator presence, not just a command bot.

Behavior targets:
- social mode: warm, natural, low-volume
- moderation mode: concise, firm, auditable
- default stance: abstain unless intervention helps

## Hard Constraints

- Use Twitch EventSub WebSocket for chat intake unless Twitch guidance changes.
- Use official Twitch APIs for chat send, whispers, and moderation.
- Do not use browser automation, scraping, unofficial IRC workarounds, or MCP.
- Keep the architecture simple and local-first.
- Treat the LLM provider as replaceable.
- Keep prompts, policy, cooldowns, thresholds, and model selection editable outside core logic.
- Every moderation-capable action must be auditable.
- Dry-run must remain available.

## Source Of Truth Files

These files are the operational source of truth:

- [config/app.yaml](config/app.yaml)
  Runtime mode, Twitch identities/scopes, provider defaults, prompt-pack selection, context limits, live-action gates.
- [config/control-plane.yaml](config/control-plane.yaml)
  Whisper control settings, trusted controllers, allowed packs, model presets.
- [config/cooldowns.yaml](config/cooldowns.yaml)
  Bot chat, moderation, moderation-notice, and AI review cooldowns.
- [config/moderation-policy.yaml](config/moderation-policy.yaml)
  Deterministic rule thresholds, public moderation notices, and AI timeout policy posture.
- [prompts/packs/](prompts/packs)
  The only supported prompt source. Each pack should carry `pack.yaml` plus the five prompt files. Do not recreate root `prompts/*.md`.
- [evals/scenarios/](evals/scenarios)
  Curated scripted YAML scenario suites for prompt/policy iteration.
- [docs/operations.md](docs/operations.md)
  Exact bring-up, reauth, whisper, replay, review, compare, eval, and troubleshooting workflows.

## Current Architecture

Keep these layers separate:

1. `src/twitch/`
   Auth, token validation, Helix API, EventSub WebSocket, identity resolution.
2. `src/ingest/`
   Normalize Twitch events into internal message shapes.
3. `src/moderation/`
   Deterministic rules and cooldown tracking.
4. `src/ai/`
   Prompt composition, structured schema parsing, deterministic context building, provider adapters, provider registry.
5. `src/actions/`
   Shared execution path for `say`, `warn`, and `timeout`.
6. `src/control/`
   Whisper command parsing, controller auth, runtime override storage, effective runtime settings.
7. `src/storage/`
   SQLite persistence and structured logs.
8. `src/runtime/`
   Shared message processor for live, replay, and eval paths.
9. `src/config/`
   Env/YAML/prompt-pack loading and validation.

## Operational Invariants

- Prompt packs are selected by name and loaded from `prompts/packs/<pack>/`.
- Curated scenarios are the main regression source of truth; replay exists to discover and promote real cases into that curated corpus.
- Runtime overrides live in SQLite. The app does not rewrite YAML config files at runtime.
- A dedicated bot account is required for whisper control to be useful.
- Whisper replies require the bot account to have a verified phone number on Twitch.
- Bot-authored chat messages are persisted for audit/context, then skipped for rules/AI to prevent loops.
- Deterministic rules always run before AI.
- `say` is the social/helpful reply path. `warn` is the public moderation-note path.
- Timeout-capable moderation should emit an auditable public `warn` after timeout when the timeout actually executes.
- Live moderation requires both:
  - `runtime.dryRun: false`
  - `actions.allowLiveModeration: true`
- Whisper controller authorization is allowlist-only and resolved by user ID at runtime.

## Preferred Stack

Unless there is a strong reason to change:
- TypeScript
- Node.js
- Twurple
- EventSub WebSocket
- SQLite
- direct provider adapters instead of heavy AI orchestration frameworks

If changing this direction, explain why before implementing.

## Agent Workflow

Before large changes:
1. read this file
2. inspect the repo
3. state the implementation plan
4. identify assumptions
5. proceed in small, reviewable steps

When implementing:
- make minimal, high-confidence changes
- keep behavior conservative by default
- update docs when structure or operation changes
- verify Twitch/API behavior against official docs if unsure
- prefer existing abstractions over parallel one-off paths

## When You Change X, Also Update Y

- If you change prompt-pack structure or prompt semantics:
  - update [docs/configuration.md](docs/configuration.md)
  - update relevant scenario cases in [evals/scenarios/](evals/scenarios)
  - update each changed pack's `pack.yaml` hypothesis if the comparison intent changed
  - update [README.md](README.md) if operator workflow changes
- If you change config schema or defaults:
  - update [config/app.yaml](config/app.yaml) or other source files
  - update [`.env.example`](.env.example) when env keys change
  - update [docs/configuration.md](docs/configuration.md)
  - add or update tests
- If you change control-plane commands or runtime override behavior:
  - update [config/control-plane.yaml](config/control-plane.yaml) if presets/allowlists change
  - update [README.md](README.md)
  - update [docs/configuration.md](docs/configuration.md)
  - update [docs/operations.md](docs/operations.md)
  - update tests for parsing/authorization/persistence
- If you change replay or scenario eval behavior:
  - update [docs/operations.md](docs/operations.md)
  - update [docs/architecture.md](docs/architecture.md)
  - update scenario or replay tests
  - update review/compare docs if the curated-first workflow changed
- If you change Twitch scopes, auth flow, or account expectations:
  - update [README.md](README.md)
  - update [docs/configuration.md](docs/configuration.md)
  - update [docs/operations.md](docs/operations.md)

## Scope Boundaries

Keep out of scope unless explicitly requested:
- multi-channel support
- cloud deployment complexity
- advanced long-term memory systems
- browser-based Twitch control
- analytics dashboards beyond logs and SQLite audit trails

## Verification Expectations

For cleanup or behavior changes, prefer:

```bash
npm run check
npm test
npm run build
```

For prompt/policy iteration:

```bash
npm run eval:scenarios -- --suite social
npm run replay -- --limit 25
npm run review:inbox -- --limit 25
npm run eval:compare -- --baseline safer-control --candidate witty-mod
npm run approve:pilot
```

For live operator checks:

```bash
npm run dev
npm run chat:send -- "hello from the bot"
```

## Documentation Set

Maintain these as concise runbooks:
- [README.md](README.md)
- [docs/configuration.md](docs/configuration.md)
- [docs/architecture.md](docs/architecture.md)
- [docs/operations.md](docs/operations.md)
- [docs/milestones.md](docs/milestones.md)

If a repeated mistake or ambiguous convention shows up, update this file so the fix persists.
