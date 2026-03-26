import type {
  AiContextSnapshot,
  AiDecisionInput,
  AiMode,
  AiPromptPayload,
  ConfigSnapshot,
  NormalizedChatMessage,
  TwitchIdentity,
} from "../types.js";
import { moderationCategorySchema } from "../types.js";
import { analyzeVisualSpam } from "../moderation/visual-spam.js";

/**
 * Keywords that always require moderation action regardless of context.
 * Referenced in the AI decision contract to override the "abstain by default" posture.
 */
export const HARD_VIOLATION_KEYWORDS = ["kys", "kill yourself", "send nudes", "send pics"] as const;

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

function formatRelativeTime(isoTimestamp: string, nowMs: number): string {
  const deltaMs = nowMs - new Date(isoTimestamp).getTime();
  if (deltaMs < 0) return "now";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `-${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `-${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `-${hours}h${minutes % 60}m`;
}

function formatRoles(roles: string[]): string {
  const nonDefault = roles.filter((r) => r !== "viewer");
  return nonDefault.length > 0 ? ` [${nonDefault.join(",")}]` : "";
}

function formatRecentRoomContext(context: AiContextSnapshot, nowMs: number): string {
  return context.recentRoomMessages
    .map(
      (entry) =>
        `- [${formatRelativeTime(entry.receivedAt, nowMs)}] ${entry.chatterLogin}${entry.isBotMessage ? " (bot)" : ""}${formatRoles(entry.roles)} ${JSON.stringify(entry.text)}`,
    )
    .join("\n");
}

function formatRecentUserContext(context: AiContextSnapshot, nowMs: number): string {
  return context.recentUserMessages
    .map(
      (entry) =>
        `- [${formatRelativeTime(entry.receivedAt, nowMs)}] ${entry.chatterLogin}${formatRoles(entry.roles)} ${JSON.stringify(entry.text)}`,
    )
    .join("\n");
}

function formatRecentBotInteractions(context: AiContextSnapshot, nowMs: number): string {
  return context.recentBotInteractions
    .map((entry) => {
      const payload =
        entry.kind === "say" || entry.kind === "warn"
          ? `msg=${formatQuoted(entry.message)}`
          : `dur=${entry.durationSeconds ?? "default"}`;

      return `- [${formatRelativeTime(entry.createdAt, nowMs)}] ${entry.kind} ${entry.status} ${payload}`;
    })
    .join("\n");
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
    "",
    "False-positive examples (do NOT flag these):",
    'input: "gonna headshot that noob lol" -> abstain (game violence discussion, not real threat)',
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
  nowMs: number = Date.now(),
): AiPromptPayload {
  const modePrompt =
    mode === "social" ? config.prompts.socialPersona.trim() : config.prompts.moderation.trim();
  const system = [
    "<role>",
    config.prompts.system.trim(),
    "</role>",
    "",
    `<mode mode="${mode}">`,
    modePrompt,
    "</mode>",
    "",
    "<style>",
    config.prompts.responseStyle.trim(),
    "</style>",
    "",
    "<safety>",
    config.prompts.safetyRules.trim(),
    "</safety>",
    "",
    "<examples>",
    formatDecisionExamples(mode),
    "</examples>",
    "",
    "<contract>",
    "- Return one JSON object only. No markdown or prose outside it.",
    `- Set mode="${mode}" exactly.`,
    mode === "social"
      ? '- Social: outcome "action" requires exactly one "say" action. moderationCategory must be "none".'
      : '- Moderation: outcome "action" requires either one "warn" or the ordered pair ["timeout", "warn"].',
    '- outcome "abstain" requires actions=[].',
    `- moderationCategory values: ${moderationCategorySchema.options.map((v) => `"${v}"`).join(", ")}.`,
    `- Only propose timeout for: ${config.moderationPolicy.aiPolicy.liveTimeouts.allowedCategories.join(", ")}.`,
    `- Timeouts require confidence >= ${config.moderationPolicy.aiPolicy.liveTimeouts.minimumConfidence.toFixed(2)} to execute. If below that, use warn instead.`,
    "- spam-escalation timeout requires prior evidence (repeated user messages or prior bot correction in history). Without evidence, use warn.",
    "- If unsure, abstain.",
    `- Hard violations that ALWAYS require action: ${HARD_VIOLATION_KEYWORDS.map((k) => `"${k}"`).join(", ")}. These are never borderline — always [timeout, warn] or warn.`,
    "</contract>",
  ].join("\n");

  const user = [
    "<ctx>",
    `<bot>@${botIdentity.login}</bot>`,
    `<channel>@${config.twitch.broadcasterLogin}</channel>`,
    `<current_mode>${mode}</current_mode>`,
    "<message>",
    `chatter_login: @${message.chatterLogin}`,
    `display_name: ${message.chatterDisplayName}`,
    `roles: ${message.roles.join(",")}`,
    `privileged: ${formatYesNo(message.isPrivileged)}`,
    `text: ${JSON.stringify(message.text)}`,
    ...(message.isReply ? [`is_reply: yes`, `reply_parent_user: ${formatQuoted(message.replyParentUserLogin)}`] : []),
    ...(message.isCheer ? [`is_cheer: yes`, `bits: ${message.bits}`] : []),
    ...(message.isRedemption ? [`is_redemption: yes`, `reward_id: ${formatQuoted(message.rewardId)}`] : []),
    "</message>",
    ...(mode === "social"
      ? [
          "<mode_sig>",
          `mentioned_bot: ${formatYesNo(signals.mentionedBot)}`,
          `textual_mention: ${formatYesNo(signals.textualMention)}`,
          `replied_to_bot: ${formatYesNo(signals.repliedToBot)}`,
          `threaded_with_bot: ${formatYesNo(signals.threadedWithBot)}`,
          `reward_triggered: ${formatYesNo(signals.rewardTriggered)}`,
          `broadcaster_addressed: ${formatYesNo(signals.broadcasterAddressed)}`,
          "</mode_sig>",
        ]
      : []),
    ...(context.recentRoomMessages.length > 0
      ? ["<room>", formatRecentRoomContext(context, nowMs), "</room>"]
      : []),
    ...(context.recentUserMessages.length > 0
      ? ["<user_hist>", formatRecentUserContext(context, nowMs), "</user_hist>"]
      : []),
    ...(context.recentBotInteractions.length > 0
      ? ["<bot_hist>", formatRecentBotInteractions(context, nowMs), "</bot_hist>"]
      : []),
    "<signals>",
    formatDerivedSignals(message, context, config),
    "</signals>",
    "</ctx>",
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
