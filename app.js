// js/app.js — logic for chat.html (contact list + conversation view)
// Mirrors ui/activities/MainActivity.java and ChatActivity.java

import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase-config.js";
import {
  getProfile,
  searchByIdCode,
  addContact,
  removeContact,
  getContactUids,
  updatePublicKey,
} from "./firestore-api.js";
import { getOrCreatePublicKeyBase64 } from "./crypto.js";
import {
  sendText,
  sendKeyExchange,
  startInbox,
  stopInbox,
  setOnlinePresence,
  getConversationHistory,
  buildConversationId,
} from "./messaging.js";

let myUid = null;
let myProfile = null;
let contacts = new Map(); // uid -> profile
let activeContactUid = null;

const els = {
  myName: document.getElementById("my-display-name"),
  myIdCode: document.getElementById("my-id-code"),
  logoutBtn: document.getElementById("btn-logout"),
  addContactBtn: document.getElementById("btn-add-contact"),
  addContactInput: document.getElementById("input-friend-code"),
  addContactError: document.getElementById("add-contact-error"),
  contactList: document.getElementById("contact-list"),
  emptyState: document.getElementById("empty-state"),
  chatPane: document.getElementById("chat-pane"),
  chatWithName: document.getElementById("chat-with-name"),
  chatWithCode: document.getElementById("chat-with-code"),
  messageLog: document.getElementById("message-log"),
  messageForm: document.getElementById("message-form"),
  messageInput: document.getElementById("message-input"),
  removeContactBtn: document.getElementById("btn-remove-contact"),
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
  myProfile = await getProfile(myUid);
  els.myName.textContent = myProfile.displayName;
  els.myIdCode.textContent = `ID: ${myProfile.idCode}`;

  const myPublicKey = await getOrCreatePublicKeyBase64();
  await updatePublicKey(myUid, myPublicKey);

  await setOnlinePresence(myUid, true);
  window.addEventListener("beforeunload", () => {
    setOnlinePresence(myUid, false);
  });

  await refreshContacts();

  startInbox(myUid, {
    onText: {
      resolveSender: async (uid) => contacts.get(uid) || (await getProfile(uid)),
      onMessage: (localMessage) => {
        if (localMessage.senderId === activeContactUid) {
          renderMessage(localMessage);
          scrollToBottom();
        }
        bumpContactPreview(localMessage.senderId, localMessage.content, localMessage.timestamp);
      },
    },
    onKeyExchange: async (msg) => {
      // Refresh that contact's public key so future messages use the new one.
      const profile = await getProfile(msg.senderId);
      contacts.set(msg.senderId, profile);
    },
    onAck: async () => {
      /* delivery/read receipts — hook up UI here if desired */
    },
  });
}

async function refreshContacts() {
  const uids = await getContactUids(myUid);
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
    } catch (_) {
      // Contact's account may have been deleted; skip.
    }
  }
}

function renderContactRow(profile) {
  const row = document.createElement("button");
  row.className = "contact-row";
  row.dataset.uid = profile.uid;
  row.innerHTML = `
    <span class="avatar-dot" data-status="${profile.isOnline ? "online" : "offline"}"></span>
    <span class="contact-meta">
      <span class="contact-name">${escapeHtml(profile.displayName)}</span>
      <span class="contact-preview">ID ${profile.idCode}</span>
    </span>
  `;
  row.addEventListener("click", () => openConversation(profile.uid));
  els.contactList.appendChild(row);
}

function bumpContactPreview(uid, text, timestamp) {
  const row = els.contactList.querySelector(`[data-uid="${uid}"] .contact-preview`);
  if (row) row.textContent = text;
}

async function openConversation(uid) {
  activeContactUid = uid;
  const profile = contacts.get(uid);
  els.chatPane.classList.remove("hidden");
  document.getElementById("no-chat-state").classList.add("hidden");
  els.chatWithName.textContent = profile.displayName;
  els.chatWithCode.textContent = `ID ${profile.idCode}`;
  els.messageLog.innerHTML = "";

  document
    .querySelectorAll(".contact-row")
    .forEach((r) => r.classList.toggle("active", r.dataset.uid === uid));

  const history = await getConversationHistory(myUid, uid);
  history.forEach(renderMessage);
  scrollToBottom();

  // Make sure we have a session key with this contact; if not, kick off
  // a key exchange the same way ChatActivity does on first open.
  if (!profile.publicKeyBase64) {
    els.addContactError.textContent = "";
  }
}

function renderMessage(msg) {
  const bubble = document.createElement("div");
  bubble.className = `bubble ${msg.isSentByMe ? "mine" : "theirs"}`;
  bubble.innerHTML = `
    <span class="bubble-text">${escapeHtml(msg.content)}</span>
    <span class="bubble-time">${formatTime(msg.timestamp)}</span>
  `;
  els.messageLog.appendChild(bubble);
}

function scrollToBottom() {
  els.messageLog.scrollTop = els.messageLog.scrollHeight;
}

els.messageForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = els.messageInput.value.trim();
  if (!text || !activeContactUid) return;

  const profile = contacts.get(activeContactUid);
  els.messageInput.value = "";

  try {
    const localMessage = await sendText(myUid, activeContactUid, profile.publicKeyBase64, text);
    renderMessage(localMessage);
    bumpContactPreview(activeContactUid, text, localMessage.timestamp);
    scrollToBottom();
  } catch (err) {
    alert("Message failed to send: " + err.message);
  }
});

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
  await setOnlinePresence(myUid, false);
  stopInbox();
  sessionStorage.setItem("vc_uid", "signing_out");
  localStorage.removeItem("vc_session");
  await signOut(auth);
  window.location.href = "index.html";
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
