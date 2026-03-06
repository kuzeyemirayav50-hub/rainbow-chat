const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

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

function emitRelationships(username) {
  const socketsForUser = userSockets.get(username);
  if (!socketsForUser) return;
  const payload = getRelationships(username);
  for (const id of socketsForUser) {
    io.to(id).emit("relationships", payload);
  }
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

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
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
    if (registeredUsers.has(trimmedUsername)) {
      return res.status(400).json({ error: "Bu kullanıcı adı zaten alınmış." });
    }
    if (String(password).length < 4) {
      return res
        .status(400)
        .json({ error: "Şifre en az 4 karakter olmalıdır." });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    registeredUsers.set(trimmedUsername, {
      username: trimmedUsername,
      passwordHash,
    });

    return res.json({ ok: true, username: trimmedUsername });
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
    const user = registeredUsers.get(trimmedUsername);
    if (!user) {
      return res.status(401).json({ error: "Kullanıcı bulunamadı." });
    }

    const isMatch = await bcrypt.compare(String(password), user.passwordHash);
    if (!isMatch) {
      return res.status(401).json({ error: "Şifre hatalı." });
    }

    return res.json({ ok: true, username: trimmedUsername });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Beklenmeyen bir hata oluştu." });
  }
});

// Arkadaşlık isteği gönder
app.post("/api/friend-request", (req, res) => {
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

  emitRelationships(from);
  emitRelationships(to);

  return res.json({ ok: true });
});

// Arkadaşlık isteğine cevap ver
app.post("/api/friend-respond", (req, res) => {
  const { username, fromUser, accept } = req.body || {};
  const target = String(username || "").trim();
  const requester = String(fromUser || "").trim();
  const acceptBool = Boolean(accept);

  if (!target || !requester) {
    return res.status(400).json({ error: "Eksik bilgi." });
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

  emitRelationships(target);
  emitRelationships(requester);

  return res.json({ ok: true });
});

// Engelle / engeli kaldır
app.post("/api/block", (req, res) => {
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

  emitRelationships(user);
  emitRelationships(other);

  return res.json({ ok: true });
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

    socket.username = trimmedUsername;
    sockets.set(socket.id, trimmedUsername);

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

  socket.on("privateMessage", ({ toUsername, message }) => {
    const text = String(message || "").trim();
    const target = String(toUsername || "").trim();
    if (!text || !target) return;

    const fromUsername = socket.username || "Bilinmeyen";
    const time = new Date().toISOString();

    // Engelleme kontrolü
    if (isBlocked(fromUsername, target)) {
      return;
    }

    // Arkadaşlık kontrolü (karşılıklı arkadaş olmayanlara DM yok)
    if (!areFriends(fromUsername, target)) {
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
  });

  // --- WebRTC Signaling (sesli / görüntülü arama) ---
  socket.on("call:offer", ({ callId, toUsername, kind, sdp }) => {
    const fromUsername = socket.username || "";
    const to = String(toUsername || "").trim();
    const id = String(callId || "").trim();
    const callKind = kind === "video" ? "video" : "audio";
    if (!fromUsername || !to || !id || !sdp) return;

    if (!canDirectMessage(fromUsername, to)) return;

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

server.listen(PORT, () => {
  console.log(`Rainbow Chat http://localhost:${PORT} adresinde çalışıyor`);
});

