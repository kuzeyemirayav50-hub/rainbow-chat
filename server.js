const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcryptjs");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Kayıtlı kullanıcılar (kalıcı değil, sunucu yeniden başlarsa sıfırlanır)
// username -> { username, passwordHash }
const registeredUsers = new Map();

// Çevrimiçi kullanıcılar
// socket.id -> username
const sockets = new Map();
// username -> Set<socket.id>
const userSockets = new Map();

function broadcastUserList() {
  const onlineUsernames = Array.from(userSockets.keys());
  io.emit("userList", onlineUsernames);
}

app.use(express.json());
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

io.on("connection", (socket) => {
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
      `Merhaba ${trimmedUsername}, özel sohbet için bir kullanıcı seç.`
    );
    socket.broadcast.emit(
      "systemMessage",
      `${trimmedUsername} çevrimiçi oldu.`
    );

    broadcastUserList();
  });

  socket.on("privateMessage", ({ toUsername, message }) => {
    const text = String(message || "").trim();
    const target = String(toUsername || "").trim();
    if (!text || !target) return;

    const fromUsername = socket.username || "Bilinmeyen";
    const time = new Date().toISOString();

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

  socket.on("disconnect", () => {
    const username = sockets.get(socket.id);
    if (username) {
      sockets.delete(socket.id);
      const set = userSockets.get(username);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) {
          userSockets.delete(username);
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

