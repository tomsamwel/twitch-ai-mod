import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { buildAbstainDecision, aiDecisionJsonSchema } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

interface AzureChatChoice {
  message?: {
    content?: string;
  };
}

interface AzureChatResponse {
  error?: { message?: string; code?: string };
  choices?: AzureChatChoice[];
}

function buildChatCompletionsUrl(azureConfig: NonNullable<ConfigSnapshot["ai"]["azure"]>): string {
  const base = azureConfig.baseUrl.replace(/\/+$/, "");

  if (azureConfig.apiVersion) {
    // Azure OpenAI Service: deployment-scoped endpoint
    return `${base}/openai/deployments/${encodeURIComponent(azureConfig.deploymentName)}/chat/completions?api-version=${encodeURIComponent(azureConfig.apiVersion)}`;
  }

  // Azure AI Model Inference (serverless): flat endpoint
  return `${base}/chat/completions`;
}

export class AzureAiProvider implements AiProvider {
  public readonly kind = "azure" as const;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  private getAzureConfig(config: ConfigSnapshot): NonNullable<ConfigSnapshot["ai"]["azure"]> {
    if (!config.ai.azure) {
      throw new Error("ai.azure configuration is required when provider is azure");
    }
    return config.ai.azure;
  }

  public async healthCheck(): Promise<void> {
    const apiKey = this.config.secrets.azureApiKey;

    if (!apiKey) {
      throw new Error("AZURE_API_KEY is required when ai.provider is azure.");
    }

    const azureConfig = this.getAzureConfig(this.config);
    const url = buildChatCompletionsUrl(azureConfig);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(this.config.ai.requestDefaults.timeoutMs),
      body: JSON.stringify({
        model: azureConfig.model,
        max_tokens: 1,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as AzureChatResponse | null;
      throw new Error(
        payload?.error?.message ?? `Azure health check failed with status ${response.status}`,
      );
    }
  }

  public async decide(input: AiDecisionInput): Promise<AiDecision> {
    const apiKey = input.config.secrets.azureApiKey;

    if (!apiKey) {
      return buildAbstainDecision(this.kind, input.mode, "Azure API key is not configured");
    }

    const azureConfig = this.getAzureConfig(input.config);

    try {
      const url = buildChatCompletionsUrl(azureConfig);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(input.config.ai.requestDefaults.timeoutMs),
        body: JSON.stringify({
          model: azureConfig.model,
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

      const payload = (await response.json()) as AzureChatResponse;

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `Azure request failed with status ${response.status}`);
      }

      const rawText = payload.choices?.[0]?.message?.content;

      if (!rawText) {
        throw new Error("Azure response did not include message content");
      }

      return parseAiDecisionText(rawText, this.kind, input, this.logger);
    } catch (error) {
      this.logger.warn({ err: error, provider: this.kind }, "Azure decision request failed; abstaining");
      return buildAbstainDecision(this.kind, input.mode, "Azure request failed", {
        failureKind: "request_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
