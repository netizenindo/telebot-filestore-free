// ============================================================
// TELEGRAM FILE-STORE BOT (tanpa database) — v3
// Webhook untuk Vercel Serverless Function
//
// Alur saat admin upload file ke CHANNEL STORAGE:
//   1. Bot generate deep link ter-encode
//   2. Bot reply link di channel storage
//   3. Bot kirim KATALOG (preview + link) ke CATALOG_CHANNEL_ID
//   4. Bot kirim SALINAN FILE ASLI ke ADMIN_ID (cadangan)
//
// Fitur lain:
//   - Batch link: 1 link = banyak file (range message_id)
//   - protect_content, custom caption, force subscribe
//   - Anti rate-limit: jeda antar kiriman + retry otomatis saat 429
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = Number(process.env.STORAGE_CHANNEL_ID);
const CATALOG_CHANNEL_ID = Number(process.env.CATALOG_CHANNEL_ID || 0); // channel katalog (link + preview)
const SECRET = Number(process.env.SECRET || 7919);
const FORCE_SUB_CHANNEL = process.env.FORCE_SUB_CHANNEL || "";
const BOT_USERNAME = process.env.BOT_USERNAME;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);
const PROTECT_CONTENT = process.env.PROTECT_CONTENT === "true";
const CUSTOM_CAPTION = process.env.CUSTOM_CAPTION || "";
const BACKUP_TO_ADMIN = process.env.BACKUP_TO_ADMIN !== "false"; // default aktif
const MAX_BATCH = 20; // diturunkan dari 30 agar aman terhadap rate limit + limit 10 detik Vercel

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------- Helper dasar ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Panggil Bot API dengan retry otomatis saat kena 429 (FloodWait)
async function tg(method, payload, retries = 2) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (!data.ok && data.error_code === 429 && retries > 0) {
    const wait = (data.parameters?.retry_after || 1) + 1;
    // jangan menunggu terlalu lama, limit eksekusi Vercel 10 detik
    if (wait <= 5) {
      await sleep(wait * 1000);
      return tg(method, payload, retries - 1);
    }
  }
  return data;
}

// ---------- Encode / Decode ----------
function b64urlEncode(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(encoded) {
  let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString("utf8");
}
function encodeSingle(messageId) {
  return b64urlEncode(String(messageId * SECRET));
}
function encodeBatch(firstId, lastId) {
  return b64urlEncode(`${firstId * SECRET}-${lastId * SECRET}`);
}
function decodePayload(encoded) {
  try {
    const parts = b64urlDecode(encoded).split("-").map(Number);
    if (parts.some((n) => !Number.isInteger(n) || n <= 0 || n % SECRET !== 0)) return null;
    if (parts.length === 1) return { type: "single", id: parts[0] / SECRET };
    if (parts.length === 2) {
      const first = parts[0] / SECRET;
      const last = parts[1] / SECRET;
      if (first > last || last - first + 1 > MAX_BATCH) return null;
      return { type: "batch", first, last };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- Utilitas file ----------
function parseMessageId(input) {
  const t = input.trim();
  if (/^\d+$/.test(t)) return Number(t);
  const m = t.match(/t\.me\/c\/\d+\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Ambil info file dari sebuah pesan channel
function getFileInfo(msg) {
  if (msg.video) {
    return {
      kind: "video",
      name: msg.video.file_name || "Video",
      size: msg.video.file_size,
      duration: msg.video.duration,
      thumb: msg.video.thumbnail?.file_id || msg.video.thumb?.file_id || null,
    };
  }
  if (msg.document) {
    return {
      kind: "document",
      name: msg.document.file_name || "Dokumen",
      size: msg.document.file_size,
      // dokumen video (mis. .mkv terkirim sebagai file) sering punya thumbnail juga
      thumb: msg.document.thumbnail?.file_id || msg.document.thumb?.file_id || null,
    };
  }
  if (msg.audio) {
    return {
      kind: "audio",
      name: msg.audio.file_name || msg.audio.title || "Audio",
      size: msg.audio.file_size,
      duration: msg.audio.duration,
      thumb: msg.audio.thumbnail?.file_id || null,
    };
  }
  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    return { kind: "photo", name: "Foto", size: largest.file_size, thumb: largest.file_id };
  }
  if (msg.animation) {
    return {
      kind: "animation",
      name: msg.animation.file_name || "GIF",
      size: msg.animation.file_size,
      thumb: msg.animation.thumbnail?.file_id || null,
    };
  }
  if (msg.voice) return { kind: "voice", name: "Pesan suara", size: msg.voice.file_size, thumb: null };
  if (msg.video_note) return { kind: "video_note", name: "Video note", size: msg.video_note.file_size, thumb: null };
  return null;
}

function formatSize(bytes) {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDuration(sec) {
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

// Escape untuk parse_mode HTML
function esc(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- Force subscribe ----------
async function isSubscribed(userId) {
  if (!FORCE_SUB_CHANNEL) return true;
  const r = await tg("getChatMember", { chat_id: FORCE_SUB_CHANNEL, user_id: userId });
  if (!r.ok) return true;
  return ["member", "administrator", "creator"].includes(r.result.status);
}

// ---------- Kirim file dari storage ke user ----------
async function sendFile(chatId, messageId) {
  const params = {
    chat_id: chatId,
    from_chat_id: STORAGE_CHANNEL_ID,
    message_id: messageId,
    protect_content: PROTECT_CONTENT,
  };
  if (CUSTOM_CAPTION) params.caption = CUSTOM_CAPTION;
  return tg("copyMessage", params);
}

// ---------- Kirim katalog (preview + link) ke channel katalog ----------
async function sendCatalog(info, link) {
  if (!CATALOG_CHANNEL_ID) return;

  const meta = [formatSize(info.size), formatDuration(info.duration)]
    .filter(Boolean)
    .join(" • ");

  const caption =
    `📁 <b>${esc(info.name)}</b>\n` +
    (meta ? `${esc(meta)}\n` : "") +
    `\n<a href="${link}">⬇️ Ambil file di sini</a>`;

  // Ada thumbnail -> kirim sebagai foto berkaption.
  // Tidak ada (zip, audio tanpa cover, dll) -> kirim teks biasa.
  if (info.thumb) {
    const r = await tg("sendPhoto", {
      chat_id: CATALOG_CHANNEL_ID,
      photo: info.thumb,
      caption,
      parse_mode: "HTML",
    });
    if (r.ok) return;
    // fallback kalau file_id thumbnail ditolak
  }

  await tg("sendMessage", {
    chat_id: CATALOG_CHANNEL_ID,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

// ---------- Handler utama ----------
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(200).send("Bot aktif ✅");

  const update = req.body;

  try {
    // ==========================================================
    // 1) POST BARU DI CHANNEL STORAGE
    // ==========================================================
    if (update.channel_post && update.channel_post.chat.id === STORAGE_CHANNEL_ID) {
      const msg = update.channel_post;
      const info = getFileInfo(msg);
      console.log("DEBUG keys:", Object.keys(msg));
      console.log("DEBUG document:", JSON.stringify(msg.document));
      console.log("DEBUG video:", JSON.stringify(msg.video));
      console.log("DEBUG info:", JSON.stringify(info));
      if (info) {
        const link = `https://t.me/${BOT_USERNAME}?start=getfile_${encodeSingle(msg.message_id)}`;

        // (a) reply link di channel storage
        await tg("sendMessage", {
          chat_id: STORAGE_CHANNEL_ID,
          reply_to_message_id: msg.message_id,
          text: `🔗 Link file (ID: ${msg.message_id}):\n${link}`,
          disable_web_page_preview: true,
        });

        // (b) katalog: preview + link ke channel kedua
        await sendCatalog(info, link);

        // (c) cadangan: salinan file asli ke chat pribadi admin
        if (BACKUP_TO_ADMIN && ADMIN_ID) {
          await tg("copyMessage", {
            chat_id: ADMIN_ID,
            from_chat_id: STORAGE_CHANNEL_ID,
            message_id: msg.message_id,
          });
        }
      }
      return res.status(200).json({ ok: true });
    }

    // ==========================================================
    // 2) PESAN DARI USER (private chat)
    // ==========================================================
    if (update.message && update.message.chat.type === "private") {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || "";

      // ---- /batch <awal> <akhir> (khusus admin) ----
      if (text.startsWith("/batch")) {
        if (msg.from.id !== ADMIN_ID) {
          await tg("sendMessage", { chat_id: chatId, text: "⛔ Perintah ini khusus admin." });
          return res.status(200).json({ ok: true });
        }

        const args = text.split(/\s+/).slice(1);
        if (args.length !== 2) {
          await tg("sendMessage", {
            chat_id: chatId,
            text:
              "Format:\n/batch <awal> <akhir>\n\nContoh:\n/batch 253847 253858\n" +
              "atau pakai link post:\n/batch https://t.me/c/1234/253847 https://t.me/c/1234/253858",
          });
          return res.status(200).json({ ok: true });
        }

        const first = parseMessageId(args[0]);
        const last = parseMessageId(args[1]);

        if (!first || !last || first > last) {
          await tg("sendMessage", { chat_id: chatId, text: "❌ ID tidak valid. Pastikan awal ≤ akhir." });
          return res.status(200).json({ ok: true });
        }
        if (last - first + 1 > MAX_BATCH) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: `❌ Maksimal ${MAX_BATCH} file per batch. Range kamu: ${last - first + 1} file.`,
          });
          return res.status(200).json({ ok: true });
        }

        const link = `https://t.me/${BOT_USERNAME}?start=getfile_${encodeBatch(first, last)}`;
        await tg("sendMessage", {
          chat_id: chatId,
          text: `📦 Batch link (${last - first + 1} file, ID ${first}–${last}):\n${link}`,
          disable_web_page_preview: true,
        });
        return res.status(200).json({ ok: true });
      }

      // ---- /start dengan payload ----
      if (text.startsWith("/start getfile_")) {
        const encoded = text.slice("/start getfile_".length).trim();
        const decoded = decodePayload(encoded);

        if (!decoded) {
          await tg("sendMessage", { chat_id: chatId, text: "❌ Link tidak valid atau sudah kedaluwarsa." });
          return res.status(200).json({ ok: true });
        }

        if (!(await isSubscribed(msg.from.id))) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: "⚠️ Kamu harus join channel dulu untuk mengambil file ini.",
            reply_markup: {
              inline_keyboard: [
                [{ text: "📢 Join Channel", url: `https://t.me/${FORCE_SUB_CHANNEL.replace("@", "")}` }],
                [{ text: "🔄 Coba Lagi", url: `https://t.me/${BOT_USERNAME}?start=getfile_${encoded}` }],
              ],
            },
          });
          return res.status(200).json({ ok: true });
        }

        if (decoded.type === "single") {
          const r = await sendFile(chatId, decoded.id);
          if (!r.ok) {
            await tg("sendMessage", {
              chat_id: chatId,
              text: "❌ File tidak ditemukan. Mungkin sudah dihapus dari storage.",
            });
          }
        } else {
          let sent = 0;
          for (let id = decoded.first; id <= decoded.last; id++) {
            const r = await sendFile(chatId, id);
            if (r.ok) sent++;
            await sleep(120); // jeda antar file, meredam rate limit
          }
          await tg("sendMessage", {
            chat_id: chatId,
            text: sent > 0
              ? `✅ ${sent} file terkirim.`
              : "❌ Tidak ada file yang bisa dikirim. Mungkin sudah dihapus dari storage.",
          });
        }
        return res.status(200).json({ ok: true });
      }

      // ---- /start biasa ----
      if (text.startsWith("/start")) {
        await tg("sendMessage", {
          chat_id: chatId,
          text: "👋 Halo! Aku bot penyimpan file.\n\nKlik link file dari channel untuk mengambil filenya di sini.",
        });
        return res.status(200).json({ ok: true });
      }

      await tg("sendMessage", {
        chat_id: chatId,
        text: "Kirim /start atau klik link file dari channel ya 🙂",
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false });
  }
}
