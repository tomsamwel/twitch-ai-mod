import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { buildAbstainDecision, aiDecisionJsonSchema } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

interface OllamaTagsResponse {
  models?: Array<{
    model?: string;
    name?: string;
  }>;
}

interface OllamaChatResponse {
  error?: string;
  message?: {
    content?: string;
  };
}

export class OllamaAiProvider implements AiProvider {
  public readonly kind = "ollama" as const;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  public async healthCheck(): Promise<void> {
    const response = await fetch(new URL("/api/tags", this.config.ai.ollama.baseUrl), {
      signal: AbortSignal.timeout(this.config.ai.requestDefaults.timeoutMs),
    });

    if (!response.ok) {
      throw new Error(`Ollama health check failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OllamaTagsResponse;
    const availableModels = new Set(
      (payload.models ?? []).flatMap((model) => [model.model, model.name].filter(Boolean) as string[]),
    );

    if (!availableModels.has(this.config.ai.ollama.model)) {
      throw new Error(
        `Ollama is reachable, but model ${this.config.ai.ollama.model} is not available. Run \`ollama pull ${this.config.ai.ollama.model}\`.`,
      );
    }
  }

  public async decide(input: AiDecisionInput): Promise<AiDecision> {
    try {
      const response = await fetch(new URL("/api/chat", this.config.ai.ollama.baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(input.config.ai.requestDefaults.timeoutMs),
        body: JSON.stringify({
          model: input.config.ai.ollama.model,
          stream: false,
          format: aiDecisionJsonSchema,
          keep_alive: input.config.ai.ollama.keepAlive ?? -1,
          options: {
            temperature: input.config.ai.requestDefaults.temperature,
            num_predict: input.config.ai.requestDefaults.maxOutputTokens,
            ...(input.config.ai.ollama.numCtx ? { num_ctx: input.config.ai.ollama.numCtx } : {}),
          },
          messages: [
            {
              role: "system",
              content: input.prompt.system,
            },
            {
              role: "user",
              content: input.prompt.user,
            },
          ],
        }),
      });

      const payload = (await response.json()) as OllamaChatResponse;

      if (!response.ok) {
        throw new Error(payload.error ?? `Ollama request failed with status ${response.status}`);
      }

      const rawText = payload.message?.content;

      if (!rawText) {
        throw new Error("Ollama response did not include message content");
      }

      return parseAiDecisionText(rawText, this.kind, input, this.logger);
    } catch (error) {
      this.logger.warn({ err: error, provider: this.kind }, "Ollama decision request failed; abstaining");
      return buildAbstainDecision(this.kind, input.mode, "Ollama request failed", {
        failureKind: "request_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
