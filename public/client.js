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
  const callAudioBtn = document.getElementById("call-audio-btn");
  const callVideoBtn = document.getElementById("call-video-btn");
  const callHangupBtn = document.getElementById("call-hangup-btn");
  const callPanelEl = document.getElementById("call-panel");
  const callStatusTitleEl = document.getElementById("call-status-title");
  const callStatusSubtitleEl = document.getElementById("call-status-subtitle");
  const toggleMicBtn = document.getElementById("toggle-mic-btn");
  const toggleCamBtn = document.getElementById("toggle-cam-btn");
  const screenShareBtn = document.getElementById("screen-share-btn");
  const callDurationEl = document.getElementById("call-duration");
  const micLevelBar = document.getElementById("mic-level-bar");
  const localVideoEl = document.getElementById("local-video");
  const remoteVideoEl = document.getElementById("remote-video");
  const incomingModalEl = document.getElementById("incoming-call-modal");
  const incomingTitleEl = document.getElementById("incoming-call-title");
  const incomingSubtitleEl = document.getElementById("incoming-call-subtitle");
  const incomingAcceptBtn = document.getElementById("incoming-accept-btn");
  const incomingRejectBtn = document.getElementById("incoming-reject-btn");

  const contactModalEl = document.getElementById("contact-modal");
  const contactOpenBtn = document.getElementById("contact-open-btn");
  const contactCloseBtn = document.getElementById("contact-close-btn");

  const messageForm = document.getElementById("message-form");
  const messageInput = document.getElementById("message-input");
  const messagesContainer = document.getElementById("messages");
  const groupListEl = document.getElementById("group-list");
  const createGroupBtn = document.getElementById("create-group-btn");
  const createGroupModal = document.getElementById("create-group-modal");
  const createGroupForm = document.getElementById("create-group-form");
  const groupNameInput = document.getElementById("group-name-input");
  const groupMembersCheckboxes = document.getElementById("group-members-checkboxes");
  const createGroupCancelBtn = document.getElementById("create-group-cancel-btn");
  const panelTabs = document.querySelectorAll(".panel-tab");
  const leaveGroupBtn = document.getElementById("leave-group-btn");
  const typingIndicatorEl = document.getElementById("typing-indicator");
  const typingUsernameEl = document.getElementById("typing-username");
  const viewingIndicatorEl = document.getElementById("viewing-indicator");
  const viewingUsernameEl = document.getElementById("viewing-username");
  const themeToggle = document.getElementById("theme-toggle");
  const messageSearchEl = document.getElementById("message-search");
  const toastContainer = document.getElementById("toast-container");

  // Refresh sonrası son kullanıcı adını hatırla (giriş ekranında doldur)
  try {
    const lastUser = localStorage.getItem("rc_lastuser");
    if (lastUser && authUsernameInput) authUsernameInput.value = lastUser;
  } catch {}

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".msg-action-dropdown-wrap")) {
      document.querySelectorAll(".msg-action-dropdown.open").forEach((d) => d.classList.remove("open"));
    }
  });

  let socket = null;
  let currentUsername = "";
  let authMode = "login"; // "login" | "register"
  let onlineUsers = []; // string[]
  let activeChatUser = null;
  let activeGroupId = null;
  const conversations = {}; // username -> [{ fromUsername, toUsername, message, time }]
  const groupConversations = {}; // groupId -> [{ fromUsername, message, time }]
  const MAX_STORED_MESSAGES = 150; // Tarayıcıda saklanacak son mesaj sayısı (sunucuyu yormamak)

  function convStorageKey(other) {
    if (!currentUsername || !other) return null;
    return "rc_conv_" + [currentUsername, other].sort().join("_");
  }
  function loadConvFromStorage(other) {
    const key = convStorageKey(other);
    if (!key) return [];
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function saveConvToStorage(other, msgs) {
    const key = convStorageKey(other);
    if (!key || !Array.isArray(msgs)) return;
    try {
      const trimmed = msgs.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem(key, JSON.stringify(trimmed));
    } catch {}
  }
  function loadGroupFromStorage(gid) {
    if (!gid) return [];
    try {
      const raw = localStorage.getItem("rc_group_" + gid);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }
  function saveGroupToStorage(gid, msgs) {
    if (!gid || !Array.isArray(msgs)) return;
    try {
      const trimmed = msgs.slice(-MAX_STORED_MESSAGES);
      localStorage.setItem("rc_group_" + gid, JSON.stringify(trimmed));
    } catch {}
  }
  let groups = []; // { id, name, createdBy, members }[]
  let relationships = {
    friends: [],
    blocked: [],
    incomingRequests: [],
    outgoingRequests: [],
  };
  const unreadCounts = {}; // username -> number
  const lastSeenCache = {}; // username -> iso string

  let notificationsEnabled = false;
  let windowFocused = true;
  let typingTimeout = null;
  let typingHideTimeout = null;

  // WebRTC call state (1:1)
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCallId = null;
  let callKind = null; // "audio" | "video"
  let incomingOffer = null; // { callId, fromUsername, kind, sdp }
  let callPeerUsername = null;
  let ringtoneInterval = null;
  let callDurationInterval = null;
  let callStartTime = null;
  let screenShareStream = null;
  let analyserNode = null;
  let micLevelAnimationId = null;

  // WebRTC config - sunucudan al (birden fazla STUN, TURN destekli)
  let rtcConfig = {
    iceServers: [
      { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
      { urls: "stun:stun2.l.google.com:19302" },
      { urls: "stun:stun3.l.google.com:19302" },
      { urls: "stun:stun4.l.google.com:19302" },
      { urls: "stun:stun.stunprotocol.org:3478" },
      { urls: "stun:stun.freeswitch.org" },
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: "max-bundle",
  };

  async function loadRtcConfig() {
    try {
      const res = await fetch("/api/webrtc-config");
      const data = await res.json();
      if (res.ok && Array.isArray(data?.iceServers) && data.iceServers.length) {
        rtcConfig = { ...rtcConfig, iceServers: data.iceServers };
      }
    } catch {}
  }

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

  let replyingTo = null;

  function createMessageElement({ id, username, message, time, type, isMe, replyTo, editedAt, pinned, reactions }) {
    const row = document.createElement("div");
    row.className = "message-row-wrapper";
    if (id) row.dataset.messageId = id;

    const bubble = document.createElement("div");

    if (type === "system") {
      row.className = "message-row system";
      bubble.className = "message-bubble";
      bubble.textContent = message;
      row.appendChild(bubble);
      return row;
    }

    row.className = `message-row-wrapper message-row ${isMe ? "me" : "other"}`;
    bubble.className = "message-bubble";

    if (replyTo && (replyTo.username || replyTo.message)) {
      const replyBlock = document.createElement("div");
      replyBlock.className = "message-reply-preview";
      replyBlock.innerHTML = `<strong>${replyTo.username || "?"}</strong>: ${String(replyTo.message || "").slice(0, 50)}${(replyTo.message || "").length > 50 ? "…" : ""}`;
      bubble.appendChild(replyBlock);
    }

    const meta = document.createElement("div");
    meta.className = "message-meta";

    const usernameSpan = document.createElement("span");
    usernameSpan.className = "message-username";
    usernameSpan.textContent = username || "Misafir";

    const timeSpan = document.createElement("span");
    timeSpan.className = "message-time";
    timeSpan.textContent = formatTime(time);
    if (editedAt) {
      const ed = document.createElement("span");
      ed.className = "message-edited";
      ed.textContent = " (düzenlendi)";
      timeSpan.appendChild(ed);
    }

    meta.appendChild(usernameSpan);
    meta.appendChild(timeSpan);
    if (pinned) {
      const pin = document.createElement("span");
      pin.className = "message-pin-badge";
      pin.textContent = " 📌";
      meta.appendChild(pin);
    }

    const content = document.createElement("div");
    content.className = "message-content";
    if (type === "image" || (message && message.startsWith("data:image/"))) {
      const img = document.createElement("img");
      img.className = "message-image";
      img.src = message;
      img.alt = "Görsel";
      content.appendChild(img);
    } else {
      const text = document.createElement("p");
      text.className = "message-text";
      text.textContent = message;
      content.appendChild(text);
    }

    bubble.appendChild(meta);
    bubble.appendChild(content);

    if (reactions && typeof reactions === "object" && Object.keys(reactions).length) {
      const reactEl = document.createElement("div");
      reactEl.className = "message-reactions";
      for (const [emoji, users] of Object.entries(reactions)) {
        if (!users || !users.length) continue;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "reaction-btn";
        btn.textContent = emoji + (users.length > 1 ? " " + users.length : "");
        btn.title = users.join(", ");
        if (id) {
          btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (socket) socket.emit("message:react", { id, emoji });
          });
        }
        reactEl.appendChild(btn);
      }
      bubble.appendChild(reactEl);
    }

    row.appendChild(bubble);

    return row;
  }

  let messageSearchQuery = "";
  let viewingChatUser = null;
  let viewingChatTimeout = null;

  async function fetchAndRenderMessagesForUser(user) {
    const convId = [currentUsername, user].sort().join("_");
    try {
      const res = await fetch(`/api/messages?convType=pm&convId=${encodeURIComponent(convId)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.messages) && data.messages.length) {
        const list = data.messages.map((m) => ({
          id: m.id,
          fromUsername: m.fromUsername,
          toUsername: user === m.fromUsername ? currentUsername : user,
          message: m.message,
          time: m.time,
          replyTo: m.replyTo,
          editedAt: m.editedAt,
          pinned: m.pinned,
          reactions: m.reactions || {},
        }));
        const byId = new Map(list.filter((m) => m.id).map((m) => [m.id, m]));
        (conversations[user] || []).forEach((m) => {
          if (m.id && !byId.has(m.id)) list.push(m);
          else if (!m.id) list.push(m);
        });
        list.sort((a, b) => new Date(a.time) - new Date(b.time));
        conversations[user] = list;
        saveConvToStorage(user, list);
      }
    } catch {}
    renderMessagesFor(user, messageSearchQuery);
  }

  async function fetchAndRenderMessagesForGroup(groupId) {
    try {
      const res = await fetch(`/api/messages?convType=group&convId=${encodeURIComponent(groupId)}`);
      const data = await res.json();
      if (res.ok && Array.isArray(data.messages) && data.messages.length) {
        const list = data.messages.map((m) => ({
          id: m.id,
          fromUsername: m.fromUsername,
          message: m.message,
          time: m.time,
          replyTo: m.replyTo,
          editedAt: m.editedAt,
          pinned: m.pinned,
          reactions: m.reactions || {},
        }));
        const byId = new Set(list.filter((m) => m.id).map((m) => m.id));
        (groupConversations[groupId] || []).forEach((m) => {
          if (m.id && !byId.has(m.id)) list.push(m);
          else if (!m.id) list.push(m);
        });
        list.sort((a, b) => new Date(a.time) - new Date(b.time));
        groupConversations[groupId] = list;
        saveGroupToStorage(groupId, list);
      }
    } catch {}
    renderMessagesForGroup(groupId, messageSearchQuery);
  }

  function renderMessagesFor(user, searchQuery) {
    if (!messagesContainer) return;
    if (!conversations[user]) {
      conversations[user] = loadConvFromStorage(user);
    }
    messagesContainer.innerHTML = "";
    const convId = [currentUsername, user].sort().join("_");
    const deletedForMe = loadDeletedForMePm(convId);
    let history = (conversations[user] || []).filter((m) => !m.id || !deletedForMe.has(m.id));
    const q = String(searchQuery || "").trim().toLowerCase();
    if (q) history = history.filter((m) => {
      const msg = String(m.message || "");
      if (msg.startsWith("data:image/")) return false;
      return msg.toLowerCase().includes(q);
    });
    history.forEach((msg) => {
      const isMe = msg.fromUsername === currentUsername;
      const el = createMessageElement({
        id: msg.id,
        username: msg.fromUsername,
        message: msg.deleted ? "(mesaj silindi)" : msg.message,
        time: msg.time,
        type: msg.deleted ? "user" : (msg.message && String(msg.message).startsWith("data:image/") ? "image" : "user"),
        isMe,
        replyTo: msg.replyTo,
        editedAt: msg.editedAt,
        pinned: msg.pinned,
        reactions: msg.reactions,
      });
      addReplyHandler(el, msg);
      addMessageActions(el, msg);
      messagesContainer.appendChild(el);
    });
    scrollToBottom();
  }

  function loadDeletedForMePm(convId) {
    try {
      const raw = localStorage.getItem("rc_deleted_me_pm_" + convId);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }
  function saveDeletedForMePm(convId, set) {
    try {
      localStorage.setItem("rc_deleted_me_pm_" + convId, JSON.stringify([...set]));
    } catch {}
  }
  function loadDeletedForMeGroup(groupId) {
    try {
      const raw = localStorage.getItem("rc_deleted_me_grp_" + groupId);
      return raw ? new Set(JSON.parse(raw)) : new Set();
    } catch { return new Set(); }
  }
  function saveDeletedForMeGroup(groupId, set) {
    try {
      localStorage.setItem("rc_deleted_me_grp_" + groupId, JSON.stringify([...set]));
    } catch {}
  }

  function addMessageActions(rowEl, msg) {
    if (!msg || msg.type === "system" || msg.deleted) return;
    const id = msg.id;
    if (!id) return;
    const isMe = msg.fromUsername === currentUsername;
    const bubble = rowEl.querySelector(".message-bubble");
    if (bubble && msg.message && !String(msg.message).startsWith("data:image/")) {
      bubble.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        navigator.clipboard.writeText(msg.message).then(() => showToast("Mesaj kopyalandı")).catch(() => {});
      });
      bubble.title = "Sağ tık: Kopyala";
    }
    const actions = document.createElement("div");
    actions.className = "message-actions";
    const reactBtn = document.createElement("button");
    reactBtn.type = "button";
    reactBtn.className = "msg-action-btn";
    reactBtn.textContent = "👍";
    reactBtn.title = "Reaksiyon";
    reactBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (socket) socket.emit("message:react", { id, emoji: "👍" });
    });
    actions.appendChild(reactBtn);
    const react2 = reactBtn.cloneNode(true);
    react2.textContent = "❤️";
    react2.onclick = () => socket?.emit("message:react", { id, emoji: "❤️" });
    actions.appendChild(react2);
    if (isMe) {
      const delWrap = document.createElement("div");
      delWrap.className = "msg-action-dropdown-wrap";
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "msg-action-btn danger";
      delBtn.textContent = "Sil ▼";
      delBtn.title = "Silme seçenekleri";
      const dropdown = document.createElement("div");
      dropdown.className = "msg-action-dropdown";
      dropdown.innerHTML = '<button type="button" class="msg-dropdown-item" data-action="forme">Benim için sil</button><button type="button" class="msg-dropdown-item danger" data-action="everyone">Herkes için sil</button>';
      dropdown.addEventListener("click", (e) => e.stopPropagation());
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.toggle("open");
      });
      dropdown.querySelector('[data-action="forme"]').addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.remove("open");
        const convId = activeChatUser ? [currentUsername, activeChatUser].sort().join("_") : null;
        const gid = activeGroupId;
        if (convId) {
          const set = loadDeletedForMePm(convId);
          set.add(id);
          saveDeletedForMePm(convId, set);
          if (activeChatUser) renderMessagesFor(activeChatUser, messageSearchQuery);
        } else if (gid) {
          const set = loadDeletedForMeGroup(gid);
          set.add(id);
          saveDeletedForMeGroup(gid, set);
          renderMessagesForGroup(gid, messageSearchQuery);
        }
      });
      dropdown.querySelector('[data-action="everyone"]').addEventListener("click", (e) => {
        e.stopPropagation();
        dropdown.classList.remove("open");
        if (socket) socket.emit("message:delete", { id });
      });
      delWrap.appendChild(delBtn);
      delWrap.appendChild(dropdown);
      actions.appendChild(delWrap);
      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "msg-action-btn";
      editBtn.textContent = "Düzenle";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const newMsg = prompt("Yeni mesaj:", msg.message);
        if (newMsg != null && newMsg.trim() && socket) socket.emit("message:edit", { id, newMessage: newMsg.trim() });
      });
      actions.appendChild(editBtn);
    }
    const fwdBtn = document.createElement("button");
    fwdBtn.type = "button";
    fwdBtn.className = "msg-action-btn";
    fwdBtn.textContent = "İlet";
    fwdBtn.title = "Mesajı ilet";
    fwdBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openForwardModal(msg);
    });
    actions.appendChild(fwdBtn);
    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = "msg-action-btn";
    pinBtn.textContent = msg.pinned ? "📌 Kaldır" : "📌 Sabitle";
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (socket) socket.emit("message:pin", { id, pinned: !msg.pinned });
    });
    actions.appendChild(pinBtn);
    rowEl.appendChild(actions);
  }

  function openForwardModal(msg) {
    const text = msg.message;
    const isImg = text && String(text).startsWith("data:image/");
    if (isImg) return showToast("Görsel iletme desteklenmiyor");
    const modal = document.createElement("div");
    modal.className = "modal modal-animate";
    modal.innerHTML = `
      <div class="modal-card" style="max-width: 360px;">
        <div class="modal-title">Mesajı ilet</div>
        <p class="subtitle">İletilecek mesaj: ${String(text || "").slice(0, 80)}${(text || "").length > 80 ? "…" : ""}</p>
        <div class="forward-target-list" id="forward-target-list"></div>
        <div class="modal-actions">
          <button type="button" class="call-btn" data-action="cancel">İptal</button>
        </div>
      </div>
    `;
    modal.classList.remove("hidden");
    document.body.appendChild(modal);
    const list = modal.querySelector("#forward-target-list");
    const friends = relationships.friends || [];
    const myGroups = groups || [];
    const fwdText = (msg.fromUsername ? `[İletildi: ${msg.fromUsername}] ` : "") + (text || "");
    friends.forEach((u) => {
      if (u === currentUsername) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "forward-target-btn";
      btn.textContent = u;
      btn.addEventListener("click", () => {
        if (socket) socket.emit("privateMessage", { toUsername: u, message: fwdText });
        modal.remove();
        showToast("Mesaj iletildi");
      });
      list.appendChild(btn);
    });
    myGroups.forEach((g) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "forward-target-btn";
      btn.textContent = "📁 " + (g.name || g.id);
      btn.addEventListener("click", () => {
        if (socket) socket.emit("groupMessage", { groupId: g.id, message: fwdText });
        modal.remove();
        showToast("Mesaj iletildi");
      });
      list.appendChild(btn);
    });
    if (!list.children.length) {
      const p = document.createElement("p");
      p.className = "subtitle";
      p.textContent = "İletilecek sohbet yok. Arkadaş ekle veya gruba katıl.";
      list.appendChild(p);
    }
    modal.querySelector('[data-action="cancel"]').addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });
  }

  function addReplyHandler(rowEl, msg) {
    if (!msg || msg.type === "system") return;
    const bubble = rowEl.querySelector(".message-bubble");
    if (bubble) {
      bubble.style.cursor = "pointer";
      bubble.addEventListener("click", (e) => {
        if (e.target.closest(".message-actions") || e.target.closest(".reaction-btn")) return;
        replyingTo = { username: msg.fromUsername, message: msg.message };
        updateReplyPreview();
      });
    }
  }

  function updateReplyPreview() {
    const existing = document.getElementById("reply-preview");
    if (existing) existing.remove();
    if (!replyingTo || !messageForm) return;
    const wrap = document.createElement("div");
    wrap.id = "reply-preview";
    wrap.className = "reply-preview";
    wrap.innerHTML = `<span>Yanıt: ${replyingTo.username}: ${String(replyingTo.message || "").slice(0, 40)}…</span> <button type="button" class="reply-cancel-btn">✕</button>`;
    wrap.querySelector(".reply-cancel-btn").addEventListener("click", () => {
      replyingTo = null;
      updateReplyPreview();
    });
    messageForm.parentNode.insertBefore(wrap, messageForm);
  }

  function renderMessagesForGroup(groupId, searchQuery) {
    if (!messagesContainer) return;
    if (!groupConversations[groupId]) {
      groupConversations[groupId] = loadGroupFromStorage(groupId);
    }
    messagesContainer.innerHTML = "";
    const deletedForMe = loadDeletedForMeGroup(groupId);
    let history = (groupConversations[groupId] || []).filter((m) => !m.id || !deletedForMe.has(m.id));
    const q = String(searchQuery || "").trim().toLowerCase();
    if (q) history = history.filter((m) => {
      const msg = String(m.message || "");
      if (msg.startsWith("data:image/")) return false;
      return msg.toLowerCase().includes(q);
    });
    history.forEach((msg) => {
      const isMe = msg.fromUsername === currentUsername;
      const el = createMessageElement({
        id: msg.id,
        username: msg.fromUsername,
        message: msg.deleted ? "(mesaj silindi)" : msg.message,
        time: msg.time,
        type: msg.deleted ? "user" : (msg.message && String(msg.message).startsWith("data:image/") ? "image" : "user"),
        isMe,
        replyTo: msg.replyTo,
        editedAt: msg.editedAt,
        pinned: msg.pinned,
        reactions: msg.reactions,
      });
      addReplyHandler(el, msg);
      addMessageActions(el, msg);
      messagesContainer.appendChild(el);
    });
    scrollToBottom();
  }

  function isFriend(username) {
    return relationships.friends.includes(username);
  }

  function isBlocked(username) {
    return relationships.blocked.includes(username);
  }

  function renderUserList() {
    if (!userListEl) return;
    userListEl.innerHTML = "";

    const onlineSet = new Set(onlineUsers.filter((u) => u !== currentUsername));
    const friendsSet = new Set(relationships.friends || []);
    const others = [...onlineSet];
    friendsSet.forEach((u) => {
      if (u !== currentUsername && !onlineSet.has(u)) others.push(u);
    });

    if (!others.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent =
        "Şu anda başka kimse çevrimiçi değil. Başka bir cihazdan aynı kullanıcıyla giriş yapıp test edebilirsin.";
      userListEl.appendChild(empty);
      return;
    }

    others.forEach((username) => {
      const status = (() => {
        if (relationships.blocked.includes(username)) return "blocked";
        if (relationships.friends.includes(username)) return "friend";
        if (relationships.incomingRequests.includes(username)) return "incoming";
        if (relationships.outgoingRequests.includes(username)) return "outgoing";
        return "none";
      })();

      const item = document.createElement("div");
      item.className = "user-item";
      if (activeChatUser === username && status === "friend") {
        item.classList.add("active");
      }

      const main = document.createElement("div");
      main.className = "user-main";

      const avatar = document.createElement("span");
      avatar.className = "user-avatar";
      avatar.textContent = (username[0] || "?").toUpperCase();
      avatar.title = username;

      const dot = document.createElement("span");
      dot.className = "user-dot" + (onlineUsers.includes(username) ? "" : " offline");

      const nameWrap = document.createElement("div");
      nameWrap.style.display = "flex";
      nameWrap.style.flexDirection = "column";
      nameWrap.style.gap = "2px";
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = username;
      nameWrap.appendChild(name);

      const isOnline = onlineUsers.includes(username);
      if (!isOnline && status === "friend" && lastSeenCache[username]) {
        const lastSeen = document.createElement("span");
        lastSeen.className = "last-seen";
        const d = new Date(lastSeenCache[username]);
        const now = new Date();
        const diff = (now - d) / 1000;
        if (diff < 60) lastSeen.textContent = "Az önce";
        else if (diff < 3600) lastSeen.textContent = Math.floor(diff / 60) + " dk önce";
        else if (diff < 86400) lastSeen.textContent = Math.floor(diff / 3600) + " sa önce";
        else lastSeen.textContent = d.toLocaleDateString("tr-TR");
        nameWrap.appendChild(lastSeen);
      }

      main.appendChild(avatar);
      main.appendChild(dot);
      main.appendChild(nameWrap);

      const rightSide = document.createElement("div");
      rightSide.style.display = "flex";
      rightSide.style.alignItems = "center";
      rightSide.style.gap = "4px";

      const unread = unreadCounts[username] || 0;
      if (unread > 0 && status === "friend") {
        const badge = document.createElement("span");
        badge.className = "unread-badge";
        badge.textContent = unread > 99 ? "99+" : `+${unread}`;
        rightSide.appendChild(badge);
      }

      const tag = document.createElement("span");
      tag.className = "user-tag";
      if (status === "friend") {
        tag.textContent = "Arkadaş";
      } else if (status === "incoming") {
        tag.textContent = "İstek gönderdi";
      } else if (status === "outgoing") {
        tag.textContent = "İstek bekliyor";
      } else if (status === "blocked") {
        tag.textContent = "Engellendi";
      } else {
        tag.textContent = "Çevrimiçi";
      }

      rightSide.appendChild(tag);

      // Aksiyon butonları
      if (status === "incoming") {
        const acceptBtn = document.createElement("button");
        acceptBtn.type = "button";
        acceptBtn.className = "user-tag";
        acceptBtn.textContent = "Kabul Et";
        acceptBtn.style.borderColor = "rgba(34,197,94,0.9)";
        acceptBtn.style.color = "#bbf7d0";
        acceptBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          respondFriend(username, true);
        });

        const rejectBtn = document.createElement("button");
        rejectBtn.type = "button";
        rejectBtn.className = "user-tag";
        rejectBtn.textContent = "Reddet";
        rejectBtn.style.borderColor = "rgba(239,68,68,0.9)";
        rejectBtn.style.color = "#fecaca";
        rejectBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          respondFriend(username, false);
        });

        rightSide.appendChild(acceptBtn);
        rightSide.appendChild(rejectBtn);
      } else if (status === "friend") {
        const blockBtn = document.createElement("button");
        blockBtn.type = "button";
        blockBtn.className = "user-tag";
        blockBtn.textContent = "Engelle";
        blockBtn.style.borderColor = "rgba(239,68,68,0.9)";
        blockBtn.style.color = "#fecaca";
        blockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          setBlock(username, true);
        });
        rightSide.appendChild(blockBtn);
      } else if (status === "blocked") {
        const unblockBtn = document.createElement("button");
        unblockBtn.type = "button";
        unblockBtn.className = "user-tag";
        unblockBtn.textContent = "Engeli kaldır";
        unblockBtn.style.borderColor = "rgba(59,130,246,0.9)";
        unblockBtn.style.color = "#bfdbfe";
        unblockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          setBlock(username, false);
        });
        rightSide.appendChild(unblockBtn);
      } else if (status === "none") {
        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "user-tag";
        addBtn.textContent = "Arkadaş ekle";
        addBtn.style.borderColor = "rgba(129,140,248,0.9)";
        addBtn.style.color = "#c7d2fe";
        addBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          sendFriendRequest(username);
        });

        const blockBtn = document.createElement("button");
        blockBtn.type = "button";
        blockBtn.className = "user-tag";
        blockBtn.textContent = "Engelle";
        blockBtn.style.borderColor = "rgba(239,68,68,0.9)";
        blockBtn.style.color = "#fecaca";
        blockBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          setBlock(username, true);
        });

        rightSide.appendChild(addBtn);
        rightSide.appendChild(blockBtn);
      }

      item.appendChild(main);
      item.appendChild(rightSide);

      item.addEventListener("click", () => {
        if (!isFriend(username)) {
          return;
        }

        activeGroupId = null;
        activeChatUser = username;
        unreadCounts[username] = 0;
        if (leaveGroupBtn) leaveGroupBtn.classList.add("hidden");

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

        // Arama butonları sadece arkadaş seçilince aktif
        if (callAudioBtn) callAudioBtn.disabled = false;
        if (callVideoBtn) callVideoBtn.disabled = false;

        if (messageSearchEl) {
          messageSearchEl.classList.remove("hidden");
          messageSearchEl.value = messageSearchQuery = "";
        }
        if (viewingIndicatorEl) viewingIndicatorEl.classList.add("hidden");
        if (socket) socket.emit("viewingChat", { toUsername: username });
        fetchAndRenderMessagesForUser(username);
        renderUserList();
        renderGroupList();
      });

      userListEl.appendChild(item);
    });
  }

  function renderGroupList() {
    if (!groupListEl) return;
    groupListEl.innerHTML = "";
    if (!groups.length) {
      const empty = document.createElement("div");
      empty.className = "hint";
      empty.textContent = "Henüz grubun yok. \"Yeni Grup\" ile sadece arkadaşlarınla grup oluşturabilirsin.";
      groupListEl.appendChild(empty);
      return;
    }
    groups.forEach((g) => {
      const item = document.createElement("div");
      item.className = "user-item group-item";
      if (activeGroupId === g.id) item.classList.add("active");
      const main = document.createElement("div");
      main.className = "user-main";
      const dot = document.createElement("span");
      dot.className = "user-dot";
      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = g.name;
      main.appendChild(dot);
      main.appendChild(name);
      const sub = document.createElement("div");
      sub.className = "group-members-preview";
      sub.textContent = (g.members || []).slice(0, 3).join(", ") + ((g.members || []).length > 3 ? "…" : "");
      item.appendChild(main);
      item.appendChild(sub);
      item.addEventListener("click", () => {
        activeGroupId = g.id;
        activeChatUser = null;
        if (chatTitleEl && chatSubtitleEl) {
          chatTitleEl.textContent = g.name;
          chatSubtitleEl.textContent = "Grup sohbeti • " + (g.members || []).join(", ");
        }
        if (messageInput) messageInput.placeholder = g.name + " grubuna mesaj yaz...";
        if (leaveGroupBtn) leaveGroupBtn.classList.remove("hidden");
        callAudioBtn.disabled = true;
        callVideoBtn.disabled = true;
        if (messageSearchEl) {
          messageSearchEl.classList.remove("hidden");
          messageSearchEl.value = messageSearchQuery = "";
        }
        if (viewingIndicatorEl) viewingIndicatorEl.classList.add("hidden");
        if (socket) socket.emit("viewingChat", { groupId: g.id });
        fetchAndRenderMessagesForGroup(g.id);
        renderUserList();
        renderGroupList();
      });
      groupListEl.appendChild(item);
    });
  }

  function switchPanel(panel) {
    panelTabs.forEach((t) => {
      t.classList.toggle("active", t.getAttribute("data-panel") === panel);
    });
    if (userListEl) userListEl.classList.toggle("hidden", panel !== "chats");
    if (groupListEl) groupListEl.classList.toggle("hidden", panel !== "groups");
    if (createGroupBtn) createGroupBtn.classList.toggle("hidden", panel !== "groups");
  }

  panelTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      switchPanel(tab.getAttribute("data-panel"));
    });
  });

  async function leaveGroup() {
    if (!activeGroupId || !currentUsername) return;
    try {
      const res = await fetch("/api/groups/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, groupId: activeGroupId }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) return;
      if (socket) socket.emit("leaveGroup", activeGroupId);
      groups = groups.filter((g) => g.id !== activeGroupId);
      delete groupConversations[activeGroupId];
      activeGroupId = null;
      if (messageSearchEl) messageSearchEl.classList.add("hidden");
      if (leaveGroupBtn) leaveGroupBtn.classList.add("hidden");
      if (chatTitleEl && chatSubtitleEl) {
        chatTitleEl.textContent = "Bir kullanıcı seç";
        chatSubtitleEl.textContent =
          "Soldan bir kullanıcı veya grup seç, mesajlaşmaya başla.";
      }
      if (messageInput) messageInput.placeholder = "Önce soldan bir seçim yap...";
      if (messagesContainer) messagesContainer.innerHTML = "";
      renderGroupList();
    } catch {}
  }

  leaveGroupBtn?.addEventListener("click", leaveGroup);

  function maybeShowNotification(fromUsername, message, playSound) {
    if (!fromUsername || !message) return;
    const shouldNotify = !windowFocused && notificationsEnabled;
    if (playSound !== false) playNotificationSound();
    if (shouldNotify) {
      try {
        new Notification("Rainbow Chat", { body: `${fromUsername}: ${message}` });
      } catch {}
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

  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 800;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.15);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.15);
    } catch {}
  }

  function showToast(message, type) {
    if (!toastContainer) return;
    const toast = document.createElement("div");
    toast.className = "toast" + (type === "new-friend" ? " new-friend" : "");
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  function setCallPanelVisible(visible) {
    if (!callPanelEl) return;
    if (visible) callPanelEl.classList.remove("hidden");
    else callPanelEl.classList.add("hidden");
  }

  function setIncomingModalVisible(visible) {
    if (!incomingModalEl) return;
    if (visible) {
      incomingModalEl.classList.remove("hidden");
      playRingtone();
    } else {
      incomingModalEl.classList.add("hidden");
      stopRingtone();
    }
  }

  function playRingtone() {
    stopRingtone();
    ringtoneInterval = setInterval(() => {
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 800;
        osc.type = "sine";
        gain.gain.setValueAtTime(0.2, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      } catch {}
    }, 1200);
  }

  function stopRingtone() {
    if (ringtoneInterval) {
      clearInterval(ringtoneInterval);
      ringtoneInterval = null;
    }
  }

  function startCallDurationTimer() {
    stopCallDurationTimer();
    callStartTime = Date.now();
    if (callDurationEl) {
      callDurationEl.classList.remove("hidden");
      callDurationInterval = setInterval(() => {
        const s = Math.floor((Date.now() - callStartTime) / 1000);
        const m = Math.floor(s / 60);
        callDurationEl.textContent = String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
      }, 1000);
    }
  }

  function stopCallDurationTimer() {
    if (callDurationInterval) {
      clearInterval(callDurationInterval);
      callDurationInterval = null;
    }
    if (callDurationEl) callDurationEl.classList.add("hidden");
  }

  function startMicLevelMeter() {
    if (!localStream || !micLevelBar) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) return;
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const source = ctx.createMediaStreamSource(localStream);
      analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);
      const data = new Uint8Array(analyserNode.frequencyBinCount);

      function update() {
        if (!analyserNode || !micLevelBar) return;
        analyserNode.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const pct = Math.min(100, Math.round((avg / 128) * 100));
        micLevelBar.style.height = (10 + pct * 0.9) + "%";
        micLevelAnimationId = requestAnimationFrame(update);
      }
      update();
    } catch {}
  }

  function stopMicLevelMeter() {
    if (micLevelAnimationId) {
      cancelAnimationFrame(micLevelAnimationId);
      micLevelAnimationId = null;
    }
    analyserNode = null;
    if (micLevelBar) micLevelBar.style.height = "10%";
  }

  function setCallStatus(title, subtitle) {
    if (callStatusTitleEl) callStatusTitleEl.textContent = title || "Arama";
    if (callStatusSubtitleEl)
      callStatusSubtitleEl.textContent = subtitle || "";
  }

  function setCallButtonsInCall(inCall) {
    if (callHangupBtn) {
      if (inCall) callHangupBtn.classList.remove("hidden");
      else callHangupBtn.classList.add("hidden");
    }
    if (callAudioBtn) callAudioBtn.disabled = inCall || !activeChatUser;
    if (callVideoBtn) callVideoBtn.disabled = inCall || !activeChatUser;
  }

  async function ensurePeerConnection() {
    if (pc) return pc;
    await loadRtcConfig();
    const config = { ...rtcConfig, iceCandidatePoolSize: 10, bundlePolicy: "max-bundle" };
    pc = new RTCPeerConnection(config);

    remoteStream = new MediaStream();
    if (remoteVideoEl) {
      remoteVideoEl.srcObject = remoteStream;
    }

    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach((track) => {
        remoteStream.addTrack(track);
      });
    };

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socket || !currentCallId) return;
      socket.emit("call:ice", { callId: currentCallId, candidate: event.candidate });
    };

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setCallStatus("Arama bağlandı", callPeerUsername ? `${callPeerUsername} ile` : "");
        startCallDurationTimer();
      } else if (pc.connectionState === "disconnected") {
        setCallStatus("Bağlantı koptu", "Tekrar deniyor…");
      } else if (pc.connectionState === "failed") {
        setCallStatus("Bağlantı kurulamadı", "Farklı ağda (örn. mobil veri) deneyin.");
      } else if (pc.connectionState === "connecting") {
        setCallStatus("Bağlanıyor", "ICE tamamlanıyor…");
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (!pc) return;
      if (pc.iceConnectionState === "failed" && pc.connectionState !== "connected") {
        setCallStatus("Bağlantı kurulamadı", "Ağ engeli olabilir; mobil veri deneyin.");
      }
    };

    return pc;
  }

  async function startLocalMedia(kind) {
    const constraints =
      kind === "video"
        ? { audio: true, video: { width: 1280, height: 720 } }
        : { audio: true, video: false };

    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (localVideoEl) {
      localVideoEl.srcObject = localStream;
    }

    if (toggleMicBtn) toggleMicBtn.classList.add("active");
    if (toggleCamBtn) {
      if (kind === "video") toggleCamBtn.classList.add("active");
      else toggleCamBtn.classList.remove("active");
    }
    if (screenShareBtn) {
      if (kind === "video") screenShareBtn.classList.remove("hidden");
      else screenShareBtn.classList.add("hidden");
    }
    if (toggleCamBtn) {
      if (kind === "audio") toggleCamBtn.classList.add("hidden");
      else toggleCamBtn.classList.remove("hidden");
    }
    startMicLevelMeter();
  }

  async function startScreenShare() {
    if (!pc || !localStream) return;
    try {
      screenShareStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const videoTrack = screenShareStream.getVideoTracks()[0];
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) sender.replaceTrack(videoTrack);
      if (localVideoEl) localVideoEl.srcObject = screenShareStream;
      screenShareBtn.classList.add("sharing");
      videoTrack.onended = () => stopScreenShare();
    } catch (err) {
      setCallStatus("Ekran paylaşımı", "İzin verilmedi veya hata oluştu.");
    }
  }

  function stopScreenShare() {
    if (screenShareStream) {
      screenShareStream.getTracks().forEach((t) => t.stop());
      screenShareStream = null;
    }
    if (localStream && localVideoEl) localVideoEl.srcObject = localStream;
    if (pc && localStream) {
      const videoTrack = localStream.getVideoTracks()[0];
      if (videoTrack) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(videoTrack);
      }
    }
    if (screenShareBtn) screenShareBtn.classList.remove("sharing");
  }

  function stopLocalMedia() {
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
    }
    localStream = null;
    if (localVideoEl) localVideoEl.srcObject = null;
  }

  function resetCallState() {
    currentCallId = null;
    callKind = null;
    callPeerUsername = null;
    incomingOffer = null;
  }

  function cleanupCall() {
    if (pc) {
      try {
        pc.ontrack = null;
        pc.onicecandidate = null;
        pc.onconnectionstatechange = null;
        pc.close();
      } catch {
        // ignore
      }
    }
    pc = null;

    stopLocalMedia();

    remoteStream = null;
    if (remoteVideoEl) remoteVideoEl.srcObject = null;

    setCallPanelVisible(false);
    setCallButtonsInCall(false);
    setCallStatus("Arama", "");
    stopCallDurationTimer();
    stopMicLevelMeter();
    stopScreenShare();
    resetCallState();
  }

  function newCallId() {
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  async function placeCall(kind) {
    if (!socket) return;
    if (!activeChatUser) return;
    if (!isFriend(activeChatUser)) return;
    if (pc) return;

    callPeerUsername = activeChatUser;
    callKind = kind;
    currentCallId = newCallId();

    setCallButtonsInCall(true);
    setCallPanelVisible(true);
    setCallStatus(kind === "video" ? "Görüntülü arama" : "Sesli arama", "Kamera/mikrofon izni bekleniyor...");

    try {
      await startLocalMedia(kind);
      setCallStatus(
        kind === "video" ? "Görüntülü arama" : "Sesli arama",
        `${callPeerUsername} aranıyor...`
      );

      const peer = await ensurePeerConnection();
      localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      socket.emit("call:offer", {
        callId: currentCallId,
        toUsername: callPeerUsername,
        kind,
        sdp: offer,
      });
    } catch (err) {
      setCallStatus("Arama başlatılamadı", "Kamera/mikrofon izni gerekli olabilir.");
      cleanupCall();
    }
  }

  async function acceptIncomingCall() {
    if (!socket || !incomingOffer) return;
    if (pc) return;
    stopRingtone();

    const { callId, fromUsername, kind, sdp } = incomingOffer;
    currentCallId = callId;
    callPeerUsername = fromUsername;
    callKind = kind;

    setIncomingModalVisible(false);
    setCallButtonsInCall(true);
    setCallPanelVisible(true);
    setCallStatus(kind === "video" ? "Görüntülü arama" : "Sesli arama", "Kamera/mikrofon izni bekleniyor...");

    try {
      await startLocalMedia(kind);
      setCallStatus(
        kind === "video" ? "Görüntülü arama" : "Sesli arama",
        `${fromUsername} ile bağlanılıyor...`
      );

      const peer = await ensurePeerConnection();
      localStream.getTracks().forEach((track) => peer.addTrack(track, localStream));

      await peer.setRemoteDescription(sdp);
      const answer = await peer.createAnswer();
      await peer.setLocalDescription(answer);

      socket.emit("call:answer", { callId, sdp: answer });
    } catch (err) {
      socket.emit("call:reject", { callId });
      cleanupCall();
    }
  }

  function rejectIncomingCall() {
    if (!socket || !incomingOffer) return;
    socket.emit("call:reject", { callId: incomingOffer.callId });
    setIncomingModalVisible(false);
    stopRingtone();
    incomingOffer = null;
  }

  function hangupCall() {
    if (socket && currentCallId) {
      socket.emit("call:hangup", { callId: currentCallId });
    }
    cleanupCall();
  }

  toggleMicBtn?.addEventListener("click", () => {
    if (!localStream) return;
    const audioTracks = localStream.getAudioTracks();
    if (!audioTracks.length) return;
    const enabled = !audioTracks[0].enabled;
    audioTracks.forEach((t) => (t.enabled = enabled));
    if (enabled) toggleMicBtn.classList.add("active");
    else toggleMicBtn.classList.remove("active");
  });

  toggleCamBtn?.addEventListener("click", () => {
    if (!localStream) return;
    const videoTracks = localStream.getVideoTracks();
    if (!videoTracks.length) return;
    const enabled = !videoTracks[0].enabled;
    videoTracks.forEach((t) => (t.enabled = enabled));
    if (enabled) toggleCamBtn.classList.add("active");
    else toggleCamBtn.classList.remove("active");
  });

  callAudioBtn?.addEventListener("click", () => placeCall("audio"));
  callVideoBtn?.addEventListener("click", () => placeCall("video"));
  callHangupBtn?.addEventListener("click", () => hangupCall());
  screenShareBtn?.addEventListener("click", () => {
    if (screenShareBtn.classList.contains("sharing")) stopScreenShare();
    else startScreenShare();
  });
  incomingAcceptBtn?.addEventListener("click", () => acceptIncomingCall());
  incomingRejectBtn?.addEventListener("click", () => rejectIncomingCall());

  contactOpenBtn?.addEventListener("click", () => {
    contactModalEl?.classList.remove("hidden");
  });

  contactCloseBtn?.addEventListener("click", () => {
    contactModalEl?.classList.add("hidden");
  });

  contactModalEl?.addEventListener("click", (event) => {
    if (event.target === contactModalEl) {
      contactModalEl.classList.add("hidden");
    }
  });

  const addFriendUsernameInput = document.getElementById("add-friend-username");
  const addFriendBtn = document.getElementById("add-friend-btn");
  const addFriendHintEl = document.getElementById("add-friend-hint");
  const userSearchResultsEl = document.getElementById("user-search-results");
  let searchUsersTimer = null;

  async function searchAndShowUsers() {
    const q = (addFriendUsernameInput && addFriendUsernameInput.value || "").trim();
    if (q.length < 2 || !userSearchResultsEl) {
      userSearchResultsEl.classList.add("hidden");
      return;
    }
    try {
      const res = await fetch("/api/users/search?q=" + encodeURIComponent(q) + "&exclude=" + encodeURIComponent(currentUsername));
      const data = await res.json();
      const list = Array.isArray(data.users) ? data.users : [];
      userSearchResultsEl.innerHTML = "";
      if (!list.length) {
        userSearchResultsEl.classList.add("hidden");
        return;
      }
      list.forEach((username) => {
        const status = relationships.friends.includes(username)
          ? "Arkadaş"
          : relationships.outgoingRequests.includes(username)
            ? "İstek bekliyor"
            : relationships.incomingRequests.includes(username)
              ? "İstek var"
              : relationships.blocked.includes(username)
                ? "Engelli"
                : null;
        const row = document.createElement("div");
        row.className = "search-result-row";
        const name = document.createElement("span");
        name.className = "search-result-name";
        name.textContent = username;
        row.appendChild(name);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "search-result-btn";
        if (status === "Arkadaş" || status === "İstek bekliyor" || status === "Engelli") {
          btn.textContent = status;
          btn.disabled = true;
        } else {
          btn.textContent = status === "İstek var" ? "Kabul/Reddet" : "Arkadaş ekle";
          btn.onclick = () => {
            if (status === "İstek var") return;
            sendFriendRequest(username);
            addFriendUsernameInput.value = "";
            userSearchResultsEl.classList.add("hidden");
          };
        }
        row.appendChild(btn);
        userSearchResultsEl.appendChild(row);
      });
      userSearchResultsEl.classList.remove("hidden");
    } catch {
      userSearchResultsEl.classList.add("hidden");
    }
  }

  addFriendUsernameInput?.addEventListener("input", () => {
    clearTimeout(searchUsersTimer);
    searchUsersTimer = setTimeout(searchAndShowUsers, 300);
  });
  addFriendUsernameInput?.addEventListener("blur", () => {
    setTimeout(() => userSearchResultsEl?.classList.add("hidden"), 150);
  });

  async function sendFriendRequest(targetUsername) {
    const hint = addFriendHintEl;
    if (hint) hint.textContent = "";
    try {
      const res = await fetch("/api/friend-request", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ username: currentUsername, target: targetUsername }),
      });
      const data = await res.json();
      if (hint) {
        if (res.ok && data.ok) {
          hint.textContent = "Arkadaşlık isteği gönderildi.";
          hint.style.color = "#86efac";
        } else {
          hint.textContent = data.error || "İstek gönderilemedi.";
          hint.style.color = "#fca5a5";
        }
      }
    } catch {
      if (hint) {
        hint.textContent = "Sunucuya bağlanılamadı.";
        hint.style.color = "#fca5a5";
      }
    }
  }

  function addFriendByUsername() {
    const input = addFriendUsernameInput;
    if (!input) return;
    const target = String(input.value || "").trim();
    if (target.length < 3) {
      if (addFriendHintEl) {
        addFriendHintEl.textContent = "Kullanıcı adı en az 3 karakter olmalı.";
        addFriendHintEl.style.color = "#fca5a5";
      }
      return;
    }
    if (target === currentUsername) {
      if (addFriendHintEl) {
        addFriendHintEl.textContent = "Kendine istek gönderemezsin.";
        addFriendHintEl.style.color = "#fca5a5";
      }
      return;
    }
    sendFriendRequest(target);
    input.value = "";
  }

  addFriendBtn?.addEventListener("click", addFriendByUsername);
  addFriendUsernameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFriendByUsername();
  });

  async function fetchGroups() {
    try {
      const res = await fetch("/api/groups?username=" + encodeURIComponent(currentUsername));
      const data = await res.json();
      if (res.ok && Array.isArray(data.groups)) {
        groups = data.groups;
        if (socket) socket.emit("joinGroups", groups.map((g) => g.id));
        renderGroupList();
      }
    } catch {}
  }

  function openCreateGroupModal() {
    if (!createGroupModal || !groupMembersCheckboxes) return;
    groupNameInput.value = "";
    groupMembersCheckboxes.innerHTML = "";
    (relationships.friends || []).forEach((friendUsername) => {
      const label = document.createElement("label");
      label.className = "checkbox-label";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = friendUsername;
      input.name = "groupMember";
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + friendUsername));
      groupMembersCheckboxes.appendChild(label);
    });
    if (!relationships.friends || !relationships.friends.length) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = "Önce arkadaş ekle; sadece arkadaşlarını gruba davet edebilirsin.";
      groupMembersCheckboxes.appendChild(p);
    }
    createGroupModal.classList.remove("hidden");
  }

  function closeCreateGroupModal() {
    if (createGroupModal) createGroupModal.classList.add("hidden");
  }

  createGroupBtn?.addEventListener("click", openCreateGroupModal);
  createGroupCancelBtn?.addEventListener("click", closeCreateGroupModal);
  createGroupModal?.addEventListener("click", (e) => {
    if (e.target === createGroupModal) closeCreateGroupModal();
  });

  createGroupForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = (groupNameInput && groupNameInput.value || "").trim();
    if (name.length < 2 || name.length > 50) return;
    const checked = groupMembersCheckboxes
      ? Array.from(groupMembersCheckboxes.querySelectorAll('input[name="groupMember"]:checked')).map((i) => i.value)
      : [];
    try {
      const res = await fetch("/api/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: currentUsername, name, members: checked }),
      });
      const data = await res.json();
      if (res.ok && data.ok && data.group) {
        groups.unshift(data.group);
        if (socket) socket.emit("joinGroups", groups.map((g) => g.id));
        renderGroupList();
        closeCreateGroupModal();
        groupNameInput.value = "";
      } else {
        if (addFriendHintEl) {
          addFriendHintEl.textContent = data.error || "Grup oluşturulamadı.";
          addFriendHintEl.style.color = "#fca5a5";
        }
      }
    } catch {
      if (addFriendHintEl) {
        addFriendHintEl.textContent = "Sunucuya bağlanılamadı.";
        addFriendHintEl.style.color = "#fca5a5";
      }
    }
  });

  async function respondFriend(fromUser, accept) {
    try {
      await fetch("/api/friend-respond", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: currentUsername,
          fromUser,
          accept,
        }),
      });
    } catch {
      // Sessizce geç
    }
  }

  async function setBlock(targetUsername, block) {
    try {
      await fetch("/api/block", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          username: currentUsername,
          target: targetUsername,
          block,
        }),
      });
    } catch {
      // Sessizce geç
    }
  }
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

  function enterChat(username) {
    currentUsername = username;
    if (authErrorEl) authErrorEl.textContent = "";
    try {
      localStorage.setItem("rc_lastuser", currentUsername);
    } catch {}

    if (!socket) {
        socket = io({
          reconnection: true,
          reconnectionAttempts: Infinity,
          reconnectionDelay: 1000,
          reconnectionDelayMax: 5000,
          timeout: 10000,
        });

        const connectionStatusEl = document.getElementById("connection-status");
        function setConnectionStatus(text, isOk) {
          if (!connectionStatusEl) return;
          connectionStatusEl.textContent = text;
          connectionStatusEl.classList.toggle("connected", isOk === true);
          connectionStatusEl.classList.toggle("reconnecting", isOk === false);
        }

        socket.on("connect", () => {
          setConnectionStatus("Bağlandı", true);
          socket.emit("join", currentUsername);
        });

        socket.on("disconnect", (reason) => {
          setConnectionStatus("Yeniden bağlanıyor…", false);
        });

        socket.on("connect_error", () => {
          setConnectionStatus("Bağlantı hatası", false);
        });

        socket.on("systemMessage", (text) => {
          const el = createMessageElement({
            type: "system",
            message: text,
          });
          messagesContainer.appendChild(el);
          scrollToBottom();
        });

        socket.on("userList", async (list) => {
          onlineUsers = Array.isArray(list) ? list : [];
          try {
            const friendsToFetch = (relationships.friends || []).filter((u) => !onlineUsers.includes(u));
            if (friendsToFetch.length) {
              const res = await fetch("/api/last-seen?usernames=" + friendsToFetch.map(encodeURIComponent).join(","));
              const data = await res.json();
              if (res.ok && data) Object.assign(lastSeenCache, data);
            }
          } catch {}
          renderUserList();
        });

        socket.on("userTyping", ({ username, toUsername, groupId }) => {
          if (typingHideTimeout) clearTimeout(typingHideTimeout);
          const inThisChat =
            (toUsername && activeChatUser === toUsername && !activeGroupId) ||
            (groupId && activeGroupId === groupId);
          if (!inThisChat || username === currentUsername) return;
          if (typingIndicatorEl && typingUsernameEl) {
            typingUsernameEl.textContent = username;
            typingIndicatorEl.classList.remove("hidden");
          }
          typingHideTimeout = setTimeout(() => {
            if (typingIndicatorEl) typingIndicatorEl.classList.add("hidden");
            typingHideTimeout = null;
          }, 3000);
        });

        socket.on("userViewingChat", ({ username }) => {
          if (viewingChatTimeout) clearTimeout(viewingChatTimeout);
          viewingChatUser = username;
          if (viewingIndicatorEl && viewingUsernameEl) {
            viewingUsernameEl.textContent = username;
            viewingIndicatorEl.classList.remove("hidden");
          }
          viewingChatTimeout = setTimeout(() => {
            if (viewingIndicatorEl) viewingIndicatorEl.classList.add("hidden");
            viewingChatUser = null;
            viewingChatTimeout = null;
          }, 5000);
        });

        socket.on("message:updated", ({ id, newMessage, editedAt }) => {
          const update = (list) => {
            const m = list.find((x) => x.id === id);
            if (m) {
              m.message = newMessage;
              m.editedAt = editedAt;
            }
          };
          if (activeChatUser) {
            const list = conversations[activeChatUser];
            if (list) update(list);
            saveConvToStorage(activeChatUser, list);
          }
          if (activeGroupId) {
            const list = groupConversations[activeGroupId];
            if (list) update(list);
            saveGroupToStorage(activeGroupId, list);
          }
          const row = messagesContainer?.querySelector(`[data-message-id="${id}"]`);
          if (row) {
            const text = row.querySelector(".message-text");
            if (text) text.textContent = newMessage;
          }
        });

        socket.on("message:deleted", ({ id }) => {
          const update = (list) => {
            const m = list.find((x) => x.id === id);
            if (m) m.deleted = true;
          };
          if (activeChatUser) {
            const list = conversations[activeChatUser];
            if (list) update(list);
            saveConvToStorage(activeChatUser, list);
          }
          if (activeGroupId) {
            const list = groupConversations[activeGroupId];
            if (list) update(list);
            saveGroupToStorage(activeGroupId, list);
          }
          const row = messagesContainer?.querySelector(`[data-message-id="${id}"]`);
          if (row) {
            const text = row.querySelector(".message-text");
            if (text) text.textContent = "(mesaj silindi)";
          }
        });

        socket.on("message:pinned", ({ id, pinned }) => {
          const update = (list) => {
            const m = list.find((x) => x.id === id);
            if (m) m.pinned = pinned;
          };
          if (activeChatUser) {
            const list = conversations[activeChatUser];
            if (list) update(list);
          }
          if (activeGroupId) {
            const list = groupConversations[activeGroupId];
            if (list) update(list);
          }
          const row = messagesContainer?.querySelector(`[data-message-id="${id}"]`);
          if (row) {
            let pin = row.querySelector(".message-pin-badge");
            if (pinned && !pin) {
              pin = document.createElement("span");
              pin.className = "message-pin-badge";
              pin.textContent = " 📌";
              row.querySelector(".message-meta")?.appendChild(pin);
            } else if (!pinned && pin) pin.remove();
          }
        });

        socket.on("message:reactions", ({ id, reactions }) => {
          const update = (list) => {
            const m = list.find((x) => x.id === id);
            if (m) m.reactions = reactions || {};
          };
          if (activeChatUser) {
            const list = conversations[activeChatUser];
            if (list) update(list);
          }
          if (activeGroupId) {
            const list = groupConversations[activeGroupId];
            if (list) update(list);
          }
          const row = messagesContainer?.querySelector(`[data-message-id="${id}"]`);
          if (row) {
            const old = row.querySelector(".message-reactions");
            if (old) old.remove();
            const bubble = row.querySelector(".message-bubble");
            if (bubble && reactions) {
              const reactEl = document.createElement("div");
              reactEl.className = "message-reactions";
              for (const [emoji, users] of Object.entries(reactions)) {
                if (!users || !users.length) continue;
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "reaction-btn";
                btn.textContent = emoji + (users.length > 1 ? " " + users.length : "");
                btn.addEventListener("click", () => socket?.emit("message:react", { id, emoji }));
                reactEl.appendChild(btn);
              }
              if (reactEl.childNodes.length) bubble.appendChild(reactEl);
            }
          }
        });

        socket.on("relationships", (data) => {
          const prevFriends = new Set(relationships.friends || []);
          relationships = {
            friends: Array.isArray(data?.friends) ? data.friends : [],
            blocked: Array.isArray(data?.blocked) ? data.blocked : [],
            incomingRequests: Array.isArray(data?.incomingRequests)
              ? data.incomingRequests
              : [],
            outgoingRequests: Array.isArray(data?.outgoingRequests)
              ? data.outgoingRequests
              : [],
          };

          const newFriends = (relationships.friends || []).filter((u) => !prevFriends.has(u));
          if (newFriends.length) {
            newFriends.forEach((u) => showToast("Yeni arkadaşınız var: " + u, "new-friend"));
          }

          if (activeChatUser && !isFriend(activeChatUser)) {
            activeChatUser = null;
            if (messageSearchEl) messageSearchEl.classList.add("hidden");
            if (chatTitleEl && chatSubtitleEl) {
              chatTitleEl.textContent = "Bir kullanıcı seç";
              chatSubtitleEl.textContent =
                "Önce arkadaş ekle, sonra yalnızca arkadaşlarınla özel mesajlaş.";
            }
            if (messageInput) {
              messageInput.placeholder =
                "Önce soldan bir arkadaş seç...";
            }
            if (messagesContainer) {
              messagesContainer.innerHTML = "";
            }
          }

          renderUserList();
          renderGroupList();
          if (addFriendUsernameInput?.value?.trim().length >= 2) searchAndShowUsers();
        });

        socket.on("groupMessage", (payload) => {
          const { groupId, fromUsername, message, time, replyTo } = payload;
          if (!groupId) return;
          if (!groupConversations[groupId]) groupConversations[groupId] = [];
          groupConversations[groupId].push({ id: payload.id, fromUsername, message, time, replyTo });
          saveGroupToStorage(groupId, groupConversations[groupId]);
          if (activeGroupId === groupId) {
            const isMe = fromUsername === currentUsername;
            const isImg = message && String(message).startsWith("data:image/");
            const msg = { id: payload.id, fromUsername, message, replyTo };
            const el = createMessageElement({
              id: payload.id,
              username: fromUsername,
              message,
              time,
              type: isImg ? "image" : "user",
              isMe,
              replyTo,
            });
            addReplyHandler(el, msg);
            addMessageActions(el, msg);
            messagesContainer.appendChild(el);
            scrollToBottom();
          } else if (fromUsername !== currentUsername) {
            maybeShowNotification(fromUsername + " (grup)", message);
          }
          renderGroupList();
        });

        socket.on("privateMessage", (payload) => {
          const { fromUsername, toUsername, message, time, replyTo } = payload;
          const other =
            fromUsername === currentUsername ? toUsername : fromUsername;
          if (!other) return;

          if (!conversations[other]) {
            conversations[other] = [];
          }
          conversations[other].push({
            id: payload.id,
            fromUsername,
            toUsername,
            message,
            time,
            replyTo,
          });
          saveConvToStorage(other, conversations[other]);

          if (activeChatUser === other) {
            const isMe = fromUsername === currentUsername;
            const isImg = message && String(message).startsWith("data:image/");
            const msg = { id: payload.id, fromUsername, message, replyTo };
            const el = createMessageElement({
              id: payload.id,
              username: fromUsername,
              message,
              time,
              type: isImg ? "image" : "user",
              isMe,
              replyTo,
            });
            addReplyHandler(el, msg);
            addMessageActions(el, msg);
            messagesContainer.appendChild(el);
            scrollToBottom();
          } else if (fromUsername !== currentUsername) {
            unreadCounts[other] = (unreadCounts[other] || 0) + 1;
            maybeShowNotification(fromUsername, message);
          }

          // Otomatik liste güncellemesi için online listeden de varsa göster
          if (!onlineUsers.includes(other)) {
            onlineUsers.push(other);
          }
          renderUserList();
        });

        // --- WebRTC signaling events ---
        socket.on("call:offer", (payload) => {
          if (pc || incomingOffer) {
            // meşgul: otomatik reddet
            socket.emit("call:reject", { callId: payload.callId });
            return;
          }

          incomingOffer = payload;
          const from = payload.fromUsername;
          const kind = payload.kind === "video" ? "video" : "audio";

          if (incomingTitleEl) {
            incomingTitleEl.textContent =
              kind === "video" ? "Gelen görüntülü arama" : "Gelen sesli arama";
          }
          if (incomingSubtitleEl) {
            incomingSubtitleEl.textContent = `${from} arıyor.`;
          }

          setIncomingModalVisible(true);
          if (!windowFocused) {
            maybeShowNotification(from, kind === "video" ? "Görüntülü arama" : "Sesli arama");
          }
        });

        socket.on("call:answer", async ({ callId, sdp }) => {
          if (!pc) return;
          if (!currentCallId || callId !== currentCallId) return;
          try {
            await pc.setRemoteDescription(sdp);
            setCallStatus("Arama bağlanıyor", "ICE tamamlanıyor...");
          } catch {
            hangupCall();
          }
        });

        socket.on("call:ice", async ({ callId, candidate }) => {
          if (!pc) return;
          if (!currentCallId || callId !== currentCallId) return;
          try {
            await pc.addIceCandidate(candidate);
          } catch {
            // ignore
          }
        });

        socket.on("call:reject", ({ callId }) => {
          if (!currentCallId || callId !== currentCallId) return;
          setCallStatus("Arama reddedildi", "Karşı taraf aramayı kabul etmedi.");
          cleanupCall();
        });

        socket.on("call:hangup", ({ callId }) => {
          if (!currentCallId || callId !== currentCallId) return;
          setCallStatus("Arama bitti", "Karşı taraf aramayı kapattı.");
          cleanupCall();
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
      fetchGroups();
      if (messageInput) messageInput.focus();
  }

  authForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = authUsernameInput.value.trim();
    const password = authPasswordInput.value;

    if (!username || !password) {
      if (authErrorEl) authErrorEl.textContent = "Kullanıcı adı ve şifre zorunlu.";
      return;
    }

    try {
      const endpoint = authMode === "login" ? "/api/login" : "/api/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        if (authErrorEl) authErrorEl.textContent = data.error || "Bir hata oluştu.";
        return;
      }
      if (data.sessionToken) {
        try { localStorage.setItem("rc_session", data.sessionToken); } catch {}
      }
      enterChat(data.username);
    } catch (err) {
      if (authErrorEl) authErrorEl.textContent = "Sunucuya bağlanırken bir hata oluştu.";
    }
  });

  (async function tryRestoreSession() {
    try {
      const token = localStorage.getItem("rc_session");
      if (!token) return;
      const res = await fetch("/api/session?token=" + encodeURIComponent(token));
      const data = await res.json();
      if (res.ok && data.ok && data.username) {
        enterChat(data.username);
      } else {
        localStorage.removeItem("rc_session");
      }
    } catch {
      localStorage.removeItem("rc_session");
    }
  })();

  messageSearchEl?.addEventListener("input", () => {
    messageSearchQuery = messageSearchEl.value;
    if (activeChatUser) renderMessagesFor(activeChatUser, messageSearchQuery);
    else if (activeGroupId) renderMessagesForGroup(activeGroupId, messageSearchQuery);
  });

  messageInput?.addEventListener("input", () => {
    if (!socket) return;
    if (typingTimeout) clearTimeout(typingTimeout);
    if (activeGroupId) {
      socket.emit("typing", { groupId: activeGroupId });
    } else if (activeChatUser && isFriend(activeChatUser)) {
      socket.emit("typing", { toUsername: activeChatUser });
    }
    typingTimeout = setTimeout(() => {
      typingTimeout = null;
    }, 2000);
  });

  themeToggle?.addEventListener("click", () => {
    const html = document.documentElement;
    const isLight = html.getAttribute("data-theme") === "light";
    html.setAttribute("data-theme", isLight ? "dark" : "light");
    themeToggle.textContent = isLight ? "🌙" : "☀️";
    try {
      localStorage.setItem("rc_theme", isLight ? "dark" : "light");
    } catch {}
  });

  (function initTheme() {
    try {
      const saved = localStorage.getItem("rc_theme");
      if (saved === "light") {
        document.documentElement.setAttribute("data-theme", "light");
        if (themeToggle) themeToggle.textContent = "☀️";
      }
    } catch {}
  })();

  messageInput?.addEventListener("paste", (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    let item = null;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf("image") !== -1) {
        item = items[i];
        break;
      }
    }
    if (!item || !socket) return;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file || file.size > 300000) return;
    const reader = new FileReader();
    reader.onload = () => {
      const data = reader.result;
      if (activeGroupId) {
        socket?.emit("groupMessage", { groupId: activeGroupId, message: data });
      } else if (activeChatUser && isFriend(activeChatUser)) {
        socket?.emit("privateMessage", { toUsername: activeChatUser, message: data });
      }
    };
    reader.readAsDataURL(file);
  });

  messageForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!socket) return;

    const msg = messageInput.value.trim();
    if (!msg) return;

    const payload = { message: msg };
    if (replyingTo) {
      payload.replyTo = replyingTo;
      replyingTo = null;
      updateReplyPreview();
    }

    if (activeGroupId) {
      socket.emit("groupMessage", { groupId: activeGroupId, ...payload });
      messageInput.value = "";
      return;
    }

    if (!activeChatUser || !isFriend(activeChatUser)) return;

    socket.emit("privateMessage", {
      toUsername: activeChatUser,
      ...payload,
    });

    messageInput.value = "";
  });
})();

