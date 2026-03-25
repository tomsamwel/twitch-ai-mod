import crypto from "node:crypto";

import type { Logger } from "pino";

import { parseControlCommand } from "./command-parser.js";
import type { RuntimeSettingsStore } from "./runtime-settings.js";
import type { BotDatabase } from "../storage/database.js";
import type {
  ControlAuditRecord,
  ControlCommand,
  ControlCommandResult,
  TrustedController,
  WhisperMessage,
} from "../types.js";
import type { TwurpleTwitchGateway } from "../twitch/twitch-gateway.js";

export class WhisperControlPlane {
  private readonly trustedUserIds: Set<string>;

  public constructor(
    private readonly commandPrefix: string,
    trustedControllers: TrustedController[],
    private readonly logger: Logger,
    private readonly runtimeSettings: Pick<
      RuntimeSettingsStore,
      | "getEffectiveSettings"
      | "getOverrides"
      | "setOverride"
      | "reset"
      | "listAvailablePromptPacks"
      | "listAvailableModelPresets"
    >,
    private readonly database: Pick<BotDatabase, "recordControlAudit" | "registerIngestedEvent">,
    private readonly twitchGateway: Pick<TwurpleTwitchGateway, "sendWhisper">,
  ) {
    this.trustedUserIds = new Set(trustedControllers.map((controller) => controller.userId));
  }

  public async processWhisper(message: WhisperMessage): Promise<void> {
    if (!this.database.registerIngestedEvent(`whisper:${message.id}`, message.id)) {
      this.logger.debug({ whisperId: message.id, sender: message.senderUserLogin }, "skipping duplicate whisper command");
      return;
    }

    if (!this.trustedUserIds.has(message.senderUserId)) {
      await this.finalize(message, null, {
        accepted: false,
        success: false,
        commandSummary: "unauthorized",
        replyMessage: "You are not allowed to control this bot.",
        highRisk: false,
        changes: [],
      });
      return;
    }

    let command: ControlCommand | null = null;

    try {
      command = parseControlCommand(message.text, this.commandPrefix);
    } catch (error) {
      await this.finalize(message, null, {
        accepted: true,
        success: false,
        commandSummary: "parse-error",
        replyMessage: error instanceof Error ? error.message : `Invalid command. Try "${this.commandPrefix} help".`,
        highRisk: false,
        changes: [],
      });
      return;
    }

    const result = this.executeCommand(command, message);
    await this.finalize(message, command, result);
  }

  private executeCommand(command: ControlCommand, message: WhisperMessage): ControlCommandResult {
    const actor = {
      userId: message.senderUserId,
      login: message.senderUserLogin,
    };
    const settings = this.runtimeSettings.getEffectiveSettings();

    switch (command.kind) {
      case "help":
        return {
          accepted: true,
          success: true,
          commandSummary: "help",
          replyMessage: [
            `${this.commandPrefix} status`,
            `${this.commandPrefix} ai on|off`,
            `${this.commandPrefix} ai-moderation on|off`,
            `${this.commandPrefix} social on|off`,
            `${this.commandPrefix} dry-run on|off`,
            `${this.commandPrefix} live-moderation on|off`,
            `${this.commandPrefix} pack <pack-name>`,
            `${this.commandPrefix} model <preset-name>`,
            `${this.commandPrefix} reset`,
          ].join(" | "),
          highRisk: false,
          changes: [],
        };
      case "status": {
        const liveModerationEffective = settings.liveModerationEnabled && !settings.dryRun;
        const aiModerationEffective =
          settings.aiEnabled &&
          settings.aiModerationEnabled &&
          settings.liveModerationEnabled &&
          !settings.dryRun;
        const modelLabel = settings.modelPreset ?? `${settings.provider}:${settings.model}`;
        return {
          accepted: true,
          success: true,
          commandSummary: "status",
          replyMessage: [
            `ai=${settings.aiEnabled ? "on" : "off"}`,
            `ai-moderation=${settings.aiModerationEnabled ? "on" : "off"} (effective ${aiModerationEffective ? "on" : "off"})`,
            `social=${settings.socialRepliesEnabled ? "on" : "off"}`,
            `dry-run=${settings.dryRun ? "on" : "off"}`,
            `live-moderation=${settings.liveModerationEnabled ? "on" : "off"} (effective ${liveModerationEffective ? "on" : "off"})`,
            `pack=${settings.promptPack}`,
            `model=${modelLabel}`,
            `last-override=${settings.lastOverrideAt ?? "none"}`,
          ].join(" | "),
          highRisk: false,
          changes: [],
        };
      }
      case "set-ai":
        return this.applyBooleanOverride(
          "aiEnabled",
          command.enabled,
          actor,
          `ai ${command.enabled ? "on" : "off"}`,
        );
      case "set-ai-moderation": {
        const result = this.applyBooleanOverride(
          "aiModerationEnabled",
          command.enabled,
          actor,
          `ai-moderation ${command.enabled ? "on" : "off"}`,
          true,
        );
        this.logger.warn(
          {
            actorLogin: message.senderUserLogin,
            actorUserId: message.senderUserId,
            previousValue: settings.aiModerationEnabled,
            nextValue: command.enabled,
          },
          "AI live moderation runtime setting changed via whisper control",
        );
        return result;
      }
      case "set-social":
        return this.applyBooleanOverride(
          "socialRepliesEnabled",
          command.enabled,
          actor,
          `social ${command.enabled ? "on" : "off"}`,
        );
      case "set-dry-run":
        return this.applyBooleanOverride(
          "dryRun",
          command.enabled,
          actor,
          `dry-run ${command.enabled ? "on" : "off"}`,
        );
      case "set-live-moderation": {
        const result = this.applyBooleanOverride(
          "liveModerationEnabled",
          command.enabled,
          actor,
          `live-moderation ${command.enabled ? "on" : "off"}`,
          true,
        );
        this.logger.warn(
          {
            actorLogin: message.senderUserLogin,
            actorUserId: message.senderUserId,
            previousValue: settings.liveModerationEnabled,
            nextValue: command.enabled,
          },
          "live moderation runtime setting changed via whisper control",
        );
        return result;
      }
      case "set-pack": {
        if (!this.runtimeSettings.listAvailablePromptPacks().includes(command.packName)) {
          return {
            accepted: true,
            success: false,
            commandSummary: "set-pack",
            replyMessage: `Unknown pack "${command.packName}". Allowed: ${this.runtimeSettings.listAvailablePromptPacks().join(", ")}`,
            highRisk: false,
            changes: [],
          };
        }

        return this.applyOverride("promptPack", command.packName, actor, `pack ${command.packName}`);
      }
      case "set-model": {
        if (!this.runtimeSettings.listAvailableModelPresets().includes(command.presetName)) {
          return {
            accepted: true,
            success: false,
            commandSummary: "set-model",
            replyMessage: `Unknown model preset "${command.presetName}". Allowed: ${this.runtimeSettings.listAvailableModelPresets().join(", ")}`,
            highRisk: false,
            changes: [],
          };
        }

        return this.applyOverride("modelPreset", command.presetName, actor, `model ${command.presetName}`);
      }
      case "reset": {
        const previous = this.runtimeSettings.getOverrides();
        this.runtimeSettings.reset(actor);
        return {
          accepted: true,
          success: true,
          commandSummary: "reset",
          replyMessage: "Runtime overrides cleared. Defaults are active again.",
          highRisk: false,
          changes: Object.entries(previous)
            .filter(([key, value]) => !["updatedAt", "updatedByUserId", "updatedByLogin"].includes(key) && value !== undefined)
            .map(([key, value]) => ({
              key: this.toOverrideKey(key),
              previousValue: value,
              nextValue: null,
            })),
        };
      }
    }
  }

  private applyBooleanOverride(
    key:
      | "aiEnabled"
      | "aiModerationEnabled"
      | "socialRepliesEnabled"
      | "dryRun"
      | "liveModerationEnabled",
    value: boolean,
    actor: { userId: string; login: string },
    commandSummary: string,
    highRisk = false,
  ): ControlCommandResult {
    return this.applyOverride(key, value, actor, commandSummary, highRisk);
  }

  private applyOverride(
    key:
      | "aiEnabled"
      | "aiModerationEnabled"
      | "socialRepliesEnabled"
      | "dryRun"
      | "liveModerationEnabled"
      | "promptPack"
      | "modelPreset",
    value: boolean | string,
    actor: { userId: string; login: string },
    commandSummary: string,
    highRisk = false,
  ): ControlCommandResult {
    const previousValue = this.runtimeSettings.getOverrides()[key] ?? this.runtimeSettings.getEffectiveSettings()[this.mapKeyToSetting(key)];
    this.runtimeSettings.setOverride(key, value, actor);

    return {
      accepted: true,
      success: true,
      commandSummary,
      replyMessage: `${commandSummary} applied.`,
      highRisk,
      changes: [
        {
          key,
          previousValue,
          nextValue: value,
        },
      ],
    };
  }

  private async finalize(
    message: WhisperMessage,
    parsedCommand: ControlCommand | null,
    result: ControlCommandResult,
  ): Promise<void> {
    try {
      await this.twitchGateway.sendWhisper(message.senderUserId, result.replyMessage);
    } catch (error) {
      this.logger.error({ err: error, sender: message.senderUserLogin }, "failed to send whisper control reply");
    }

    const auditEntry: ControlAuditRecord = {
      id: crypto.randomUUID(),
      actorUserId: message.senderUserId,
      actorLogin: message.senderUserLogin,
      actorDisplayName: message.senderUserDisplayName,
      rawCommandText: message.text,
      parsedCommandJson: parsedCommand ? JSON.stringify(parsedCommand) : null,
      accepted: result.accepted,
      success: result.success,
      commandSummary: result.commandSummary,
      highRisk: result.highRisk,
      replyMessage: result.replyMessage,
      changesJson: JSON.stringify(result.changes),
      createdAt: new Date().toISOString(),
    };

    this.database.recordControlAudit(auditEntry);
    this.logger.info(
      {
        actorLogin: message.senderUserLogin,
        commandSummary: result.commandSummary,
        accepted: result.accepted,
        success: result.success,
        highRisk: result.highRisk,
      },
      "processed whisper control command",
    );
  }

  private mapKeyToSetting(
    key:
      | "aiEnabled"
      | "aiModerationEnabled"
      | "socialRepliesEnabled"
      | "dryRun"
      | "liveModerationEnabled"
      | "promptPack"
      | "modelPreset",
  ):
    | "aiEnabled"
    | "aiModerationEnabled"
    | "socialRepliesEnabled"
    | "dryRun"
    | "liveModerationEnabled"
    | "promptPack"
    | "modelPreset" {
    return key;
  }

  private toOverrideKey(
    key: string,
  ):
    | "aiEnabled"
    | "aiModerationEnabled"
    | "socialRepliesEnabled"
    | "dryRun"
    | "liveModerationEnabled"
    | "promptPack"
    | "modelPreset" {
    switch (key) {
      case "aiEnabled":
      case "aiModerationEnabled":
      case "socialRepliesEnabled":
      case "dryRun":
      case "liveModerationEnabled":
      case "promptPack":
      case "modelPreset":
        return key;
      default:
        throw new Error(`Unsupported runtime override key: ${key}`);
    }
  }
}
