import type { Logger } from "pino";

import { aiDecisionPayloadSchema, buildAbstainDecision, payloadToAiDecision } from "./decision-schema.js";
import type { AiDecision, AiDecisionInput, AiProviderKind } from "../types.js";

function normalizeCommonModelMistakes(parsed: unknown, input: AiDecisionInput): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const candidate = structuredClone(parsed) as Record<string, unknown>;

  if (typeof candidate.mode === "string" && candidate.mode !== input.mode) {
    candidate.mode = input.mode;
  }

  if (candidate.outcome === "abstain") {
    candidate.actions = [];
  }

  if (
    typeof candidate.moderationCategory !== "string" &&
    (candidate.mode === "social" || candidate.outcome === "abstain")
  ) {
    candidate.moderationCategory = "none";
  }

  if (!Array.isArray(candidate.actions)) {
    return candidate;
  }

  const actions = candidate.actions.filter(
    (action): action is Record<string, unknown> => !!action && typeof action === "object" && !Array.isArray(action),
  );

  if (candidate.mode === "moderation" && candidate.outcome === "action") {
    const firstAction = actions[0];
    const secondAction = actions[1];
    const fallbackMessage = input.config.moderationPolicy.publicNotices.generic;

    if (firstAction?.kind === "timeout" && !secondAction) {
      candidate._normalizedMissingWarn = true;
      actions.push({
        kind: "warn",
        reason: "public timeout notice",
        message: fallbackMessage,
      });
    }

    for (const action of actions) {
      if (action.kind === "warn" && typeof action.message !== "string") {
        action.message = fallbackMessage;
      }
    }

    candidate.actions = actions;
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
    const providerMode =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).mode === "string"
        ? ((parsed as Record<string, unknown>).mode as string)
        : null;
    const normalized = normalizeCommonModelMistakes(parsed, input);
    const hadMissingWarn =
      normalized && typeof normalized === "object" && !Array.isArray(normalized) &&
      (normalized as Record<string, unknown>)._normalizedMissingWarn === true;
    if (hadMissingWarn) {
      delete (normalized as Record<string, unknown>)._normalizedMissingWarn;
      logger.warn(
        { provider: source, eventId: input.message.eventId },
        "AI model returned timeout without companion warn; injected fallback warn",
      );
    }
    const payload = aiDecisionPayloadSchema.parse(normalized);
    const decision = payloadToAiDecision(payload, source, input);

    if (providerMode && providerMode !== input.mode) {
      return {
        ...decision,
        metadata: {
          ...(decision.metadata ?? {}),
          providerMode,
          normalizedMode: input.mode,
        },
      };
    }

    return decision;
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
