# Milestones

## Current Delivered Scope

The repo now supports:

- local Node.js + TypeScript runtime
- Twurple auth and EventSub WebSocket integration
- live chat intake
- live chat send through the shared action executor
- one real moderation action: timeout
- dry-run gating for all actions
- structured logs plus SQLite audit trails
- prompt-pack based behavior tuning
- real `ollama` and `openai` adapters behind one provider interface
- deterministic SQLite-backed AI context retrieval
- replay against captured chat snapshots
- scripted scenario-lab evaluation against curated YAML cases
- replay inbox reports with local review verdicts
- replay-to-scenario promotion scaffolds
- side-by-side prompt-pack comparison reports
- whisper-based trusted-controller runtime overrides
- self-loop suppression for bot-authored chat events
- pilot approval reports against scenario suites plus replay
- a separate runtime gate for AI-generated live moderation

## Current Operating Posture

Recommended during active tuning:

- use a dedicated bot account
- keep live social replies enabled only when you want reality checks
- keep live moderation disabled by default
- keep AI live moderation disabled by default until the approval report passes and timeout candidates are reviewed
- iterate first through:
  - prompt packs
  - scenario eval
  - replay
  - pilot approval
  - then controlled live chat tests

## Near-Term Next Steps

1. Tune the default prompt pack with curated-first scenario comparisons plus replay promotion.
2. Review and refine the future-warn scenario slice before adding live warn support.
3. Run a limited AI-assisted live moderation pilot behind explicit operator gates.
4. Improve API-provider parity so local and remote backends are easier to compare.
5. Add more operator-safe controls only if they stay strict and auditable.

## Later

- Azure/OpenAI-compatible adapters
- broader moderation escalation policies
- richer but still low-volume social behavior
- stronger regression reporting around prompt packs and models
- multi-channel support only if single-channel iteration is stable enough to justify it
