const bcrypt = require("bcryptjs");

function createDb({ databaseUrl }) {
  if (!databaseUrl) return null;
  // Lazy require so local dev doesn't break if pg missing
  // (but we do include it in package.json for Render)
  // eslint-disable-next-line global-require
  const { Pool } = require("pg");

  const ssl =
    String(process.env.DB_SSL || "").toLowerCase() === "true" ||
    String(process.env.NODE_ENV || "").toLowerCase() === "production";

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS friends (
        user_a TEXT NOT NULL,
        user_b TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_a, user_b)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS blocks (
        blocker TEXT NOT NULL,
        blocked TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (blocker, blocked)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        from_user TEXT NOT NULL,
        to_user TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (from_user, to_user)
      );
    `);
  }

  async function userExists(username) {
    const { rows } = await pool.query(
      "SELECT 1 FROM users WHERE username = $1 LIMIT 1",
      [username]
    );
    return rows.length > 0;
  }

  async function createUser({ username, password }) {
    const passwordHash = await bcrypt.hash(String(password), 10);
    await pool.query(
      "INSERT INTO users (username, password_hash) VALUES ($1, $2)",
      [username, passwordHash]
    );
  }

  async function verifyUser({ username, password }) {
    const { rows } = await pool.query(
      "SELECT password_hash FROM users WHERE username = $1 LIMIT 1",
      [username]
    );
    if (!rows.length) return { ok: false, reason: "not_found" };
    const isMatch = await bcrypt.compare(String(password), rows[0].password_hash);
    return { ok: isMatch, reason: isMatch ? "ok" : "bad_password" };
  }

  async function getRelationships(username) {
    const [friendsRows, blocksRows, incomingRows, outgoingRows] = await Promise.all([
      pool.query("SELECT user_b FROM friends WHERE user_a = $1", [username]),
      pool.query("SELECT blocked FROM blocks WHERE blocker = $1", [username]),
      pool.query("SELECT from_user FROM friend_requests WHERE to_user = $1", [username]),
      pool.query("SELECT to_user FROM friend_requests WHERE from_user = $1", [username]),
    ]);

    return {
      friends: friendsRows.rows.map((r) => r.user_b),
      blocked: blocksRows.rows.map((r) => r.blocked),
      incomingRequests: incomingRows.rows.map((r) => r.from_user),
      outgoingRequests: outgoingRows.rows.map((r) => r.to_user),
    };
  }

  async function isBlocked(a, b) {
    const { rows } = await pool.query(
      `
      SELECT 1
      FROM blocks
      WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)
      LIMIT 1
    `,
      [a, b]
    );
    return rows.length > 0;
  }

  async function areFriends(a, b) {
    const { rows } = await pool.query(
      "SELECT 1 FROM friends WHERE user_a = $1 AND user_b = $2 LIMIT 1",
      [a, b]
    );
    return rows.length > 0;
  }

  async function sendFriendRequest({ from, to }) {
    await pool.query("INSERT INTO friend_requests (from_user, to_user) VALUES ($1, $2)", [
      from,
      to,
    ]);
  }

  async function deleteFriendRequest({ from, to }) {
    await pool.query("DELETE FROM friend_requests WHERE from_user = $1 AND to_user = $2", [
      from,
      to,
    ]);
  }

  async function addFriendship(a, b) {
    // store both directions for easy reads
    await pool.query(
      `
      INSERT INTO friends (user_a, user_b) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
      [a, b]
    );
    await pool.query(
      `
      INSERT INTO friends (user_a, user_b) VALUES ($1, $2)
      ON CONFLICT DO NOTHING
    `,
      [b, a]
    );
  }

  async function removeFriendship(a, b) {
    await pool.query("DELETE FROM friends WHERE (user_a = $1 AND user_b = $2) OR (user_a = $2 AND user_b = $1)", [
      a,
      b,
    ]);
  }

  async function setBlock({ user, other, block }) {
    if (block) {
      await pool.query(
        `
        INSERT INTO blocks (blocker, blocked) VALUES ($1, $2)
        ON CONFLICT DO NOTHING
      `,
        [user, other]
      );
    } else {
      await pool.query("DELETE FROM blocks WHERE blocker = $1 AND blocked = $2", [
        user,
        other,
      ]);
    }
  }

  async function clearRequestsBetween(a, b) {
    await pool.query(
      `
      DELETE FROM friend_requests
      WHERE (from_user = $1 AND to_user = $2) OR (from_user = $2 AND to_user = $1)
    `,
      [a, b]
    );
  }

  return {
    init,
    pool,
    userExists,
    createUser,
    verifyUser,
    getRelationships,
    isBlocked,
    areFriends,
    sendFriendRequest,
    deleteFriendRequest,
    addFriendship,
    removeFriendship,
    setBlock,
    clearRequestsBetween,
  };
}

module.exports = { createDb };

