import { z } from "zod";

import {
  moderationCategorySchema,
  type AiDecision,
  type AiDecisionInput,
  type AiMode,
  type AiProviderKind,
  type ModerationCategory,
  type ProposedAction,
} from "../types.js";

const aiActionPayloadBaseSchema = z
  .object({
    kind: z.enum(["say", "warn", "timeout"]),
    reason: z.string().min(1),
    message: z.string().min(1).optional(),
    targetUserId: z.string().min(1).optional(),
    targetUserName: z.string().min(1).optional(),
    durationSeconds: z.number().int().positive().optional(),
    replyParentMessageId: z.string().min(1).optional(),
  })
  .strict();

const aiDecisionPayloadBaseSchema = z
  .object({
    outcome: z.enum(["abstain", "action"]),
    reason: z.string().min(1),
    confidence: z.number().min(0).max(1),
    mode: z.enum(["social", "moderation"]),
    moderationCategory: moderationCategorySchema,
    actions: z.array(aiActionPayloadBaseSchema),
  })
  .strict();

export function createAiDecisionPayloadSchema(options?: { isFirstTimeChatter?: boolean }) {
  return aiDecisionPayloadBaseSchema.superRefine((payload, context) => {
    _validateAiDecisionPayload(payload, context, options?.isFirstTimeChatter ?? false);
  });
}

export const aiDecisionPayloadSchema = createAiDecisionPayloadSchema();

function _validateAiDecisionPayload(
  payload: z.infer<typeof aiDecisionPayloadBaseSchema>,
  context: z.RefinementCtx,
  isFirstTimeChatter: boolean,
): void {
  if (payload.actions.length > 2) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "actions may contain at most two items",
      path: ["actions"],
    });
  }

  if (payload.outcome === "abstain" && payload.actions.length > 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "abstain outcomes must not include actions",
      path: ["actions"],
    });
  }

  const firstAction = payload.actions[0];
  const secondAction = payload.actions[1];

  if (payload.outcome === "action") {
    if (payload.mode === "social" && payload.actions.length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "social action outcomes must include exactly one action",
        path: ["actions"],
      });
    }

    if (payload.mode === "moderation" && payload.actions.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "moderation action outcomes must include at least one action",
        path: ["actions"],
      });
    }
  }

  if (!firstAction) {
    return;
  }

  if ((firstAction.kind === "say" || firstAction.kind === "warn") && !firstAction.message) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${firstAction.kind} actions must include a message`,
      path: ["actions", 0, "message"],
    });
  }

  if (secondAction && (secondAction.kind === "say" || secondAction.kind === "warn") && !secondAction.message) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${secondAction.kind} actions must include a message`,
      path: ["actions", 1, "message"],
    });
  }

  if (payload.mode === "social" && payload.moderationCategory !== "none") {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'social decisions must use moderationCategory "none"',
      path: ["moderationCategory"],
    });
  }

  if (payload.outcome === "abstain") {
    return;
  }

  if (payload.mode === "social") {
    if (firstAction.kind !== "say") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'social actions must use kind "say"',
        path: ["actions", 0, "kind"],
      });
    }

    return;
  }

  const allowGreetingSay = isFirstTimeChatter && firstAction.kind === "say" && payload.moderationCategory === "none";
  if (payload.actions.length === 1 && firstAction.kind !== "warn" && !allowGreetingSay) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'single moderation actions must use kind "warn"',
      path: ["actions", 0, "kind"],
    });
  }

  if (payload.actions.length === 2) {
    if (firstAction.kind !== "timeout" || secondAction?.kind !== "warn") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'two-action moderation decisions must use the ordered shape ["timeout", "warn"]',
        path: ["actions"],
      });
    }
  }
}

export const aiDecisionJsonSchema = (function stripSchemaMeta(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripSchemaMeta);
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "$schema")
      .map(([key, nestedValue]) => [key, stripSchemaMeta(nestedValue)] as const);

    return Object.fromEntries(entries);
  }

  return value;
})(z.toJSONSchema(aiDecisionPayloadBaseSchema, { reused: "inline" })) as Record<string, unknown>;

export function buildAbstainDecision(
  source: AiProviderKind,
  mode: AiMode,
  reason: string,
  metadata?: Record<string, unknown>,
) {
  return {
    source,
    outcome: "abstain" as const,
    reason,
    confidence: 0,
    mode,
    moderationCategory: "none" as ModerationCategory,
    actions: [],
    ...(metadata ? { metadata } : {}),
  };
}

export function payloadToAiDecision(
  payload: z.infer<typeof aiDecisionPayloadSchema>,
  source: AiProviderKind,
  input: AiDecisionInput,
): AiDecision {
  const actions = payload.actions.map((action): ProposedAction => {
    if (action.kind === "say" || action.kind === "warn") {
      return {
        kind: action.kind,
        reason: action.reason,
        message: action.message!,
        targetUserId: input.message.chatterId,
        targetUserName: input.message.chatterLogin,
        replyParentMessageId: input.message.sourceMessageId,
      };
    }

    return {
      kind: "timeout",
      reason: action.reason,
      targetUserId: input.message.chatterId,
      targetUserName: input.message.chatterLogin,
      durationSeconds:
        action.durationSeconds ?? input.config.moderationPolicy.deterministicRules.timeoutSeconds,
    };
  });

  return {
    source,
    outcome: payload.outcome,
    reason: payload.reason,
    confidence: payload.confidence,
    mode: input.mode,
    moderationCategory: input.mode === "social" ? "none" : payload.moderationCategory,
    actions,
    ...(payload.mode !== input.mode
      ? {
          metadata: {
            providerMode: payload.mode,
            normalizedMode: input.mode,
          },
        }
      : {}),
  };
}
