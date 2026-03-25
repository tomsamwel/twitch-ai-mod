import { z } from "zod";

import type { AiDecisionInput, AiMode, AiProviderKind, ProposedAction } from "../types.js";

const aiActionPayloadBaseSchema = z
  .object({
    kind: z.enum(["say", "timeout"]),
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
    actions: z.array(aiActionPayloadBaseSchema),
  })
  .strict();

export const aiDecisionPayloadSchema = aiDecisionPayloadBaseSchema.superRefine((payload, context) => {
  if (payload.actions.length > 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "actions may contain at most one item",
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

  if (payload.outcome === "action" && payload.actions.length !== 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "action outcomes must include exactly one action",
      path: ["actions"],
    });
  }

  const firstAction = payload.actions[0];

  if (!firstAction) {
    return;
  }

  if (firstAction.kind === "say" && !firstAction.message) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "say actions must include a message",
      path: ["actions", 0, "message"],
    });
  }
});

export type AiDecisionPayload = z.infer<typeof aiDecisionPayloadSchema>;

function stripSchemaMeta(value: unknown): unknown {
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
}

export const aiDecisionJsonSchema = stripSchemaMeta(
  z.toJSONSchema(aiDecisionPayloadBaseSchema, {
    reused: "inline",
  }),
) as Record<string, unknown>;

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
    actions: [],
    ...(metadata ? { metadata } : {}),
  };
}

export function payloadToAiDecision(
  payload: AiDecisionPayload,
  source: AiProviderKind,
  input: AiDecisionInput,
): {
  source: AiProviderKind;
  outcome: "abstain" | "action";
  reason: string;
  confidence: number;
  mode: AiMode;
  actions: ProposedAction[];
} {
  const actions = payload.actions.map((action) => {
    if (action.kind === "say") {
      return {
        kind: "say" as const,
        reason: action.reason,
        message: action.message!,
        targetUserId: action.targetUserId ?? input.message.chatterId,
        targetUserName: action.targetUserName ?? input.message.chatterLogin,
        replyParentMessageId: action.replyParentMessageId ?? input.message.sourceMessageId,
      };
    }

    return {
      kind: "timeout" as const,
      reason: action.reason,
      targetUserId: action.targetUserId ?? input.message.chatterId,
      targetUserName: action.targetUserName ?? input.message.chatterLogin,
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
