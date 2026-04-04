import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { buildAbstainDecision, aiDecisionJsonSchema } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

interface LlamaCppChatChoice {
  message?: {
    content?: string;
  };
}

interface LlamaCppChatResponse {
  error?: { message?: string };
  choices?: LlamaCppChatChoice[];
}

export class LlamaCppAiProvider implements AiProvider {
  public readonly kind = "llama-cpp" as const;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  private getLlamaCppConfig(config: ConfigSnapshot): { baseUrl: string; model: string } {
    if (!config.ai.llamaCpp) {
      throw new Error("ai.llamaCpp configuration is required when provider is llama-cpp");
    }
    return config.ai.llamaCpp;
  }

  public async healthCheck(): Promise<void> {
    const { baseUrl } = this.getLlamaCppConfig(this.config);
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(this.config.ai.requestDefaults.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`llama-server health check failed with status ${response.status}`);
    }
  }

  public async decide(input: AiDecisionInput): Promise<AiDecision> {
    const { baseUrl, model } = this.getLlamaCppConfig(input.config);

    try {
      const response = await fetch(new URL("/v1/chat/completions", baseUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(input.config.ai.requestDefaults.timeoutMs),
        body: JSON.stringify({
          model,
          cache_prompt: true,
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

      const payload = (await response.json()) as LlamaCppChatResponse;

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `llama-server request failed with status ${response.status}`);
      }

      const rawText = payload.choices?.[0]?.message?.content;

      if (!rawText) {
        throw new Error("llama-server response did not include message content");
      }

      return parseAiDecisionText(rawText, this.kind, input, this.logger);
    } catch (error) {
      this.logger.warn({ err: error, provider: this.kind }, "llama-server decision request failed; abstaining");
      return buildAbstainDecision(this.kind, input.mode, "llama-server request failed", {
        failureKind: "request_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
