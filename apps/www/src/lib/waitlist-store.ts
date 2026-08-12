import { randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Waitlist storage: a `waitlist` table in the Railway Postgres the control
 * plane already uses. The marketing site runs on Vercel, whose filesystem is
 * ephemeral and read-only outside /tmp — a local SQLite file was silently
 * unwritable there, so every signup 500'd. Postgres is the only store here
 * that outlives a deployment.
 *
 * Reached over Railway's public TCP proxy (WAITLIST_DATABASE_URL); the
 * control plane keeps using the private `.railway.internal` host.
 *
 * Server-only. Client code may import the types, nothing else.
 */

/** How many places one successful referral moves you up. */
export const REFERRAL_BOOST = 5;

/** Public shape — safe to hand to anyone holding the code. No email, and no
 * invite code: referral codes travel in shared links, and an invite is a
 * credential. The POST response gates the code on knowing the email. */
export type WaitlistStatus = {
  code: string;
  /** 1-based place in line after referral boosts. 0 once invited. */
  position: number;
  /** Everyone still waiting (invited entries have left the line). */
  total: number;
  /** Signups attributed to this entry's referral link. */
  referrals: number;
  /** True once an operator has promoted this entry off the list. */
  invited: boolean;
};

export type JoinResult = {
  status: WaitlistStatus;
  /** True when the email was already in line — we returned their spot. */
  alreadyJoined: boolean;
  /** The Suma invite code, present only once invited (email was proven). */
  inviteCode: string | null;
};

/**
 * Referral codes: 10 chars over an alphabet with 0/1/l/o/i removed, so the
 * code survives being read aloud or retyped from a screenshot.
 */
const CODE_ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const CODE_LENGTH = 10;

const DATABASE_URL =
  process.env.WAITLIST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Survives dev-server module reloads; one pool per process otherwise. */
const globalStore = globalThis as unknown as {
  __sumaWaitlistSql?: postgres.Sql;
  __sumaWaitlistReady?: Promise<void>;
};

function client(): postgres.Sql {
  if (globalStore.__sumaWaitlistSql) return globalStore.__sumaWaitlistSql;
  if (!DATABASE_URL) {
    throw new Error(
      "WAITLIST_DATABASE_URL (or DATABASE_URL) is required for the waitlist",
    );
  }
  // One connection per serverless instance: many short-lived instances against
  // a single Postgres exhausts max_connections far faster than they'd ever be
  // used in parallel. prepare:false keeps this working if the connection ever
  // moves behind a transaction pooler.
  const sql = postgres(DATABASE_URL, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    // This crosses the public internet (Vercel → Railway's TCP proxy), so TLS
    // is not optional. Railway terminates with its own CA, hence no chain
    // verification — this stops passive interception, not an active MITM that
    // already controls DNS or BGP.
    ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
  });
  globalStore.__sumaWaitlistSql = sql;
  return sql;
}

/** Idempotent bootstrap, once per process. Mirrors the control plane's
 * additive CREATE TABLE IF NOT EXISTS approach in the same database. */
function ready(): Promise<void> {
  if (globalStore.__sumaWaitlistReady) return globalStore.__sumaWaitlistReady;
  const sql = client();
  const pending = (async () => {
    await sql`
      CREATE TABLE IF NOT EXISTS waitlist (
        id bigserial PRIMARY KEY,
        email text NOT NULL UNIQUE,
        code text NOT NULL UNIQUE,
        referred_by bigint REFERENCES waitlist(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        invited_at timestamptz,
        invite_code text
      )
    `;
    await sql`
      CREATE INDEX IF NOT EXISTS waitlist_referred_by ON waitlist(referred_by)
    `;
  })().catch((error: unknown) => {
    // A failed bootstrap must not poison every later request in this process.
    globalStore.__sumaWaitlistReady = undefined;
    throw error;
  });
  globalStore.__sumaWaitlistReady = pending;
  return pending;
}

async function sql(): Promise<postgres.Sql> {
  await ready();
  return client();
}

type Row = {
  id: string;
  email: string;
  code: string;
  invited_at: Date | null;
  invite_code: string | null;
};

async function statusForRow(row: Row): Promise<WaitlistStatus> {
  const db = client();
  const invited = row.invited_at !== null;

  /**
   * Rank = signup order minus REFERRAL_BOOST places per referral. Later
   * signups can therefore pass earlier ones, but two entries with the same
   * score keep their signup order — nobody is overtaken by a tie.
   */
  const position = invited
    ? 0
    : Number(
        (
          await db<{ position: string }[]>`
            WITH scored AS (
              SELECT
                w.id AS id,
                w.id - ${REFERRAL_BOOST} * (
                  SELECT COUNT(*) FROM waitlist r WHERE r.referred_by = w.id
                ) AS score
              FROM waitlist w
              WHERE w.invited_at IS NULL
            )
            SELECT (
              SELECT COUNT(*) FROM scored s
              WHERE s.score < me.score OR (s.score = me.score AND s.id < me.id)
            ) + 1 AS position
            FROM scored me
            WHERE me.id = ${row.id}
          `
        )[0]?.position ?? 1,
      );

  const [totals] = await db<{ total: string }[]>`
    SELECT COUNT(*) AS total FROM waitlist WHERE invited_at IS NULL
  `;
  const [referred] = await db<{ referrals: string }[]>`
    SELECT COUNT(*) AS referrals FROM waitlist WHERE referred_by = ${row.id}
  `;

  return {
    code: row.code,
    position,
    total: Number(totals?.total ?? 0),
    referrals: Number(referred?.referrals ?? 0),
    invited,
  };
}

function generateCode(): string {
  let code = "";
  for (const byte of randomBytes(CODE_LENGTH)) {
    code += CODE_ALPHABET.charAt(byte % CODE_ALPHABET.length);
  }
  return code;
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Sanity check, not RFC pedantry — the send later is the real validator. */
export function isPlausibleEmail(email: string): boolean {
  return (
    email.length >= 5 &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)
  );
}

const ROW_COLUMNS = "id, email, code, invited_at, invite_code";

/** Postgres unique-violation, however the driver surfaces it. */
function uniqueViolation(error: unknown, constraint: string): boolean {
  const detail = error as { code?: string; constraint_name?: string };
  if (detail?.code !== "23505") return false;
  return (
    detail.constraint_name === constraint ||
    String((error as Error).message ?? "").includes(constraint)
  );
}

/**
 * Adds an email to the line, or returns the existing spot if it is already
 * there — submitting twice is how people check their place, not an error.
 * `refCode` credits the referrer when it resolves to someone else's entry.
 */
export async function joinWaitlist(
  email: string,
  refCode?: string | null,
): Promise<JoinResult> {
  const db = await sql();

  const [existing] = await db<Row[]>`
    SELECT ${db.unsafe(ROW_COLUMNS)} FROM waitlist WHERE email = ${email}
  `;
  if (existing) {
    return {
      status: await statusForRow(existing),
      alreadyJoined: true,
      inviteCode: existing.invite_code,
    };
  }

  let referrerId: string | null = null;
  if (refCode) {
    const [referrer] = await db<{ id: string; email: string }[]>`
      SELECT id, email FROM waitlist WHERE code = ${refCode.trim().toLowerCase()}
    `;
    if (referrer && referrer.email !== email) referrerId = referrer.id;
  }

  // Codes collide with probability ~1/31^10; retry anyway rather than 500.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const code = generateCode();
    try {
      const [row] = await db<Row[]>`
        INSERT INTO waitlist (email, code, referred_by)
        VALUES (${email}, ${code}, ${referrerId})
        RETURNING ${db.unsafe(ROW_COLUMNS)}
      `;
      if (!row) throw new Error("insert returned no row");
      return {
        status: await statusForRow(row),
        alreadyJoined: false,
        inviteCode: null,
      };
    } catch (error) {
      // A concurrent insert of the same email lands here too — return theirs.
      if (uniqueViolation(error, "waitlist_email_key")) {
        const [row] = await db<Row[]>`
          SELECT ${db.unsafe(ROW_COLUMNS)} FROM waitlist WHERE email = ${email}
        `;
        if (row) {
          return {
            status: await statusForRow(row),
            alreadyJoined: true,
            inviteCode: row.invite_code,
          };
        }
      }
      if (!uniqueViolation(error, "waitlist_code_key")) throw error;
    }
  }
  throw new Error("could not allocate a unique referral code");
}

/** Looks up a spot by referral code. Returns null when the code is unknown. */
export async function getStatus(code: string): Promise<WaitlistStatus | null> {
  const db = await sql();
  const [row] = await db<Row[]>`
    SELECT ${db.unsafe(ROW_COLUMNS)} FROM waitlist
    WHERE code = ${code.trim().toLowerCase()}
  `;
  return row ? statusForRow(row) : null;
}

/* ------------------------- promotion (operator) -------------------------- */

export type PromotionCandidate = {
  email: string;
  code: string;
  position: number;
  referrals: number;
};

/** The next `limit` people in line, front first — who a promotion would take. */
export async function listNextInLine(
  limit: number,
): Promise<PromotionCandidate[]> {
  const db = await sql();
  const rows = await db<
    { email: string; code: string; referrals: string }[]
  >`
    WITH scored AS (
      SELECT
        w.id AS id,
        w.email AS email,
        w.code AS code,
        (SELECT COUNT(*) FROM waitlist r WHERE r.referred_by = w.id) AS referrals,
        w.id - ${REFERRAL_BOOST} * (
          SELECT COUNT(*) FROM waitlist r WHERE r.referred_by = w.id
        ) AS score
      FROM waitlist w
      WHERE w.invited_at IS NULL
    )
    SELECT email, code, referrals FROM scored
    ORDER BY score ASC, id ASC
    LIMIT ${limit}
  `;
  return rows.map((row, index) => ({
    email: row.email,
    code: row.code,
    referrals: Number(row.referrals),
    position: index + 1,
  }));
}

/** Finds an entry by email (normalized by the caller). */
export async function findByEmail(
  email: string,
): Promise<PromotionCandidate | null> {
  const db = await sql();
  const [row] = await db<Row[]>`
    SELECT ${db.unsafe(ROW_COLUMNS)} FROM waitlist WHERE email = ${email}
  `;
  if (!row || row.invited_at !== null) return null;
  const status = await statusForRow(row);
  return {
    email: row.email,
    code: row.code,
    position: status.position,
    referrals: status.referrals,
  };
}

/** Records a minted invite against an entry, taking it out of the line. */
export async function markInvited(
  email: string,
  inviteCode: string,
): Promise<boolean> {
  const db = await sql();
  const rows = await db`
    UPDATE waitlist
    SET invited_at = now(), invite_code = ${inviteCode}
    WHERE email = ${email} AND invited_at IS NULL
    RETURNING id
  `;
  return rows.length === 1;
}
