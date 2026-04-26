# Architecture

## Layer Map

1. `src/twitch/`
   Twurple auth, identity lookup, token validation, Helix API access, EventSub WebSocket subscriptions.
2. `src/ingest/`
   Normalizes Twitch events into internal message shapes.
3. `src/moderation/`
   Deterministic rules plus cooldown tracking.
4. `src/ai/`
   Prompt composition, prompt packs, decision schema parsing, deterministic context retrieval, provider adapters, provider registry.
5. `src/actions/`
   Shared execution path for `say`, `warn`, and `timeout`.
6. `src/control/`
   Whisper command parsing, controller authorization, runtime override storage, effective runtime settings.
7. `src/storage/`
   SQLite persistence and structured logging.
8. `src/runtime/`
   Shared message processor used by live chat, replay, and scenario evaluation.
9. `src/eval/`
   Scripted YAML scenario suites, replay promotion helpers, and evaluation reporting.
10. `src/review/`
   Replay inbox ranking and local review report generation.
12. `src/config/`
   Env/YAML/prompt-pack loading and validation into one `ConfigSnapshot`.

## Source Of Truth

- YAML files hold default behavior.
- prompt packs hold editable voice/behavior instructions.
- SQLite holds runtime state:
  - OAuth tokens
  - ingested event dedupe
  - message snapshots
  - rule/AI decisions
  - actions
  - review decisions
  - runtime overrides
  - control audits

The app never rewrites YAML files at runtime.

## Effective Runtime Settings

The live app, replay CLI, and scenario lab all depend on the same effective runtime settings logic:

1. Start with file-backed `ConfigSnapshot`.
2. Overlay persisted runtime overrides from SQLite.
3. Resolve the active prompt pack.
4. Resolve the active model preset, if any.
5. Produce an effective config for the AI/action pipeline.

This keeps live, replay, and eval behavior aligned instead of hand-rolling mode-specific config objects.

## Live Chat Flow

1. Load config, prompt packs, and SQLite.
2. Load the stored Twitch token through Twurple.
3. Resolve broadcaster and bot identities.
4. Start EventSub WebSocket for chat and whispers.
5. Normalize incoming chat events.
6. Persist/dedupe events and snapshot messages.
7. Ignore bot-authored chat after snapshotting to avoid self-reply loops while preserving audit/context value.
8. Run deterministic rules.
9. If rules abstain and AI is enabled, build deterministic SQLite-backed context and call the active AI provider.
10. Execute resulting actions through the shared action executor, including moderation-notice cooldowns and the live AI timeout precision gate.
11. Persist decisions/actions and emit structured logs.

## Whisper Control Flow

1. Receive `user.whisper.message` for the bot account.
2. Parse a strict `aimod ...` command.
3. Resolve controller authorization by user ID.
4. Apply allowed runtime overrides in SQLite.
5. Reply privately by whisper.
6. Record the attempt and outcome in `control_audit`.

Important invariants:
- dedicated bot account recommended
- verified phone number required for outgoing whisper replies
- controller allowlist is local-only: YAML plus local admin-panel runtime additions, never mutated from Twitch chat
- runtime-added controllers are stored with stable Twitch user IDs and authorized by sender user ID
- three permission tiers: broadcaster (everything), admin (all toggles + management), mod (status + exempt + block)
- runtime exemptions and blocked terms stored in SQLite, checked before rule engine and action execution

## Replay Flow

1. Read message snapshots from SQLite.
2. Re-run the shared rule/AI/action pipeline.
3. Force all resulting actions to dry-run.
4. Persist replay-tagged decisions/actions for comparison.
5. Keep replay-tagged rows out of live heuristics and live-default operator views.

Replay is for real captured chat history.

## Scenario Eval Flow

1. Load curated YAML cases from `evals/scenarios/`.
2. Seed scenario history into SQLite.
3. Run the same rule/AI/action pipeline step by step.
4. Force all actions to dry-run.
5. Aggregate per-step blocking/advisory issues plus pass/fail into one scenario result.
6. Print a human-readable pass/fail report.

Scenario snapshots, decisions, and actions are partitioned from live data by `processing_mode` so seeded history stays useful for evaluation without leaking into live context retrieval, repeat-offender heuristics, or live-default dashboards.

Scenario eval is for curated prompt/policy iteration, not Twitch integration testing.

## Review Inbox Flow

1. Read recent SQLite message snapshots.
2. Join related decisions, actions, and prior review verdicts.
3. Rank high-signal incidents such as timeout candidates, precision-gated timeout skips, AI replies, provider failures, cooldown suppressions, privileged cases, self-loops, and repeated-user sequences.
   Review reports also surface `warn-issued`, `timeout-notice-skipped`, and `visual-spam-candidate` reasons for moderation tuning.
4. Write Markdown plus JSON review reports under `data/reports/`.
5. Optionally mark incidents locally or scaffold them into new scripted scenarios.

Review/inbox and admin activity views default to live-mode rows. Replay and scenario data remain stored for intentional evaluation workflows, but they are not mixed into live operations by default.

## AI Design Notes

- The app owns a narrow `AiProvider` interface.
- Provider creation is centralized behind the provider registry/factory path.
- `llama-cpp`, `ollama`, and `openai` use the same decision schema.
- Prompt packs are first-class and selected by name; `pack.yaml` includes a changelog tracking prompt changes with hypotheses and results.
- Prompt-pack manifests make baseline vs candidate comparisons explicit.
- System prompt ordering: role → mode → style → safety → contract → examples (contract before examples so examples are read in output-schema context).
- Safety rules include "why" justifications to help the model generalize to novel edge cases.
- The `reason` field in the decision contract uses compressed chain-of-thought: a short evidence checklist, not a reasoning narrative.
- The moderation action contract is intentionally narrow:
  moderation can abstain, emit a public `warn`, or emit ordered `[timeout, warn]`; social mode only emits `say`.
- Context enrichment is deterministic and local-first; there is no separate summarizer or long-term memory model.
- A small post-model guardrail can convert known-clean de-escalation follow-ups into abstains so prior history alone does not trigger moderation.

## Operational Notes

- Twurple `8.x` is ESM-only, so the project uses `NodeNext`/ESM.
- Real moderation is gated by the nested config tree: rules-sourced timeouts need `rules.enabled`; AI-sourced timeouts additionally need `ai.enabled && ai.moderation.enabled && ai.moderation.timeout`.
- Live AI timeout execution is narrower than general AI moderation:
  only allowlisted moderation categories with sufficient confidence can execute, and spam-escalation also needs repeat evidence or a recent corrective interaction.
- Scenario approval is precision-first:
  wrongful timeouts, blocking missed required timeouts, and provider failures block approval; abstains and reply-quality misses are advisory unless a scenario explicitly marks the missed timeout as blocking.
- Large high-confidence visual spam can be timed out deterministically before AI.
- Public moderation notes use `warn`, default to replying to the offending message, and stay auditable even when skipped.
- Chat send and moderation share the same action executor and audit trail.
- Bot-authored messages remain available for context and history even though they are skipped for live decisioning.
