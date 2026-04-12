# Design: Azure AI Foundry LLM Integration

## Status

Proposal — not yet implemented.

## Context

The bot currently supports three LLM providers (`ollama`, `openai`, `llama-cpp`), all behind the `AiProvider` interface. We want to use models deployed through **Azure AI Foundry** — which covers both Azure OpenAI Service (GPT-4o, o-series) and Azure AI Model Inference (Llama, Mistral, Phi, etc. as serverless endpoints).

### Current provider architecture

```
AiProvider interface
├── OllamaAiProvider    — POST /api/chat             (Ollama-native format)
├── OpenAiAiProvider    — POST /responses             (OpenAI Responses API)
└── LlamaCppAiProvider  — POST /v1/chat/completions   (OpenAI Chat Completions)
```

Each provider is self-contained (~60–170 lines), handles its own HTTP calls, auth, health checks, and response parsing. The decision parser (`parseAiDecisionText`) is shared. Adding a new provider touches ~10 files (documented in CLAUDE.md).

### Azure AI Foundry API surface

Azure exposes two endpoint styles, both using the **Chat Completions** format:

| Deployment type | URL pattern | Auth |
|---|---|---|
| Azure OpenAI Service | `https://{resource}.openai.azure.com/openai/deployments/{deployment}/chat/completions?api-version={version}` | `api-key` header or Azure AD Bearer token |
| Azure AI Model Inference (serverless) | `https://{endpoint}.models.ai.azure.com/chat/completions` | `api-key` header or Azure AD Bearer token |

Key differences from what the codebase already supports:

1. **Auth header**: Azure uses `api-key: <key>`, not `Authorization: Bearer <key>`
2. **API version**: Azure OpenAI requires `?api-version=` query parameter
3. **URL structure**: deployment name is in the URL path, not the request body
4. **Health check**: no `/health` or `/models/{id}` — Azure has no equivalent lightweight endpoint
5. **Content filtering**: Azure responses may include `content_filter_results` metadata
6. **Structured output**: Azure OpenAI supports `response_format: { type: "json_schema", ... }` (same as llama-cpp uses today)

### Critical observation

The existing `openai` provider uses the **Responses API** (`POST /responses` with `input_text` content blocks) — this is a newer OpenAI-specific API that Azure does **not** support. Azure uses the **Chat Completions API** (`POST /chat/completions` with `messages` array), which is the same format that `llama-cpp` already uses. This rules out simple config-only approaches through the `openai` provider.

---

## Options

### Option A: Dedicated `azure` provider (recommended)

Add `"azure"` as a new `AiProviderKind` with its own adapter class.

#### What changes

| File | Change |
|---|---|
| `src/types.ts` | Add `"azure"` to `AI_PROVIDER_KINDS` |
| `src/config/schema.ts` | Add `azure` config section to `appConfigSchema.ai`; add `"azure"` to both `z.enum(AI_PROVIDER_KINDS)` sites (line 40, line 98) |
| `src/types.ts` | Add `azure` section to `ConfigSnapshot["ai"]` |
| `src/config/load-config.ts` | Map `azure` config; validate `AZURE_API_KEY` when provider is `azure` |
| `src/config/schema.ts` (`envSchema`) | Add `AZURE_API_KEY` optional env var |
| `src/ai/providers/azure.ts` | **New file** — `AzureAiProvider` implementing `AiProvider` |
| `src/ai/provider-registry.ts` | Add `azure` entry to registry |
| `src/ai/provider-config.ts` | Add `azure` branch to `getConfiguredProviderInfo` |
| `src/control/runtime-settings.ts` | Add `azure` branches to `getProviderConfig` + `createEffectiveConfig` |
| `src/scripts/script-support.ts` | Add `azure` branch to model override |
| 4 CLI scripts | Add `"azure"` to `--provider` validation |
| `.env.example` | Add `AZURE_API_KEY` |
| `tests/ai-provider.test.ts` | Add Azure provider tests |
| `config/app.yaml` | Add `azure:` config section |

#### Config shape

```yaml
# config/app.yaml
ai:
  azure:
    baseUrl: https://my-resource.openai.azure.com   # or https://my-endpoint.models.ai.azure.com
    deploymentName: gpt-4o                           # Azure OpenAI deployment name
    model: gpt-4o                                    # model identifier for logging/cache key
    apiVersion: "2024-12-01-preview"                 # required for Azure OpenAI; omit for serverless
```

```env
# .env
AZURE_API_KEY=your-azure-api-key-here
```

The provider would build the URL dynamically:
- If `apiVersion` is set: `{baseUrl}/openai/deployments/{deploymentName}/chat/completions?api-version={apiVersion}` (Azure OpenAI)
- If `apiVersion` is omitted: `{baseUrl}/chat/completions` (serverless inference)

#### Provider implementation sketch

```typescript
export class AzureAiProvider implements AiProvider {
  public readonly kind = "azure" as const;

  async healthCheck(): Promise<void> {
    // Azure has no lightweight /health — send a minimal
    // completions request with max_tokens: 1, or simply
    // validate that the API key is present and the base URL
    // is reachable (HEAD request or similar).
  }

  async decide(input: AiDecisionInput): Promise<AiDecision> {
    const { baseUrl, deploymentName, model, apiVersion } = input.config.ai.azure;
    const apiKey = input.config.secrets.azureApiKey;

    const url = apiVersion
      ? `${baseUrl}/openai/deployments/${deploymentName}/chat/completions?api-version=${apiVersion}`
      : `${baseUrl}/chat/completions`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": apiKey,            // Azure auth style
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Same Chat Completions body as llama-cpp provider:
        model,
        temperature: input.config.ai.requestDefaults.temperature,
        max_tokens: input.config.ai.requestDefaults.maxOutputTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "twitch_ai_decision",
            strict: true,
            schema: aiDecisionJsonSchema,
          },
        },
        messages: [
          { role: "system", content: input.prompt.system },
          { role: "user", content: input.prompt.user },
        ],
      }),
    });

    // Parse Chat Completions response: payload.choices[0].message.content
    // Then: parseAiDecisionText(rawText, this.kind, input, this.logger)
  }
}
```

#### Pros

- **Follows established pattern** — every existing provider is a self-contained class; this is the same
- **Clean identity** — `source: "azure"` in decisions and logs; no ambiguity
- **Azure-specific features** — can parse `content_filter_results`, handle Azure-specific error codes (429 with `retry-after-ms`), support Azure AD auth in future
- **Independent health check** — can implement Azure-appropriate validation without compromising other providers
- **Runtime switchable** — works with existing model preset system out of the box
- **Predictable scope** — the ~10-file checklist in CLAUDE.md is already documented

#### Cons

- **~20 lines of HTTP logic overlap with `llama-cpp`** — the Chat Completions request body and response parsing are nearly identical
- **~10 files touched** — standard for any new provider, but non-trivial

#### Effort estimate

The provider class itself is ~90 lines. The remaining ~10 file changes are mechanical (adding `"azure"` to unions, config sections, switch branches). Tests add ~60 lines following existing patterns.

---

### Option B: Extract shared Chat Completions client, thin Azure adapter

Refactor the Chat Completions HTTP logic out of `LlamaCppAiProvider` into a shared utility module, then both `llama-cpp` and `azure` become thin wrappers.

#### What changes (on top of Option A's file list)

| File | Change |
|---|---|
| `src/ai/providers/chat-completions-client.ts` | **New file** — shared `sendChatCompletionsRequest()` function |
| `src/ai/providers/llama-cpp.ts` | Refactored to use shared client |
| `src/ai/providers/azure.ts` | Uses shared client with Azure auth/URL logic |

#### Shared client shape

```typescript
interface ChatCompletionsOptions {
  url: string;
  headers: Record<string, string>;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}

interface ChatCompletionsResult {
  text: string;
  raw: unknown;   // full response for metadata extraction
}

export async function sendChatCompletionsRequest(
  options: ChatCompletionsOptions,
): Promise<ChatCompletionsResult> {
  // ~30 lines: build body, fetch, parse choices[0].message.content
}
```

#### Pros

- **DRY** — Chat Completions logic written once, used by `llama-cpp`, `azure`, and any future OpenAI-compatible provider (vLLM, TGI, etc.)
- **Easier to add more providers later** — each new one is just URL + headers + config
- **Testable in isolation** — the shared client can have its own unit tests

#### Cons

- **Refactors working code** — `llama-cpp` works today; extracting logic risks subtle regressions
- **More indirection** — two modules to understand instead of one self-contained file
- **Premature if Azure is the only addition** — the shared logic is only ~20 lines; the abstraction overhead may exceed the duplication cost
- **Same ~10-file scope** for the new provider kind — this option doesn't reduce config/type changes

#### Verdict

This is the right move **if** we expect to add a third Chat Completions provider (Anthropic via OpenAI-compatible proxy, vLLM, etc.). For Azure alone, the duplication is small enough (~20 lines) that Option A is simpler.

---

### Option C: Extend `openai` provider with Azure compatibility mode

Add an `azureConfig` subsection to the existing `openai` config, and branch inside `OpenAiAiProvider` based on whether Azure mode is active.

#### What changes

| File | Change |
|---|---|
| `src/config/schema.ts` | Add `azure` sub-object to `openai` config section |
| `src/ai/providers/openai.ts` | Add Azure branches for URL construction, auth, request format, response parsing |
| `src/config/load-config.ts` | Handle `AZURE_API_KEY` |
| Fewer type/registry changes | No new provider kind needed |

#### How it would work

```yaml
ai:
  provider: openai
  openai:
    baseUrl: https://my-resource.openai.azure.com
    model: gpt-4o
    azure:                               # presence of this section activates Azure mode
      deploymentName: gpt-4o
      apiVersion: "2024-12-01-preview"
```

Inside `OpenAiAiProvider.decide()`:
```typescript
if (this.isAzureMode()) {
  // Build Azure URL, use api-key header, Chat Completions format
} else {
  // Existing Responses API logic
}
```

#### Pros

- **No new provider kind** — fewer files touched (~5 instead of ~10)
- **Conceptual grouping** — Azure OpenAI "is" OpenAI, so sharing a provider kind makes some sense

#### Cons

- **Fundamental API mismatch** — the current `openai` provider uses the Responses API (`/responses` with `input_text` content blocks); Azure uses Chat Completions (`/chat/completions` with `messages`). These are completely different request/response formats. The provider would need two entirely separate code paths for request building AND response parsing
- **Misleading identity** — `source: "openai"` in decisions when the request went to Azure; confuses debugging, eval analysis, and production monitoring
- **Conditional complexity** — every method (`healthCheck`, `decide`, response parsing) needs `if (azure)` branches, turning a clean 170-line provider into a ~300-line two-in-one
- **Testing burden** — need to test both paths, doubling the test surface for one provider
- **Breaks provider cache** — the registry caches by `${kind}|${baseUrl}|${model}`, so `"openai"` + Azure URL would cache correctly, but logs and decision sources would be wrong
- **Config coupling** — changes to Azure config could break vanilla OpenAI users and vice versa

#### Verdict

**Not recommended.** The Responses API vs Chat Completions API mismatch means this isn't really "extending" the provider — it's cramming two unrelated providers into one class. The file-count savings (~5 fewer files) don't justify the architectural cost.

---

### Option D: Config-only reuse of `llama-cpp` provider

Point `llamaCpp.baseUrl` at an Azure endpoint with no code changes.

```yaml
ai:
  provider: llama-cpp
  llamaCpp:
    baseUrl: https://my-endpoint.models.ai.azure.com
    model: gpt-4o
```

#### Why this doesn't work

| Problem | Severity |
|---|---|
| No auth headers — Azure requires `api-key` header | **Blocker**: every request returns 401 |
| No `api-version` query param for Azure OpenAI endpoints | **Blocker** for Azure OpenAI Service |
| Health check hits `/health` which doesn't exist on Azure | Startup failure |
| `source: "llama-cpp"` in decisions is misleading | Confusing |
| `managed: true` would try to start a local llama-server | Crash |

#### Verdict

**Non-viable without code changes.** Listed for completeness — this is the first thing someone would try, and it's important to document why it fails.

---

## Comparison matrix

| Criterion | A: Dedicated | B: Shared client | C: Extend openai | D: Config-only |
|---|---|---|---|---|
| Works without code changes | No | No | No | **No (blocker)** |
| Files touched | ~14 | ~16 | ~8 | 0 |
| New lines of code | ~150 | ~190 | ~130 | 0 |
| Duplicated logic | ~20 lines | None | None | N/A |
| Follows existing patterns | Yes | Partially (refactors) | No | N/A |
| Clean provider identity | Yes | Yes | No | No |
| Azure-specific features | Easy | Easy | Possible | No |
| Future extensibility | Good | Best | Poor | N/A |
| Risk of regression | Low | Medium | Medium | N/A |
| Runtime preset support | Works | Works | Partial | N/A |

## Recommendation

**Option A (dedicated `azure` provider)** for initial implementation. It follows the exact pattern the codebase already uses, the ~20-line duplication with `llama-cpp` is trivial, and the ~10-file checklist is already documented in CLAUDE.md.

If a third Chat Completions provider is added later, refactor to Option B at that point — extracting the shared client is straightforward when you have two concrete implementations to generalize from.

## Implementation order

If proceeding with Option A:

1. `src/types.ts` — add `"azure"` to `AI_PROVIDER_KINDS`
2. `src/config/schema.ts` — add `AZURE_API_KEY` to `envSchema`, add `azure` section to `appConfigSchema.ai`, add `"azure"` to both `z.enum(AI_PROVIDER_KINDS)` sites
3. `src/types.ts` — add `azure` to `ConfigSnapshot["ai"]`, add `azureApiKey` to `secrets`
4. `src/config/load-config.ts` — map azure config, validate key, expose secret
5. `src/ai/providers/azure.ts` — implement `AzureAiProvider`
6. `src/ai/provider-registry.ts` — add factory entry
7. `src/ai/provider-config.ts` — add `getConfiguredProviderInfo` branch
8. `src/control/runtime-settings.ts` — add `getProviderConfig` + `createEffectiveConfig` branches
9. `src/scripts/script-support.ts` — add model override branch
10. 4 CLI scripts — add `"azure"` to `--provider` validation
11. Config files — add `azure:` section to `app.yaml`, optional preset to `control-plane.yaml`
12. `.env.example` — add `AZURE_API_KEY`
13. `tests/ai-provider.test.ts` — add Azure provider tests
14. Docs — update `docs/configuration.md`, CLAUDE.md counts

## Open questions

1. **Azure AD auth**: Should we support managed identity / Azure AD tokens in addition to API keys? This would require a token refresh mechanism. Recommendation: start with API key only, add Azure AD later if needed.
2. **Content filtering metadata**: Azure responses include `content_filter_results`. Should we surface this in `AiDecision.metadata`? Recommendation: yes, log it but don't act on it (the bot has its own moderation logic).
3. **Health check strategy**: Azure has no `/health` endpoint. Options: (a) validate API key is present + do a GET on the deployment, (b) send a minimal completions request with `max_tokens: 1`, (c) skip health check for Azure. Recommendation: (a) — validate config locally, attempt a lightweight GET to verify connectivity.
4. **Structured output support**: Azure OpenAI supports `response_format: { type: "json_schema" }` for GPT-4o and later. Older deployments may not. Should the provider fall back to `json_object` mode? Recommendation: require a model that supports `json_schema`; fail loudly if not.
