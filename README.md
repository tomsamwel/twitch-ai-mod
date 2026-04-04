# twitch-ai-mod

Local-first AI Twitch moderator bot for a single Twitch channel.

The bot runs on your machine, reads live chat through official Twitch EventSub, sends chat/moderation actions through official Twitch APIs, and keeps prompts, policy, runtime controls, and eval tooling editable without changing the core pipeline.

## What Exists Now

- Twurple auth, Helix API access, and EventSub WebSocket ingestion
- shared action path for `say`, `warn`, and `timeout`
- dry-run gating plus auditable live actions
- moderation-only public warning notices that stay separate from social replies
- SQLite persistence for tokens, ingested events, message snapshots, decisions, actions, runtime overrides, and control audits
- prompt-pack based AI behavior
- local `llama-cpp` (via llama-server with KV cache checkpointing), `ollama`, and remote `openai` adapters behind one `AiProvider` interface
- deterministic large visual-spam / ASCII-art timeout detection
- replay CLI against captured chat snapshots
- scripted scenario-lab CLI against curated YAML cases
- review inbox and replay-to-scenario promotion workflow
- side-by-side prompt-pack comparison reports
- local Prompt Lab in the admin panel for draft editing, dataset building, experiments, annotations, and pack export
- whisper control plane for trusted controllers

## Quick Start

1. Create a Twitch app at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps).
2. Set the redirect URI to `http://localhost:3000/callback`.
3. Copy [`.env.example`](.env.example) to `.env` and fill in the Twitch client ID and secret.
4. Edit:
   - [config/app.yaml](config/app.yaml)
   - [config/control-plane.yaml](config/control-plane.yaml)
   - [config/cooldowns.yaml](config/cooldowns.yaml)
   - [config/moderation-policy.yaml](config/moderation-policy.yaml)
5. Install llama-server and pull the model:

```bash
brew install llama.cpp
ollama pull qwen3:4b-instruct
```

6. Start llama-server (keep this terminal open):

```bash
./scripts/start-llama-server.sh
```

7. Use a dedicated bot account for whisper control. That account must:
   - be separate from the broadcaster account
   - be moderator in the channel
   - have verified email
   - have a verified phone number if it needs to send whisper replies
8. Run OAuth for the bot account:

```bash
npm run auth:login
```

9. Start the bot (in a second terminal):

```bash
npm run dev
```

## Why llama-server Instead of Ollama?

The default model (`qwen3:4b-instruct`) uses a hybrid attention architecture that breaks Ollama's KV cache prefix reuse. Every request reprocesses the full prompt from scratch, adding 2-4 seconds of latency.

`llama-server` from llama.cpp b8458+ includes `--checkpoint-every-n-tokens` which creates recurrent state checkpoints, enabling prefix caching. With our prompts, ~88% of the system prompt is reused across requests, reducing prompt eval from ~2-4s to ~0.9s.

The `ollama` provider is still available as a fallback via `aimod model local-ollama`.

## Daily Commands

```bash
npm run check
npm test
npm run build
npm run start
npm run chat:send -- "hello from the bot"
npm run replay -- --limit 25
npm run eval:scenarios -- --suite social
npm run eval:compare -- --baseline safer-control --candidate witty-mod
npm run review:inbox -- --limit 25
npm run review:mark -- --event-id <event-id> --verdict prompt-fix
npm run review:promote -- --event-id <event-id> --suite promo-scam --id promoted-case
npm run approve:pilot
```

## Prompt And Eval Workflow

- Prompt packs live only in [prompts/packs](prompts/packs).
- Each prompt pack also carries a small `pack.yaml` manifest so comparisons are tied to an explicit hypothesis.
- Curated eval cases live in [evals/scenarios](evals/scenarios).
- Scenarios are now script-capable: `seed` history plus `steps[]`.
- The legacy-named `future-warn-candidates` suite is now active coverage for public room-setting `warn` behavior.
- Replay reuses real captured chat from SQLite.
- Replay inbox turns high-signal real incidents into a lightweight local review queue.
- Promotion scaffolds reviewed replay incidents into curated YAML scenarios.
- Scenario compare runs candidate vs baseline packs side by side.
- Runtime overrides from whisper commands persist in SQLite until `aimod reset`.
- Prompt Lab drafts, datasets, runs, and annotations live in SQLite and stay local to your machine.
- Prompt Lab drafts do not affect production behavior until you explicitly export them into `prompts/packs/<pack>/`.
- Exported packs are registered immediately, so they show up in runtime pack selection without restarting the bot.
- Replay and scenario artifacts stay stored for evaluation, but live heuristics and live-default operator views stay scoped to live data.

When `admin.enabled: true`, open `http://127.0.0.1:3001` and use the `Prompt Lab` tab as:
- `Iterate`: create a draft, build one active dataset, and run focused experiments
- `Ship`: export the draft, run full compare and approval, then optionally set the runtime pack
- `Discovery`: review recent live cases, label them, add them to datasets, and promote edited scaffolds into curated scenarios

Prompt Lab is local-first on purpose: the SQLite workspace is for fast iteration, while on-disk prompt packs remain the only source of truth for anything that can become live. Full compare and approval in the UI still run against exported packs only, so the terminal and the admin panel share the same reproducible pack boundary.

Example comparisons:

```bash
npm run eval:scenarios -- --suite promo-scam --prompt-pack witty-mod
npm run eval:compare -- --baseline safer-control --candidate witty-mod --model qwen3:4b-instruct
npm run review:inbox -- --limit 25
npm run review:promote -- --event-id <event-id> --suite escalation --id promoted-case
npm run approve:pilot -- --prompt-pack witty-mod --model qwen3:4b-instruct
```

`approve:pilot` runs the curated scenario suites only and writes Markdown plus JSON approval artifacts under `data/reports/`. Those reports are generated output and are not kept in source control. Real captured chat stays outside the test verdict and should be reviewed separately through `review:inbox` and optionally promoted into new curated scenarios.

Approval is precision-first: wrongful timeouts, blocking missed required timeouts, and provider failures block approval. General abstains and social-quality misses stay visible in the report, but they are advisory by default.

## Whisper Control

Whispers are the private control surface. Trusted controller logins are configured in [config/control-plane.yaml](config/control-plane.yaml).

Supported commands:

```text
aimod help
aimod status
aimod ai on|off
aimod ai-moderation on|off
aimod social on|off
aimod dry-run on|off
aimod live-moderation on|off
aimod pack <pack-name>
aimod model <preset-name>
aimod reset
```

Operational notes:
- `aimod status` shows effective live state, not just file defaults
- overrides survive restart because they are stored in SQLite
- `aimod reset` clears runtime overrides, exemptions, and runtime blocked terms, then returns to file defaults
- `aimod ai-moderation on` is a separate gate for AI-generated live moderation actions
- whisper replies require the bot account to have a verified phone number on Twitch
- runtime-added controllers from the local admin panel persist in SQLite and are authorized by stable Twitch user ID
- authorized whispers refresh the stored login/display-name metadata for runtime-added controllers

## Safety Defaults

- deterministic rules run before AI
- live moderation remains disabled unless you explicitly turn it on
- AI live moderation has its own separate runtime gate and stays off by default
- live AI timeouts are hard-gated by confidence, moderation category, privileged/self protection, and repeat-evidence checks
- clean apologies and de-escalation follow-ups are guarded against history-only AI moderation
- `warn` is a moderation-only public notice; `say` remains the social/helpful reply path
- timeout flows can pair `timeout` with a public `warn`, and skipped notices are still audited
- chat send and moderation have separate gates
- bot-authored messages are snapshotted for context/audit, then ignored for rules/AI to prevent loops

## Docs

- [AGENTS.md](AGENTS.md): repo runbook and invariants for agents
- [docs/configuration.md](docs/configuration.md): source-of-truth config files and runtime overrides
- [docs/architecture.md](docs/architecture.md): system design and runtime flow
- [docs/operations.md](docs/operations.md): exact bring-up, whisper, replay, review, compare, and troubleshooting steps
- [docs/milestones.md](docs/milestones.md): delivered scope and next milestones

## Design Constraints

This repo intentionally stays on official Twitch patterns only:
- EventSub WebSocket for chat intake
- Helix APIs for send/moderation/whispers
- no browser automation
- no unofficial IRC workarounds
- no MCP

The AI layer intentionally stays lightweight:
- one narrow app-owned provider interface
- direct adapters underneath it
- deterministic local context retrieval instead of a separate summarizer model
