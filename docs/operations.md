# Operations

## Initial Bring-Up

1. Create a Twitch app with redirect URI:

```text
http://localhost:3000/callback
```

2. Copy [`.env.example`](.env.example) to `.env`.
3. Configure:
   - [config/app.yaml](config/app.yaml)
   - [config/control-plane.yaml](config/control-plane.yaml)
   - [config/cooldowns.yaml](config/cooldowns.yaml)
   - [config/moderation-policy.yaml](config/moderation-policy.yaml)
4. Choose your AI backend.

For local `llama-cpp`:

```bash
brew install llama.cpp
ollama pull qwen3:4b-instruct
```

For Azure AI Foundry:
- set `ai.provider: azure-foundry`
- set `ai.azureFoundry.baseUrl` to your OpenAI v1 endpoint
- set `ai.azureFoundry.deployment` to the deployed model name
- set `AZURE_FOUNDRY_API_KEY` in `.env`

5. Use a dedicated bot account for whisper control.
6. Mod that bot account in the broadcaster channel.
7. Run bot OAuth:

```bash
npm run auth:login
```

8. Start the bot:

```bash
npm run dev
```

When `ai.provider: llama-cpp` and `ai.llamaCpp.managed: true`, the app starts `llama-server` automatically. If managed startup is disabled, run your own compatible server at the configured `ai.llamaCpp.baseUrl`.

For unattended operation, prefer:

```bash
npm run build
npm start
```

Run that under `systemd`, `launchd`, `pm2`, or a container restart policy. The bot now has an EventSub disconnect watchdog and can exit after a long Twitch/network outage, but a supervisor is what turns that into an automatic restart.

## Re-Auth After Scope Changes

If you add/remove Twitch scopes in [config/app.yaml](config/app.yaml):

1. stop the bot
2. rerun:

```bash
npm run auth:login
```

3. make sure you authorize the bot account, not the broadcaster account
4. restart the bot

## Local Smoke Test

1. Start the bot:

```bash
npm run dev
```

2. Send one manual bot chat message:

```bash
npm run chat:send -- "hello from the bot"
```

3. Verify logs show:
   - startup
   - EventSub WebSocket connected
   - processed action request for `say`
   - or, during moderation tests, processed action requests for `warn` and `timeout`

## Whisper Control Test

From the broadcaster or another trusted controller, whisper the bot account:

```text
aimod status
aimod recent
aimod stats
aimod rules on
aimod ai on
aimod social on
aimod mod on
aimod warn on
aimod timeout off
aimod exempt someuser
aimod block raid spam phrase
aimod status
aimod reset
```

Expected:
- one whisper reply per command
- a `control_audit` record per command
- runtime changes visible immediately in logs and `aimod status`
- `aimod reset` clears runtime overrides, exemptions, and runtime blocked terms, but leaves trusted controllers intact

## Prompt Iteration Loop

For curated prompt/policy iteration:

```bash
npm run eval:scenarios -- --suite social-direct
npm run eval:scenarios -- --suite promo-scam --prompt-pack safer-control
npm run eval:scenarios -- --suite adversarial
npm run eval:compare -- --baseline safer-control --candidate witty-mod --model qwen3:4b-instruct
npm run eval:scenarios -- --model qwen2.5:1.5b
npm run eval:scenarios -- --provider azure-foundry --model your-deployment-name
```

To find production decisions worth promoting to eval scenarios:

```bash
npm run eval:candidates -- --limit 30
npm run review:promote -- --event-id <id> --suite <suite> --id <slug>
```

For real captured chat:

```bash
npm run replay -- --limit 25
npm run review:inbox -- --limit 25
```

Operational expectation:
- replay and scenario runs are still written to SQLite for evaluation
- live moderation heuristics and live-default admin/review views stay scoped to live data

Recommended order:
1. scenario eval
2. compare against baseline with the precision-first report
3. replay
4. review inbox
5. promote any must-keep replay cases into curated scenarios
6. pilot approval report
7. short live social test
8. only then consider live moderation rehearsal

Current installed local comparison set:
- `qwen3:4b-instruct`
- `qwen2.5:1.5b`

Deferred follow-up once additional models are installed:
- rerun the same eval loop on `qwen3:8b`
- rerun the same eval loop on `gemma3:12b`

During prompt tuning, include the active public-warning and visual-spam cases in the loop:
- standalone `warn` scenarios should stay `warn`, not slide back to social `say`
- obvious large visual spam should stay deterministic `timeout` plus `warn`
- borderline symbol floods should avoid wrongful timeouts
- clean apology and de-escalation follow-up scenarios should stay `abstain` even after prior warnings

## Replay Review Loop

Use the local review loop to turn real incidents into permanent eval coverage:

```bash
npm run review:inbox -- --limit 25
npm run review:mark -- --event-id <event-id> --verdict prompt-fix
npm run review:promote -- --event-id <event-id> --suite escalation --id promoted-case
```

Recommended use:
1. generate the inbox
2. mark whether the issue is prompt, policy, or promotion-worthy
3. promote only the incidents worth keeping as permanent regression cases
4. clean up the generated YAML before relying on it

## Pilot Approval

Run the approval pass before any AI-assisted live moderation:

```bash
npm run approve:pilot -- --model qwen3:4b-instruct
```

What it does:
- runs all scenario suites
- writes Markdown and JSON reports to `data/reports/`
- treats wrongful timeouts, blocking missed timeouts, and provider failures as approval blockers
- keeps pass rates and social misses visible, but advisory
- keeps missing or skipped public notices visible in reports, but advisory unless a scenario explicitly requires them

Only enable AI live moderation after:
- the approval report passes
- there are no wrongful timeout blockers
- there are no blocking missed-timeout blockers
- there are no provider failures
- recent real-chat cases from `review:inbox` were reviewed manually
- you still explicitly choose to enable the AI moderation gate

Enable sequence:

```text
aimod status
aimod rules on
aimod mod on
aimod status
```

## Safe Live Moderation Rehearsal

Only enable this intentionally.

Required settings:
- `rules.enabled: true` (or `aimod rules on`)
- `ai.moderation.enabled: true` (or `aimod mod on`)
- `ai.moderation.timeout: true` (or `aimod timeout on` — default true when `mod` flips on)

Prefer a short timeout duration during rehearsal and use a test chatter account in a controlled session.
Remember that live AI timeouts are still hard-gated by confidence, moderation category, privileged/self protection, and spam-escalation repeat evidence.
If live chat messages are enabled, timeout flows may also emit a follow-up public `warn`. If the timeout is skipped or live chat messages are disabled, the skipped notice is still recorded for audit.

## Troubleshooting

### Whisper command works but no whisper reply arrives

Likely causes:
- bot account has no verified phone number
- bot OAuth token is missing whisper scopes
- the bot account is not the account that was authenticated

Check:
- [config/app.yaml](config/app.yaml) scopes
- rerun `npm run auth:login`
- verify the bot account phone number in Twitch settings

### Whisper reply arrives twice

The control plane dedupes by whisper event ID, so duplicates usually mean two app processes are running.

Check:

```bash
ps -ef | grep "tsx watch src/index.ts"
```

Stop the extra process and retry.

### Bot receives chat but does not answer

Check:
- was the incoming message a direct mention or clear social prompt
- is `aimod ai on`
- is `aimod social on`
- is the active prompt pack the one you expect
- is the current model stable enough
- are cooldowns suppressing replies

Use:

```text
aimod status
```

Also check the admin `Health` panel. It now shows EventSub connection state, disconnect count, last disconnect time, and whether the disconnect watchdog considers the connection stalled.

### Bot speaks to itself

Bot-authored messages should be snapshotted and then skipped for rules/AI. If self-loop behavior appears again:
- verify the configured bot login matches the authenticated bot account
- verify the incoming chatter ID for the echoed bot message
- inspect recent snapshots and actions in SQLite

### Live moderation never fires

Check all the gates:
- for rule-sourced timeouts: `rules.enabled: true` (or `aimod rules on`)
- for AI-sourced timeouts: `ai.enabled: true` + `ai.moderation.enabled: true` + `ai.moderation.timeout: true` (or `aimod mod on` / `aimod timeout on`)

Also verify the rule or AI path actually produced a moderation action.
If the timeout came from AI, also verify:
- the AI confidence met the configured minimum
- the moderation category is allowlisted for live timeout
- the target was not privileged
- spam-escalation cases had repeat evidence or a recent corrective bot interaction
- `review:inbox` does not show repeated `precision-gated-timeout` skips for that pattern

### Timeout happens but no public warning appears

Check:
- `actions.allowLiveChatMessages: true`
- moderation-notice cooldowns in [config/cooldowns.yaml](config/cooldowns.yaml)
- whether the timeout itself was skipped, precision-gated, or failed

Use `review:inbox` to confirm whether the event was recorded as `warn-issued` or `timeout-notice-skipped`.

## Verification Commands

Use this set after meaningful changes:

```bash
npm run check
npm test
npm run build
npm run eval:scenarios -- --model qwen3:4b-instruct
npm run eval:scenarios -- --model qwen2.5:1.5b
npm run eval:compare -- --baseline safer-control --candidate witty-mod --model qwen3:4b-instruct
npm run approve:pilot -- --model qwen3:4b-instruct
npm run review:inbox -- --limit 25
```
