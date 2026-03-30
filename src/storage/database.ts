import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

import type {
  ActionRequest,
  ActionResult,
  AiDecision,
  ControlAuditRecord,
  ModerationCategory,
  NormalizedChatMessage,
  OAuthTokenRecord,
  PersistedActionRecord,
  PersistedDecisionRecord,
  PersistedMessageSnapshot,
  ProcessingMode,
  ReviewDecisionRecord,
  RuntimeOverrideKey,
  RuntimeOverrideRecord,
  RuleDecision,
  TwitchIdentity,
} from "../types.js";

function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export class BotDatabase {
  private readonly database: Database.Database;

  public constructor(sqlitePath: string) {
    mkdirSync(path.dirname(sqlitePath), { recursive: true });
    this.database = new Database(sqlitePath);
    this.database.pragma("journal_mode = WAL");
    this.initialize();
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        provider TEXT NOT NULL,
        user_id TEXT NOT NULL,
        login TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        scopes_json TEXT NOT NULL,
        expires_in INTEGER,
        obtainment_timestamp INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (provider, user_id)
      );

      CREATE TABLE IF NOT EXISTS ingested_events (
        event_id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        stage TEXT NOT NULL,
        event_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        chatter_id TEXT NOT NULL,
        chatter_login TEXT NOT NULL,
        outcome TEXT NOT NULL,
        reason TEXT NOT NULL,
        matched_rule TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        action_kind TEXT NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        source_event_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        target_user_id TEXT,
        target_user_name TEXT,
        reason TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS message_snapshots (
        event_id TEXT PRIMARY KEY,
        source_message_id TEXT NOT NULL,
        chatter_id TEXT NOT NULL,
        chatter_login TEXT NOT NULL,
        received_at TEXT NOT NULL,
        bot_identity_json TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_message_snapshots_received_at
      ON message_snapshots(received_at DESC);

      CREATE INDEX IF NOT EXISTS idx_message_snapshots_chatter_received_at
      ON message_snapshots(chatter_id, received_at DESC);

      CREATE TABLE IF NOT EXISTS runtime_overrides (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by_user_id TEXT,
        updated_by_login TEXT
      );

      CREATE TABLE IF NOT EXISTS control_audit (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT NOT NULL,
        actor_login TEXT NOT NULL,
        actor_display_name TEXT NOT NULL,
        raw_command_text TEXT NOT NULL,
        parsed_command_json TEXT,
        accepted INTEGER NOT NULL,
        success INTEGER NOT NULL,
        command_summary TEXT NOT NULL,
        high_risk INTEGER NOT NULL,
        reply_message TEXT NOT NULL,
        changes_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_control_audit_created_at
      ON control_audit(created_at DESC);

      CREATE TABLE IF NOT EXISTS review_decisions (
        event_id TEXT PRIMARY KEY,
        verdict TEXT NOT NULL,
        notes TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_review_decisions_updated_at
      ON review_decisions(updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_decisions_event_created_at
      ON decisions(event_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_actions_source_event_created_at
      ON actions(source_event_id, created_at ASC);

      CREATE INDEX IF NOT EXISTS idx_actions_target_user_created_at
      ON actions(target_user_id, created_at ASC);

      CREATE TABLE IF NOT EXISTS exempt_users (
        user_login TEXT PRIMARY KEY,
        added_by_login TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_blocked_terms (
        term TEXT PRIMARY KEY,
        added_by_login TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runtime_controllers (
        login TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        added_by_login TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureColumn("decisions", "processing_mode", "TEXT NOT NULL DEFAULT 'live'");
    this.ensureColumn("decisions", "run_id", "TEXT");
    this.ensureColumn("actions", "processing_mode", "TEXT NOT NULL DEFAULT 'live'");
    this.ensureColumn("actions", "run_id", "TEXT");
  }

  // Table/column names are hardcoded constants from initialize() — no injection risk.
  private ensureColumn(tableName: string, columnName: string, definition: string): void {
    const columns = this.database
      .prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;

    if (columns.some((column) => column.name === columnName)) {
      return;
    }

    this.database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  public close(): void {
    this.database.close();
  }

  public upsertTwitchToken(token: OAuthTokenRecord): void {
    const statement = this.database.prepare(`
      INSERT INTO oauth_tokens (
        provider,
        user_id,
        login,
        access_token,
        refresh_token,
        scopes_json,
        expires_in,
        obtainment_timestamp,
        updated_at
      ) VALUES (
        @provider,
        @userId,
        @login,
        @accessToken,
        @refreshToken,
        @scopesJson,
        @expiresIn,
        @obtainmentTimestamp,
        @updatedAt
      )
      ON CONFLICT(provider, user_id) DO UPDATE SET
        login = excluded.login,
        access_token = excluded.access_token,
        refresh_token = excluded.refresh_token,
        scopes_json = excluded.scopes_json,
        expires_in = excluded.expires_in,
        obtainment_timestamp = excluded.obtainment_timestamp,
        updated_at = excluded.updated_at
    `);

    statement.run({
      provider: token.provider,
      userId: token.userId,
      login: token.login,
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      scopesJson: stringifyJson(token.scope),
      expiresIn: token.expiresIn,
      obtainmentTimestamp: token.obtainmentTimestamp,
      updatedAt: new Date().toISOString(),
    });
  }

  public getLatestTwitchToken(): OAuthTokenRecord | null {
    const row = this.database
      .prepare(
        `
          SELECT provider, user_id, login, access_token, refresh_token, scopes_json, expires_in, obtainment_timestamp
          FROM oauth_tokens
          WHERE provider = 'twitch'
          ORDER BY updated_at DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          provider: "twitch";
          user_id: string;
          login: string;
          access_token: string;
          refresh_token: string | null;
          scopes_json: string;
          expires_in: number | null;
          obtainment_timestamp: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      provider: row.provider,
      userId: row.user_id,
      login: row.login,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      scope: JSON.parse(row.scopes_json) as string[],
      expiresIn: row.expires_in,
      obtainmentTimestamp: row.obtainment_timestamp,
    };
  }

  public listRuntimeOverrides(): RuntimeOverrideRecord[] {
    const rows = this.database
      .prepare(
        `
          SELECT key, value_json, updated_at, updated_by_user_id, updated_by_login
          FROM runtime_overrides
          ORDER BY updated_at ASC
        `,
      )
      .all() as Array<{
      key: RuntimeOverrideKey;
      value_json: string;
      updated_at: string;
      updated_by_user_id: string | null;
      updated_by_login: string | null;
    }>;

    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value_json) as unknown,
      updatedAt: row.updated_at,
      updatedByUserId: row.updated_by_user_id,
      updatedByLogin: row.updated_by_login,
    }));
  }

  public setRuntimeOverride(
    key: RuntimeOverrideKey,
    value: unknown,
    actor: { userId: string | null; login: string | null },
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO runtime_overrides (
            key,
            value_json,
            updated_at,
            updated_by_user_id,
            updated_by_login
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            updated_at = excluded.updated_at,
            updated_by_user_id = excluded.updated_by_user_id,
            updated_by_login = excluded.updated_by_login
        `,
      )
      .run(
        key,
        stringifyJson(value),
        new Date().toISOString(),
        actor.userId,
        actor.login,
      );
  }

  public clearRuntimeOverrides(): void {
    this.database.prepare(`DELETE FROM runtime_overrides`).run();
  }

  public recordControlAudit(entry: ControlAuditRecord): void {
    this.database
      .prepare(
        `
          INSERT INTO control_audit (
            id,
            actor_user_id,
            actor_login,
            actor_display_name,
            raw_command_text,
            parsed_command_json,
            accepted,
            success,
            command_summary,
            high_risk,
            reply_message,
            changes_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        entry.id,
        entry.actorUserId,
        entry.actorLogin,
        entry.actorDisplayName,
        entry.rawCommandText,
        entry.parsedCommandJson,
        entry.accepted ? 1 : 0,
        entry.success ? 1 : 0,
        entry.commandSummary,
        entry.highRisk ? 1 : 0,
        entry.replyMessage,
        entry.changesJson,
        entry.createdAt,
      );
  }

  public setReviewDecision(eventId: string, verdict: ReviewDecisionRecord["verdict"], notes?: string | null): void {
    this.database
      .prepare(
        `
          INSERT INTO review_decisions (event_id, verdict, notes, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(event_id) DO UPDATE SET
            verdict = excluded.verdict,
            notes = excluded.notes,
            updated_at = excluded.updated_at
        `,
      )
      .run(eventId, verdict, notes ?? null, new Date().toISOString());
  }

  public listReviewDecisions(eventIds?: string[]): ReviewDecisionRecord[] {
    if (eventIds && eventIds.length === 0) {
      return [];
    }

    const rows = (eventIds
      ? this.database
          .prepare(
            `
              SELECT event_id, verdict, notes, updated_at
              FROM review_decisions
              WHERE event_id IN (${eventIds.map(() => "?").join(", ")})
              ORDER BY updated_at DESC
            `,
          )
          .all(...eventIds)
      : this.database
          .prepare(
            `
              SELECT event_id, verdict, notes, updated_at
              FROM review_decisions
              ORDER BY updated_at DESC
            `,
          )
          .all()) as Array<{
      event_id: string;
      verdict: ReviewDecisionRecord["verdict"];
      notes: string | null;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      verdict: row.verdict,
      notes: row.notes,
      updatedAt: row.updated_at,
    }));
  }

  public registerIngestedEvent(eventId: string, sourceMessageId: string): boolean {
    const result = this.database
      .prepare(
        `
          INSERT OR IGNORE INTO ingested_events (event_id, source_message_id, received_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(eventId, sourceMessageId, new Date().toISOString());

    return result.changes > 0;
  }

  public recordMessageSnapshot(message: NormalizedChatMessage, botIdentity: TwitchIdentity): void {
    this.database
      .prepare(
        `
          INSERT OR IGNORE INTO message_snapshots (
            event_id,
            source_message_id,
            chatter_id,
            chatter_login,
            received_at,
            bot_identity_json,
            message_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        message.eventId,
        message.sourceMessageId,
        message.chatterId,
        message.chatterLogin,
        message.receivedAt,
        stringifyJson(botIdentity),
        stringifyJson(message),
        new Date().toISOString(),
      );
  }

  public listMessageSnapshots(limit?: number): PersistedMessageSnapshot[] {
    const rows = (limit && limit > 0
      ? this.database
          .prepare(
            `
              SELECT *
              FROM (
                SELECT
                  event_id,
                  source_message_id,
                  chatter_id,
                  chatter_login,
                  received_at,
                  bot_identity_json,
                  message_json,
                  created_at
                FROM message_snapshots
                ORDER BY received_at DESC
                LIMIT ?
              )
              ORDER BY received_at ASC
            `,
          )
          .all(limit)
      : this.database
          .prepare(
            `
              SELECT
                event_id,
                source_message_id,
                chatter_id,
                chatter_login,
                received_at,
                bot_identity_json,
                message_json,
                created_at
              FROM message_snapshots
              ORDER BY received_at ASC
            `,
          )
          .all()) as Array<{
      event_id: string;
      source_message_id: string;
      chatter_id: string;
      chatter_login: string;
      received_at: string;
      bot_identity_json: string;
      message_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      sourceMessageId: row.source_message_id,
      chatterId: row.chatter_id,
      chatterLogin: row.chatter_login,
      receivedAt: row.received_at,
      botIdentity: JSON.parse(row.bot_identity_json) as TwitchIdentity,
      message: JSON.parse(row.message_json) as NormalizedChatMessage,
      createdAt: row.created_at,
    }));
  }

  public getMessageSnapshotByEventId(eventId: string): PersistedMessageSnapshot | null {
    const row = this.database
      .prepare(
        `
          SELECT
            event_id,
            source_message_id,
            chatter_id,
            chatter_login,
            received_at,
            bot_identity_json,
            message_json,
            created_at
          FROM message_snapshots
          WHERE event_id = ?
          LIMIT 1
        `,
      )
      .get(eventId) as
      | {
          event_id: string;
          source_message_id: string;
          chatter_id: string;
          chatter_login: string;
          received_at: string;
          bot_identity_json: string;
          message_json: string;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      eventId: row.event_id,
      sourceMessageId: row.source_message_id,
      chatterId: row.chatter_id,
      chatterLogin: row.chatter_login,
      receivedAt: row.received_at,
      botIdentity: JSON.parse(row.bot_identity_json) as TwitchIdentity,
      message: JSON.parse(row.message_json) as NormalizedChatMessage,
      createdAt: row.created_at,
    };
  }

  public listRecentRoomMessageSnapshots(
    beforeReceivedAt: string,
    excludeEventId: string,
    limit: number,
  ): PersistedMessageSnapshot[] {
    if (limit <= 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM (
            SELECT
              event_id,
              source_message_id,
              chatter_id,
              chatter_login,
              received_at,
              bot_identity_json,
              message_json,
              created_at
            FROM message_snapshots
            WHERE received_at <= ?
              AND event_id != ?
            ORDER BY received_at DESC
            LIMIT ?
          )
          ORDER BY received_at ASC
        `,
      )
      .all(beforeReceivedAt, excludeEventId, limit) as Array<{
      event_id: string;
      source_message_id: string;
      chatter_id: string;
      chatter_login: string;
      received_at: string;
      bot_identity_json: string;
      message_json: string;
      created_at: string;
    }>;

    return this.mapSnapshotRows(rows);
  }

  public listRecentUserMessageSnapshots(
    chatterId: string,
    beforeReceivedAt: string,
    excludeEventId: string,
    limit: number,
  ): PersistedMessageSnapshot[] {
    if (limit <= 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `
          SELECT *
          FROM (
            SELECT
              event_id,
              source_message_id,
              chatter_id,
              chatter_login,
              received_at,
              bot_identity_json,
              message_json,
              created_at
            FROM message_snapshots
            WHERE chatter_id = ?
              AND received_at <= ?
              AND event_id != ?
            ORDER BY received_at DESC
            LIMIT ?
          )
          ORDER BY received_at ASC
        `,
      )
      .all(chatterId, beforeReceivedAt, excludeEventId, limit) as Array<{
      event_id: string;
      source_message_id: string;
      chatter_id: string;
      chatter_login: string;
      received_at: string;
      bot_identity_json: string;
      message_json: string;
      created_at: string;
    }>;

    return this.mapSnapshotRows(rows);
  }

  public listRecentBotInteractions(
    targetUserId: string,
    beforeCreatedAt: string,
    limit: number,
  ): PersistedActionRecord[] {
    if (limit <= 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            action_kind,
            status,
            source,
            target_user_id,
            target_user_name,
            reason,
            dry_run,
            processing_mode,
            payload_json,
            result_json,
            created_at
          FROM (
            SELECT
              id,
              action_kind,
              status,
              source,
              target_user_id,
              target_user_name,
              reason,
              dry_run,
              processing_mode,
              payload_json,
              result_json,
              created_at
            FROM actions
            WHERE target_user_id = ?
              AND created_at <= ?
              AND action_kind IN ('say', 'warn', 'timeout')
            ORDER BY created_at DESC
            LIMIT ?
          )
          ORDER BY created_at ASC
        `,
      )
      .all(targetUserId, beforeCreatedAt, limit) as Array<{
      id: string;
      action_kind: "say" | "warn" | "timeout";
      status: ActionResult["status"];
      source: "rules" | "ai";
      target_user_id: string | null;
      target_user_name: string | null;
      reason: string;
      dry_run: 0 | 1;
      processing_mode: ProcessingMode;
      payload_json: string;
      result_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      kind: row.action_kind,
      status: row.status,
      source: row.source,
      targetUserId: row.target_user_id,
      targetUserName: row.target_user_name,
      reason: row.reason,
      dryRun: row.dry_run === 1,
      processingMode: row.processing_mode,
      payload: JSON.parse(row.payload_json) as ActionRequest,
      result: JSON.parse(row.result_json) as ActionResult,
      createdAt: row.created_at,
    }));
  }

  public listDecisionsForEventIds(eventIds: string[]): PersistedDecisionRecord[] {
    if (eventIds.length === 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            stage,
            event_id,
            source_message_id,
            chatter_id,
            chatter_login,
            outcome,
            reason,
            matched_rule,
            processing_mode,
            run_id,
            payload_json,
            created_at
          FROM decisions
          WHERE event_id IN (${eventIds.map(() => "?").join(", ")})
          ORDER BY created_at ASC
        `,
      )
      .all(...eventIds) as Array<{
      id: string;
      stage: "rules" | "ai";
      event_id: string;
      source_message_id: string;
      chatter_id: string;
      chatter_login: string;
      outcome: string;
      reason: string;
      matched_rule: string | null;
      processing_mode: ProcessingMode;
      run_id: string | null;
      payload_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      eventId: row.event_id,
      sourceMessageId: row.source_message_id,
      chatterId: row.chatter_id,
      chatterLogin: row.chatter_login,
      outcome: row.outcome,
      reason: row.reason,
      ...(row.matched_rule ? { matchedRule: row.matched_rule } : {}),
      processingMode: row.processing_mode,
      ...(row.run_id ? { runId: row.run_id } : {}),
      payload: JSON.parse(row.payload_json) as RuleDecision | AiDecision,
      createdAt: row.created_at,
    }));
  }

  public listActionsForEventIds(eventIds: string[]): PersistedActionRecord[] {
    if (eventIds.length === 0) {
      return [];
    }

    const rows = this.database
      .prepare(
        `
          SELECT
            id,
            action_kind,
            status,
            source,
            source_event_id,
            target_user_id,
            target_user_name,
            reason,
            dry_run,
            processing_mode,
            payload_json,
            result_json,
            created_at
          FROM actions
          WHERE source_event_id IN (${eventIds.map(() => "?").join(", ")})
          ORDER BY created_at ASC
        `,
      )
      .all(...eventIds) as Array<{
      id: string;
      action_kind: "say" | "warn" | "timeout";
      status: ActionResult["status"];
      source: "rules" | "ai";
      source_event_id: string;
      target_user_id: string | null;
      target_user_name: string | null;
      reason: string;
      dry_run: 0 | 1;
      processing_mode: ProcessingMode;
      payload_json: string;
      result_json: string;
      created_at: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      kind: row.action_kind,
      status: row.status,
      source: row.source,
      targetUserId: row.target_user_id,
      targetUserName: row.target_user_name,
      reason: row.reason,
      dryRun: row.dry_run === 1,
      processingMode: row.processing_mode,
      payload: JSON.parse(row.payload_json) as ActionRequest,
      result: JSON.parse(row.result_json) as ActionResult,
      createdAt: row.created_at,
    }));
  }

  public recordRuleDecision(
    message: { eventId: string; sourceMessageId: string; chatterId: string; chatterLogin: string },
    decision: RuleDecision,
    context: { processingMode?: ProcessingMode; runId?: string } = {},
  ): void {
    this.recordDecision("rules", message, decision.outcome, decision.reason, decision.matchedRule, decision, context);
  }

  public recordAiDecision(
    message: { eventId: string; sourceMessageId: string; chatterId: string; chatterLogin: string },
    decision: AiDecision,
    context: { processingMode?: ProcessingMode; runId?: string } = {},
  ): void {
    this.recordDecision("ai", message, decision.outcome, decision.reason, undefined, decision, context);
  }

  public countRecentTimeoutsForUser(targetUserId: string, afterTimestamp: string): number {
    const row = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM actions
          WHERE target_user_id = ?
            AND action_kind = 'timeout'
            AND status IN ('executed', 'dry-run')
            AND created_at > ?
        `,
      )
      .get(targetUserId, afterTimestamp) as { count: number };

    return row.count;
  }

  public recordAction(action: ActionRequest, result: ActionResult): void {
    this.database
      .prepare(
        `
          INSERT INTO actions (
            id,
            action_kind,
            status,
            source,
            source_event_id,
            source_message_id,
            target_user_id,
            target_user_name,
            reason,
            dry_run,
            processing_mode,
            run_id,
            payload_json,
            result_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        action.id,
        action.kind,
        result.status,
        action.source,
        action.sourceEventId,
        action.sourceMessageId,
        action.targetUserId ?? null,
        action.targetUserName ?? null,
        action.reason,
        action.dryRun ? 1 : 0,
        action.processingMode,
        action.runId ?? null,
        stringifyJson(action),
        stringifyJson(result),
        action.initiatedAt,
      );
  }

  private recordDecision(
    stage: "rules" | "ai",
    message: { eventId: string; sourceMessageId: string; chatterId: string; chatterLogin: string },
    outcome: string,
    reason: string,
    matchedRule: string | undefined,
    payload: unknown,
    context: { processingMode?: ProcessingMode; runId?: string } = {},
  ): void {
    this.database
      .prepare(
        `
          INSERT INTO decisions (
            id,
            stage,
            event_id,
            source_message_id,
            chatter_id,
            chatter_login,
            outcome,
            reason,
            matched_rule,
            processing_mode,
            run_id,
            payload_json,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        crypto.randomUUID(),
        stage,
        message.eventId,
        message.sourceMessageId,
        message.chatterId,
        message.chatterLogin,
        outcome,
        reason,
        matchedRule ?? null,
        context.processingMode ?? "live",
        context.runId ?? null,
        stringifyJson(payload),
        new Date().toISOString(),
      );
  }

  private mapSnapshotRows(
    rows: Array<{
      event_id: string;
      source_message_id: string;
      chatter_id: string;
      chatter_login: string;
      received_at: string;
      bot_identity_json: string;
      message_json: string;
      created_at: string;
    }>,
  ): PersistedMessageSnapshot[] {
    return rows.map((row) => ({
      eventId: row.event_id,
      sourceMessageId: row.source_message_id,
      chatterId: row.chatter_id,
      chatterLogin: row.chatter_login,
      receivedAt: row.received_at,
      botIdentity: JSON.parse(row.bot_identity_json) as TwitchIdentity,
      message: JSON.parse(row.message_json) as NormalizedChatMessage,
      createdAt: row.created_at,
    }));
  }

  // --- Exempt users ---

  public addExemptUser(login: string, actorLogin: string): boolean {
    const result = this.database
      .prepare(`INSERT OR IGNORE INTO exempt_users (user_login, added_by_login, created_at) VALUES (?, ?, ?)`)
      .run(login.toLowerCase(), actorLogin, new Date().toISOString());
    return result.changes > 0;
  }

  public removeExemptUser(login: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM exempt_users WHERE user_login = ?`)
      .run(login.toLowerCase());
    return result.changes > 0;
  }

  public listExemptUsers(): Array<{ userLogin: string; addedByLogin: string; createdAt: string }> {
    const rows = this.database
      .prepare(`SELECT user_login, added_by_login, created_at FROM exempt_users ORDER BY created_at ASC`)
      .all() as Array<{ user_login: string; added_by_login: string; created_at: string }>;
    return rows.map((row) => ({
      userLogin: row.user_login,
      addedByLogin: row.added_by_login,
      createdAt: row.created_at,
    }));
  }

  public isUserExempt(login: string): boolean {
    const row = this.database
      .prepare(`SELECT 1 FROM exempt_users WHERE user_login = ? LIMIT 1`)
      .get(login.toLowerCase()) as { 1: number } | undefined;
    return row !== undefined;
  }

  // --- Runtime blocked terms ---

  public addRuntimeBlockedTerm(term: string, actorLogin: string): boolean {
    const result = this.database
      .prepare(`INSERT OR IGNORE INTO runtime_blocked_terms (term, added_by_login, created_at) VALUES (?, ?, ?)`)
      .run(term.toLowerCase().trim(), actorLogin, new Date().toISOString());
    return result.changes > 0;
  }

  public removeRuntimeBlockedTerm(term: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM runtime_blocked_terms WHERE term = ?`)
      .run(term.toLowerCase().trim());
    return result.changes > 0;
  }

  public listRuntimeBlockedTerms(): Array<{ term: string; addedByLogin: string; createdAt: string }> {
    const rows = this.database
      .prepare(`SELECT term, added_by_login, created_at FROM runtime_blocked_terms ORDER BY created_at ASC`)
      .all() as Array<{ term: string; added_by_login: string; created_at: string }>;
    return rows.map((row) => ({
      term: row.term,
      addedByLogin: row.added_by_login,
      createdAt: row.created_at,
    }));
  }

  // --- Runtime controllers ---

  public addRuntimeController(login: string, role: "admin" | "mod", actorLogin: string): void {
    this.database
      .prepare(
        `INSERT INTO runtime_controllers (login, role, added_by_login, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(login) DO UPDATE SET role = excluded.role, added_by_login = excluded.added_by_login`,
      )
      .run(login.toLowerCase(), role, actorLogin, new Date().toISOString());
  }

  public removeRuntimeController(login: string): boolean {
    const result = this.database
      .prepare(`DELETE FROM runtime_controllers WHERE login = ?`)
      .run(login.toLowerCase());
    return result.changes > 0;
  }

  public updateRuntimeControllerRole(login: string, role: "admin" | "mod"): boolean {
    const result = this.database
      .prepare(`UPDATE runtime_controllers SET role = ? WHERE login = ?`)
      .run(role, login.toLowerCase());
    return result.changes > 0;
  }

  public listRuntimeControllers(): Array<{ login: string; role: string; addedByLogin: string; createdAt: string }> {
    const rows = this.database
      .prepare(`SELECT login, role, added_by_login, created_at FROM runtime_controllers ORDER BY created_at ASC`)
      .all() as Array<{ login: string; role: string; added_by_login: string; created_at: string }>;
    return rows.map((row) => ({
      login: row.login,
      role: row.role,
      addedByLogin: row.added_by_login,
      createdAt: row.created_at,
    }));
  }

  public getRuntimeController(login: string): { login: string; role: string } | null {
    const row = this.database
      .prepare(`SELECT login, role FROM runtime_controllers WHERE login = ? LIMIT 1`)
      .get(login.toLowerCase()) as { login: string; role: string } | undefined;
    return row ?? null;
  }

  // --- Chatter autocomplete ---

  public getKnownChatterLogins(prefix: string, limit = 20): string[] {
    const escaped = prefix.toLowerCase().replace(/[%_]/g, "\\$&");
    const rows = this.database
      .prepare(
        `SELECT DISTINCT chatter_login FROM message_snapshots
         WHERE chatter_login LIKE ? || '%' ESCAPE '\\'
         ORDER BY chatter_login ASC
         LIMIT ?`,
      )
      .all(escaped, limit) as Array<{ chatter_login: string }>;
    return rows.map((row) => row.chatter_login);
  }

  // --- Admin queries ---

  public getRecentDecisionsPaginated(
    limit: number,
    offset: number,
    filters?: { chatter?: string; outcome?: string; stage?: string; after?: string },
  ): { rows: Array<Record<string, unknown>>; total: number } {
    const conditions: string[] = ["d.stage IN ('ai', 'rules')"];
    const params: unknown[] = [];

    if (filters?.chatter) {
      conditions.push("d.chatter_login = ?");
      params.push(filters.chatter.toLowerCase());
    }
    if (filters?.outcome) {
      conditions.push("d.outcome = ?");
      params.push(filters.outcome);
    }
    if (filters?.stage) {
      conditions.push("d.stage = ?");
      params.push(filters.stage);
    }
    if (filters?.after) {
      conditions.push("d.created_at >= ?");
      params.push(filters.after);
    }

    const where = conditions.join(" AND ");

    const countRow = this.database
      .prepare(`SELECT COUNT(*) as total FROM decisions d WHERE ${where}`)
      .get(...params) as { total: number };

    const rows = this.database
      .prepare(
        `SELECT d.event_id, d.chatter_login, d.outcome, d.reason, d.stage, d.created_at,
                json_extract(d.payload_json, '$.mode') as mode,
                json_extract(d.payload_json, '$.confidence') as confidence,
                json_extract(d.payload_json, '$.moderationCategory') as category,
                substr(json_extract(m.message_json, '$.text'), 1, 80) as text_snippet,
                (SELECT GROUP_CONCAT(action_kind || ':' || status, ', ')
                 FROM actions WHERE source_event_id = d.event_id) as actions_summary
         FROM decisions d
         LEFT JOIN message_snapshots m ON m.event_id = d.event_id
         WHERE ${where}
         ORDER BY d.created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        eventId: row.event_id,
        chatter: row.chatter_login,
        text: row.text_snippet ?? null,
        outcome: row.outcome,
        mode: row.mode ?? null,
        reason: row.reason,
        confidence: row.confidence ?? null,
        category: row.category ?? null,
        stage: row.stage,
        actions: row.actions_summary ?? null,
        createdAt: row.created_at,
      })),
      total: countRow.total,
    };
  }

  public getControlAuditLog(
    limit: number,
    offset: number,
  ): { rows: Array<Record<string, unknown>>; total: number } {
    const countRow = this.database
      .prepare(`SELECT COUNT(*) as total FROM control_audit`)
      .get() as { total: number };

    const rows = this.database
      .prepare(
        `SELECT id, actor_login, command_summary, raw_command_text, accepted, success,
                high_risk, reply_message, changes_json, created_at
         FROM control_audit
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<Record<string, unknown>>;

    return {
      rows: rows.map((row) => ({
        id: row.id,
        actorLogin: row.actor_login,
        command: row.command_summary,
        rawText: row.raw_command_text,
        accepted: row.accepted === 1,
        success: row.success === 1,
        highRisk: row.high_risk === 1,
        reply: row.reply_message,
        changes: JSON.parse(row.changes_json as string) as unknown[],
        createdAt: row.created_at,
      })),
      total: countRow.total,
    };
  }

  public getUserHistory(
    login: string,
    limit = 25,
  ): {
    messages: Array<Record<string, unknown>>;
    decisions: Array<Record<string, unknown>>;
    actions: Array<Record<string, unknown>>;
    isExempt: boolean;
  } {
    const lowerLogin = login.toLowerCase();

    const messages = this.database
      .prepare(
        `SELECT event_id, received_at,
                substr(json_extract(message_json, '$.text'), 1, 120) as text_snippet
         FROM message_snapshots
         WHERE chatter_login = ?
         ORDER BY received_at DESC
         LIMIT ?`,
      )
      .all(lowerLogin, limit) as Array<Record<string, unknown>>;

    const decisions = this.database
      .prepare(
        `SELECT d.id, d.stage, d.outcome, d.reason, d.matched_rule, d.created_at,
                json_extract(d.payload_json, '$.confidence') as confidence,
                json_extract(d.payload_json, '$.moderationCategory') as category
         FROM decisions d
         WHERE d.chatter_login = ?
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(lowerLogin, limit) as Array<Record<string, unknown>>;

    const actions = this.database
      .prepare(
        `SELECT id, action_kind, status, source, reason, dry_run, created_at
         FROM actions
         WHERE target_user_name = ?
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(lowerLogin, limit) as Array<Record<string, unknown>>;

    return {
      messages: messages.map((row) => ({
        eventId: row.event_id,
        receivedAt: row.received_at,
        text: row.text_snippet,
      })),
      decisions: decisions.map((row) => ({
        id: row.id,
        stage: row.stage,
        outcome: row.outcome,
        reason: row.reason,
        matchedRule: row.matched_rule ?? null,
        confidence: row.confidence ?? null,
        category: row.category ?? null,
        createdAt: row.created_at,
      })),
      actions: actions.map((row) => ({
        id: row.id,
        kind: row.action_kind,
        status: row.status,
        source: row.source,
        reason: row.reason,
        dryRun: row.dry_run === 1,
        createdAt: row.created_at,
      })),
      isExempt: this.isUserExempt(lowerLogin),
    };
  }

  public getHourlyStats(sinceIso: string): {
    decisions: { total: number; byOutcome: Record<string, number> };
    actions: { total: number; byKind: Record<string, number>; byStatus: Record<string, number> };
    timeouts: { total: number; bySource: Record<string, number> };
  } {
    const decisionRows = this.database
      .prepare(
        `SELECT outcome, COUNT(*) as cnt
         FROM decisions
         WHERE created_at >= ? AND stage IN ('ai', 'rules')
         GROUP BY outcome`,
      )
      .all(sinceIso) as Array<{ outcome: string; cnt: number }>;

    const byOutcome: Record<string, number> = {};
    let decisionTotal = 0;
    for (const row of decisionRows) {
      byOutcome[row.outcome] = row.cnt;
      decisionTotal += row.cnt;
    }

    const actionRows = this.database
      .prepare(
        `SELECT action_kind, status, COUNT(*) as cnt
         FROM actions
         WHERE created_at >= ?
         GROUP BY action_kind, status`,
      )
      .all(sinceIso) as Array<{ action_kind: string; status: string; cnt: number }>;

    const byKind: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let actionTotal = 0;
    for (const row of actionRows) {
      byKind[row.action_kind] = (byKind[row.action_kind] ?? 0) + row.cnt;
      byStatus[row.status] = (byStatus[row.status] ?? 0) + row.cnt;
      actionTotal += row.cnt;
    }

    const timeoutRows = this.database
      .prepare(
        `SELECT source, COUNT(*) as cnt
         FROM actions
         WHERE created_at >= ? AND action_kind = 'timeout' AND status IN ('executed', 'dry-run')
         GROUP BY source`,
      )
      .all(sinceIso) as Array<{ source: string; cnt: number }>;

    const bySource: Record<string, number> = {};
    let timeoutTotal = 0;
    for (const row of timeoutRows) {
      bySource[row.source] = row.cnt;
      timeoutTotal += row.cnt;
    }

    return {
      decisions: { total: decisionTotal, byOutcome },
      actions: { total: actionTotal, byKind, byStatus },
      timeouts: { total: timeoutTotal, bySource },
    };
  }

  public getRecentDecisionsForAdmin(limit: number): Array<Record<string, unknown>> {
    const rows = this.database
      .prepare(
        `SELECT d.event_id, d.chatter_login, d.outcome, d.reason, d.stage, d.created_at,
                json_extract(d.payload_json, '$.mode') as mode,
                json_extract(d.payload_json, '$.confidence') as confidence,
                json_extract(d.payload_json, '$.moderationCategory') as category,
                substr(json_extract(m.message_json, '$.text'), 1, 80) as text_snippet,
                (SELECT GROUP_CONCAT(action_kind || ':' || status, ', ')
                 FROM actions WHERE source_event_id = d.event_id) as actions_summary
         FROM decisions d
         LEFT JOIN message_snapshots m ON m.event_id = d.event_id
         WHERE d.stage IN ('ai', 'rules')
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      eventId: row.event_id,
      chatter: row.chatter_login,
      text: row.text_snippet ?? null,
      outcome: row.outcome,
      mode: row.mode ?? null,
      reason: row.reason,
      confidence: row.confidence ?? null,
      category: row.category ?? null,
      stage: row.stage,
      actions: row.actions_summary ?? null,
      createdAt: row.created_at,
    }));
  }

  /**
   * Lists AI decisions that are good candidates for promotion to eval scenarios.
   * Interesting = actions taken (timeout/warn), low-confidence decisions, or provider failures.
   * Excludes events already reviewed.
   */
  public listEvalCandidates(limit: number): Array<{
    eventId: string;
    chatterLogin: string;
    text: string | null;
    outcome: string;
    mode: string | null;
    reason: string;
    confidence: number | null;
    category: ModerationCategory | null;
    hasTimeout: boolean;
    hasWarn: boolean;
    createdAt: string;
  }> {
    const rows = this.database
      .prepare(
        `SELECT
           d.event_id,
           d.chatter_login,
           d.outcome,
           d.reason,
           d.created_at,
           json_extract(d.payload_json, '$.mode') as mode,
           json_extract(d.payload_json, '$.confidence') as confidence,
           json_extract(d.payload_json, '$.moderationCategory') as category,
           substr(json_extract(m.message_json, '$.text'), 1, 120) as text_snippet,
           EXISTS(SELECT 1 FROM actions a WHERE a.source_event_id = d.event_id AND a.action_kind = 'timeout' AND a.status IN ('executed', 'dry-run')) as has_timeout,
           EXISTS(SELECT 1 FROM actions a WHERE a.source_event_id = d.event_id AND a.action_kind = 'warn' AND a.status IN ('executed', 'dry-run')) as has_warn
         FROM decisions d
         LEFT JOIN message_snapshots m ON m.event_id = d.event_id
         LEFT JOIN review_decisions r ON r.event_id = d.event_id
         WHERE d.stage = 'ai'
           AND d.processing_mode = 'live'
           AND r.event_id IS NULL
           AND (
             d.outcome = 'action'
             OR (json_extract(d.payload_json, '$.confidence') IS NOT NULL AND json_extract(d.payload_json, '$.confidence') < 0.80)
           )
         ORDER BY d.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      event_id: string;
      chatter_login: string;
      text_snippet: string | null;
      outcome: string;
      mode: string | null;
      reason: string;
      confidence: number | null;
      category: string | null;
      has_timeout: 0 | 1;
      has_warn: 0 | 1;
      created_at: string;
    }>;

    return rows.map((row) => ({
      eventId: row.event_id,
      chatterLogin: row.chatter_login,
      text: row.text_snippet,
      outcome: row.outcome,
      mode: row.mode,
      reason: row.reason,
      confidence: row.confidence,
      category: row.category as ModerationCategory | null,
      hasTimeout: row.has_timeout === 1,
      hasWarn: row.has_warn === 1,
      createdAt: row.created_at,
    }));
  }
}
