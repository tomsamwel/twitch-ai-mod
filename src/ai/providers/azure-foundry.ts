import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { buildAbstainDecision } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

import { stripTrailingSlash } from "./util.js";

function extractCompletionText(payload: ChatCompletion): string {
  const content = payload.choices[0]?.message?.content;

  if (typeof content === "string" && content.trim().length > 0) {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .flatMap((part) => ("text" in part && typeof part.text === "string" ? [part.text] : []))
      .join("\n")
      .trim();

    if (text.length > 0) {
      return text;
    }
  }

  throw new Error("Azure AI Foundry response did not include output text");
}

export class AzureFoundryAiProvider implements AiProvider {
  public readonly kind = "azure-foundry" as const;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  public async healthCheck(): Promise<void> {
    const apiKey = this.config.secrets.azureFoundryApiKey;

    if (!apiKey) {
      throw new Error("AZURE_FOUNDRY_API_KEY is required when ai.provider is azure-foundry.");
    }

    if (!this.config.ai.azureFoundry) {
      throw new Error("ai.azureFoundry configuration is required when ai.provider is azure-foundry.");
    }

    new URL(this.config.ai.azureFoundry.baseUrl);

    if (this.config.ai.azureFoundry.apiStyle !== "chat-completions") {
      throw new Error(`Unsupported Azure AI Foundry apiStyle: ${this.config.ai.azureFoundry.apiStyle}`);
    }
  }

  public async decide(input: AiDecisionInput): Promise<AiDecision> {
    const apiKey = input.config.secrets.azureFoundryApiKey;

    if (!apiKey) {
      this.logger.warn(
        { provider: this.kind },
        "Azure AI Foundry API key is not configured; AI decisions will be skipped",
      );
      return buildAbstainDecision(this.kind, input.mode, "Azure AI Foundry API key is not configured", {
        failureKind: "configuration_error",
      });
    }

    if (!input.config.ai.azureFoundry) {
      this.logger.warn(
        { provider: this.kind },
        "Azure AI Foundry config is missing; AI decisions will be skipped",
      );
      return buildAbstainDecision(this.kind, input.mode, "Azure AI Foundry config is missing", {
        failureKind: "configuration_error",
      });
    }

    try {
      const client = new OpenAI({
        apiKey,
        baseURL: stripTrailingSlash(input.config.ai.azureFoundry.baseUrl),
      });

      const response: ChatCompletion = await client.chat.completions.create(
        {
          model: input.config.ai.azureFoundry.deployment,
          stream: false,
          temperature: input.temperature,
          max_tokens: input.config.ai.requestDefaults.maxOutputTokens,
          response_format: {
            type: "json_object",
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
        },
        {
          timeout: input.config.ai.requestDefaults.timeoutMs,
        },
      );

      return parseAiDecisionText(extractCompletionText(response), this.kind, input, this.logger);
    } catch (error) {
      this.logger.warn(
        { err: error, provider: this.kind },
        "Azure AI Foundry decision request failed; abstaining",
      );
      return buildAbstainDecision(this.kind, input.mode, "Azure AI Foundry request failed", {
        failureKind: "request_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
