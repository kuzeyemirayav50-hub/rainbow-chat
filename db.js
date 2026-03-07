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
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ;
    `).catch(() => {});

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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS groups (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        username TEXT NOT NULL,
        joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (group_id, username)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        conv_type TEXT NOT NULL,
        conv_id TEXT NOT NULL,
        from_username TEXT NOT NULL,
        message TEXT NOT NULL,
        reply_to JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        edited_at TIMESTAMPTZ,
        deleted BOOLEAN NOT NULL DEFAULT FALSE,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        reactions JSONB NOT NULL DEFAULT '{}'
      );
    `);
  }

  async function createSession(token, username) {
    await pool.query(
      "INSERT INTO sessions (token, username) VALUES ($1, $2) ON CONFLICT (token) DO UPDATE SET username = $2, created_at = NOW()",
      [token, username]
    );
  }

  async function getSessionByToken(token) {
    const { rows } = await pool.query("SELECT username FROM sessions WHERE token = $1", [token]);
    return rows[0]?.username || null;
  }

  async function deleteSession(token) {
    await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
  }

  async function updateLastSeen(username) {
    try {
      await pool.query("UPDATE users SET last_seen = NOW() WHERE username = $1", [username]);
    } catch {}
  }

  async function getLastSeen(username) {
    try {
      const { rows } = await pool.query("SELECT last_seen FROM users WHERE username = $1", [username]);
      return rows[0]?.last_seen;
    } catch {
      return null;
    }
  }

  async function insertMessage({ convType, convId, fromUsername, message, replyTo }) {
    const { rows } = await pool.query(
      `INSERT INTO messages (conv_type, conv_id, from_username, message, reply_to)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [convType, convId, fromUsername, message, replyTo ? JSON.stringify(replyTo) : null]
    );
    return rows[0];
  }

  async function getMessages(convType, convId, limit = 100) {
    const { rows } = await pool.query(
      `SELECT id, from_username, message, reply_to, created_at, edited_at, deleted, pinned, reactions
       FROM messages
       WHERE conv_type = $1 AND conv_id = $2 AND deleted = FALSE
       ORDER BY created_at DESC LIMIT $3`,
      [convType, convId, limit]
    );
    return rows.reverse();
  }

  async function editMessage(id, fromUsername, newMessage) {
    const { rowCount } = await pool.query(
      `UPDATE messages SET message = $2, edited_at = NOW() WHERE id = $1::uuid AND from_username = $3 AND deleted = FALSE`,
      [id, newMessage, fromUsername]
    );
    return rowCount > 0;
  }

  async function deleteMessage(id, fromUsername) {
    const { rowCount } = await pool.query(
      `UPDATE messages SET deleted = TRUE WHERE id = $1::uuid AND from_username = $2`,
      [id, fromUsername]
    );
    return rowCount > 0;
  }

  async function setMessagePinned(id, pinned, username) {
    const msg = await pool.query("SELECT from_username FROM messages WHERE id = $1::uuid AND deleted = FALSE", [id]);
    if (!msg.rows.length) return false;
    const { rowCount } = await pool.query(
      `UPDATE messages SET pinned = $2 WHERE id = $1::uuid AND deleted = FALSE`,
      [id, !!pinned]
    );
    return rowCount > 0;
  }

  async function toggleReaction(id, username, emoji) {
    const { rows } = await pool.query("SELECT reactions FROM messages WHERE id = $1::uuid AND deleted = FALSE", [id]);
    if (!rows.length) return null;
    let reactions = rows[0].reactions || {};
    if (typeof reactions === "string") reactions = JSON.parse(reactions);
    const list = reactions[emoji] || [];
    const idx = list.indexOf(username);
    if (idx >= 0) list.splice(idx, 1);
    else list.push(username);
    if (list.length) reactions[emoji] = list;
    else delete reactions[emoji];
    await pool.query("UPDATE messages SET reactions = $2::jsonb WHERE id = $1::uuid", [id, JSON.stringify(reactions)]);
    return reactions;
  }

  async function getMessage(id) {
    const { rows } = await pool.query("SELECT * FROM messages WHERE id = $1::uuid", [id]);
    return rows[0] || null;
  }

  async function userExists(username) {
    const { rows } = await pool.query(
      "SELECT 1 FROM users WHERE username = $1 LIMIT 1",
      [username]
    );
    return rows.length > 0;
  }

  async function searchUsers(query, excludeUsername) {
    const q = String(query || "").trim();
    if (q.length < 2) return [];
    const pattern = "%" + q + "%";
    const { rows } = await pool.query(
      `SELECT username FROM users WHERE username ILIKE $1 AND username != $2 ORDER BY username LIMIT 20`,
      [pattern, excludeUsername || ""]
    );
    return rows.map((r) => r.username);
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

  async function createGroup({ name, createdBy, memberUsernames }) {
    const { rows: insertRows } = await pool.query(
      "INSERT INTO groups (name, created_by) VALUES ($1, $2) RETURNING id",
      [name, createdBy]
    );
    const groupId = insertRows[0].id;
    const allMembers = [createdBy, ...(memberUsernames || []).filter((u) => u && u !== createdBy)];
    for (const username of allMembers) {
      await pool.query(
        "INSERT INTO group_members (group_id, username) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [groupId, username]
      );
    }
    return groupId;
  }

  async function getGroupsForUser(username) {
    const { rows } = await pool.query(
      `
      SELECT g.id, g.name, g.created_by, g.created_at
      FROM groups g
      INNER JOIN group_members gm ON gm.group_id = g.id
      WHERE gm.username = $1
      ORDER BY g.created_at DESC
      `,
      [username]
    );
    const withMembers = await Promise.all(
      rows.map(async (r) => {
        const { rows: memberRows } = await pool.query(
          "SELECT username FROM group_members WHERE group_id = $1",
          [r.id]
        );
        return { ...r, members: memberRows.map((m) => m.username) };
      })
    );
    return withMembers;
  }

  async function getGroup(groupId) {
    const { rows } = await pool.query("SELECT id, name, created_by, created_at FROM groups WHERE id = $1", [
      groupId,
    ]);
    if (!rows.length) return null;
    const { rows: memberRows } = await pool.query(
      "SELECT username FROM group_members WHERE group_id = $1",
      [groupId]
    );
    return { ...rows[0], members: memberRows.map((m) => m.username) };
  }

  async function isGroupMember(groupId, username) {
    const { rows } = await pool.query(
      "SELECT 1 FROM group_members WHERE group_id = $1 AND username = $2 LIMIT 1",
      [groupId, username]
    );
    return rows.length > 0;
  }

  async function leaveGroup(groupId, username) {
    await pool.query("DELETE FROM group_members WHERE group_id = $1 AND username = $2", [
      groupId,
      username,
    ]);
  }

  return {
    init,
    pool,
    createSession,
    getSessionByToken,
    deleteSession,
    updateLastSeen,
    getLastSeen,
    insertMessage,
    getMessages,
    getMessage,
    editMessage,
    deleteMessage,
    setMessagePinned,
    toggleReaction,
    userExists,
    searchUsers,
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
    createGroup,
    getGroupsForUser,
    getGroup,
    isGroupMember,
    leaveGroup,
  };
}

module.exports = { createDb };

