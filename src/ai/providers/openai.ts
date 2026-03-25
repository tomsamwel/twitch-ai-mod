import type { Logger } from "pino";

import { parseAiDecisionText } from "../decision-parser.js";
import { aiDecisionJsonSchema, buildAbstainDecision } from "../decision-schema.js";
import type { AiDecision, AiDecisionInput, ConfigSnapshot } from "../../types.js";
import type { AiProvider } from "../provider.js";

interface OpenAiErrorResponse {
  error?: {
    message?: string;
  };
}

interface OpenAiModelResponse {
  id?: string;
}

interface OpenAiResponsesOutputTextItem {
  type: "output_text";
  text: string;
}

interface OpenAiResponsesRefusalItem {
  type: "refusal";
  refusal: string;
}

interface OpenAiResponsesMessage {
  content?: Array<OpenAiResponsesOutputTextItem | OpenAiResponsesRefusalItem>;
}

interface OpenAiResponsesResponse extends OpenAiErrorResponse {
  output_text?: string;
  output?: Array<{
    content?: OpenAiResponsesMessage["content"];
  }>;
}

function stripTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function extractResponseText(payload: OpenAiResponsesResponse): string {
  if (payload.output_text) {
    return payload.output_text;
  }

  const chunks =
    payload.output
      ?.flatMap((entry) => entry.content ?? [])
      .map((content) => {
        if (content.type === "refusal") {
          throw new Error(content.refusal);
        }

        return content.text;
      })
      .filter(Boolean) ?? [];

  if (chunks.length === 0) {
    throw new Error("OpenAI response did not include output text");
  }

  return chunks.join("\n");
}

export class OpenAiAiProvider implements AiProvider {
  public readonly kind = "openai" as const;

  public constructor(
    private readonly config: ConfigSnapshot,
    private readonly logger: Logger,
  ) {}

  public async healthCheck(): Promise<void> {
    const apiKey = this.config.secrets.openaiApiKey;

    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is required when ai.provider is openai.");
    }

    const response = await fetch(
      `${stripTrailingSlash(this.config.ai.openai.baseUrl)}/models/${encodeURIComponent(this.config.ai.openai.model)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(this.config.ai.requestDefaults.timeoutMs),
      },
    );

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as OpenAiErrorResponse | null;
      throw new Error(payload?.error?.message ?? `OpenAI health check failed with status ${response.status}`);
    }

    const payload = (await response.json()) as OpenAiModelResponse;

    if (payload.id !== this.config.ai.openai.model) {
      throw new Error(`OpenAI model ${this.config.ai.openai.model} could not be validated.`);
    }
  }

  public async decide(input: AiDecisionInput): Promise<AiDecision> {
    const apiKey = input.config.secrets.openaiApiKey;

    if (!apiKey) {
      return buildAbstainDecision(this.kind, input.mode, "OpenAI API key is not configured");
    }

    try {
      const response = await fetch(`${stripTrailingSlash(input.config.ai.openai.baseUrl)}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(input.config.ai.requestDefaults.timeoutMs),
        body: JSON.stringify({
          model: input.config.ai.openai.model,
          store: false,
          temperature: input.config.ai.requestDefaults.temperature,
          max_output_tokens: input.config.ai.requestDefaults.maxOutputTokens,
          input: [
            {
              role: "system",
              content: [
                {
                  type: "input_text",
                  text: input.prompt.system,
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: input.prompt.user,
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "twitch_ai_decision",
              strict: true,
              schema: aiDecisionJsonSchema,
            },
          },
        }),
      });

      const payload = (await response.json()) as OpenAiResponsesResponse;

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `OpenAI request failed with status ${response.status}`);
      }

      return parseAiDecisionText(extractResponseText(payload), this.kind, input, this.logger);
    } catch (error) {
      this.logger.warn({ err: error, provider: this.kind }, "OpenAI decision request failed; abstaining");
      return buildAbstainDecision(this.kind, input.mode, "OpenAI request failed", {
        failureKind: "request_failed",
        errorType: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
