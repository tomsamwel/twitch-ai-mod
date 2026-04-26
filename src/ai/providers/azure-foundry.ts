import OpenAI from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { buildAbstainDecision } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

import { stripTrailingSlash } from "./util.js";

class AzureContentFilterError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AzureContentFilterError";
  }
}

function isAzureContentFilterError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (error instanceof AzureContentFilterError) return true;
  const record = error as Record<string, unknown>;
  if (record.code === "content_filter") return true;
  const inner = record.error;
  if (inner && typeof inner === "object" && (inner as Record<string, unknown>).code === "content_filter") {
    return true;
  }
  return false;
}

function extractCompletionText(payload: ChatCompletion): string {
  const choice = payload.choices[0];
  const content = choice?.message?.content;

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

  // Azure also filters model *output* — in that case the API returns a
  // ChatCompletion with empty content and finish_reason="content_filter".
  if (choice?.finish_reason === "content_filter") {
    throw new AzureContentFilterError("Azure content filter blocked the model output");
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

      const deployment = input.config.ai.azureFoundry.deployment;
      // Pure reasoning models (GPT-5, GPT-5-mini/nano, o-series) don't support
      // custom temperature and include reasoning tokens in the completion budget.
      // GPT-5.x variants (5.4-mini etc.) are standard instruction models, NOT reasoning.
      const isReasoningModel = /^(gpt-5(-|$)|o[0-9])/.test(deployment);

      const response: ChatCompletion = await client.chat.completions.create(
        {
          model: deployment,
          stream: false,
          ...(isReasoningModel ? {} : { temperature: input.temperature }),
          // Reasoning models (GPT-5, o-series) use completion token budget for both
          // internal reasoning AND output. A 150-token budget gets consumed entirely
          // by reasoning, producing empty output. Use a floor of 2000 to ensure
          // enough headroom for reasoning + our ~150 token JSON output.
          max_completion_tokens: isReasoningModel
            ? Math.max(2000, input.config.ai.requestDefaults.maxOutputTokens)
            : input.config.ai.requestDefaults.maxOutputTokens,
          response_format: {
            type: "json_object",
          },
          messages: [
            {
              // Reasoning models (GPT-5, o-series) use "developer" role; others use "system".
              role: isReasoningModel ? "developer" : "system",
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

      this.logger.debug(
        { provider: this.kind, finishReason: response.choices[0]?.finish_reason, hasContent: !!response.choices[0]?.message?.content },
        "Azure AI Foundry raw response metadata",
      );

      return parseAiDecisionText(extractCompletionText(response), this.kind, input, this.logger);
    } catch (error) {
      const isContentFilter = isAzureContentFilterError(error);
      this.logger.warn(
        { err: error, provider: this.kind, contentFilter: isContentFilter },
        isContentFilter
          ? "Azure AI Foundry content filter rejected the prompt; abstaining"
          : "Azure AI Foundry decision request failed; abstaining",
      );
      return buildAbstainDecision(
        this.kind,
        input.mode,
        isContentFilter ? "Azure content filter rejected prompt" : "Azure AI Foundry request failed",
        {
          failureKind: isContentFilter ? "content_filter" : "request_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
        },
      );
    }
  }
}
