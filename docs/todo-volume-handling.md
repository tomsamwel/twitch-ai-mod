# Volume Handling for High-Traffic Streams

## Completed

### AI Review Queue (implemented)

Bounded async queue between the deterministic rule engine and AI inference. Deployed in `src/runtime/ai-review-queue.ts` with integration in `MessageProcessor`.

- Configurable capacity, concurrency, and staleness threshold (`ai.queue` in app.yaml)
- Drop-oldest eviction when queue is full
- Staleness check: items waiting longer than `stalenessMs` are discarded before processing
- Concurrency limiter: prevents unbounded parallel AI calls (1 for local LLM, configurable higher for API)
- Queue stats exposed on the admin panel (`GET /api/status → aiQueue`)
- Eval/replay scripts bypass the queue entirely (direct path via processingMode check)
- CooldownManager Maps now have TTL-based eviction to prevent unbounded memory growth

## Future Considerations

The items below are ideas that emerged during high-volume research. They are not committed plans — by the time they're revisited, the actual bottlenecks observed in production may point to different solutions. Treat these as starting points for investigation, not specifications.

### Priority Lanes

The current queue uses simple drop-oldest eviction. Under sustained load, this means a safety-critical message (e.g., first-time chatter posting a suspicious URL) could be evicted by a flood of routine messages. A priority system could ensure certain message categories always reach AI review.

Possible priority signals to investigate:
- Messages containing hard-violation keywords or URLs from non-subscribers
- First-time chatters (no prior message history in the database)
- Messages directly addressing the bot (social mode)
- Inverse subscriber tier (newer/unknown users get higher moderation priority)

The right priority scheme depends heavily on what real traffic patterns look like. It may turn out that the deterministic rule engine already catches the high-priority cases, making priority lanes unnecessary.

### Circuit Breaker for AI Provider

When llama-server becomes unresponsive or consistently times out, the queue fills up and items are evicted without getting reviewed. A circuit breaker could detect this pattern and temporarily disable AI dispatch, falling back to deterministic-only moderation until the provider recovers.

This would involve tracking consecutive failures or latency spikes, transitioning to an "open" state where AI calls are skipped immediately, and periodically probing to detect recovery. The existing abstain-on-error behavior in the provider already handles individual failures gracefully — the circuit breaker would formalize the pattern for sustained outages.

### Fast-Path Triage Filters

Not all messages need AI review. Adding lightweight checks before the queue could significantly reduce AI call volume during high-traffic periods:

- Emote-only messages (zero text parts after filtering emotes)
- Very short messages with no risk signals (<8 chars, no URLs, no mentions, no hard-violation keywords)
- Near-duplicate detection for raid copypasta (hash recent messages, only AI-review the first few copies of identical content)
- Trusted user cache (users with N consecutive abstain decisions get temporarily exempted)

The tradeoff is complexity vs. AI call reduction. Some of these filters may interact with the prompt system or moderation policy in non-obvious ways. Measuring the actual AI call rate during a real stream would help prioritize which filters to implement.

### Adaptive Load Shedding

Rather than fixed triage rules, the system could dynamically adjust which messages reach AI based on current queue pressure:

- Queue depth 0-50%: normal triage
- Queue depth 50-80%: tighten filters (e.g., skip AI for subscribers with clean history)
- Queue depth 80-100%: only safety-critical messages get AI review

This requires a sliding window message rate counter to detect bursts, and clear operator visibility (log level transitions, admin panel indicators).

Whether this is worth the complexity depends on how often the queue actually fills up during real streams. It may be that the existing capacity + staleness eviction is sufficient.

### Deterministic Rule Expansion

Expanding the deterministic rule engine to catch more patterns without AI would reduce load on the queue:

- URL/link detection for non-subscribers as a standalone rule
- More regex patterns for common scam/spam variants
- Repeated message detection (same user posting identical content multiple times)

This is the most conservative approach — it doesn't add architectural complexity, just more patterns. The eval system can validate that new rules don't produce false positives.

## Constraints (unchanged)

- Must not drop hard-violation messages (keywords like "kys", "send nudes")
- Must not skip deterministic rules regardless of load
- Social replies (bot addressed) should always be processed
- All skipped/shed messages should be logged for audit

## Prior Research

Detailed analysis of token budgets, Ollama performance, Twitch rate limits, and architecture options was done during the prompt-optimization and volume-research work. Key findings: 10k-follower streams see 3-10 msg/sec normally, 20-50+ during bursts. Twitch EventSub delivers all messages with no server-side throttle. The Twitch moderator chat limit is 100 msg/30s. llama-server with Qwen3 4B processes ~12-30 decisions/minute.
