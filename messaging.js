// js/messaging.js
//
// Mirrors app/src/.../util/MessageSender.java exactly: messages are dropped
// as encrypted mailbox entries at /messages/{recipientUid}/{messageId} in the
// Realtime Database, read once by whichever client (Android or web) is next
// online, decrypted, saved locally, then deleted from the server. There is no
// server-side chat history — that's by design (see the block comment in
// MessageSender.java), so this web client and the Android app share message
// delivery, not message storage.

import {
  ref,
  push,
  set,
  remove,
  onChildAdded,
  off,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { rtdb } from "./firebase-config.js";
import { idb } from "./idb.js";
import { deriveSharedKey, encryptText, decryptText } from "./crypto.js";

const MESSAGES_PATH = "messages";
const PRESENCE_PATH = "presence";

export function buildConversationId(uid1, uid2) {
  return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

// ─── Send ─────────────────────────────────────────────────────────────

export async function sendText(myUid, recipientUid, theirPublicKeyBase64, plaintext) {
  const aesKey = await deriveSharedKey(theirPublicKeyBase64);
  const encryptedContent = await encryptText(aesKey, plaintext);

  const messageId = crypto.randomUUID();
  const timestamp = Date.now();

  const payload = {
    messageId,
    senderId: myUid,
    encryptedContent,
    type: "TEXT",
    timestamp,
  };

  await set(ref(rtdb, `${MESSAGES_PATH}/${recipientUid}/${messageId}`), payload);

  const convId = buildConversationId(myUid, recipientUid);
  const localMessage = {
    messageId,
    conversationId: convId,
    senderId: myUid,
    receiverId: recipientUid,
    content: plaintext,
    messageType: "TEXT",
    timestamp,
    isSentByMe: true,
    status: "SENT",
  };
  await idb.put("messages", localMessage);
  return localMessage;
}

export async function sendKeyExchange(myUid, recipientUid, myPublicKeyBase64) {
  const exchangeId = crypto.randomUUID();
  await set(ref(rtdb, `${MESSAGES_PATH}/${recipientUid}/${exchangeId}`), {
    messageId: exchangeId,
    senderId: myUid,
    type: "KEY_EXCHANGE",
    publicKey: myPublicKeyBase64,
    timestamp: Date.now(),
  });
}

// ─── Receive (mirrors VaultMessageListener) ──────────────────────────────
//
// Call startInbox(myUid, handlers) once after login. It listens for new
// children under /messages/{myUid}, decrypts, stores locally, deletes the
// server copy, and invokes the matching handler.

let inboxRef = null;

export function startInbox(myUid, { onText, onKeyExchange, onAck }) {
  inboxRef = ref(rtdb, `${MESSAGES_PATH}/${myUid}`);
  onChildAdded(inboxRef, async (snapshot) => {
    const msg = snapshot.val();
    const nodeRef = ref(rtdb, `${MESSAGES_PATH}/${myUid}/${snapshot.key}`);

    try {
      if (msg.type === "KEY_EXCHANGE") {
        onKeyExchange && (await onKeyExchange(msg));
      } else if (msg.type === "DELIVERY_ACK" || msg.type === "READ_ACK") {
        onAck && (await onAck(msg));
      } else if (msg.type === "TEXT") {
        const senderProfile = await onText.resolveSender(msg.senderId);
        const aesKey = await deriveSharedKey(senderProfile.publicKeyBase64);
        const plaintext = await decryptText(aesKey, msg.encryptedContent);

        const convId = buildConversationId(myUid, msg.senderId);
        const localMessage = {
          messageId: msg.messageId,
          conversationId: convId,
          senderId: msg.senderId,
          receiverId: myUid,
          content: plaintext,
          messageType: "TEXT",
          timestamp: msg.timestamp,
          isSentByMe: false,
          status: "DELIVERED",
        };
        await idb.put("messages", localMessage);
        onText.onMessage(localMessage);
      }
      // Media types (IMAGE/VIDEO/FILE/AUDIO) follow the same shape with an
      // added encryptedMedia field — extend here the same way if you need
      // media support in the web client.
    } finally {
      // Mailbox pattern: always delete after processing, success or not,
      // to match the Android client's "delete immediately after receipt".
      await remove(nodeRef);
    }
  });
}

export function stopInbox() {
  if (inboxRef) off(inboxRef);
  inboxRef = null;
}

// ─── Presence ─────────────────────────────────────────────────────────

export async function setOnlinePresence(uid, isOnline) {
  await set(ref(rtdb, `${PRESENCE_PATH}/${uid}`), { isOnline, lastSeen: Date.now() });
}

// ─── Local history ─────────────────────────────────────────────────────

export async function getConversationHistory(uid1, uid2) {
  const convId = buildConversationId(uid1, uid2);
  const messages = await idb.getAllByIndex("messages", "byConversation", convId);
  return messages.sort((a, b) => a.timestamp - b.timestamp);
}
