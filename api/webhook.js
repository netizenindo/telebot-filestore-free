// ============================================================
// TELEGRAM FILE-STORE BOT (tanpa database) — v2
// Webhook untuk Vercel Serverless Function
//
// Fitur:
// - Deep link ter-encode (base64url + obfuscation SECRET)
// - Batch link: 1 link = banyak file (range message_id)
// - protect_content: user tidak bisa forward/save (opsional)
// - Custom caption: timpa caption semua file terkirim (opsional)
// - Force subscribe (opsional)
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;
const STORAGE_CHANNEL_ID = Number(process.env.STORAGE_CHANNEL_ID);
const SECRET = Number(process.env.SECRET || 7919);
const FORCE_SUB_CHANNEL = process.env.FORCE_SUB_CHANNEL || "";
const BOT_USERNAME = process.env.BOT_USERNAME;
const ADMIN_ID = Number(process.env.ADMIN_ID || 0);          // user_id kamu, untuk perintah /batch
const PROTECT_CONTENT = process.env.PROTECT_CONTENT === "true"; // "true" = tidak bisa forward/save
const CUSTOM_CAPTION = process.env.CUSTOM_CAPTION || "";     // kosong = pakai caption asli
const MAX_BATCH = 30; // batas file per batch (jaga-jaga limit eksekusi Vercel 10 detik)

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ---------- Helper: panggil Bot API ----------
async function tg(method, payload) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  return res.json();
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

// Single file: encode(id * SECRET)
function encodeSingle(messageId) {
  return b64urlEncode(String(messageId * SECRET));
}

// Batch: encode(`${awal*SECRET}-${akhir*SECRET}`)
function encodeBatch(firstId, lastId) {
  return b64urlEncode(`${firstId * SECRET}-${lastId * SECRET}`);
}

// Return: { type: "single", id } | { type: "batch", first, last } | null
function decodePayload(encoded) {
  try {
    const raw = b64urlDecode(encoded);
    const parts = raw.split("-").map(Number);

    if (parts.some((n) => !Number.isInteger(n) || n <= 0 || n % SECRET !== 0)) {
      return null; // payload palsu / hasil tebak-tebakan
    }

    if (parts.length === 1) {
      return { type: "single", id: parts[0] / SECRET };
    }
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

// ---------- Parse message_id dari input admin ----------
// Menerima: angka polos "253847" ATAU link "https://t.me/c/1234567890/253847"
function parseMessageId(input) {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/t\.me\/c\/\d+\/(\d+)/);
  if (match) return Number(match[1]);
  return null;
}

// ---------- Cek force subscribe ----------
async function isSubscribed(userId) {
  if (!FORCE_SUB_CHANNEL) return true;
  const r = await tg("getChatMember", {
    chat_id: FORCE_SUB_CHANNEL,
    user_id: userId,
  });
  if (!r.ok) return true;
  return ["member", "administrator", "creator"].includes(r.result.status);
}

// ---------- Kirim 1 file dari storage ke user ----------
async function sendFile(chatId, messageId) {
  const params = {
    chat_id: chatId,
    from_chat_id: STORAGE_CHANNEL_ID,
    message_id: messageId,
    protect_content: PROTECT_CONTENT,
  };
  // Timpa caption kalau CUSTOM_CAPTION diisi.
  // Catatan: ini MENGGANTI caption asli, bukan menambahkan.
  if (CUSTOM_CAPTION) params.caption = CUSTOM_CAPTION;
  return tg("copyMessage", params);
}

// ---------- Handler utama ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot aktif ✅");
  }

  const update = req.body;

  try {
    // ==========================================================
    // 1) POST BARU DI CHANNEL STORAGE -> generate deep link
    // ==========================================================
    if (update.channel_post && update.channel_post.chat.id === STORAGE_CHANNEL_ID) {
      const msg = update.channel_post;
      const hasFile =
        msg.document || msg.video || msg.audio || msg.photo ||
        msg.animation || msg.voice || msg.video_note;

      if (hasFile) {
        const link = `https://t.me/${BOT_USERNAME}?start=getfile_${encodeSingle(msg.message_id)}`;
        await tg("sendMessage", {
          chat_id: STORAGE_CHANNEL_ID,
          reply_to_message_id: msg.message_id,
          text: `🔗 Link file (ID: ${msg.message_id}):\n${link}`,
          disable_web_page_preview: true,
        });
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

      // ---- /batch (khusus admin): /batch <awal> <akhir> ----
      // <awal>/<akhir> boleh angka message_id atau link t.me/c/...
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
              "Format:\n/batch <awal> <akhir>\n\n" +
              "Contoh:\n/batch 253847 253858\n" +
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
          await tg("sendMessage", {
            chat_id: chatId,
            text: "❌ Link tidak valid atau sudah kedaluwarsa.",
          });
          return res.status(200).json({ ok: true });
        }

        // cek force subscribe
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
          // batch: kirim berurutan, lewati yang gagal (mis. pesan terhapus)
          let sent = 0;
          for (let id = decoded.first; id <= decoded.last; id++) {
            const r = await sendFile(chatId, id);
            if (r.ok) sent++;
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
          text:
            "👋 Halo! Aku bot penyimpan file.\n\n" +
            "Klik link file dari channel untuk mengambil filenya di sini.",
        });
        return res.status(200).json({ ok: true });
      }

      // ---- pesan lain ----
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
