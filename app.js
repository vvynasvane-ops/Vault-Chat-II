// js/app.js — logic for chat.html (contact list + conversation view)
// Mirrors ui/activities/MainActivity.java and ChatActivity.java.
//
// This file wires together every module: firestore-api (accounts/contacts),
// messaging (encrypted relay + status + edit/delete/media), crypto
// (X25519/AES-256-GCM), idb (local persistence), and appearance
// (theme/fonts/wallpapers).

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase-config.js";
import {
  getProfile,
  searchByIdCode,
  addContact,
  removeContact,
  getContactUids,
  updatePublicKey,
  updateProfilePhoto,
  listenToProfile,
} from "./firestore-api.js";
import { getOrCreatePublicKeyBase64, getStoredKeyPair, toBase64 } from "./crypto.js";
import {
  sendText,
  sendMediaFile,
  sendKeyExchange,
  sendEdit,
  sendDeleteEveryone,
  sendDeliveryAck,
  sendReadAck,
  startInbox,
  stopInbox,
  setOnlinePresence,
  getConversationHistory,
  clearConversation,
  buildConversationId,
  MAX_MEDIA_BYTES,
} from "./messaging.js";
import { idb } from "./idb.js";
import {
  initAppearance,
  saveAppearance,
  resetAppearanceText,
  loadAppearance,
  FONT_FAMILIES,
  FONT_WEIGHTS,
  FONT_COLORS,
  setWallpaper,
  clearWallpaper,
  applyWallpaper,
  getContactPrefs,
  setContactPrefs,
} from "./appearance.js";

let myUid = null;
let myProfile = null;
let contacts = new Map(); // uid -> profile
let contactUnsubscribers = new Map(); // uid -> onSnapshot unsubscribe
let activeContactUid = null;
let activeMenuMessageId = null;
let editingMessageId = null;

const els = {
  myName: document.getElementById("my-display-name"),
  myIdCode: document.getElementById("my-id-code"),
  myAvatar: document.getElementById("my-avatar"),
  myAvatarInput: document.getElementById("my-avatar-input"),
  logoutBtn: document.getElementById("btn-logout"),
  addContactBtn: document.getElementById("btn-add-contact"),
  addContactInput: document.getElementById("input-friend-code"),
  addContactError: document.getElementById("add-contact-error"),
  contactSearch: document.getElementById("input-contact-search"),
  contactList: document.getElementById("contact-list"),
  emptyState: document.getElementById("empty-state"),
  sidebar: document.getElementById("sidebar"),
  chatPane: document.getElementById("chat-pane"),
  chatWithName: document.getElementById("chat-with-name"),
  chatWithCode: document.getElementById("chat-with-code"),
  chatMenuBtn: document.getElementById("btn-chat-menu"),
  chatMenu: document.getElementById("chat-menu"),
  messageLog: document.getElementById("message-log"),
  messageForm: document.getElementById("message-form"),
  messageInput: document.getElementById("message-input"),
  removeContactBtn: document.getElementById("btn-remove-contact"),
  pinnedBar: document.getElementById("pinned-bar"),
  pinnedCount: document.getElementById("pinned-count"),
  filePickerImages: document.getElementById("file-picker-images"),
  filePickerFiles: document.getElementById("file-picker-files"),
  btnAttachMedia: document.getElementById("btn-attach-media"),
  btnAttachFile: document.getElementById("btn-attach-file"),
  msgContextMenu: document.getElementById("msg-context-menu"),
  idCodeCopyBtn: document.getElementById("btn-copy-idcode"),
  idCodeShareBtn: document.getElementById("btn-share-idcode"),
  btnAppearance: document.getElementById("btn-appearance"),
  appearancePanel: document.getElementById("appearance-panel"),
  btnEncryptionInfo: document.getElementById("btn-encryption-info"),
  encryptionDialog: document.getElementById("encryption-dialog"),
  btnClearChat: document.getElementById("btn-clear-chat"),
  btnViewMedia: document.getElementById("btn-view-media"),
  mediaGalleryDialog: document.getElementById("media-gallery-dialog"),
  mediaGalleryGrid: document.getElementById("media-gallery-grid"),
  btnSetWallpaper: document.getElementById("btn-set-wallpaper"),
  btnResetWallpaper: document.getElementById("btn-reset-wallpaper"),
  wallpaperInput: document.getElementById("wallpaper-input"),
  btnSetHomeBg: document.getElementById("btn-set-home-bg"),
  btnResetHomeBg: document.getElementById("btn-reset-home-bg"),
  homeBgInput: document.getElementById("home-bg-input"),
  pinnedListDialog: document.getElementById("pinned-list-dialog"),
  pinnedListBody: document.getElementById("pinned-list-body"),
};

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "index.html";
    return;
  }
  myUid = user.uid;
  await boot();
});

async function boot() {
  await initAppearance();
  setupAppearancePanel();

  myProfile = await getProfile(myUid);
  els.myName.textContent = myProfile.displayName;
  els.myIdCode.textContent = formatIdCode(myProfile.idCode);
  renderAvatar(els.myAvatar, myProfile.profilePhotoBase64, myProfile.displayName);

  const myPublicKey = await getOrCreatePublicKeyBase64();
  await updatePublicKey(myUid, myPublicKey);

  await setOnlinePresence(myUid, true);
  window.addEventListener("beforeunload", () => {
    setOnlinePresence(myUid, false);
  });

  await applyWallpaper("home", els.sidebar);

  await refreshContacts();

  startInbox(myUid, {
    resolveSender: async (uid) => contacts.get(uid) || (await getProfile(uid)),
    onText: (localMessage) => handleIncoming(localMessage),
    onMedia: (localMessage) => handleIncoming(localMessage),
    onKeyExchange: async (msg) => {
      // Refresh that contact's public key so future messages use the new one.
      const profile = await getProfile(msg.senderId);
      contacts.set(msg.senderId, profile);
      if (!contacts.has(msg.senderId)) return;
      const uids = await getContactUids(myUid);
      if (uids.includes(msg.senderId)) {
        upsertContactRow(profile);
      }
    },
    onEdited: (localMessage) => {
      if (localMessage.senderId === activeContactUid || localMessage.receiverId === activeContactUid) {
        refreshBubble(localMessage);
      }
    },
    onDeletedEveryone: (localMessage) => {
      if (localMessage.senderId === activeContactUid || localMessage.receiverId === activeContactUid) {
        refreshBubble(localMessage);
      }
      refreshPinnedBar();
    },
    onDeliveryAck: async (messageId) => {
      const msg = await idb.get("messages", messageId);
      if (msg && msg.status === "SENT") {
        msg.status = "DELIVERED";
        await idb.put("messages", msg);
        updateStatusIcon(messageId, "DELIVERED");
      }
    },
    onReadAck: async (messageIds) => {
      for (const id of messageIds) {
        const msg = await idb.get("messages", id);
        if (msg) {
          msg.status = "READ";
          await idb.put("messages", msg);
          updateStatusIcon(id, "READ");
        }
      }
    },
  });
}

function handleIncoming(localMessage) {
  if (localMessage.senderId === activeContactUid) {
    renderMessage(localMessage);
    scrollToBottom();
    // Chat is open — mark read immediately and notify the sender (Section 3).
    sendReadAck(localMessage.senderId, myUid, [localMessage.messageId]);
    idb.get("messages", localMessage.messageId).then((m) => {
      if (m) {
        m.status = "READ";
        idb.put("messages", m);
      }
    });
  } else {
    sendDeliveryAck(localMessage.senderId, myUid, localMessage.messageId);
  }
  bumpContactPreview(
    localMessage.senderId,
    localMessage.messageType === "TEXT" ? localMessage.content : `📎 ${localMessage.content}`,
    localMessage.timestamp
  );
}

// ─── Contacts (Section 2) ─────────────────────────────────────────────

async function refreshContacts() {
  const uids = await getContactUids(myUid);
  for (const unsub of contactUnsubscribers.values()) unsub();
  contactUnsubscribers.clear();
  contacts.clear();
  els.contactList.innerHTML = "";

  if (uids.length === 0) {
    els.emptyState.classList.remove("hidden");
    return;
  }
  els.emptyState.classList.add("hidden");

  for (const uid of uids) {
    try {
      const profile = await getProfile(uid);
      contacts.set(uid, profile);
      renderContactRow(profile);
      // Live sync: refresh cached contact info whenever their profile changes.
      const unsub = listenToProfile(
        uid,
        (updated) => {
          contacts.set(uid, updated);
          upsertContactRow(updated);
          if (activeContactUid === uid) {
            els.chatWithName.textContent = updated.displayName;
            els.chatWithCode.textContent = formatIdCode(updated.idCode);
          }
        },
        () => {}
      );
      contactUnsubscribers.set(uid, unsub);
    } catch (_) {
      // Contact's account may have been deleted; skip.
    }
  }
  sortContactRows();
}

function renderContactRow(profile) {
  const row = document.createElement("div");
  row.className = "contact-row";
  row.dataset.uid = profile.uid;
  fillContactRow(row, profile);
  row.addEventListener("click", (e) => {
    if (e.target.closest(".contact-row-menu-btn")) return;
    openConversation(profile.uid);
  });
  attachContactContextMenu(row, profile.uid);
  els.contactList.appendChild(row);
  applyContactPrefsToRow(row, profile.uid);
}

function upsertContactRow(profile) {
  let row = els.contactList.querySelector(`[data-uid="${profile.uid}"]`);
  if (!row) {
    renderContactRow(profile);
    return;
  }
  fillContactRow(row, profile);
  applyContactPrefsToRow(row, profile.uid);
}

function fillContactRow(row, profile) {
  row.innerHTML = `
    <span class="avatar-wrap">
      ${avatarHtml(profile.profilePhotoBase64, profile.displayName, 34)}
      <span class="avatar-dot" data-status="${profile.isOnline ? "online" : "offline"}"></span>
    </span>
    <span class="contact-meta">
      <span class="contact-name">${escapeHtml(profile.displayName)}</span>
      <span class="contact-preview">ID ${escapeHtml(profile.idCode || "")}</span>
    </span>
    <span class="contact-badges"></span>
  `;
}

async function applyContactPrefsToRow(row, uid) {
  const prefs = await getContactPrefs(uid);
  const badges = row.querySelector(".contact-badges");
  if (!badges) return;
  badges.innerHTML = "";
  if (prefs.favorite) badges.insertAdjacentHTML("beforeend", `<span class="badge" title="Favourite">★</span>`);
  if (prefs.muted) badges.insertAdjacentHTML("beforeend", `<span class="badge" title="Muted">🔕</span>`);
  row.classList.toggle("favorite", !!prefs.favorite);
}

async function sortContactRows() {
  const rows = Array.from(els.contactList.children);
  const withPrefs = await Promise.all(
    rows.map(async (r) => ({ r, prefs: await getContactPrefs(r.dataset.uid) }))
  );
  withPrefs.sort((a, b) => Number(b.prefs.favorite) - Number(a.prefs.favorite));
  withPrefs.forEach(({ r }) => els.contactList.appendChild(r));
}

function bumpContactPreview(uid, text, timestamp) {
  const row = els.contactList.querySelector(`[data-uid="${uid}"] .contact-preview`);
  if (row) row.textContent = text;
}

// Long-press (touch) / right-click (desktop) contact actions (Section 2):
// delete contact, mark favourite, mute.
function attachContactContextMenu(row, uid) {
  const open = (x, y) => showGenericMenu(x, y, [
    { label: "Toggle favourite", action: async () => {
        const prefs = await getContactPrefs(uid);
        await setContactPrefs(uid, { favorite: !prefs.favorite });
        applyContactPrefsToRow(row, uid);
        sortContactRows();
      } },
    { label: "Toggle mute", action: async () => {
        const prefs = await getContactPrefs(uid);
        await setContactPrefs(uid, { muted: !prefs.muted });
        applyContactPrefsToRow(row, uid);
      } },
    { label: "Delete contact", danger: true, action: async () => {
        if (!confirm("Delete this contact? Message history stays on this device.")) return;
        await removeContact(myUid, uid);
        if (activeContactUid === uid) {
          els.chatPane.classList.add("hidden");
          activeContactUid = null;
        }
        await refreshContacts();
      } },
  ]);

  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    open(e.clientX, e.clientY);
  });
  attachLongPress(row, (x, y) => open(x, y));
}

// Search contacts by name (Section 2).
els.contactSearch.addEventListener("input", () => {
  const q = els.contactSearch.value.trim().toLowerCase();
  els.contactList.querySelectorAll(".contact-row").forEach((row) => {
    const name = row.querySelector(".contact-name")?.textContent.toLowerCase() || "";
    row.classList.toggle("hidden", q.length > 0 && !name.includes(q));
  });
});

// Pull-to-refresh (Section 2): drag down at the top of the contact list.
let pullStartY = null;
els.contactList.addEventListener("touchstart", (e) => {
  if (els.contactList.scrollTop === 0) pullStartY = e.touches[0].clientY;
});
els.contactList.addEventListener("touchend", (e) => {
  if (pullStartY !== null) {
    const dy = e.changedTouches[0].clientY - pullStartY;
    if (dy > 80) refreshContacts();
  }
  pullStartY = null;
});

// ─── Conversation view ────────────────────────────────────────────────

async function openConversation(uid) {
  activeContactUid = uid;
  const profile = contacts.get(uid);
  els.chatPane.classList.remove("hidden");
  document.getElementById("no-chat-state").classList.add("hidden");
  els.chatWithName.textContent = profile.displayName;
  els.chatWithCode.textContent = formatIdCode(profile.idCode);
  els.messageLog.innerHTML = "";

  document
    .querySelectorAll(".contact-row")
    .forEach((r) => r.classList.toggle("active", r.dataset.uid === uid));

  await applyWallpaper(uid, els.messageLog);

  const history = await getConversationHistory(myUid, uid);
  for (const m of history) await renderMessage(m);
  scrollToBottom();
  refreshPinnedBar();

  // Opening a chat marks all of their messages as read and notifies them
  // (Section 3 — read receipts).
  const unreadIds = history
    .filter((m) => !m.isSentByMe && m.status !== "READ")
    .map((m) => m.messageId);
  if (unreadIds.length) {
    await sendReadAck(uid, myUid, unreadIds);
    for (const m of history) {
      if (unreadIds.includes(m.messageId)) {
        m.status = "READ";
        await idb.put("messages", m);
      }
    }
  }
}

// ─── Rendering: date separators (Section 4) + message bubbles ──────────

function dateSeparatorLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const startOf = (dt) => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diffDays = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  }
  return d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function maybeInsertDateSeparator(ts) {
  const lastSep = els.messageLog.dataset.lastSepDay;
  const day = new Date(ts).toDateString();
  if (lastSep === day) return;
  els.messageLog.dataset.lastSepDay = day;
  const sep = document.createElement("div");
  sep.className = "date-sep";
  sep.dataset.day = day;
  sep.innerHTML = `<span>${dateSeparatorLabel(ts)}</span>`;
  els.messageLog.appendChild(sep);
}

async function renderMessage(msg) {
  maybeInsertDateSeparator(msg.timestamp);

  const bubble = document.createElement("div");
  bubble.className = `bubble ${msg.isSentByMe ? "mine" : "theirs"}`;
  bubble.dataset.messageId = msg.messageId;
  await fillBubble(bubble, msg);
  els.messageLog.appendChild(bubble);

  attachBubbleContextMenu(bubble, msg);
}

function statusIcon(status) {
  switch (status) {
    case "SENDING": return "🕓";
    case "SENT": return "✓";
    case "DELIVERED": return "✓✓";
    case "READ": return `<span class="status-read">✓✓</span>`;
    case "FAILED": return `<span class="status-failed">⚠</span>`;
    default: return "";
  }
}

async function fillBubble(bubble, msg) {
  const pinTag = msg.pinned ? `<span class="pin-badge" title="Pinned">📌</span>` : "";
  const editedTag = msg.edited && !msg.deletedForEveryone ? `<span class="edited-tag">edited</span>` : "";
  const statusTag = msg.isSentByMe ? `<span class="bubble-status">${statusIcon(msg.status)}</span>` : "";

  if (msg.deletedForEveryone) {
    bubble.innerHTML = `
      <span class="bubble-text tombstone">🚫 This message was deleted</span>
      <span class="bubble-time">${pinTag}${formatTime(msg.timestamp)}${statusTag}</span>
    `;
    return;
  }

  if (["IMAGE", "VIDEO", "AUDIO", "FILE"].includes(msg.messageType)) {
    const blob = await idb.get("media", msg.messageId).catch(() => null);
    const url = blob ? URL.createObjectURL(blob) : null;
    let mediaHtml;
    if (msg.messageType === "IMAGE" && url) {
      mediaHtml = `<img class="media-thumb" src="${url}" alt="${escapeHtml(msg.fileName)}" />`;
    } else if (msg.messageType === "VIDEO" && url) {
      mediaHtml = `<video class="media-thumb" src="${url}" controls></video>`;
    } else if (msg.messageType === "AUDIO" && url) {
      mediaHtml = `<audio src="${url}" controls></audio>`;
    } else {
      mediaHtml = `<span class="file-row">📄 ${escapeHtml(msg.fileName)}</span>`;
    }
    const openHtml = url
      ? `<a class="media-open" href="${url}" download="${escapeHtml(msg.fileName)}" target="_blank" rel="noopener">Open / Save</a>`
      : "";
    bubble.innerHTML = `
      ${mediaHtml}
      ${openHtml}
      <span class="bubble-time">${pinTag}${editedTag}${formatTime(msg.timestamp)}${statusTag}</span>
    `;
    return;
  }

  bubble.innerHTML = `
    <span class="bubble-text">${escapeHtml(msg.content)}</span>
    <span class="bubble-time">${pinTag}${editedTag}${formatTime(msg.timestamp)}${statusTag}</span>
  `;
}

function refreshBubble(msg) {
  const bubble = els.messageLog.querySelector(`[data-message-id="${msg.messageId}"]`);
  if (bubble) fillBubble(bubble, msg);
}

function updateStatusIcon(messageId, status) {
  const bubble = els.messageLog.querySelector(`[data-message-id="${messageId}"] .bubble-status`);
  if (bubble) bubble.innerHTML = statusIcon(status);
}

function scrollToBottom() {
  els.messageLog.scrollTop = els.messageLog.scrollHeight;
}

// ─── Long-press / right-click message menu (Section 5 & 6) ─────────────
// Only the options relevant to that specific message are shown.

function attachBubbleContextMenu(bubble, msg) {
  const open = (x, y) => {
    activeMenuMessageId = msg.messageId;
    const items = [];
    if (msg.isSentByMe && msg.messageType === "TEXT" && !msg.deletedForEveryone) {
      items.push({ label: "Edit", action: () => startEdit(msg) });
    }
    if (!msg.deletedForEveryone) {
      items.push({ label: msg.pinned ? "Unpin" : "Pin", action: () => togglePin(msg) });
    }
    if (["IMAGE", "VIDEO", "AUDIO", "FILE"].includes(msg.messageType) && !msg.deletedForEveryone) {
      items.push({ label: "Share to other app", action: () => shareMedia(msg) });
    }
    if (msg.isSentByMe && !msg.deletedForEveryone) {
      items.push({ label: "Delete for everyone", danger: true, action: () => deleteForEveryone(msg) });
    }
    items.push({ label: "Delete for me", danger: true, action: () => deleteForMe(msg) });
    showGenericMenu(x, y, items);
  };
  bubble.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    open(e.clientX, e.clientY);
  });
  attachLongPress(bubble, open);
}

function startEdit(msg) {
  editingMessageId = msg.messageId;
  els.messageInput.value = msg.content;
  els.messageInput.focus();
  els.messageForm.classList.add("editing");
}

async function togglePin(msg) {
  msg.pinned = !msg.pinned;
  await idb.put("messages", msg);
  refreshBubble(msg);
  refreshPinnedBar();
}

async function deleteForEveryone(msg) {
  if (!confirm("Delete this message for everyone? This can't be undone.")) return;
  msg.content = "";
  msg.deletedForEveryone = true;
  msg.pinned = false;
  await idb.put("messages", msg);
  await idb.delete("media", msg.messageId).catch(() => {});
  refreshBubble(msg);
  refreshPinnedBar();
  const otherUid = msg.isSentByMe ? msg.receiverId : msg.senderId;
  await sendDeleteEveryone(otherUid, myUid, msg.messageId);
}

async function deleteForMe(msg) {
  if (!confirm("Delete this message for you? The other person keeps their copy.")) return;
  await idb.delete("messages", msg.messageId);
  await idb.delete("media", msg.messageId).catch(() => {});
  const bubble = els.messageLog.querySelector(`[data-message-id="${msg.messageId}"]`);
  if (bubble) bubble.remove();
  refreshPinnedBar();
}

async function shareMedia(msg) {
  const blob = await idb.get("media", msg.messageId).catch(() => null);
  if (!blob) return;
  const file = new File([blob], msg.fileName, { type: msg.mimeType });
  if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: msg.fileName });
      return;
    } catch (_) {
      /* user cancelled or share failed — fall through to download */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = msg.fileName;
  a.click();
}

// ─── Pinned messages (Section 6) ─────────────────────────────────────

async function refreshPinnedBar() {
  if (!activeContactUid) return;
  const history = await getConversationHistory(myUid, activeContactUid);
  const pinned = history.filter((m) => m.pinned && !m.deletedForEveryone);
  if (pinned.length === 0) {
    els.pinnedBar.classList.add("hidden");
    return;
  }
  els.pinnedBar.classList.remove("hidden");
  els.pinnedCount.textContent = `${pinned.length} pinned message${pinned.length > 1 ? "s" : ""}`;
}

els.pinnedBar.addEventListener("click", async () => {
  const history = await getConversationHistory(myUid, activeContactUid);
  const pinned = history.filter((m) => m.pinned && !m.deletedForEveryone);
  els.pinnedListBody.innerHTML = pinned
    .map(
      (m) => `
      <button class="pinned-item" data-message-id="${m.messageId}">
        <span class="pinned-item-preview">${escapeHtml(
          m.messageType === "TEXT" ? m.content.slice(0, 80) : `📎 ${m.fileName}`
        )}</span>
        <span class="pinned-item-time">${formatTime(m.timestamp)}</span>
      </button>`
    )
    .join("");
  els.pinnedListBody.querySelectorAll(".pinned-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.messageId;
      closeDialog(els.pinnedListDialog);
      const target = els.messageLog.querySelector(`[data-message-id="${id}"]`);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("flash");
        setTimeout(() => target.classList.remove("flash"), 1200);
      }
    });
  });
  openDialog(els.pinnedListDialog);
});

// ─── Sending: text + edit-in-place ────────────────────────────────────

els.messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !activeContactUid) return;

  const profile = contacts.get(activeContactUid);
  els.messageInput.value = "";

  if (editingMessageId) {
    const id = editingMessageId;
    editingMessageId = null;
    els.messageForm.classList.remove("editing");
    try {
      const existing = await idb.get("messages", id);
      existing.content = text;
      existing.edited = true;
      await idb.put("messages", existing);
      refreshBubble(existing);
      await sendEdit(activeContactUid, myUid, profile.publicKeyBase64, id, text);
    } catch (err) {
      alert("Edit failed to send: " + err.message);
    }
    return;
  }

  try {
    const localMessage = await sendText(myUid, activeContactUid, profile.publicKeyBase64, text);
    await renderMessage(localMessage);
    bumpContactPreview(activeContactUid, text, localMessage.timestamp);
    scrollToBottom();
  } catch (err) {
    alert("Message failed to send: " + err.message);
  }
});

// Typing area: send disabled until something is typed or attached (Section 3).
function refreshSendEnabled() {
  const submit = els.messageForm.querySelector('button[type="submit"]');
  submit.disabled = els.messageInput.value.trim().length === 0;
}
els.messageInput.addEventListener("input", refreshSendEnabled);
refreshSendEnabled();

// ─── Media pickers (Section 7 — multi-select photo/video + file) ───────

els.btnAttachMedia.addEventListener("click", () => els.filePickerImages.click());
els.btnAttachFile.addEventListener("click", () => els.filePickerFiles.click());

els.filePickerImages.addEventListener("change", () => sendPickedFiles(els.filePickerImages.files));
els.filePickerFiles.addEventListener("change", () => sendPickedFiles(els.filePickerFiles.files));

async function sendPickedFiles(fileList) {
  if (!activeContactUid || !fileList || fileList.length === 0) return;
  const profile = contacts.get(activeContactUid);
  for (const file of Array.from(fileList)) {
    try {
      const localMessage = await sendMediaFile(myUid, activeContactUid, profile.publicKeyBase64, file);
      await renderMessage(localMessage);
      bumpContactPreview(activeContactUid, `📎 ${file.name}`, localMessage.timestamp);
      scrollToBottom();
    } catch (err) {
      alert(err.message);
    }
  }
  els.filePickerImages.value = "";
  els.filePickerFiles.value = "";
}

// Share-out round trip (Section 7): dropping a file onto the message log
// sends it, same as choosing it from the picker.
els.messageLog.addEventListener("dragover", (e) => e.preventDefault());
els.messageLog.addEventListener("drop", (e) => {
  e.preventDefault();
  if (e.dataTransfer.files.length) sendPickedFiles(e.dataTransfer.files);
});

// ─── Add / remove contact ─────────────────────────────────────────────

els.addContactBtn.addEventListener("click", async () => {
  const code = els.addContactInput.value.trim();
  els.addContactError.textContent = "";
  if (!/^\d{6}$/.test(code)) {
    els.addContactError.textContent = "Enter a 6-digit ID code.";
    return;
  }
  try {
    const profile = await searchByIdCode(code);
    if (profile.uid === myUid) {
      els.addContactError.textContent = "That's your own ID code.";
      return;
    }
    await addContact(myUid, profile.uid);
    await sendKeyExchange(myUid, profile.uid, await getOrCreatePublicKeyBase64());
    els.addContactInput.value = "";
    await refreshContacts();
  } catch (err) {
    els.addContactError.textContent =
      err.message === "User not found" ? "No account with that ID code." : err.message;
  }
});

els.removeContactBtn.addEventListener("click", async () => {
  if (!activeContactUid) return;
  if (!confirm("Remove this contact? Message history stays on this device.")) return;
  await removeContact(myUid, activeContactUid);
  els.chatPane.classList.add("hidden");
  activeContactUid = null;
  await refreshContacts();
});

els.logoutBtn.addEventListener("click", async () => {
  if (!confirm("Sign out?")) return;
  await setOnlinePresence(myUid, false);
  stopInbox();
  sessionStorage.setItem("vc_uid", "signing_out");
  localStorage.removeItem("vc_session");
  await signOut(auth);
  window.location.href = "index.html";
});

// ─── ID code copy / share (Section 1) ─────────────────────────────────

function formatIdCode(code) {
  if (!code) return "ID: ------";
  return `ID: ${code.slice(0, 3)} ${code.slice(3)}`;
}

els.idCodeCopyBtn.addEventListener("click", async () => {
  await navigator.clipboard.writeText(myProfile.idCode);
  flashToast("ID code copied");
});

els.idCodeShareBtn.addEventListener("click", async () => {
  const text = `Add me using my ID code: ${myProfile.idCode}`;
  if (navigator.share) {
    try {
      await navigator.share({ text, title: "VaultChatt II" });
      return;
    } catch (_) {}
  }
  await navigator.clipboard.writeText(text);
  flashToast("Copied — paste it anywhere");
});

// ─── Chat menu: Encryption Info / Clear Chat / View Media (Section 3) ──

els.chatMenuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  els.chatMenu.classList.toggle("hidden");
});
document.addEventListener("click", () => els.chatMenu.classList.add("hidden"));

els.btnEncryptionInfo.addEventListener("click", async () => {
  const keyPair = await getStoredKeyPair();
  let fingerprint = "—";
  if (keyPair) {
    const raw = await crypto.subtle.exportKey("raw", keyPair.publicKey);
    const b64 = toBase64(new Uint8Array(raw));
    fingerprint = `${b64.slice(0, 8)}…${b64.slice(-8)}`;
  }
  document.getElementById("encryption-fingerprint").textContent = fingerprint;
  openDialog(els.encryptionDialog);
});

els.btnClearChat.addEventListener("click", async () => {
  if (!activeContactUid) return;
  if (!confirm("Clear this chat? Messages and media will be removed from this device. Wallpaper stays.")) return;
  await clearConversation(myUid, activeContactUid);
  els.messageLog.innerHTML = "";
  delete els.messageLog.dataset.lastSepDay;
  refreshPinnedBar();
});

els.btnViewMedia.addEventListener("click", async () => {
  const history = await getConversationHistory(myUid, activeContactUid);
  const mediaMsgs = history.filter(
    (m) => ["IMAGE", "VIDEO", "AUDIO", "FILE"].includes(m.messageType) && !m.deletedForEveryone
  );
  els.mediaGalleryGrid.innerHTML = "";
  if (mediaMsgs.length === 0) {
    els.mediaGalleryGrid.innerHTML = `<p class="empty-state">No media exchanged in this conversation yet.</p>`;
  }
  for (const m of mediaMsgs) {
    const blob = await idb.get("media", m.messageId).catch(() => null);
    if (!blob) continue;
    const url = URL.createObjectURL(blob);
    const cell = document.createElement("a");
    cell.className = "gallery-cell";
    cell.href = url;
    cell.download = m.fileName;
    cell.target = "_blank";
    cell.rel = "noopener";
    if (m.messageType === "IMAGE") cell.innerHTML = `<img src="${url}" alt="${escapeHtml(m.fileName)}" />`;
    else if (m.messageType === "VIDEO") cell.innerHTML = `<video src="${url}"></video>`;
    else cell.innerHTML = `<span class="gallery-file">📄<br/>${escapeHtml(m.fileName)}</span>`;
    els.mediaGalleryGrid.appendChild(cell);
  }
  openDialog(els.mediaGalleryDialog);
});

// ─── Chat wallpaper (Section 8) & home background (Section 9) ─────────

els.btnSetWallpaper.addEventListener("click", () => els.wallpaperInput.click());
els.wallpaperInput.addEventListener("change", async () => {
  const file = els.wallpaperInput.files[0];
  if (!file || !activeContactUid) return;
  await setWallpaper(activeContactUid, file);
  await applyWallpaper(activeContactUid, els.messageLog);
  els.wallpaperInput.value = "";
});
els.btnResetWallpaper.addEventListener("click", async () => {
  if (!activeContactUid) return;
  await clearWallpaper(activeContactUid);
  await applyWallpaper(activeContactUid, els.messageLog);
});

els.btnSetHomeBg.addEventListener("click", () => els.homeBgInput.click());
els.homeBgInput.addEventListener("change", async () => {
  const file = els.homeBgInput.files[0];
  if (!file) return;
  await setWallpaper("home", file);
  await applyWallpaper("home", els.sidebar);
  els.homeBgInput.value = "";
});
els.btnResetHomeBg.addEventListener("click", async () => {
  await clearWallpaper("home");
  await applyWallpaper("home", els.sidebar);
});

// ─── Appearance panel: dark/light + fonts (Sections 10 & 11) ───────────

function setupAppearancePanel() {
  els.btnAppearance.addEventListener("click", () => openDialog(els.appearancePanel));

  const themeSwitch = document.getElementById("theme-switch");
  const familySelect = document.getElementById("font-family-select");
  const weightSelect = document.getElementById("font-weight-select");
  const sizeSlider = document.getElementById("font-size-slider");
  const sizeLabel = document.getElementById("font-size-label");
  const colorGrid = document.getElementById("font-color-grid");
  const resetBtn = document.getElementById("btn-reset-appearance");

  Object.keys(FONT_FAMILIES).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    familySelect.appendChild(opt);
  });
  Object.keys(FONT_WEIGHTS).forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    weightSelect.appendChild(opt);
  });
  FONT_COLORS.forEach((c) => {
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "color-swatch";
    sw.dataset.value = c.value;
    sw.title = c.name;
    sw.style.background = c.value || "linear-gradient(135deg,#666,#222)";
    sw.addEventListener("click", () => saveAppearance({ fontColor: c.value }).then(reflect));
    colorGrid.appendChild(sw);
  });

  themeSwitch.addEventListener("change", () =>
    saveAppearance({ theme: themeSwitch.checked ? "light" : "dark" })
  );
  familySelect.addEventListener("change", () => saveAppearance({ fontFamily: familySelect.value }));
  weightSelect.addEventListener("change", () => saveAppearance({ fontWeight: weightSelect.value }));
  sizeSlider.addEventListener("input", () => {
    sizeLabel.textContent = `${sizeSlider.value}%`;
    saveAppearance({ fontSizePct: Number(sizeSlider.value) });
  });
  resetBtn.addEventListener("click", () => resetAppearanceText().then(reflect));

  async function reflect() {
    const s = await loadAppearance();
    themeSwitch.checked = s.theme === "light";
    familySelect.value = s.fontFamily;
    weightSelect.value = s.fontWeight;
    sizeSlider.value = s.fontSizePct;
    sizeLabel.textContent = `${s.fontSizePct}%`;
    colorGrid.querySelectorAll(".color-swatch").forEach((sw) => {
      sw.classList.toggle("selected", sw.dataset.value === s.fontColor);
    });
  }
  reflect();
}

// ─── Profile picture (Section 12) ──────────────────────────────────────

els.myAvatar.addEventListener("click", () => els.myAvatarInput.click());
els.myAvatarInput.addEventListener("change", async () => {
  const file = els.myAvatarInput.files[0];
  if (!file) return;
  try {
    const base64 = await cropAndCompressToSquareJpeg(file, 256, 0.82);
    await updateProfilePhoto(myUid, base64);
    myProfile.profilePhotoBase64 = base64;
    renderAvatar(els.myAvatar, base64, myProfile.displayName);
  } catch (err) {
    alert("Couldn't set profile photo: " + err.message);
  } finally {
    els.myAvatarInput.value = "";
  }
});

function cropAndCompressToSquareJpeg(file, size, quality) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Orientation-corrected via canvas draw (browsers auto-apply EXIF
      // orientation for <img> in current engines); cropped to a centered square.
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      URL.revokeObjectURL(img.src);
      resolve(canvas.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = () => reject(new Error("Couldn't read that image"));
    img.src = URL.createObjectURL(file);
  });
}

function avatarHtml(base64Jpeg, displayName, sizePx) {
  if (base64Jpeg) {
    return `<img class="avatar-img" style="width:${sizePx}px;height:${sizePx}px" src="data:image/jpeg;base64,${base64Jpeg}" alt="" />`;
  }
  const initial = (displayName || "?").trim().charAt(0).toUpperCase() || "?";
  return `<span class="avatar-fallback" style="width:${sizePx}px;height:${sizePx}px">${initial}</span>`;
}

function renderAvatar(container, base64Jpeg, displayName) {
  container.innerHTML = avatarHtml(base64Jpeg, displayName, 40);
}

// ─── Generic long-press-or-right-click context menu ────────────────────

function attachLongPress(el, callback) {
  let timer = null;
  let startX = 0, startY = 0;
  el.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    timer = setTimeout(() => callback(startX, startY), 500);
  });
  el.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) {
      clearTimeout(timer);
    }
  });
  el.addEventListener("touchend", () => clearTimeout(timer));
  el.addEventListener("touchcancel", () => clearTimeout(timer));
}

function showGenericMenu(x, y, items) {
  const menu = els.msgContextMenu;
  menu.innerHTML = "";
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.className = `ctx-item${item.danger ? " danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      menu.classList.add("hidden");
      item.action();
    });
    menu.appendChild(btn);
  });
  menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - items.length * 40 - 20)}px`;
  menu.classList.remove("hidden");
}
document.addEventListener("click", (e) => {
  if (!e.target.closest("#msg-context-menu")) els.msgContextMenu.classList.add("hidden");
});

// ─── Dialog helpers ─────────────────────────────────────────────────

function openDialog(dialogEl) {
  dialogEl.classList.remove("hidden");
}
function closeDialog(dialogEl) {
  dialogEl.classList.add("hidden");
}
document.querySelectorAll("[data-close-dialog]").forEach((btn) => {
  btn.addEventListener("click", () => closeDialog(btn.closest(".dialog-backdrop")));
});
document.querySelectorAll(".dialog-backdrop").forEach((backdrop) => {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) closeDialog(backdrop);
  });
});

function flashToast(text) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = text;
  document.body.appendChild(toast);
  setTimeout(() => toast.classList.add("show"), 10);
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 300);
  }, 1800);
}

// ─── Misc helpers ─────────────────────────────────────────────────────

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
