# Configuration

## File Map

Configuration is intentionally split by concern.

- [config/app.yaml](config/app.yaml)
  App identity, Twitch logins/scopes, provider defaults, prompt-pack selection, context limits, dry-run/live gates.
- [config/control-plane.yaml](config/control-plane.yaml)
  Whisper command settings, trusted controllers, allowed prompt packs, named model presets.
- [config/cooldowns.yaml](config/cooldowns.yaml)
  Chat, moderation, and mode-aware AI review cooldowns.
- [config/moderation-policy.yaml](config/moderation-policy.yaml)
  Deterministic rules, high-level AI posture, and live AI timeout gating.
- [prompts/packs/](prompts/packs)
  The only supported prompt source.
- `prompts/packs/<pack>/pack.yaml`
  Small pack manifest for comparison reports and prompt iteration hypotheses.
- [evals/scenarios/](evals/scenarios)
  Curated scripted YAML suites for prompt/policy evaluation.

Root `prompts/*.md` is not supported anymore.

## Environment

Use [`.env.example`](.env.example) as the template.

Required:
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TWITCH_REDIRECT_URI`

Optional:
- `TWITCH_BROADCASTER_LOGIN` — override the broadcaster login from `config/app.yaml` (live mode only)
- `TWITCH_BOT_LOGIN` — override the bot login from `config/app.yaml` (live mode only)
- `TWITCH_OAUTH_HOST`
- `TWITCH_OAUTH_PORT`
- `OPENAI_API_KEY`
- `APP_LOG_LEVEL`

Login overrides apply only when running the live bot (`npm run dev`). Eval, replay, and approval scripts always use the YAML-defined logins so scenario identities stay deterministic.

## App Config

[config/app.yaml](config/app.yaml) controls:

- `runtime`
  Dry-run, log level, token validation cadence.
- `storage`
  SQLite path.
- `promptPacks.defaultPack`
  The default pack loaded at startup.
- `twitch`
  Broadcaster login, bot login, required scopes.
- `ai`
  Provider selection, request defaults, context limits, provider-specific endpoints/models.
- `actions`
  Live chat send and live moderation gates.

Important live flags:

- `runtime.dryRun: true`
  No real send or moderation actions.
- `runtime.dryRun: false` and `actions.allowLiveChatMessages: true`
  Allows real chat sends.
- `runtime.dryRun: false` and `actions.allowLiveModeration: true`
  Allows real timeout actions.

For safe rollout, enable chat send before moderation.

## Prompt Packs

Each prompt pack must contain:

- `pack.yaml`
- `system.md`
- `social-persona.md`
- `moderation.md`
- `response-style.md`
- `safety-rules.md`

Example pack paths:

- [prompts/packs/witty-mod](prompts/packs/witty-mod)
- [prompts/packs/safer-control](prompts/packs/safer-control)

Prompt packs should keep a clear timeout ladder:
- first-pass nuisance spam, fuzzy growth hints, suggestive-but-not-explicit sexual chatter, and ordinary self-promo stay below timeout
- explicit scams, explicit sexual demands, coercive threats, and clearly repeated spam after correction may timeout

The selected pack can come from:
- `promptPacks.defaultPack`
- a runtime override via whisper control
- a replay/eval CLI override

## Control Plane

[config/control-plane.yaml](config/control-plane.yaml) controls:

- `enabled`
- `commandPrefix`
- `trustedControllerLogins`
- `broadcasterAlwaysAllowed`
- `allowedPromptPacks`
- `modelPresets`

Whisper control requirements:
- use a dedicated bot account
- mod that bot in the channel
- include whisper scopes in `twitch.requiredScopes`
- rerun `npm run auth:login` after scope changes
- verify a phone number on the bot account if whisper replies should work

Supported commands:

- `aimod help`
- `aimod status`
- `aimod ai on|off`
- `aimod ai-moderation on|off`
- `aimod social on|off`
- `aimod dry-run on|off`
- `aimod live-moderation on|off`
- `aimod pack <pack-name>`
- `aimod model <preset-name>`
- `aimod reset`

Rules:
- controller access is allowlist-only
- controller logins are managed locally in YAML, not from Twitch chat
- `model` only switches between named presets, not arbitrary model strings
- `reset` clears SQLite overrides and restores file defaults

## Runtime Overrides

Whisper commands do not rewrite YAML files.

Instead, runtime overrides are stored in SQLite and applied through the effective runtime settings layer. That means:
- changes take effect immediately
- changes survive restart
- file defaults remain unchanged
- `aimod reset` restores the file-defined defaults

Typical override targets:
- AI on/off
- AI live moderation on/off
- social replies on/off
- dry-run on/off
- live moderation on/off
- active prompt pack
- active model preset

## AI Providers

`ai.provider: ollama`
- local HTTP runtime
- current default model: `qwen3:4b-instruct`
- useful fallback preset: `qwen2.5:1.5b`

`ai.provider: openai`
- OpenAI Responses API
- requires `OPENAI_API_KEY`
- configured through `ai.openai.baseUrl` and `ai.openai.model`

The app keeps one shared decision schema across providers, so the rest of the pipeline stays the same when switching.

The current action contract is:
- `[]` for abstain
- `[say]` for social/helpful replies
- `[warn]` for public moderation without timeout
- `[timeout, warn]` for timeout plus public room-setting notice

`warn` is moderation-only. Social mode should never emit `warn`.

## AI Moderation Policy

`aiPolicy`
- `enabled`
- `mode`
- `socialReplyStyle`
- `moderationStyle`
- `abstainByDefault`

`aiPolicy.liveTimeouts`
- `mode`
  Keep this at `hard-gated` in the current design.
- `minimumConfidence`
  Minimum AI confidence required before a live AI timeout may execute.
- `allowedCategories`
  The only moderation categories allowed to execute as live AI timeouts.

The hard gate applies only to live AI timeout execution. Dry-run evals still record the timeout intent so scenario approval can judge the model decision itself.

## Deterministic Moderation Rules

`deterministicRules`
- `timeoutSeconds`
- `blockedTerms`
- `spam`
- `visualSpam`
- `escalationThresholds`

`deterministicRules.visualSpam`
- `enabled`
- `minimumHighConfidenceScore`
- `minimumBorderlineScore`
- `minimumVisibleCharacters`
- `minimumLineCount`
- `minimumLongestLineLength`
- `minimumDenseSymbolRunLength`
- `minimumRepeatedVisualLines`
- `minimumSymbolDensity`
- `maximumNaturalWordRatio`

High-confidence large visual spam triggers a deterministic timeout with a companion public `warn`. Borderline visual spam stays in the prompt context as derived signals so AI can choose `warn` or abstain conservatively.

## Public Moderation Notices

`publicNotices`
- `blockedTerm`
- `spamHeuristic`
- `visualSpamAsciiArt`
- `generic`

These short templates are used for deterministic moderation notices. AI-proposed `warn` actions can provide their own wording, but deterministic rules fall back to these editable templates.

## AI Context

The AI layer builds deterministic context from SQLite:
- recent room messages
- same-user recent history
- recent bot interactions toward that user

Limits live under `ai.context` in [config/app.yaml](config/app.yaml):
- `recentRoomMessages`
- `recentUserMessages`
- `recentBotInteractions`
- `maxPromptChars`

## Cooldowns

`chat`
- `minimumSecondsBetweenBotMessages`
- `minimumSecondsBetweenBotRepliesToSameUser`
- `minimumSecondsBetweenModerationNotices`
  Shared room-setting cooldown for `warn` and timeout companion notices.
- `minimumSecondsBetweenModerationNoticesPerUser`
  Per-target cooldown so moderation notices do not flood one chatter.

`moderation`
- `minimumSecondsBetweenModerationActionsPerUser`
- `minimumSecondsBetweenEquivalentActions`

`ai`
- `minimumSecondsBetweenAiModerationReviewsForSameUser`
  Prevents repeated moderation-only AI reviews from re-firing too quickly for the same chatter.
- `minimumSecondsBetweenAiSocialReviewsForSameUser`
  Lets direct follow-up social prompts still reach the shared reply path so cooldown-suppressed follow-ups are recorded as skipped `say` actions instead of disappearing before action evaluation.

## Replay

```bash
npm run replay -- --limit 25
```

Replay:
- loads stored normalized message snapshots from SQLite
- runs rules first, then AI
- forces all resulting actions to dry-run
- tags replay decisions/actions separately from live runs

Optional overrides:
- `--provider ollama|openai`
- `--model <model-name>`
- `--prompt-pack <pack-name>`

## Scenario Lab

```bash
npm run eval:scenarios -- --suite social
```

Scenario eval:
- loads YAML scenarios from [evals/scenarios/](evals/scenarios)
- accepts both legacy single-turn files and scripted `seed + steps[]` files
- normalizes legacy cases into one-step scripts at load time
- seeds history into SQLite
- runs the shared message pipeline
- forces actions to dry-run
- prints a readable CLI report with prompt-size hints

Optional overrides:
- `--suite <name>`
- `--scenario <id>`
- `--provider ollama|openai`
- `--model <model-name>`
- `--prompt-pack <pack-name>`

### Scenario Suites

Suite directories:
- `edge-cases` — false positives, edge conditions, cooldown/privilege/loop correctness
- `escalation` — multi-step escalation paths after warnings
- `future-warn-candidates` — borderline public `warn` behavior (aspirational, not blocking)
- `harassment-sexual` — sexual harassment and coercive threats
- `loops-cooldowns` — cooldown suppression and self-loop prevention
- `moderation` — core moderation: scams, spam, rudeness, copypasta
- `privileged-safety` — privileged user exemptions
- `promo-scam` — promotional spam and scam variants
- `social` — general social interaction scenarios
- `social-direct` — bot-addressed social prompts
- `social-quiet` — non-addressing benign chat

Use suite names as filters when iterating on a specific behavior slice.

## Review Inbox

```bash
npm run review:inbox -- --limit 25
```

Review inbox:
- scans recent SQLite-backed message snapshots
- surfaces timeout candidates, precision-gated timeout skips, warn-issued events, timeout-notice skips, visual-spam candidates, AI replies, provider failures, cooldown suppressions, privileged/self-loop cases, and repeated-user sequences
- writes Markdown plus JSON reports to `data/reports/` as generated, gitignored artifacts

Review decisions are stored locally in SQLite with a small verdict set:
- `ignore`
- `keep-for-monitoring`
- `promote-to-scenario`
- `prompt-fix`
- `policy-fix`

Mark a reviewed case:

```bash
npm run review:mark -- --event-id <event-id> --verdict prompt-fix
```

Promote a replay case into a new scripted scenario scaffold:

```bash
npm run review:promote -- --event-id <event-id> --suite promo-scam --id promoted-case
```

The promoted YAML always needs manual cleanup before it becomes a trusted fixture.

## Prompt Comparison

```bash
npm run eval:compare -- --baseline safer-control --candidate witty-mod --model qwen3:4b-instruct
```

Comparison runs:
- execute the same curated scenarios against both packs
- write Markdown plus JSON reports to `data/reports/` as generated, gitignored artifacts
- rank packs precision-first: wrongful timeouts, then blocking missed timeouts, then provider failures, then advisory issues
- summarize suite pass deltas, provider-failure deltas, reply/action differences, timeout precision, and prompt-size hints

## Pilot Approval

```bash
npm run approve:pilot -- --provider ollama --model qwen3:4b-instruct
```

Approval runs:
- every scenario suite
- use the configured provider by default, or an explicit `--provider` and `--model` override

Outputs:
- a Markdown report in `data/reports/`
- a JSON report in `data/reports/`

Automatic approval blocks on:
- any wrongful timeout issue
- any blocking missed required-timeout issue
- any provider parse failure or request failure during the run

Overall pass rate, moderation pass rate, and social pass rate are still reported, but they are advisory context rather than approval gates.

Even after a passing approval run, manually review real captured chat through `review:inbox` before enabling `aimod ai-moderation on`.
