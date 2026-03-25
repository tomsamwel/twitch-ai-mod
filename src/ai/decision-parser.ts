import type { Logger } from "pino";

import { aiDecisionPayloadSchema, buildAbstainDecision, payloadToAiDecision } from "./decision-schema.js";
import type { AiDecision, AiDecisionInput, AiProviderKind } from "../types.js";

function normalizeCommonModelMistakes(parsed: unknown): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const candidate = structuredClone(parsed) as Record<string, unknown>;

  if (candidate.outcome === "abstain") {
    candidate.actions = [];
  }

  return candidate;
}

export function parseAiDecisionText(
  rawText: string,
  source: AiProviderKind,
  input: AiDecisionInput,
  logger: Logger,
): AiDecision {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const payload = aiDecisionPayloadSchema.parse(normalizeCommonModelMistakes(parsed));
    return payloadToAiDecision(payload, source, input);
  } catch (error) {
    logger.warn(
      {
        err: error,
        provider: source,
        rawText: rawText.slice(0, 2000),
      },
      "AI provider returned invalid structured output; abstaining",
    );

    return buildAbstainDecision(source, input.mode, "provider returned invalid structured output", {
      failureKind: "invalid_output",
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
