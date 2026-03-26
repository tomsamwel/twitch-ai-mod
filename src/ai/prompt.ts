import type {
  AiContextSnapshot,
  AiDecisionInput,
  AiMode,
  AiPromptPayload,
  ConfigSnapshot,
  NormalizedChatMessage,
  TwitchIdentity,
} from "../types.js";
import { analyzeVisualSpam } from "../moderation/visual-spam.js";

interface AiModeSignals {
  mode: AiMode;
  mentionedBot: boolean;
  textualMention: boolean;
  repliedToBot: boolean;
  threadedWithBot: boolean;
  rewardTriggered: boolean;
  broadcasterAddressed: boolean;
}

export interface AiModeSelection {
  mode: AiMode;
  signals: AiModeSignals;
}

function formatYesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function formatQuoted(value: string | null | undefined): string {
  return value ? JSON.stringify(value) : "none";
}

function countMentions(message: NormalizedChatMessage): number {
  return message.parts.filter((part) => part.type === "mention").length;
}

function hasRecentBotCorrectiveInteraction(context: AiContextSnapshot): boolean {
  return context.recentBotInteractions.some(
    (interaction) => (interaction.kind === "say" || interaction.kind === "warn") && interaction.status !== "failed",
  );
}

function formatRecentRoomContext(context: AiContextSnapshot): string {
  if (context.recentRoomMessages.length === 0) {
    return "none";
  }

  return context.recentRoomMessages
    .map(
      (entry) =>
        `- [${entry.receivedAt}] @${entry.chatterLogin}${entry.isBotMessage ? " (bot)" : ""} roles=${entry.roles.join(",")} text=${JSON.stringify(entry.text)}`,
    )
    .join("\n");
}

function formatRecentUserContext(context: AiContextSnapshot): string {
  if (context.recentUserMessages.length === 0) {
    return "none";
  }

  return context.recentUserMessages
    .map(
      (entry) =>
        `- [${entry.receivedAt}] @${entry.chatterLogin} roles=${entry.roles.join(",")} text=${JSON.stringify(entry.text)}`,
    )
    .join("\n");
}

function formatRecentBotInteractions(context: AiContextSnapshot): string {
  if (context.recentBotInteractions.length === 0) {
    return "none";
  }

  return context.recentBotInteractions
    .map((entry) => {
      const payload =
        entry.kind === "say" || entry.kind === "warn"
          ? `message=${formatQuoted(entry.message)}`
          : `durationSeconds=${entry.durationSeconds ?? "default"}`;

      return `- [${entry.createdAt}] ${entry.kind} status=${entry.status} source=${entry.source} ${payload} reason=${JSON.stringify(entry.reason)}`;
    })
    .join("\n");
}

function formatModerationPolicySummary(config: ConfigSnapshot): string {
  const policy = config.moderationPolicy;
  return [
    `- privileged users (broadcaster, moderator, vip, trusted) are never timed out`,
    `- ai posture: abstain by default, timeout only with high confidence`,
    `- live timeout gate: minimumConfidence=${policy.aiPolicy.liveTimeouts.minimumConfidence.toFixed(2)}, categories=${policy.aiPolicy.liveTimeouts.allowedCategories.join(", ")}`,
    `- deterministic rules handle blocked terms and spam automatically`,
  ].join("\n");
}

function formatDerivedSignals(
  message: NormalizedChatMessage,
  context: AiContextSnapshot,
  config: ConfigSnapshot,
): string {
  const visualSpam = analyzeVisualSpam(message.text, config.moderationPolicy.deterministicRules.visualSpam);
  const visualSpamLabel = visualSpam.highConfidence
    ? "detected (high confidence)"
    : visualSpam.borderline
      ? "detected (borderline)"
      : "none";

  return [
    `mention_count: ${countMentions(message)}`,
    `recent_same_user_messages: ${context.recentUserMessages.length}`,
    `recent_bot_correction: ${formatYesNo(hasRecentBotCorrectiveInteraction(context))}`,
    `visual_spam: ${visualSpamLabel}`,
  ].join("\n");
}

function formatDecisionExamples(mode: AiMode): string {
  if (mode === "social") {
    return [
      'input: "@bot what do u even do" -> action, say "I help keep chat friendly.", conf=0.88 (direct question, brief answer)',
      'input: "@bot help pls" -> action, say "I\'m here to keep chat smooth.", conf=0.86 (help request)',
      'input: "nice stream" no direct address -> abstain (not addressing bot, ignore)',
      "",
      'Full output shape: {"outcome":"action","reason":"...","confidence":0.88,"mode":"social","moderationCategory":"none","actions":[{"kind":"say","reason":"...","message":"..."}]}',
    ].join("\n");
  }

  return [
    "Moderation examples:",
    'input: "maybe help people get followers" -> abstain, category=scam, conf=0.69 (ambiguous, could be casual chat)',
    'input: "send pics or ill find u" -> [timeout, warn], category=sexual-harassment, conf=0.99 (coercive sexual threat)',
    'input: roles=vip "follow for follow" -> abstain, category=none, conf=0.95 (privileged user, never timeout)',
    'input: "@bot*5" after prior bot warn -> [timeout, warn], category=spam-escalation, conf=0.95 (repeated after correction)',
    'input: "shut up bot kys" -> [timeout, warn], category=targeted-harassment, conf=0.99 (kys is always a hard violation)',
    'input: visual spam borderline -> warn, category=spam-escalation, conf=0.76 (disruptive but not extreme)',
    'input: copypasta text wall with heavy repetition -> warn, category=spam-escalation, conf=0.82 (disruptive repetitive spam)',
    "",
    "False-positive examples (do NOT flag these):",
    'input: "gonna headshot that noob lol" -> abstain (game violence discussion, not real threat)',
    'input: "this stream is so bad its good lmao" -> abstain (positive sentiment despite negative words)',
    'input: "someone said a slur earlier can mods ban them" -> abstain (reporting a violation, not committing one)',
    "",
    'Full output shape: {"outcome":"action","reason":"...","confidence":0.95,"mode":"moderation","moderationCategory":"spam-escalation","actions":[{"kind":"timeout","reason":"..."},{"kind":"warn","reason":"...","message":"..."}]}',
  ].join("\n");
}

function detectAiModeSignals(
  message: NormalizedChatMessage,
  botIdentity: TwitchIdentity,
  config: ConfigSnapshot,
): AiModeSignals {
  const mentionedBot = message.parts.some((part) => {
    if (part.type !== "mention") {
      return false;
    }

    return (
      part.mentionUserId === botIdentity.id ||
      part.mentionUserLogin?.toLowerCase() === botIdentity.login.toLowerCase()
    );
  });

  const lowerText = message.text.toLowerCase();
  const textualMention = lowerText.includes(`@${botIdentity.login.toLowerCase()}`);
  const repliedToBot = message.replyParentUserId === botIdentity.id;
  const threadedWithBot = message.threadMessageUserId === botIdentity.id;
  const rewardTriggered = message.isRedemption;
  const broadcasterAddressed =
    message.parts.some(
      (part) =>
        part.type === "mention" &&
        part.mentionUserLogin?.toLowerCase() === config.twitch.broadcasterLogin.toLowerCase(),
    ) || lowerText.includes(`@${config.twitch.broadcasterLogin.toLowerCase()}`);

  return {
    mode:
      mentionedBot || textualMention || repliedToBot || threadedWithBot || rewardTriggered || broadcasterAddressed
        ? "social"
        : "moderation",
    mentionedBot,
    textualMention,
    repliedToBot,
    threadedWithBot,
    rewardTriggered,
    broadcasterAddressed,
  };
}

export function selectAiMode(
  message: NormalizedChatMessage,
  botIdentity: TwitchIdentity,
  config: ConfigSnapshot,
): AiModeSelection {
  const signals = detectAiModeSignals(message, botIdentity, config);
  return {
    mode: signals.mode,
    signals,
  };
}

export function composeAiPrompt(
  message: NormalizedChatMessage,
  config: ConfigSnapshot,
  mode: AiMode,
  botIdentity: TwitchIdentity,
  signals: AiModeSignals,
  context: AiContextSnapshot,
): AiPromptPayload {
  const modePrompt =
    mode === "social" ? config.prompts.socialPersona.trim() : config.prompts.moderation.trim();
  const system = [
    "<role>",
    config.prompts.system.trim(),
    "</role>",
    "",
    `<mode_instructions mode="${mode}">`,
    modePrompt,
    "</mode_instructions>",
    "",
    "<style>",
    config.prompts.responseStyle.trim(),
    "</style>",
    "",
    "<safety>",
    config.prompts.safetyRules.trim(),
    "</safety>",
    "",
    "<decision_examples>",
    formatDecisionExamples(mode),
    "</decision_examples>",
    "",
    "<decision_contract>",
    "- Return one JSON object only. No markdown or prose outside it.",
    `- Set mode="${mode}" exactly.`,
    mode === "social"
      ? '- Social: outcome "action" requires exactly one "say" action. moderationCategory must be "none".'
      : '- Moderation: outcome "action" requires either one "warn" or the ordered pair ["timeout", "warn"].',
    '- outcome "abstain" requires actions=[].',
    '- moderationCategory values: "none", "scam", "targeted-harassment", "sexual-harassment", "spam-escalation", "soft-promo", "rude-disruption", "other".',
    `- Only propose timeout for: ${config.moderationPolicy.aiPolicy.liveTimeouts.allowedCategories.join(", ")}.`,
    `- Timeouts require confidence >= ${config.moderationPolicy.aiPolicy.liveTimeouts.minimumConfidence.toFixed(2)} to execute. If below that, use warn instead.`,
    "- spam-escalation timeout requires prior evidence (repeated user messages or prior bot correction in history). Without evidence, use warn.",
    "- If unsure, abstain.",
    '- Hard violations that ALWAYS require action: "kys", "kill yourself", "send nudes", "send pics". These are never borderline — always timeout or warn.',
    "</decision_contract>",
  ].join("\n");

  const user = [
    "<conversation_context>",
    `<bot>@${botIdentity.login}</bot>`,
    `<channel>@${config.twitch.broadcasterLogin}</channel>`,
    `<current_mode>${mode}</current_mode>`,
    "<message>",
    `event_id: ${message.eventId}`,
    `chatter_id: ${message.chatterId}`,
    `chatter_login: @${message.chatterLogin}`,
    `display_name: ${message.chatterDisplayName}`,
    `roles: ${message.roles.join(",")}`,
    `privileged: ${formatYesNo(message.isPrivileged)}`,
    `text: ${JSON.stringify(message.text)}`,
    `message_type: ${message.messageType}`,
    `is_reply: ${formatYesNo(message.isReply)}`,
    `reply_parent_user: ${formatQuoted(message.replyParentUserLogin)}`,
    `is_cheer: ${formatYesNo(message.isCheer)}`,
    `bits: ${message.bits}`,
    `is_redemption: ${formatYesNo(message.isRedemption)}`,
    `reward_id: ${formatQuoted(message.rewardId)}`,
    "</message>",
    "<mode_signals>",
    `mentioned_bot: ${formatYesNo(signals.mentionedBot)}`,
    `textual_mention: ${formatYesNo(signals.textualMention)}`,
    `replied_to_bot: ${formatYesNo(signals.repliedToBot)}`,
    `threaded_with_bot: ${formatYesNo(signals.threadedWithBot)}`,
    `reward_triggered: ${formatYesNo(signals.rewardTriggered)}`,
    `broadcaster_addressed: ${formatYesNo(signals.broadcasterAddressed)}`,
    "</mode_signals>",
    "<recent_room_context>",
    formatRecentRoomContext(context),
    "</recent_room_context>",
    "<recent_same_user_history>",
    formatRecentUserContext(context),
    "</recent_same_user_history>",
    "<recent_bot_interactions>",
    formatRecentBotInteractions(context),
    "</recent_bot_interactions>",
    "<derived_signals>",
    formatDerivedSignals(message, context, config),
    "</derived_signals>",
    "</conversation_context>",
    "",
    "<policy_summary>",
    formatModerationPolicySummary(config),
    "</policy_summary>",
    "",
    "<task>",
    mode === "social"
      ? "Decide whether to abstain or take one social say action for this single message."
      : 'Decide whether to abstain, issue one public warn, or issue the ordered moderation pair ["timeout", "warn"] for this single message.',
    "Return JSON only.",
    "</task>",
  ].join("\n");

  return { system, user };
}

export function buildAiDecisionInput(
  message: NormalizedChatMessage,
  context: AiContextSnapshot,
  config: ConfigSnapshot,
  botIdentity: TwitchIdentity,
  selection = selectAiMode(message, botIdentity, config),
): AiDecisionInput {
  return {
    mode: selection.mode,
    message,
    context,
    config,
    prompt: composeAiPrompt(message, config, selection.mode, botIdentity, selection.signals, context),
  };
}
