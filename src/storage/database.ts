import { mkdirSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import Database from "better-sqlite3";

import type {
  ActionRequest,
  ActionResult,
  AiDecision,
  ControlAuditRecord,
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

  public getRecentDecisionsForAdmin(limit: number): Array<Record<string, unknown>> {
    const rows = this.database
      .prepare(
        `SELECT d.event_id, d.chatter_login, d.outcome, d.reason, d.stage, d.created_at,
                json_extract(d.payload_json, '$.mode') as mode,
                json_extract(d.payload_json, '$.confidence') as confidence,
                json_extract(d.payload_json, '$.moderationCategory') as category,
                m.text_snippet
         FROM decisions d
         LEFT JOIN (
           SELECT event_id, substr(json_extract(message_json, '$.text'), 1, 80) as text_snippet
           FROM message_snapshots
         ) m ON m.event_id = d.event_id
         WHERE d.stage IN ('ai', 'rule')
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
      createdAt: row.created_at,
    }));
  }
}
