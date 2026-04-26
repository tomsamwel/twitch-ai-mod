import type { Logger } from "pino";

import { aiDecisionPayloadSchema, createAiDecisionPayloadSchema, buildAbstainDecision, payloadToAiDecision } from "./decision-schema.js";
import type { AiDecision, AiDecisionInput, AiProviderKind } from "../types.js";
import { asRecord } from "../utils.js";

export type AiDecisionParseContext = Pick<
  AiDecisionInput,
  "mode" | "config" | "isFirstTimeChatter" | "greetingEnabled" | "message"
>;

interface NormalizationResult {
  value: unknown;
  injectedMissingWarn: boolean;
}

function normalizeCommonModelMistakes(parsed: unknown, input: AiDecisionParseContext): NormalizationResult {
  const candidate = asRecord(parsed);
  if (!candidate) {
    return { value: parsed, injectedMissingWarn: false };
  }

  if (typeof candidate.mode === "string" && candidate.mode !== input.mode) {
    candidate.mode = input.mode;
  }

  // Some models (observed on GPT-4.1) emit the action kind as the top-level outcome
  // (e.g. {"outcome":"warn",...,"actions":[{"kind":"warn",...}]}). When the outcome
  // string matches a known action kind and actions are present, coerce to "action".
  if (
    (candidate.outcome === "warn" || candidate.outcome === "timeout" || candidate.outcome === "say") &&
    Array.isArray(candidate.actions) &&
    candidate.actions.length > 0
  ) {
    candidate.outcome = "action";
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
    return { value: candidate, injectedMissingWarn: false };
  }

  const actions = candidate.actions.filter(
    (action): action is Record<string, unknown> => asRecord(action) !== null,
  );

  let injectedMissingWarn = false;

  if (candidate.mode === "moderation" && candidate.outcome === "action") {
    const firstAction = actions[0];
    const secondAction = actions[1];
    const fallbackMessage = input.config.moderationPolicy.publicNotices.generic;

    if (firstAction?.kind === "timeout" && !secondAction) {
      injectedMissingWarn = true;
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

  // First-time chatter greeting: if the model returned multiple say actions,
  // merge them into one (the model sometimes splits a greeting into two messages).
  if (input.isFirstTimeChatter && actions.length > 1 && actions.every((a) => a.kind === "say")) {
    const merged = actions[0]!;
    for (let i = 1; i < actions.length; i++) {
      const extra = actions[i];
      if (typeof extra?.message === "string" && typeof merged.message === "string") {
        merged.message = `${merged.message} ${extra.message}`;
      }
    }
    candidate.actions = [merged];
  }

  return { value: candidate, injectedMissingWarn };
}

export function parseAiDecisionText(
  rawText: string,
  source: AiProviderKind,
  input: AiDecisionParseContext,
  logger: Logger,
): AiDecision {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    const providerMode =
      parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as Record<string, unknown>).mode === "string"
        ? ((parsed as Record<string, unknown>).mode as string)
        : null;
    const { value: normalized, injectedMissingWarn } = normalizeCommonModelMistakes(parsed, input);
    if (injectedMissingWarn) {
      logger.warn(
        { provider: source, eventId: input.message.eventId },
        "AI model returned timeout without companion warn; injected fallback warn",
      );
    }
    const schema = input.isFirstTimeChatter
      ? createAiDecisionPayloadSchema({ isFirstTimeChatter: true, greetingEnabled: input.greetingEnabled })
      : aiDecisionPayloadSchema;
    const payload = schema.parse(normalized);
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
