# CLAUDE.md

## Build & Test

```bash
npm run check            # TypeScript type check
npm test                 # 240 unit tests (~4s), node:test framework
npm run build            # Compile to dist/
npm run eval:scenarios   # 95 AI scenarios via llama-server (several minutes, exit code 1 = some failures, expected)
npm run eval:candidates  # List production decisions worth promoting to eval scenarios
npm run eval:compare -- --baseline safer-control --candidate witty-mod
npm run approve:pilot    # Final gate before live AI moderation
npm run db:reset         # Wipe SQLite for fresh testing (requires npm run auth:login afterwards)
```

Build before running evals — they execute compiled JS from `dist/`.

## Stack

- TypeScript 5.9, Node.js >=20.20, ESM (`NodeNext`), strict mode
- Twurple 8.x (ESM-only) for Twitch API
- SQLite via better-sqlite3 (WAL mode)
- Zod 4 for schema validation
- Pino for structured logging
- Zero web framework — admin panel uses Node's built-in `http` module

## Architecture (11 layers)

`twitch/` → `ingest/` → `moderation/` (deterministic rules) → `ai/` (LLM decision) → `actions/` (execute say/warn/timeout)

Supporting: `control/` (whisper commands), `runtime/` (message processor), `storage/` (SQLite), `config/` (YAML+env loading), `eval/` (scenario testing), `review/` (replay inbox), `admin/` (HTTP panel + llama-server management)

Deterministic rules always run before AI. Bot-authored messages are snapshotted then skipped.

In live mode, AI reviews go through a bounded queue (`AiReviewQueue` in `src/runtime/ai-review-queue.ts`) with configurable capacity, concurrency, and staleness eviction (`ai.queue` in app.yaml). The queue supports per-user coalescing: rapid messages from the same chatter merge into a single queue entry, keeping the riskiest message (by URL/caps/mentions/length score) and injecting a `coalescedCount` signal into the AI prompt. Eval/replay scripts bypass the queue — `MessageProcessor.processAiReview()` is called directly.

## Config System — Key Gotchas

- **New top-level YAML sections** must be explicitly mapped in `src/config/load-config.ts` return object — the spread only covers existing fields
- **`ConfigSnapshot` in `src/types.ts` is manually defined**, not inferred from Zod — both must stay in sync
- **Env var login overrides** only apply when `applyLoginEnvOverrides: true` — only `src/bootstrap.ts` passes this for the live bot; eval/replay scripts always use YAML values
- Config files: `app.yaml` (runtime, AI, actions), `control-plane.yaml` (whisper, presets), `cooldowns.yaml`, `moderation-policy.yaml`

## Provider System

Three providers: `llama-cpp` (default), `ollama`, `openai` — all behind `AiProvider` interface.

**Adding a new provider touches ~10 files:**
1. `src/types.ts` — `AiProviderKind` union
2. `src/config/schema.ts` — two `z.enum` sites + new config section
3. `src/ai/providers/` — new adapter implementing `AiProvider`
4. `src/ai/provider-registry.ts` — factory entry
5. `src/ai/provider-config.ts` — `getConfiguredProviderInfo` branch
6. `src/control/runtime-settings.ts` — `getProviderConfig` + `buildEffectiveRuntimeSettings` + `createEffectiveConfig`
7. `src/scripts/script-support.ts` — model override branch
8. Four CLI scripts — `--provider` validation string

**llama-cpp is the default** because Qwen3's hybrid attention breaks Ollama's KV cache prefix reuse. llama-server with `--checkpoint-every-n-tokens` enables caching (~88% reuse, 3x faster prompt eval). Ollama stores blobs with dashes (`sha256-...`), not colons.

## Runtime Settings & Safety Gates

Config shape is a nested tree. Each toggle does exactly what its name says — no truth tables:

```
rules.enabled              # deterministic rules may execute warns + timeouts
ai.enabled                 # master AI toggle (kills social + moderation)
  ai.social.enabled        # AI replies (say actions) execute
  ai.moderation.enabled    # AI moderation mode runs at all
    ai.moderation.warn     # AI-issued warns execute
    ai.moderation.timeout  # AI-issued timeouts execute
```

Plus `promptPack` and `modelPreset`. All SQLite-persisted, survive restart. Override keys use dotted paths (e.g. `ai.moderation.timeout`). Runtime exemptions (`exempt_users` table) and blocked terms (`runtime_blocked_terms` table) are also SQLite-persisted.

**Defaults (fresh install)**: `rules.enabled=true`, `ai.enabled=true`, `ai.social.enabled=true`, `ai.moderation.enabled=false` (explicit opt-in), `warn=true`, `timeout=true`. Flipping `ai.moderation.enabled: true` is the single deliberate step to go live.

**Gate table**:

| Action | Source | Gates required (all) |
|--------|--------|---------------------|
| `say` | AI | `ai.enabled` + `ai.social.enabled` |
| `warn` | AI | `ai.enabled` + `ai.moderation.enabled` + `ai.moderation.warn` |
| `timeout` | AI | `ai.enabled` + `ai.moderation.enabled` + `ai.moderation.timeout` |
| `warn`/`timeout` | rules | `rules.enabled` |

AI timeouts additionally require: confidence ≥ 0.90, category in allowlist, target not privileged, spam-escalation needs prior evidence.

`ai.moderation.enabled: false` skips the moderation AI call entirely (saves a provider round-trip). To observe AI moderation decisions without acting, set `enabled: true, warn: false, timeout: false`.

There is no `dryRun` runtime toggle anymore. Eval/replay/approval scripts get dry-run behavior via `processingMode !== "live"` (set automatically by `applyNonLiveScriptOverrides`).

When bot=broadcaster, whisper control doesn't work — use admin panel at `localhost:3001`.

**Whisper commands**: `rules on|off`, `ai on|off`, `social on|off`, `mod on|off`, `warn on|off`, `timeout on|off`. Aliases: `soc`=social, `moderation`=mod. Batch commands: `panic` (everything on), `chill` (rules+social on, moderation off), `off` (rules+ai both off). Other commands: `recent [N]`, `stats`, `exempt`/`unexempt`, `block`/`unblock`, `pack`, `model`, `reset`.

**Permission tiers** (in `control-plane.yaml`): `broadcaster` (everything), `admin` (all toggles + management), `mod` (status + exempt + block only). Config uses `trustedControllers: [{login, role}]`.

## Prompt System

- **Token budget**: moderation prompts are ~2200 tokens at 4096 ctx — adding few-shot examples or safety rules can overflow; check `chars=` in eval output after changes
- Prompt packs in `prompts/packs/<name>/`: `system.md`, `social-persona.md`, `moderation.md`, `response-style.md`, `safety-rules.md`, `pack.yaml`
- Mode selection: message addresses bot/broadcaster → social; otherwise → moderation
- XML tags use short names: `<ctx>`, `<room>`, `<user_hist>`, `<bot_hist>`, `<signals>`, `<examples>`, `<contract>`
- System prompt ordering: role → mode → style → safety → **contract** → examples (contract before examples so examples are read in schema context)
- `HARD_VIOLATION_KEYWORDS` in `src/ai/prompt.ts` — shared constant for keywords that always require action
- `moderationCategorySchema.options` generates category lists dynamically from the Zod enum — don't hardcode
- Context format uses relative timestamps (`-2m`, `-45s`), omits empty sections, drops zero-value message fields
- Decision contract: social = exactly one `say`; moderation = one `warn` or ordered `[timeout, warn]`
- Contract includes compressed chain-of-thought guidance for the `reason` field (evidence checklist, not reasoning process)
- Safety rules include "why" justifications — helps the model generalize to novel edge cases
- `pack.yaml` includes a `changelog` array tracking prompt changes with date, description, hypothesis, result

## Action System

Three kinds: `say` (social reply), `warn` (public moderation notice), `timeout` (mute user).

- `warn` is moderation-only; social mode never uses it
- Parser auto-injects companion `warn` if AI returns only `timeout`
- Companion `warn` is skipped if the timeout itself was skipped/failed
- Cooldowns are per-user AND global — both must pass
- Reply fallback: if a `say`/`warn` reply-parent was purged (e.g. by a preceding timeout), the message is retried without the reply thread
- Skipped actions now log a `skipReason` field for easier debugging

## Eval System

95 YAML scenarios across 13 suites: `adversarial`, `edge-cases`, `escalation`, `future-warn-candidates`, `harassment-sexual`, `irl-safety`, `loops-cooldowns`, `moderation`, `privileged-safety`, `promo-scam`, `social`, `social-direct`, `social-quiet`.

Scenarios use `seed` history + `steps[]` with expected outcomes.

Approval is precision-first: wrongful timeouts and blocking missed timeouts fail approval. Abstains and social-quality misses are advisory.

`eval:scenarios` output includes per-category precision/recall table and confidence calibration buckets. `eval:candidates` lists production decisions worth promoting to scenarios via `review:promote`.

## Testing Conventions

- `tests/helpers.ts`: `createTestConfig()`, `createChatEvent()`, `createEmptyContext()`, `createTestRuntimeSettings()`
- Test config uses `testchannel`/`testbot` identities — matches scenario YAML
- Assert style: `node:assert/strict` with `assert.match`, `assert.equal`, `assert.ok`
- Provider tests use `withMockFetch()` helper

## When Changing X, Also Update Y

- **Prompt semantics** → update relevant scenario YAML, pack.yaml hypothesis + changelog, docs/configuration.md; verify token budget with a fast eval (`--suite irl-safety`)
- **Scenario files added/removed** → update counts in CLAUDE.md (Build & Test + Eval System), docs/milestones.md, docs/configuration.md
- **Config schema** → update `src/config/schema.ts` + `src/types.ts` ConfigSnapshot + `src/config/load-config.ts` mapping + `.env.example` if env keys change + docs/configuration.md
- **Control commands** → update `command-parser.ts` + `control-plane.ts` + `runtime-settings.ts` + README.md + docs/operations.md + tests
- **Eval behavior** → update docs/operations.md + docs/architecture.md + scenario tests
