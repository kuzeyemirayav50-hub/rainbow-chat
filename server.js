require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");
const { createDb } = require("./db");

const PERSISTENCE_DIR = path.join(__dirname, "data");
const PERSISTENCE_FILE = path.join(PERSISTENCE_DIR, "persistence.json");
let savePersistenceTimer = null;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

function isMaintenanceMode() {
  return String(process.env.MAINTENANCE_MODE || "").toLowerCase() === "true";
}

// Kayıtlı kullanıcılar (kalıcı değil, sunucu yeniden başlarsa sıfırlanır)
// username -> { username, passwordHash }
const registeredUsers = new Map();

// Çevrimiçi kullanıcılar
// socket.id -> username
const sockets = new Map();
// username -> Set<socket.id>
const userSockets = new Map();

// Arkadaşlıklar ve engellemeler
// username -> Set<friendUsername>
const friends = new Map();
// username -> Set<blockedUsername>
const blocks = new Map();
// Arkadaşlık istekleri
// incoming: hedef kullanıcı -> Set(istek gönderen)
const friendRequestsIncoming = new Map();
// outgoing: istek gönderen -> Set(hedef kullanıcı)
const friendRequestsOutgoing = new Map();

// Arama (WebRTC sinyalleşme) - sunucu sadece yönlendirir
// callId -> { callId, fromUsername, toUsername, kind }
const calls = new Map();
// username -> Set<callId>
const callsByUser = new Map();

// Gruplar (DB yoksa in-memory)
// groupId -> { id, name, createdBy, created_at?, members: string[] }
const groups = new Map();
// groupId -> Set<username>
const groupMembers = new Map();
let nextGroupId = 1;

// Oturum token'ları (refresh sonrası girişte kalmak için)
const sessions = new Map(); // token -> username

// Kullanıcı meta verisi: roller, ban, IP geçmişi
// Bu veriler kalıcı değil (veri dosyası veya veritabanı kullanıyorsa kaydedilir)
const userMeta = new Map(); // username -> { role: string, banned: boolean, ips: Set<string> }

const db = createDb({ databaseUrl: process.env.DATABASE_URL });

function ensureUserMeta(username) {
  if (!userMeta.has(username)) {
    userMeta.set(username, { role: "user", banned: false, ips: new Set() });
  }
  return userMeta.get(username);
}

function isAdmin(username) {
  return Boolean(username && ensureUserMeta(username).role === "admin");
}

function isBanned(username) {
  return Boolean(username && ensureUserMeta(username).banned);
}

function setUserRole(username, role) {
  const meta = ensureUserMeta(username);
  meta.role = role || "user";
}

function setUserBanned(username, banned) {
  const meta = ensureUserMeta(username);
  meta.banned = Boolean(banned);
}

function recordUserIp(username, ip) {
  if (!username || !ip) return;
  const meta = ensureUserMeta(username);
  meta.ips.add(ip);
}

function loadPersistence() {
  if (db) return;
  try {
    const raw = fs.readFileSync(PERSISTENCE_FILE, "utf8");
    const data = JSON.parse(raw);
    registeredUsers.clear();
    userMeta.clear();
    (data.users || []).forEach((u) => {
      registeredUsers.set(u.username, { username: u.username, passwordHash: u.passwordHash });
      const meta = ensureUserMeta(u.username);
      if (u.role) meta.role = u.role;
      if (u.banned) meta.banned = true;
      if (Array.isArray(u.ips)) {
        u.ips.forEach((ip) => { if (ip) meta.ips.add(ip); });
      }
    });
    friends.clear();
    (data.friendPairs || []).forEach(([a, b]) => {
      ensureSet(friends, a).add(b);
    });
    blocks.clear();
    (data.blocks || []).forEach(([blocker, blocked]) => {
      ensureSet(blocks, blocker).add(blocked);
    });
    friendRequestsIncoming.clear();
    friendRequestsOutgoing.clear();
    (data.friendRequests || []).forEach(([from, to]) => {
      ensureSet(friendRequestsIncoming, to).add(from);
      ensureSet(friendRequestsOutgoing, from).add(to);
    });
    groups.clear();
    groupMembers.clear();
    (data.groups || []).forEach((g) => {
      groups.set(g.id, { id: g.id, name: g.name, createdBy: g.createdBy, members: g.members || [] });
      groupMembers.set(g.id, new Set(g.members || []));
    });
    nextGroupId = Math.max(1, (data.nextGroupId || 1));
    sessions.clear();
    (data.sessions || []).forEach(({ token, username }) => {
      if (token && username) sessions.set(token, username);
    });
  } catch (err) {
    if (err.code !== "ENOENT") console.error("Persistence load error:", err.message);
  }
}

function savePersistence() {
  if (db) return;
  if (savePersistenceTimer) clearTimeout(savePersistenceTimer);
  savePersistenceTimer = setTimeout(() => {
    savePersistenceTimer = null;
    try {
      if (!fs.existsSync(PERSISTENCE_DIR)) fs.mkdirSync(PERSISTENCE_DIR, { recursive: true });
      const users = Array.from(registeredUsers.values()).map((u) => {
        const meta = userMeta.get(u.username);
        return {
          username: u.username,
          passwordHash: u.passwordHash,
          role: meta?.role,
          banned: meta?.banned,
          ips: meta ? Array.from(meta.ips) : [],
        };
      });
      const friendPairs = [];
      friends.forEach((set, user) => set.forEach((f) => friendPairs.push([user, f])));
      const blocksList = [];
      blocks.forEach((set, blocker) => set.forEach((blocked) => blocksList.push([blocker, blocked])));
      const friendRequests = [];
      friendRequestsOutgoing.forEach((set, from) => set.forEach((to) => friendRequests.push([from, to])));
      const groupsList = Array.from(groups.values());
      const sessionsList = Array.from(sessions.entries()).map(([token, username]) => ({ token, username }));
      const payload = JSON.stringify({
        users,
        friendPairs,
        blocks: blocksList,
        friendRequests,
        groups: groupsList,
        nextGroupId,
        sessions: sessionsList,
      });
      fs.writeFileSync(PERSISTENCE_FILE, payload, "utf8");
    } catch (err) {
      console.error("Persistence save error:", err.message);
    }
  }, 300);
}

function ensureSet(map, key) {
  if (!map.has(key)) {
    map.set(key, new Set());
  }
  return map.get(key);
}

function broadcastUserList() {
  const onlineUsernames = Array.from(userSockets.keys());
  io.emit("userList", onlineUsernames);
}

function disconnectUser(username, reason) {
  const socketsForUser = userSockets.get(username);
  if (!socketsForUser) return;
  for (const id of [...socketsForUser]) {
    const socket = io.sockets.sockets.get(id);
    if (socket) {
      try {
        if (reason) socket.emit("systemMessage", reason);
      } catch {}
      socket.disconnect(true);
    }
    sockets.delete(id);
    socketsForUser.delete(id);
  }
  if (socketsForUser.size === 0) {
    userSockets.delete(username);
  }
  broadcastUserList();
}

function getUsernameFromToken(req) {
  const token = String(req.query.token || req.headers["x-session-token"] || req.headers.authorization || "").trim();
  if (!token) return null;
  return sessions.get(token) || null;
}

function requireAdmin(req, res) {
  const username = getUsernameFromToken(req);
  if (!username || !isAdmin(username)) {
    res.status(403).json({ error: "Bu işlem için yönetici yetkisi gerekli." });
    return null;
  }
  return username;
}

function getRelationships(username) {
  const f = Array.from(friends.get(username) || []);
  const b = Array.from(blocks.get(username) || []);
  const incoming = Array.from(friendRequestsIncoming.get(username) || []);
  const outgoing = Array.from(friendRequestsOutgoing.get(username) || []);
  return {
    friends: f,
    blocked: b,
    incomingRequests: incoming,
    outgoingRequests: outgoing,
  };
}

async function getRelationshipsUnified(username) {
  if (db) {
    return await db.getRelationships(username);
  }
  return getRelationships(username);
}

function emitRelationships(username) {
  const socketsForUser = userSockets.get(username);
  if (!socketsForUser) return;
  void (async () => {
    const payload = await getRelationshipsUnified(username);
    for (const id of socketsForUser) {
      io.to(id).emit("relationships", payload);
    }
  })();
}

function isBlocked(a, b) {
  const setA = blocks.get(a);
  if (setA && setA.has(b)) return true;
  const setB = blocks.get(b);
  if (setB && setB.has(a)) return true;
  return false;
}

function areFriends(a, b) {
  const fa = friends.get(a);
  const fb = friends.get(b);
  return Boolean(fa && fb && fa.has(b) && fb.has(a));
}

function canDirectMessage(a, b) {
  if (!a || !b) return false;
  if (a === b) return false;
  if (isBlocked(a, b)) return false;
  if (!areFriends(a, b)) return false;
  return true;
}

async function isBlockedUnified(a, b) {
  if (db) return await db.isBlocked(a, b);
  return isBlocked(a, b);
}

async function areFriendsUnified(a, b) {
  if (db) return await db.areFriends(a, b);
  return areFriends(a, b);
}

async function canDirectMessageUnified(a, b) {
  if (!a || !b) return false;
  if (a === b) return false;
  if (await isBlockedUnified(a, b)) return false;
  if (!(await areFriendsUnified(a, b))) return false;
  return true;
}

function emitToAllUserSockets(username, event, payload) {
  const set = userSockets.get(username);
  if (!set) return;
  for (const id of set) {
    io.to(id).emit(event, payload);
  }
}

app.use(express.json());

// Bakım modu: siteyi geçici olarak kapat
app.use((req, res, next) => {
  if (!isMaintenanceMode()) return next();

  // Sağlık kontrolü
  if (req.path === "/health") {
    return res.status(200).json({ ok: true, maintenance: true });
  }

  // API istekleri
  if (req.path.startsWith("/api/")) {
    return res.status(503).json({ error: "Bakımdayız. Lütfen daha sonra dene." });
  }

  // HTML sayfası isteyenlere bakım sayfası
  const acceptsHtml = String(req.headers.accept || "").includes("text/html");
  if (req.method === "GET" && acceptsHtml) {
    return res
      .status(503)
      .sendFile(path.join(__dirname, "public", "maintenance.html"));
  }

  return res.status(503).send("Bakımdayız. Lütfen daha sonra dene.");
});

app.use(express.static(path.join(__dirname, "public")));

// Favicon 404 kaldır (tarayıcı otomatik ister)
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/status", async (req, res) => {
  try {
    if (db) {
      await db.pool.query("SELECT 1");
      return res.json({
        storage: "database",
        ok: true,
        message: "Kullanıcılar veritabanında kalıcı (deploy sonrası silinmez)",
      });
    }
    return res.json({
      storage: "file",
      ok: true,
      message: "Kullanıcılar dosyada (Render deploy'da sıfırlanabilir)",
      database_url_defined: !!process.env.DATABASE_URL,
    });
  } catch (err) {
    return res.status(500).json({
      storage: "database",
      ok: false,
      error: "Veritabanı bağlantı hatası - kullanıcılar KAYBEDİLİR",
      detail: err.message,
    });
  }
});

// WebRTC ICE sunucuları (ses/görüntü araması için)
app.get("/api/webrtc-config", (req, res) => {
  const iceServers = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: "stun:stun2.l.google.com:19302" },
    { urls: "stun:stun3.l.google.com:19302" },
    { urls: "stun:stun4.l.google.com:19302" },
    { urls: "stun:stun.stunprotocol.org:3478" },
    { urls: "stun:stun.freeswitch.org" },
  ];
  const turnUrl = process.env.TURN_URL;
  const turnUser = process.env.TURN_USERNAME;
  const turnCred = process.env.TURN_CREDENTIAL;
  if (turnUrl && turnUser && turnCred) {
    iceServers.push({ urls: turnUrl, username: turnUser, credential: turnCred });
  }
  res.json({ iceServers });
});

app.post("/api/register", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Kullanıcı adı ve şifre zorunludur." });
    }

    const trimmedUsername = String(username).trim();
    if (trimmedUsername.length < 3 || trimmedUsername.length > 24) {
      return res
        .status(400)
        .json({ error: "Kullanıcı adı 3-24 karakter arasında olmalıdır." });
    }
    if (isBanned(trimmedUsername)) {
      return res.status(403).json({ error: "Bu kullanıcı adı yasaklı." });
    }

    if (db) {
      if (await db.userExists(trimmedUsername)) {
        return res.status(400).json({ error: "Bu kullanıcı adı zaten alınmış." });
      }
    } else if (registeredUsers.has(trimmedUsername)) {
      return res.status(400).json({ error: "Bu kullanıcı adı zaten alınmış." });
    }
    if (String(password).length < 4) {
      return res
        .status(400)
        .json({ error: "Şifre en az 4 karakter olmalıdır." });
    }

    if (db) {
      await db.createUser({ username: trimmedUsername, password: String(password) });
    } else {
      const passwordHash = await bcrypt.hash(String(password), 10);
      registeredUsers.set(trimmedUsername, {
        username: trimmedUsername,
        passwordHash,
      });
      savePersistence();
    }

    // Yeni kullanıcı için meta veriyi başlat (ban/rol/ip)
    ensureUserMeta(trimmedUsername);
    // Özel yönetici kullanıcı tanımı
    if (trimmedUsername.toLowerCase() === "kuzxty") {
      setUserRole(trimmedUsername, "admin");
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionToken, trimmedUsername);
    savePersistence();
    const storage = db ? "veritabanı (PostgreSQL)" : "dosya (persistence.json)";
    console.log(`[KAYIT] ${trimmedUsername} oluşturuldu → ${storage} (silinmeyecek)`);
    return res.json({ ok: true, username: trimmedUsername, sessionToken });
  } catch (err) {
    console.error("Register error:", err);
    return res.status(500).json({ error: "Beklenmeyen bir hata oluştu." });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Kullanıcı adı ve şifre zorunludur." });
    }

    const trimmedUsername = String(username).trim();
    if (db) {
      const result = await db.verifyUser({
        username: trimmedUsername,
        password: String(password),
      });
      if (!result.ok) {
        return res
          .status(401)
          .json({ error: result.reason === "bad_password" ? "Şifre hatalı." : "Kullanıcı bulunamadı." });
      }
    } else {
      const user = registeredUsers.get(trimmedUsername);
      if (!user) {
        return res.status(401).json({ error: "Kullanıcı bulunamadı." });
      }

      const isMatch = await bcrypt.compare(String(password), user.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ error: "Şifre hatalı." });
      }
    }

    // Ban kontrolü
    if (isBanned(trimmedUsername)) {
      return res.status(403).json({ error: "Hesabınız yasaklandı." });
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");
    sessions.set(sessionToken, trimmedUsername);
    savePersistence();
    const storage = db ? "veritabanı" : "dosya";
    console.log(`[GİRİŞ] ${trimmedUsername} başarılı → ${storage} doğrulandı (hesap silinmemiş)`);
    return res.json({ ok: true, username: trimmedUsername, sessionToken });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Beklenmeyen bir hata oluştu." });
  }
});

app.get("/api/users/search", (req, res) => {
  void (async () => {
    const q = String(req.query.q || "").trim();
    const exclude = String(req.query.exclude || "").trim();
    if (q.length < 2) return res.json({ users: [] });

    if (db) {
      try {
        const users = await db.searchUsers(q, exclude);
        return res.json({ users });
      } catch (err) {
        return res.status(500).json({ users: [] });
      }
    }

    const lower = q.toLowerCase();
    const list = [];
    for (const u of registeredUsers.keys()) {
      if (u === exclude) continue;
      if (u.toLowerCase().includes(lower)) list.push(u);
      if (list.length >= 20) break;
    }
    return res.json({ users: list });
  })();
});

app.get("/api/session", (req, res) => {
  const token = String(req.query.token || "").trim();
  if (!token) return res.status(401).json({ ok: false });
  const username = sessions.get(token);
  if (!username) return res.status(401).json({ ok: false });
  return res.json({ ok: true, username });
});

// Yönetici API'leri
app.get("/api/admin/users", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const users = Array.from(registeredUsers.keys()).map((username) => {
    const meta = ensureUserMeta(username);
    return {
      username,
      role: meta.role,
      banned: meta.banned,
      ips: Array.from(meta.ips),
      online: userSockets.has(username),
    };
  });
  res.json({ users });
});

app.post("/api/admin/role", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const { target, role } = req.body || {};
  const username = String(target || "").trim();
  const newRole = String(role || "").trim();
  if (!username || !newRole) {
    return res.status(400).json({ error: "target ve role gerekli." });
  }
  if (!registeredUsers.has(username)) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  setUserRole(username, newRole);
  savePersistence();
  return res.json({ ok: true, username, role: newRole });
});

app.post("/api/admin/ban", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const { target, ban } = req.body || {};
  const username = String(target || "").trim();
  const shouldBan = Boolean(ban);
  if (!username) {
    return res.status(400).json({ error: "target gerekli." });
  }
  if (!registeredUsers.has(username)) {
    return res.status(404).json({ error: "Kullanıcı bulunamadı." });
  }

  setUserBanned(username, shouldBan);
  if (shouldBan) {
    disconnectUser(username, "Hesabınız banlandı.");
  }
  savePersistence();
  return res.json({ ok: true, username, banned: shouldBan });
});

app.get("/api/admin/ips", (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const ips = {};
  for (const username of registeredUsers.keys()) {
    const meta = ensureUserMeta(username);
    ips[username] = Array.from(meta.ips);
  }
  res.json({ ips });
});

// Arkadaşlık isteği gönder
app.post("/api/friend-request", (req, res) => {
  void (async () => {
  const { username, target } = req.body || {};
  const from = String(username || "").trim();
  const to = String(target || "").trim();

  if (!from || !to) {
    return res.status(400).json({ error: "Hedef kullanıcı bulunamadı." });
  }
  if (from === to) {
    return res
      .status(400)
      .json({ error: "Kendine arkadaşlık isteği gönderemezsin." });
  }
  if (db) {
    if (!(await db.userExists(to))) {
      return res.status(404).json({ error: "Bu kullanıcı mevcut değil." });
    }
    if (await db.isBlocked(from, to)) {
      return res.status(403).json({ error: "Bu kullanıcıyla etkileşim engellenmiş." });
    }
    if (await db.areFriends(from, to)) {
      return res.status(400).json({ error: "Zaten arkadaşsınız." });
    }
    // duplicate request check is handled by PK constraint; handle nicer message
    try {
      await db.sendFriendRequest({ from, to });
    } catch {
      return res.status(400).json({ error: "Zaten bekleyen bir isteğin var." });
    }

    emitRelationships(from);
    emitRelationships(to);
    return res.json({ ok: true });
  }

  if (!registeredUsers.has(to)) {
    return res.status(404).json({ error: "Bu kullanıcı mevcut değil." });
  }

  const fromBlocked = blocks.get(to);
  const toBlocked = blocks.get(from);
  if ((fromBlocked && fromBlocked.has(from)) || (toBlocked && toBlocked.has(to))) {
    return res.status(403).json({ error: "Bu kullanıcıyla etkileşim engellenmiş." });
  }

  const fromFriends = friends.get(from);
  if (fromFriends && fromFriends.has(to)) {
    return res.status(400).json({ error: "Zaten arkadaşsınız." });
  }

  const outgoingSet = ensureSet(friendRequestsOutgoing, from);
  const incomingSet = ensureSet(friendRequestsIncoming, to);

  if (outgoingSet.has(to)) {
    return res.status(400).json({ error: "Zaten bekleyen bir isteğin var." });
  }

  outgoingSet.add(to);
  incomingSet.add(from);
  savePersistence();

  emitRelationships(from);
  emitRelationships(to);

  return res.json({ ok: true });
  })();
});

// Arkadaşlık isteğine cevap ver
app.post("/api/friend-respond", (req, res) => {
  void (async () => {
  const { username, fromUser, accept } = req.body || {};
  const target = String(username || "").trim();
  const requester = String(fromUser || "").trim();
  const acceptBool = Boolean(accept);

  if (!target || !requester) {
    return res.status(400).json({ error: "Eksik bilgi." });
  }

  if (db) {
    // Accept/reject is just "delete request" + optionally add friendship
    try {
      await db.deleteFriendRequest({ from: requester, to: target });
    } catch {
      return res.status(400).json({ error: "Böyle bir arkadaşlık isteği yok." });
    }
    if (acceptBool) {
      await db.addFriendship(target, requester);
    }

    emitRelationships(target);
    emitRelationships(requester);
    return res.json({ ok: true });
  }

  const incomingSet = friendRequestsIncoming.get(target);
  if (!incomingSet || !incomingSet.has(requester)) {
    return res.status(400).json({ error: "Böyle bir arkadaşlık isteği yok." });
  }

  incomingSet.delete(requester);
  if (incomingSet.size === 0) {
    friendRequestsIncoming.delete(target);
  }

  const outgoingSet = friendRequestsOutgoing.get(requester);
  if (outgoingSet) {
    outgoingSet.delete(target);
    if (outgoingSet.size === 0) {
      friendRequestsOutgoing.delete(requester);
    }
  }

  if (acceptBool) {
    ensureSet(friends, target).add(requester);
    ensureSet(friends, requester).add(target);
  }
  savePersistence();

  emitRelationships(target);
  emitRelationships(requester);

  return res.json({ ok: true });
  })();
});

// Engelle / engeli kaldır
app.post("/api/block", (req, res) => {
  void (async () => {
  const { username, target, block } = req.body || {};
  const user = String(username || "").trim();
  const other = String(target || "").trim();
  const shouldBlock = Boolean(block);

  if (!user || !other) {
    return res.status(400).json({ error: "Eksik bilgi." });
  }
  if (user === other) {
    return res.status(400).json({ error: "Kendini engelleyemezsin." });
  }

  if (db) {
    await db.setBlock({ user, other, block: shouldBlock });
    if (shouldBlock) {
      await db.removeFriendship(user, other);
      await db.clearRequestsBetween(user, other);
    }
    emitRelationships(user);
    emitRelationships(other);
    return res.json({ ok: true });
  }

  const blockedSet = ensureSet(blocks, user);

  if (shouldBlock) {
    blockedSet.add(other);
    // Arkadaşlığı kaldır
    const f1 = friends.get(user);
    if (f1) f1.delete(other);
    const f2 = friends.get(other);
    if (f2) f2.delete(user);

    // Bekleyen istekleri kaldır
    const incomingUser = friendRequestsIncoming.get(user);
    if (incomingUser) {
      incomingUser.delete(other);
      if (incomingUser.size === 0) {
        friendRequestsIncoming.delete(user);
      }
    }
    const outgoingUser = friendRequestsOutgoing.get(user);
    if (outgoingUser) {
      outgoingUser.delete(other);
      if (outgoingUser.size === 0) {
        friendRequestsOutgoing.delete(user);
      }
    }

    const incomingOther = friendRequestsIncoming.get(other);
    if (incomingOther) {
      incomingOther.delete(user);
      if (incomingOther.size === 0) {
        friendRequestsIncoming.delete(other);
      }
    }
    const outgoingOther = friendRequestsOutgoing.get(other);
    if (outgoingOther) {
      outgoingOther.delete(user);
      if (outgoingOther.size === 0) {
        friendRequestsOutgoing.delete(other);
      }
    }
  } else {
    blockedSet.delete(other);
  }
  savePersistence();

  emitRelationships(user);
  emitRelationships(other);

  return res.json({ ok: true });
  })();
});

// Grup oluştur (sadece arkadaşlar eklenebilir)
app.post("/api/groups", (req, res) => {
  void (async () => {
    const { username, name, members } = req.body || {};
    const createdBy = String(username || "").trim();
    const groupName = String(name || "").trim();
    const memberList = Array.isArray(members) ? members.map((m) => String(m).trim()).filter(Boolean) : [];

    if (!createdBy || !groupName) {
      return res.status(400).json({ error: "Grup adı ve kullanıcı bilgisi zorunludur." });
    }
    if (groupName.length < 2 || groupName.length > 50) {
      return res.status(400).json({ error: "Grup adı 2-50 karakter arasında olmalıdır." });
    }

    if (db) {
      const myFriends = (await db.getRelationships(createdBy)).friends;
      for (const m of memberList) {
        if (m === createdBy) continue;
        if (!myFriends.includes(m)) {
          return res.status(400).json({ error: `Sadece arkadaşlarını gruba ekleyebilirsin. "${m}" arkadaş listenizde yok.` });
        }
      }
      try {
        const groupId = await db.createGroup({ name: groupName, createdBy, memberUsernames: memberList });
        const group = await db.getGroup(groupId);
        return res.json({ ok: true, group: { id: groupId, ...group } });
      } catch (err) {
        console.error("Create group error:", err);
        return res.status(500).json({ error: "Grup oluşturulurken hata oluştu." });
      }
    }

    const myFriends = (friends.get(createdBy) || new Set());
    for (const m of memberList) {
      if (m === createdBy) continue;
      if (!myFriends.has(m)) {
        return res.status(400).json({ error: `Sadece arkadaşlarını gruba ekleyebilirsin. "${m}" arkadaş listenizde yok.` });
      }
    }

    const groupId = `mem-${nextGroupId++}`;
    const allMembers = [createdBy, ...memberList.filter((m) => m !== createdBy)];
    groups.set(groupId, { id: groupId, name: groupName, createdBy, members: allMembers });
    groupMembers.set(groupId, new Set(allMembers));
    savePersistence();
    return res.json({ ok: true, group: { id: groupId, name: groupName, createdBy, members: allMembers } });
  })();
});

// Gruptan çık
app.post("/api/groups/leave", (req, res) => {
  void (async () => {
    const { username, groupId } = req.body || {};
    const user = String(username || "").trim();
    const gid = String(groupId || "").trim();
    if (!user || !gid) return res.status(400).json({ error: "Eksik bilgi." });

    if (db) {
      const ok = await db.isGroupMember(gid, user);
      if (!ok) return res.status(400).json({ error: "Grupta değilsin." });
      await db.leaveGroup(gid, user);
      return res.json({ ok: true });
    }

    const members = groupMembers.get(gid);
    if (!members || !members.has(user)) return res.status(400).json({ error: "Grupta değilsin." });
    members.delete(user);
    if (members.size === 0) {
      groups.delete(gid);
      groupMembers.delete(gid);
    }
    savePersistence();
    return res.json({ ok: true });
  })();
});

// Kullanıcının gruplarını getir
app.get("/api/groups", (req, res) => {
  void (async () => {
    const username = String(req.query.username || "").trim();
    if (!username) {
      return res.status(400).json({ error: "username gerekli." });
    }

    if (db) {
      try {
        const list = await db.getGroupsForUser(username);
        return res.json({ groups: list });
      } catch (err) {
        console.error("Get groups error:", err);
        return res.status(500).json({ error: "Gruplar alınırken hata oluştu." });
      }
    }

    const list = [];
    for (const [gid, g] of groups) {
      if (groupMembers.get(gid).has(username)) {
        list.push({ id: gid, name: g.name, createdBy: g.createdBy, members: [...g.members] });
      }
    }
    return res.json({ groups: list });
  })();
});

io.on("connection", (socket) => {
  if (isMaintenanceMode()) {
    socket.emit("systemMessage", "Bakımdayız. Lütfen daha sonra tekrar dene.");
    socket.disconnect(true);
    return;
  }

  socket.on("join", (username) => {
    const trimmedUsername = String(username || "").trim();
    if (!trimmedUsername) return;

    // Ban kontrolü
    if (isBanned(trimmedUsername)) {
      socket.emit("systemMessage", "Hesabınız banlandı.");
      socket.disconnect(true);
      return;
    }

    // 'kuzxty' kullanıcısını her zaman yönetici yap
    if (trimmedUsername.toLowerCase() === "kuzxty") {
      setUserRole(trimmedUsername, "admin");
    }

    socket.username = trimmedUsername;
    sockets.set(socket.id, trimmedUsername);

    // IP kaydı (yönlendirilmiş isteklerde X-Forwarded-For)
    const forwarded = String(socket.handshake.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const ip = forwarded || socket.handshake.address;
    recordUserIp(trimmedUsername, ip);
    savePersistence();

    if (!userSockets.has(trimmedUsername)) {
      userSockets.set(trimmedUsername, new Set());
    }
    userSockets.get(trimmedUsername).add(socket.id);

    socket.emit(
      "systemMessage",
      `Merhaba ${trimmedUsername}, arkadaş ekleyip yalnızca onlarla özel sohbet edebilirsin.`
    );
    socket.broadcast.emit(
      "systemMessage",
      `${trimmedUsername} çevrimiçi oldu.`
    );

    broadcastUserList();
    emitRelationships(trimmedUsername);
  });

  socket.on("joinGroups", (groupIds) => {
    const username = socket.username;
    if (!username) return;
    const list = Array.isArray(groupIds) ? groupIds : [];
    void (async () => {
      for (const gid of list) {
        if (!gid) continue;
        let isMember = false;
        if (db) {
          isMember = await db.isGroupMember(gid, username);
        } else {
          const members = groupMembers.get(gid);
          isMember = members ? members.has(username) : false;
        }
        if (isMember) socket.join("group:" + gid);
      }
    })();
  });

  socket.on("leaveGroup", (groupId) => {
    const gid = String(groupId || "").trim();
    if (gid) socket.leave("group:" + gid);
  });

  socket.on("groupMessage", ({ groupId, message }) => {
    void (async () => {
      const text = String(message || "").trim();
      const gid = String(groupId || "").trim();
      const fromUsername = socket.username || "";
      if (!text || !gid || !fromUsername) return;

      let isMember = false;
      if (db) {
        isMember = await db.isGroupMember(gid, fromUsername);
      } else {
        const members = groupMembers.get(gid);
        isMember = members ? members.has(fromUsername) : false;
      }
      if (!isMember) return;

      const payload = {
        groupId: gid,
        fromUsername,
        message: text,
        time: new Date().toISOString(),
      };
      io.to("group:" + gid).emit("groupMessage", payload);
    })();
  });

  socket.on("privateMessage", ({ toUsername, message }) => {
    void (async () => {
    const text = String(message || "").trim();
    const target = String(toUsername || "").trim();
    if (!text || !target) return;

    const fromUsername = socket.username || "Bilinmeyen";
    const time = new Date().toISOString();

    // Engelleme + arkadaşlık kontrolü (DB varsa DB üzerinden)
    if (!(await canDirectMessageUnified(fromUsername, target))) {
      return;
    }

    const payload = {
      fromUsername,
      toUsername: target,
      message: text,
      time,
    };

    // Hedef kullanıcının tüm socket'lerine gönder
    const targetSockets = userSockets.get(target);
    if (targetSockets) {
      for (const id of targetSockets) {
        io.to(id).emit("privateMessage", payload);
      }
    }

    // Gönderene de kendi mesajını yansıt
    socket.emit("privateMessage", payload);
    })();
  });

  // --- WebRTC Signaling (sesli / görüntülü arama) ---
  socket.on("call:offer", ({ callId, toUsername, kind, sdp }) => {
    const fromUsername = socket.username || "";
    const to = String(toUsername || "").trim();
    const id = String(callId || "").trim();
    const callKind = kind === "video" ? "video" : "audio";
    if (!fromUsername || !to || !id || !sdp) return;

    void (async () => {
      if (!(await canDirectMessageUnified(fromUsername, to))) return;

      // call kaydı
      calls.set(id, { callId: id, fromUsername, toUsername: to, kind: callKind });
      ensureSet(callsByUser, fromUsername).add(id);
      ensureSet(callsByUser, to).add(id);

      emitToAllUserSockets(to, "call:offer", {
        callId: id,
        fromUsername,
        kind: callKind,
        sdp,
      });
    })();
  });

  socket.on("call:answer", ({ callId, sdp }) => {
    const username = socket.username || "";
    const id = String(callId || "").trim();
    if (!username || !id || !sdp) return;

    const call = calls.get(id);
    if (!call) return;

    // sadece taraflar cevaplayabilir
    if (username !== call.toUsername && username !== call.fromUsername) return;

    const other =
      username === call.fromUsername ? call.toUsername : call.fromUsername;
    emitToAllUserSockets(other, "call:answer", {
      callId: id,
      fromUsername: call.fromUsername,
      toUsername: call.toUsername,
      sdp,
    });
  });

  socket.on("call:ice", ({ callId, candidate }) => {
    const username = socket.username || "";
    const id = String(callId || "").trim();
    if (!username || !id || !candidate) return;

    const call = calls.get(id);
    if (!call) return;
    if (username !== call.toUsername && username !== call.fromUsername) return;

    const other =
      username === call.fromUsername ? call.toUsername : call.fromUsername;
    emitToAllUserSockets(other, "call:ice", {
      callId: id,
      candidate,
    });
  });

  socket.on("call:reject", ({ callId }) => {
    const username = socket.username || "";
    const id = String(callId || "").trim();
    if (!username || !id) return;
    const call = calls.get(id);
    if (!call) return;
    if (username !== call.toUsername && username !== call.fromUsername) return;

    const other =
      username === call.fromUsername ? call.toUsername : call.fromUsername;
    emitToAllUserSockets(other, "call:reject", { callId: id });

    calls.delete(id);
    const a = callsByUser.get(call.fromUsername);
    if (a) a.delete(id);
    const b = callsByUser.get(call.toUsername);
    if (b) b.delete(id);
  });

  socket.on("call:hangup", ({ callId }) => {
    const username = socket.username || "";
    const id = String(callId || "").trim();
    if (!username || !id) return;
    const call = calls.get(id);
    if (!call) return;
    if (username !== call.toUsername && username !== call.fromUsername) return;

    const other =
      username === call.fromUsername ? call.toUsername : call.fromUsername;
    emitToAllUserSockets(other, "call:hangup", { callId: id });

    calls.delete(id);
    const a = callsByUser.get(call.fromUsername);
    if (a) a.delete(id);
    const b = callsByUser.get(call.toUsername);
    if (b) b.delete(id);
  });

  socket.on("disconnect", () => {
    const username = sockets.get(socket.id);
    if (username) {
      sockets.delete(socket.id);
      const set = userSockets.get(username);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          userSockets.delete(username);

          // Kullanıcı tamamen offline olduysa aktif çağrılarını düşür
          const callSet = callsByUser.get(username);
          if (callSet) {
            for (const callId of callSet) {
              const call = calls.get(callId);
              if (!call) continue;
              const other =
                username === call.fromUsername
                  ? call.toUsername
                  : call.fromUsername;
              emitToAllUserSockets(other, "call:hangup", {
                callId,
                reason: "disconnect",
              });
              calls.delete(callId);
            }
            callsByUser.delete(username);
          }
        }
      }

      socket.broadcast.emit(
        "systemMessage",
        `${username} bağlantısını kesti.`
      );
      broadcastUserList();
    }
  });
});

async function start() {
  if (db) {
    try {
      await db.init();
      await db.pool.query("SELECT 1");
      console.log("[VERİTABANI] PostgreSQL bağlı → kullanıcılar SİLİNMEYECEK (deploy sonrası kalır)");
    } catch (err) {
      console.error("[HATA] Veritabanı bağlanamadı! Kullanıcılar deploy'da KAYBEDİLİR.");
      console.error("DATABASE_URL kontrol et. Render: Web Service → Environment → DATABASE_URL");
      console.error("Hata:", err.message);
      throw err;
    }
  } else {
    loadPersistence();

    // Özel kullanıcı 'kuzxty' varsa otomatik admin yap
    if (registeredUsers.has("kuzxty")) {
      setUserRole("kuzxty", "admin");
      savePersistence();
    }

    console.log("[UYARI] DATABASE_URL yok → dosya kullanılıyor (Render deploy'da sıfırlanır!)");
  }

  server.listen(PORT, () => {
    console.log(`Rainbow Chat http://localhost:${PORT} adresinde çalışıyor`);
  });
}

start().catch((err) => {
  console.error("Startup error:", err);
  process.exit(1);
});

