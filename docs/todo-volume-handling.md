# TODO: Volume Handling for High-Traffic Streams

## Problem

The bot currently sends every non-rule-matched message to the local LLM sequentially. At ~5s per inference, a 10k-follower stream with 20-50 messages/second during peaks (raids, hype trains, emote storms) would create an unbounded backlog. Moderation decisions arriving 30+ seconds late are worse than no moderation.

## Research Areas

### 1. AI Request Queue
- Bounded queue between message processor and LLM provider
- Concurrency limit (1 for local, higher for API)
- Priority scoring (social > first-time chatter > subscriber > viewer)
- Stale message dropping (messages older than N seconds are not worth moderating)

### 2. Smart Fast-Path Filtering
- Short messages (<12 chars, no URLs, no hard-violation keywords) skip AI
- Emote-only messages skip AI
- Trusted user cache (N consecutive clean messages → temporary AI skip)
- Near-duplicate detection for raid copypasta (only first few copies need AI)

### 3. Adaptive Load Shedding
- When queue depth exceeds thresholds, progressively raise filtering aggressiveness
- Social-mode messages (bot addressed) should never be shed
- Operator visibility: log level transitions, optional whisper/admin notification

### 4. Deterministic Rule Expansion
- More regex patterns for common scam/spam variants to catch without AI
- URL/link detection for non-subscribers as a deterministic rule
- Reduce the percentage of messages that need AI from ~10-25% to ~5%

## Constraints

- Must not drop hard-violation messages (keywords like "kys", "send nudes")
- Must not skip deterministic rules regardless of load
- Social replies (bot addressed) should always be processed
- All skipped/shed messages should be logged for audit

## Prior Research

Detailed analysis of token budgets, Ollama performance, and architecture options was done during the prompt-optimization work. See the research notes in the project memory and the eval results from that session. The token optimization and llama-cpp provider migration were the first steps — this volume handling work is the next layer.
