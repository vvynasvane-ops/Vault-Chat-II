// js/messaging.js
//
// Mirrors app/src/.../util/MessageSender.java exactly: messages are dropped
// as encrypted mailbox entries at /messages/{recipientUid}/{messageId} in the
// Realtime Database, read once by whichever client (Android or web) is next
// online, decrypted, saved locally, then deleted from the server. There is no
// server-side chat history — that's by design (see the block comment in
// MessageSender.java), so this web client and the Android app share message
// delivery, not message storage.
//
// Signal types carried through the same mailbox (all still relay-and-delete):
//   TEXT            - Section 3, core messaging
//   KEY_EXCHANGE    - initial/rotated public key handoff
//   IMAGE/VIDEO/    - Section 7, encrypted file/image/video/audio bytes
//   AUDIO/FILE        (type is the concrete media kind, matching the RTDB
//                      rules' validated type list — no wrapper "MEDIA" type)
//   DELIVERY_ACK    - Section 3, message status: Sent -> Delivered
//   READ_ACK        - Section 3, message status: Delivered -> Read
//   EDIT            - Section 5, edit synced to the recipient's copy
//   DELETE_EVERYONE - Section 5, true delete-for-everyone tombstone

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
import {
  deriveSharedKey,
  encryptText,
  decryptText,
  encryptBytes,
  decryptBytes,
  toBase64,
  fromBase64,
} from "./crypto.js";

const MESSAGES_PATH = "messages";
const PRESENCE_PATH = "presence";

// Section 7 note: this mailbox is relay-and-delete (no server-side chat
// history by design — see block comment above), so a media message has to
// fit in a single RTDB node write. This cap keeps that write reliable; it
// is a web-client transport limit, not a feature limit.
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024; // 8MB

export function buildConversationId(uid1, uid2) {
  return uid1 < uid2 ? `${uid1}_${uid2}` : `${uid2}_${uid1}`;
}

async function mailbox(recipientUid, messageId, payload) {
  await set(ref(rtdb, `${MESSAGES_PATH}/${recipientUid}/${messageId}`), payload);
}

// ─── Send: text (Section 3) ──────────────────────────────────────────────

export async function sendText(myUid, recipientUid, theirPublicKeyBase64, plaintext) {
  const messageId = crypto.randomUUID();
  const convId = buildConversationId(myUid, recipientUid);
  const timestamp = Date.now();

  const localMessage = {
    messageId,
    conversationId: convId,
    senderId: myUid,
    receiverId: recipientUid,
    content: plaintext,
    messageType: "TEXT",
    timestamp,
    isSentByMe: true,
    status: "SENDING",
    edited: false,
    deletedForEveryone: false,
    pinned: false,
  };
  await idb.put("messages", localMessage);

  try {
    const aesKey = await deriveSharedKey(theirPublicKeyBase64);
    const encryptedContent = await encryptText(aesKey, plaintext);
    await mailbox(recipientUid, messageId, {
      messageId,
      senderId: myUid,
      encryptedContent,
      type: "TEXT",
      timestamp,
    });
    localMessage.status = "SENT";
  } catch (err) {
    localMessage.status = "FAILED";
    await idb.put("messages", localMessage);
    throw err;
  }
  await idb.put("messages", localMessage);
  return localMessage;
}

export async function sendKeyExchange(myUid, recipientUid, myPublicKeyBase64) {
  const exchangeId = crypto.randomUUID();
  await mailbox(recipientUid, exchangeId, {
    messageId: exchangeId,
    senderId: myUid,
    type: "KEY_EXCHANGE",
    publicKey: myPublicKeyBase64,
    timestamp: Date.now(),
  });
}

// ─── Send: media (Section 7 — Media & File Sharing) ──────────────────────
// message type is auto-detected from the file's MIME type, same as the
// Android picker: image/* -> IMAGE, video/* -> VIDEO, audio/* -> AUDIO,
// anything else -> FILE.

function detectMediaType(mimeType) {
  if (mimeType.startsWith("image/")) return "IMAGE";
  if (mimeType.startsWith("video/")) return "VIDEO";
  if (mimeType.startsWith("audio/")) return "AUDIO";
  return "FILE";
}

export async function sendMediaFile(myUid, recipientUid, theirPublicKeyBase64, file) {
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error(
      `"${file.name}" is too large to send (${Math.round(file.size / 1024 / 1024)}MB). ` +
        `Max ${Math.round(MAX_MEDIA_BYTES / 1024 / 1024)}MB per file over this relay.`
    );
  }

  const messageId = crypto.randomUUID();
  const convId = buildConversationId(myUid, recipientUid);
  const timestamp = Date.now();
  const mediaType = detectMediaType(file.type || "application/octet-stream");

  // Keep the original bytes locally right away so the sender's own bubble
  // renders instantly, same as Android's optimistic local insert.
  await idb.put("media", file, messageId);

  const localMessage = {
    messageId,
    conversationId: convId,
    senderId: myUid,
    receiverId: recipientUid,
    content: file.name,
    messageType: mediaType,
    mimeType: file.type || "application/octet-stream",
    fileName: file.name,
    fileSize: file.size,
    timestamp,
    isSentByMe: true,
    status: "SENDING",
    edited: false,
    deletedForEveryone: false,
    pinned: false,
  };
  await idb.put("messages", localMessage);

  try {
    const aesKey = await deriveSharedKey(theirPublicKeyBase64);
    const rawBytes = new Uint8Array(await file.arrayBuffer());
    const encryptedBytes = await encryptBytes(aesKey, rawBytes);
    await mailbox(recipientUid, messageId, {
      messageId,
      senderId: myUid,
      // `type` matches the RTDB rules' validated set directly
      // (IMAGE|VIDEO|FILE|AUDIO) — no separate "MEDIA" wrapper type.
      type: mediaType,
      fileName: file.name,
      mimeType: file.type || "application/octet-stream",
      fileSize: file.size,
      encryptedMedia: toBase64(encryptedBytes),
      timestamp,
    });
    localMessage.status = "SENT";
  } catch (err) {
    localMessage.status = "FAILED";
    await idb.put("messages", localMessage);
    throw err;
  }
  await idb.put("messages", localMessage);
  return localMessage;
}

// ─── Edit & delete, synced both ends (Section 5) ─────────────────────────

export async function sendEdit(recipientUid, myUid, theirPublicKeyBase64, messageId, newPlaintext) {
  const aesKey = await deriveSharedKey(theirPublicKeyBase64);
  const encryptedContent = await encryptText(aesKey, newPlaintext);
  const signalId = crypto.randomUUID();
  await mailbox(recipientUid, signalId, {
    messageId: signalId,
    senderId: myUid,
    type: "EDIT",
    targetMessageId: messageId,
    encryptedContent,
    timestamp: Date.now(),
  });
}

export async function sendDeleteEveryone(recipientUid, myUid, messageId) {
  const signalId = crypto.randomUUID();
  await mailbox(recipientUid, signalId, {
    messageId: signalId,
    senderId: myUid,
    type: "DELETE_EVERYONE",
    targetMessageId: messageId,
    timestamp: Date.now(),
  });
}

// ─── Delivery / read receipts (Section 3) ────────────────────────────────

export async function sendDeliveryAck(recipientUid, myUid, messageId) {
  const signalId = crypto.randomUUID();
  await mailbox(recipientUid, signalId, {
    messageId: signalId,
    senderId: myUid,
    type: "DELIVERY_ACK",
    targetMessageId: messageId,
    timestamp: Date.now(),
  });
}

export async function sendReadAck(recipientUid, myUid, messageIds) {
  if (!messageIds.length) return;
  const signalId = crypto.randomUUID();
  await mailbox(recipientUid, signalId, {
    messageId: signalId,
    senderId: myUid,
    type: "READ_ACK",
    targetMessageIds: messageIds,
    timestamp: Date.now(),
  });
}

// ─── Receive (mirrors VaultMessageListener) ──────────────────────────────
//
// Call startInbox(myUid, handlers) once after login. It listens for new
// children under /messages/{myUid}, decrypts, stores locally, deletes the
// server copy, and invokes the matching handler.
//
// handlers:
//   resolveSender(uid)              -> profile (used for TEXT/media/EDIT)
//   onText(localMessage)            -> new decrypted text message saved
//   onMedia(localMessage)           -> new decrypted media message saved
//   onKeyExchange(msg)              -> a contact's public key arrived
//   onEdited(localMessage)          -> an earlier message was edited
//   onDeletedEveryone(localMessage) -> an earlier message was tombstoned
//   onDeliveryAck(messageId)        -> our sent message was delivered
//   onReadAck(messageIds)           -> our sent messages were read

let inboxRef = null;

export function startInbox(myUid, handlers) {
  inboxRef = ref(rtdb, `${MESSAGES_PATH}/${myUid}`);
  onChildAdded(inboxRef, async (snapshot) => {
    const msg = snapshot.val();
    const nodeRef = ref(rtdb, `${MESSAGES_PATH}/${myUid}/${snapshot.key}`);

    try {
      if (msg.type === "KEY_EXCHANGE") {
        handlers.onKeyExchange && (await handlers.onKeyExchange(msg));
      } else if (msg.type === "DELIVERY_ACK") {
        handlers.onDeliveryAck && (await handlers.onDeliveryAck(msg.targetMessageId));
      } else if (msg.type === "READ_ACK") {
        handlers.onReadAck && (await handlers.onReadAck(msg.targetMessageIds || []));
      } else if (msg.type === "EDIT") {
        const senderProfile = await handlers.resolveSender(msg.senderId);
        const aesKey = await deriveSharedKey(senderProfile.publicKeyBase64);
        const plaintext = await decryptText(aesKey, msg.encryptedContent);
        const existing = await idb.get("messages", msg.targetMessageId);
        if (existing) {
          existing.content = plaintext;
          existing.edited = true;
          await idb.put("messages", existing);
          handlers.onEdited && handlers.onEdited(existing);
        }
      } else if (msg.type === "DELETE_EVERYONE") {
        const existing = await idb.get("messages", msg.targetMessageId);
        if (existing) {
          existing.content = "";
          existing.deletedForEveryone = true;
          existing.pinned = false;
          await idb.put("messages", existing);
          await idb.delete("media", msg.targetMessageId);
          handlers.onDeletedEveryone && handlers.onDeletedEveryone(existing);
        }
      } else if (msg.type === "TEXT") {
        const senderProfile = await handlers.resolveSender(msg.senderId);
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
          edited: false,
          deletedForEveryone: false,
          pinned: false,
        };
        await idb.put("messages", localMessage);
        handlers.onText && handlers.onText(localMessage);
      } else if (["IMAGE", "VIDEO", "AUDIO", "FILE"].includes(msg.type)) {
        const senderProfile = await handlers.resolveSender(msg.senderId);
        const aesKey = await deriveSharedKey(senderProfile.publicKeyBase64);
        const encryptedBytes = fromBase64(msg.encryptedMedia);
        const rawBytes = await decryptBytes(aesKey, encryptedBytes);
        const blob = new Blob([rawBytes], { type: msg.mimeType });
        await idb.put("media", blob, msg.messageId);

        const convId = buildConversationId(myUid, msg.senderId);
        const localMessage = {
          messageId: msg.messageId,
          conversationId: convId,
          senderId: msg.senderId,
          receiverId: myUid,
          content: msg.fileName,
          messageType: msg.type,
          mimeType: msg.mimeType,
          fileName: msg.fileName,
          fileSize: msg.fileSize,
          timestamp: msg.timestamp,
          isSentByMe: false,
          status: "DELIVERED",
          edited: false,
          deletedForEveryone: false,
          pinned: false,
        };
        await idb.put("messages", localMessage);
        handlers.onMedia && handlers.onMedia(localMessage);
      }
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

export async function clearConversation(uid1, uid2) {
  const messages = await getConversationHistory(uid1, uid2);
  for (const m of messages) {
    await idb.delete("messages", m.messageId);
    await idb.delete("media", m.messageId);
  }
}
