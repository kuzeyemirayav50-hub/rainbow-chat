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
  const localVideoEl = document.getElementById("local-video");
  const remoteVideoEl = document.getElementById("remote-video");
  const incomingModalEl = document.getElementById("incoming-call-modal");
  const incomingTitleEl = document.getElementById("incoming-call-title");
  const incomingSubtitleEl = document.getElementById("incoming-call-subtitle");
  const incomingAcceptBtn = document.getElementById("incoming-accept-btn");
  const incomingRejectBtn = document.getElementById("incoming-reject-btn");
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

  let socket = null;
  let currentUsername = "";
  let authMode = "login"; // "login" | "register"
  let onlineUsers = []; // string[]
  let activeChatUser = null;
  let activeGroupId = null;
  const conversations = {}; // username -> [{ fromUsername, toUsername, message, time }]
  const groupConversations = {}; // groupId -> [{ fromUsername, message, time }]
  let groups = []; // { id, name, createdBy, members }[]
  let relationships = {
    friends: [],
    blocked: [],
    incomingRequests: [],
    outgoingRequests: [],
  };
  const unreadCounts = {}; // username -> number

  let notificationsEnabled = false;
  let windowFocused = true;

  // WebRTC call state (1:1)
  let pc = null;
  let localStream = null;
  let remoteStream = null;
  let currentCallId = null;
  let callKind = null; // "audio" | "video"
  let incomingOffer = null; // { callId, fromUsername, kind, sdp }
  let callPeerUsername = null;

  const rtcConfig = {
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  };

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

  function renderMessagesForGroup(groupId) {
    if (!messagesContainer) return;
    messagesContainer.innerHTML = "";
    const history = groupConversations[groupId] || [];
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

  function isFriend(username) {
    return relationships.friends.includes(username);
  }

  function isBlocked(username) {
    return relationships.blocked.includes(username);
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

      const dot = document.createElement("span");
      dot.className = "user-dot";

      const name = document.createElement("span");
      name.className = "user-name";
      name.textContent = username;

      main.appendChild(dot);
      main.appendChild(name);

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

        renderMessagesFor(username);
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
        callAudioBtn.disabled = true;
        callVideoBtn.disabled = true;
        renderMessagesForGroup(g.id);
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

  function setCallPanelVisible(visible) {
    if (!callPanelEl) return;
    if (visible) callPanelEl.classList.remove("hidden");
    else callPanelEl.classList.add("hidden");
  }

  function setIncomingModalVisible(visible) {
    if (!incomingModalEl) return;
    if (visible) incomingModalEl.classList.remove("hidden");
    else incomingModalEl.classList.add("hidden");
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
    pc = new RTCPeerConnection(rtcConfig);

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
      } else if (pc.connectionState === "disconnected") {
        setCallStatus("Bağlantı koptu", "Arama sonlandırılıyor...");
      } else if (pc.connectionState === "failed") {
        setCallStatus("Bağlantı başarısız", "Arama sonlandırılıyor...");
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
  incomingAcceptBtn?.addEventListener("click", () => acceptIncomingCall());
  incomingRejectBtn?.addEventListener("click", () => rejectIncomingCall());

  const addFriendUsernameInput = document.getElementById("add-friend-username");
  const addFriendBtn = document.getElementById("add-friend-btn");
  const addFriendHintEl = document.getElementById("add-friend-hint");

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

        socket.on("userList", (list) => {
          onlineUsers = Array.isArray(list) ? list : [];
          renderUserList();
        });

        socket.on("relationships", (data) => {
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

          if (activeChatUser && !isFriend(activeChatUser)) {
            activeChatUser = null;
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
        });

        socket.on("groupMessage", (payload) => {
          const { groupId, fromUsername, message, time } = payload;
          if (!groupId) return;
          if (!groupConversations[groupId]) groupConversations[groupId] = [];
          groupConversations[groupId].push({ fromUsername, message, time });
          if (activeGroupId === groupId) {
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
          }
          renderGroupList();
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

    if (activeGroupId) {
      socket.emit("groupMessage", { groupId: activeGroupId, message: msg });
      messageInput.value = "";
      return;
    }

    if (!activeChatUser || !isFriend(activeChatUser)) return;

    socket.emit("privateMessage", {
      toUsername: activeChatUser,
      message: msg,
    });

    messageInput.value = "";
  });
})();

