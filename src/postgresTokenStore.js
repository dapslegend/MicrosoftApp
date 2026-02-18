 import pg from "pg";

const { Pool } = pg;

export class PostgresTokenStore {
  constructor(databaseUrl) {
    if (!databaseUrl) throw new Error("Missing DATABASE_URL for PostgresTokenStore");
    this.pool = new Pool({ connectionString: databaseUrl, ssl: maybeSsl(databaseUrl) });
  }

  async ensureSchema() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        user_key TEXT PRIMARY KEY,
        "user" JSONB,
        token JSONB NOT NULL,
        scope TEXT,
        expires_at TIMESTAMPTZ,
        saved_at TIMESTAMPTZ NOT NULL
      );
    `);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS oauth_tokens_saved_at_idx ON oauth_tokens (saved_at DESC);`);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS pending_auth (
        state TEXT PRIMARY KEY,
        data JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // cleanup old pending auths (older than 1 hour)
    await this.pool.query(`DELETE FROM pending_auth WHERE created_at < NOW() - INTERVAL '1 hour';`);

    // Create ramp-up tracking table
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS email_ramp_up (
        user_key TEXT PRIMARY KEY,
        ramp_up_start_date DATE NOT NULL DEFAULT CURRENT_DATE,
        ramp_up_days INTEGER NOT NULL DEFAULT 30,
        current_day INTEGER NOT NULL DEFAULT 1,
        emails_sent_today INTEGER NOT NULL DEFAULT 0,
        last_send_date DATE DEFAULT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async savePendingAuth(state, data) {
    await this.pool.query(
      `INSERT INTO pending_auth (state, data) VALUES ($1, $2) ON CONFLICT (state) DO UPDATE SET data = EXCLUDED.data, created_at = NOW()`,
      [state, data],
    );
  }

  async getPendingAuth(state) {
    const { rows } = await this.pool.query(`SELECT data FROM pending_auth WHERE state = $1`, [state]);
    return rows[0]?.data || null;
  }

  async deletePendingAuth(state) {
    await this.pool.query(`DELETE FROM pending_auth WHERE state = $1`, [state]);
  }

  async list() {
    const { rows } = await this.pool.query(
      `SELECT user_key, "user", scope, expires_at, saved_at FROM oauth_tokens ORDER BY saved_at DESC`,
    );
    return rows.map((r) => ({
      user_key: r.user_key,
      user: r.user || null,
      scope: r.scope || null,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
      saved_at: new Date(r.saved_at).toISOString(),
    }));
  }

  async mostRecentUserKey() {
    const { rows } = await this.pool.query(
      `SELECT user_key FROM oauth_tokens ORDER BY saved_at DESC LIMIT 1`,
    );
    return rows[0]?.user_key || null;
  }

  async load(userKey) {
    const { rows } = await this.pool.query(
      `SELECT user_key, "user", token, scope, expires_at, saved_at
       FROM oauth_tokens
       WHERE user_key = $1`,
      [userKey],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      ...(r.token || {}),
      user_key: r.user_key,
      user: r.user || null,
      scope: r.scope || r.token?.scope || null,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : r.token?.expires_at,
      saved_at: new Date(r.saved_at).toISOString(),
    };
  }

  async save(userKey, tokens) {
    const savedAt = new Date();
    const expiresAt = tokens?.expires_at ? new Date(tokens.expires_at) : null;
    const scope = tokens?.scope || null;
    const user = tokens?.user || null;

    const token = { ...tokens };
    // keep table columns as the source of truth
    delete token.user;
    delete token.user_key;
    delete token.saved_at;

    await this.pool.query(
      `INSERT INTO oauth_tokens (user_key, "user", token, scope, expires_at, saved_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_key)
       DO UPDATE SET
         "user" = EXCLUDED."user",
         token = EXCLUDED.token,
         scope = EXCLUDED.scope,
         expires_at = EXCLUDED.expires_at,
         saved_at = EXCLUDED.saved_at`,
      [userKey, user, token, scope, expiresAt, savedAt],
    );

    return await this.load(userKey);
  }

  async clear(userKey) {
    await this.pool.query(`DELETE FROM oauth_tokens WHERE user_key = $1`, [userKey]);
  }

  async clearAll() {
    await this.pool.query(`DELETE FROM oauth_tokens`);
  }

  /**
   * Get ramp-up status for a user
   */
  async getRampUpStatus(userKey) {
    const { rows } = await this.pool.query(
      `SELECT * FROM email_ramp_up WHERE user_key = $1`,
      [userKey]
    );

    if (rows.length === 0) {
      // Initialize ramp-up for new user
      await this.pool.query(
        `INSERT INTO email_ramp_up (user_key) VALUES ($1)`,
        [userKey]
      );
      return await this.getRampUpStatus(userKey);
    }

    const status = rows[0];

    // Check if it's a new day and reset counter if needed
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    const lastSendDate = status.last_send_date
      ? new Date(status.last_send_date).toISOString().split('T')[0]
      : null;
    if (lastSendDate !== today) {
      // Reset daily counter for new day
      await this.pool.query(
        `UPDATE email_ramp_up
         SET emails_sent_today = 0, last_send_date = $2, updated_at = NOW()
         WHERE user_key = $1`,
        [userKey, today]
      );
      status.emails_sent_today = 0;
      status.last_send_date = today;
    }

    return {
      userKey: status.user_key,
      rampUpStartDate: status.ramp_up_start_date,
      rampUpDays: status.ramp_up_days,
      currentDay: status.current_day,
      emailsSentToday: status.emails_sent_today,
      lastSendDate: status.last_send_date
        ? new Date(status.last_send_date).toISOString().split('T')[0]
        : null,
      maxEmailsToday: this.calculateMaxEmailsForDay(status.current_day)
    };
  }

  /**
   * Calculate max emails allowed for a given ramp-up day
   * Day 1: 100 emails, Day 2: 105 emails, Day 3: 110 emails, etc.
   */
  calculateMaxEmailsForDay(day) {
    return 100 + ((day - 1) * 5);
  }

  /**
   * Check if user can send more emails today based on ramp-up
   */
  async canSendEmail(userKey) {
    const status = await this.getRampUpStatus(userKey);
    return status.emailsSentToday < status.maxEmailsToday;
  }

  /**
   * Increment email count for today and advance ramp-up if needed
   */
  async recordEmailSent(userKey) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Get current status
      const status = await this.getRampUpStatus(userKey);
      const newCount = status.emailsSentToday + 1;
      const today = new Date().toISOString().split('T')[0];

      // Check if we've reached the max for current day and need to advance
      let newDay = status.currentDay;
      if (newCount >= status.maxEmailsToday) {
        newDay = Math.min(status.currentDay + 1, status.rampUpDays);
      }

      // Update the record
      await client.query(
        `UPDATE email_ramp_up
         SET emails_sent_today = $2, current_day = $3, updated_at = NOW()
         WHERE user_key = $1`,
        [userKey, newCount, newDay]
      );

      await client.query('COMMIT');

      return {
        ...status,
        emailsSentToday: newCount,
        currentDay: newDay,
        maxEmailsToday: this.calculateMaxEmailsForDay(newDay)
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Reset ramp-up progress (useful for testing or starting over)
   */
  async resetRampUp(userKey, rampUpDays = 30) {
    await this.pool.query(
      `UPDATE email_ramp_up
       SET ramp_up_start_date = CURRENT_DATE,
           ramp_up_days = $2,
           current_day = 1,
           emails_sent_today = 0,
           last_send_date = NULL,
           updated_at = NOW()
       WHERE user_key = $1`,
      [userKey, rampUpDays]
    );
  }

  /**
   * Get time until next batch can be sent (considering ramp-up limits)
   */
  async getTimeUntilNextBatch(userKey) {
    const status = await this.getRampUpStatus(userKey);

    if (status.emailsSentToday < status.maxEmailsToday) {
      // Can still send today
      return 0;
    }

    // Calculate time until next day (midnight)
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(0, 0, 0, 0);

    return tomorrow.getTime() - now.getTime();
  }
}

function maybeSsl(databaseUrl) {
  // Render Postgres requires SSL.
  // Local Postgres often does not. We use a heuristic:
  // - If sslmode=require is present -> enable SSL
  // - If the hostname looks like Render Postgres -> enable SSL
  // - Otherwise leave undefined (pg default)
  try {
    const u = new URL(databaseUrl);
    const host = (u.hostname || "").toLowerCase();
    if (/sslmode=require/i.test(databaseUrl)) return { rejectUnauthorized: false };
    if (host.endsWith(".render.com") || host.includes("render.com")) return { rejectUnauthorized: false };
    if (host.startsWith("dpg-") && host.includes("postgres")) return { rejectUnauthorized: false };
    return undefined;
  } catch {
    // If parsing fails but sslmode=require exists, still enable SSL.
    return /sslmode=require/i.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  }
}


