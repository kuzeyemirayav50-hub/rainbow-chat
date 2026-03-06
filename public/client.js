(() => {
  const usernameSection = document.getElementById("username-section");
  const chatSection = document.getElementById("chat-section");
  const authForm = document.getElementById("auth-form");
  const authUsernameInput = document.getElementById("auth-username");
  const authPasswordInput = document.getElementById("auth-password");
  const authTabs = document.querySelectorAll(".auth-tab");
  const authSubmitBtn = document.getElementById("auth-submit-btn");
  const authErrorEl = document.getElementById("auth-error");
  const currentUsernamePill = document.getElementById("current-username-pill");
  const userListEl = document.getElementById("user-list");
  const chatTitleEl = document.getElementById("chat-title");
  const chatSubtitleEl = document.getElementById("chat-subtitle");
  const messageForm = document.getElementById("message-form");
  const messageInput = document.getElementById("message-input");
  const messagesContainer = document.getElementById("messages");

  let socket = null;
  let currentUsername = "";
  let authMode = "login"; // "login" | "register"
  let onlineUsers = []; // string[]
  let activeChatUser = null;
  const conversations = {}; // username -> [{ fromUsername, toUsername, message, time }]

  let notificationsEnabled = false;
  let windowFocused = true;

  function formatTime(isoString) {
    const date = isoString ? new Date(isoString) : new Date();
    return date.toLocaleTimeString("tr-TR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function scrollToBottom() {
    if (!messagesContainer) return;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function createMessageElement({ username, message, time, type, isMe }) {
    const row = document.createElement("div");
    const bubble = document.createElement("div");

    if (type === "system") {
      row.className = "message-row system";
      bubble.className = "message-bubble";
      bubble.textContent = message;
      row.appendChild(bubble);
      return row;
    }

    row.className = `message-row ${isMe ? "me" : "other"}`;
    bubble.className = "message-bubble";

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const usernameSpan = document.createElement("span");
    usernameSpan.className = "message-username";
    usernameSpan.textContent = username || "Misafir";

    const timeSpan = document.createElement("span");
    timeSpan.className = "message-time";
    timeSpan.textContent = formatTime(time);

    meta.appendChild(usernameSpan);
    meta.appendChild(timeSpan);

    const text = document.createElement("p");
    text.className = "message-text";
    text.textContent = message;

    bubble.appendChild(meta);
    bubble.appendChild(text);
    row.appendChild(bubble);

    return row;
  }

  function renderMessagesFor(user) {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = "";

    const history = conversations[user] || [];
    history.forEach((msg) => {
      const isMe = msg.fromUsername === currentUsername;
      const el = createMessageElement({
        username: msg.fromUsername,
        message: msg.message,
        time: msg.time,
        type: "user",
        isMe,
      });
      messagesContainer.appendChild(el);
    });

    scrollToBottom();
  }

  function renderUserList() {
    if (!userListEl) return;
    userListEl.innerHTML = "";

    const others = onlineUsers.filter((u) => u !== currentUsername);

    if (!others.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent =
        "Şu anda başka kimse çevrimiçi değil. Başka bir cihazdan aynı kullanıcıyla giriş yapıp test edebilirsin.";
      userListEl.appendChild(empty);
      return;
    }

    others.forEach((username) => {
      const item = document.createElement("div");
      item.className = "user-item";
      if (activeChatUser === username) {
        item.classList.add("active");
      }

      const main = document.createElement("div");
      main.className = "user-main";

      const dot = document.createElement("span");
      dot.className = "user-dot";

      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = username;

      main.appendChild(dot);
      main.appendChild(name);

      const tag = document.createElement("span");
      tag.className = "user-tag";
      tag.textContent = "Özel sohbet";

      item.appendChild(main);
      item.appendChild(tag);

      item.addEventListener("click", () => {
        activeChatUser = username;

        if (chatTitleEl && chatSubtitleEl) {
          chatTitleEl.textContent = username;
          chatSubtitleEl.textContent =
            "Bu pencerede sadece seninle " +
            username +
            " arasındaki özel mesajlar gösterilir.";
        }

        if (messageInput) {
          messageInput.placeholder = username + " için mesaj yaz...";
        }

        renderMessagesFor(username);
        renderUserList();
      });

      userListEl.appendChild(item);
    });
  }

  function maybeShowNotification(fromUsername, message) {
    if (!notificationsEnabled) return;
    if (!fromUsername || !message) return;
    if (windowFocused) return;

    try {
      new Notification("Rainbow Chat", {
        body: `${fromUsername}: ${message}`,
      });
    } catch {
      // sessizce geç
    }
  }

  function setupNotificationPermission() {
    if (!("Notification" in window)) return;

    if (Notification.permission === "granted") {
      notificationsEnabled = true;
      return;
    }

    if (Notification.permission === "default") {
      Notification.requestPermission().then((result) => {
        notificationsEnabled = result === "granted";
      });
    }
  }

  window.addEventListener("focus", () => {
    windowFocused = true;
  });
  window.addEventListener("blur", () => {
    windowFocused = false;
  });

  authTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      authTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      authMode =
        tab.getAttribute("data-mode") === "register" ? "register" : "login";
      if (authSubmitBtn) {
        authSubmitBtn.textContent =
          authMode === "login" ? "Giriş Yap" : "Kayıt Ol";
      }
      if (authErrorEl) authErrorEl.textContent = "";
    });
  });

  authForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = authUsernameInput.value.trim();
    const password = authPasswordInput.value;

    if (!username || !password) {
      if (authErrorEl) {
        authErrorEl.textContent = "Kullanıcı adı ve şifre zorunlu.";
      }
      return;
    }

    try {
      const endpoint = authMode === "login" ? "/api/login" : "/api/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (authErrorEl) {
          authErrorEl.textContent = data.error || "Bir hata oluştu.";
        }
        return;
      }

      currentUsername = data.username;
      if (authErrorEl) authErrorEl.textContent = "";

      if (!socket) {
        socket = io();

        socket.on("connect", () => {
          socket.emit("join", currentUsername);
        });

        socket.on("systemMessage", (text) => {
          const el = createMessageElement({
            type: "system",
            message: text,
          });
          messagesContainer.appendChild(el);
          scrollToBottom();
        });

        socket.on("userList", (list) => {
          onlineUsers = Array.isArray(list) ? list : [];
          renderUserList();
        });

        socket.on("privateMessage", (payload) => {
          const { fromUsername, toUsername, message, time } = payload;
          const other =
            fromUsername === currentUsername ? toUsername : fromUsername;
          if (!other) return;

          if (!conversations[other]) {
            conversations[other] = [];
          }
          conversations[other].push({
            fromUsername,
            toUsername,
            message,
            time,
          });

          if (activeChatUser === other) {
            const isMe = fromUsername === currentUsername;
            const el = createMessageElement({
              username: fromUsername,
              message,
              time,
              type: "user",
              isMe,
            });
            messagesContainer.appendChild(el);
            scrollToBottom();
          } else if (fromUsername !== currentUsername) {
            maybeShowNotification(fromUsername, message);
          }

          // Otomatik liste güncellemesi için online listeden de varsa göster
          if (!onlineUsers.includes(other)) {
            onlineUsers.push(other);
          }
          renderUserList();
        });
      } else {
        socket.emit("join", currentUsername);
      }

      if (currentUsernamePill) {
        currentUsernamePill.textContent = `👤 ${currentUsername}`;
      }

      usernameSection.classList.add("hidden");
      chatSection.classList.remove("hidden");
      setupNotificationPermission();
      renderUserList();
      if (messageInput) messageInput.focus();
    } catch (err) {
      if (authErrorEl) {
        authErrorEl.textContent = "Sunucuya bağlanırken bir hata oluştu.";
      }
    }
  });

  messageForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!socket) return;

    const msg = messageInput.value.trim();
    if (!msg) return;
    if (!activeChatUser) return;

    socket.emit("privateMessage", {
      toUsername: activeChatUser,
      message: msg,
    });

    messageInput.value = "";
  });
})();

