// ============================================================
// TELEGRAM FILE-STORE BOT (tanpa database)
// Webhook untuk Vercel Serverless Function
//
// Konsep:
// - Admin upload file ke CHANNEL STORAGE (private, bot = admin)
// - Bot otomatis balas dengan deep link: t.me/botmu?start=getfile_XXXX
// - User klik link -> bot copyMessage dari channel storage ke user
// - Payload di-encode base64url + obfuscation (dikali SECRET)
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN;                 // dari @BotFather
const STORAGE_CHANNEL_ID = Number(process.env.STORAGE_CHANNEL_ID); // contoh: -1001234567890
const SECRET = Number(process.env.SECRET || 7919);       // angka rahasia untuk obfuscation
const FORCE_SUB_CHANNEL = process.env.FORCE_SUB_CHANNEL || ""; // contoh: @channelpublikmu (kosongkan jika tidak pakai)
const BOT_USERNAME = process.env.BOT_USERNAME;           // tanpa @, contoh: asusiIabot

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

// ---------- Encode / Decode payload ----------
function encodePayload(messageId) {
  const obfuscated = messageId * SECRET; // obfuscation sederhana
  return Buffer.from(String(obfuscated))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodePayload(encoded) {
  try {
    let b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const obfuscated = Number(Buffer.from(b64, "base64").toString("utf8"));
    if (!Number.isInteger(obfuscated)) return null;
    if (obfuscated % SECRET !== 0) return null; // payload palsu / hasil tebak-tebakan
    return obfuscated / SECRET;
  } catch {
    return null;
  }
}

// ---------- Cek force subscribe (opsional) ----------
async function isSubscribed(userId) {
  if (!FORCE_SUB_CHANNEL) return true; // fitur dimatikan
  const r = await tg("getChatMember", {
    chat_id: FORCE_SUB_CHANNEL,
    user_id: userId,
  });
  if (!r.ok) return true; // kalau error (mis. bot bukan admin di channel), jangan blokir user
  const status = r.result.status;
  return ["member", "administrator", "creator"].includes(status);
}

// ---------- Handler utama ----------
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(200).send("Bot aktif ✅");
  }

  const update = req.body;

  try {
    // ==========================================================
    // 1) ADA POST BARU DI CHANNEL STORAGE -> generate deep link
    // ==========================================================
    if (update.channel_post && update.channel_post.chat.id === STORAGE_CHANNEL_ID) {
      const msg = update.channel_post;

      // hanya proses pesan yang mengandung file/media
      const hasFile =
        msg.document || msg.video || msg.audio || msg.photo ||
        msg.animation || msg.voice || msg.video_note;

      if (hasFile) {
        const payload = encodePayload(msg.message_id);
        const link = `https://t.me/${BOT_USERNAME}?start=getfile_${payload}`;

        // balas di channel storage dengan link siap copy
        await tg("sendMessage", {
          chat_id: STORAGE_CHANNEL_ID,
          reply_to_message_id: msg.message_id,
          text: `🔗 Link file:\n${link}`,
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

      // ---- /start dengan payload ----
      if (text.startsWith("/start getfile_")) {
        const encoded = text.slice("/start getfile_".length).trim();
        const messageId = decodePayload(encoded);

        if (!messageId) {
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
            text: `⚠️ Kamu harus join channel dulu untuk mengambil file ini.`,
            reply_markup: {
              inline_keyboard: [
                [{ text: "📢 Join Channel", url: `https://t.me/${FORCE_SUB_CHANNEL.replace("@", "")}` }],
                [{ text: "🔄 Coba Lagi", url: `https://t.me/${BOT_USERNAME}?start=getfile_${encoded}` }],
              ],
            },
          });
          return res.status(200).json({ ok: true });
        }

        // kirim file dari channel storage
        const r = await tg("copyMessage", {
          chat_id: chatId,
          from_chat_id: STORAGE_CHANNEL_ID,
          message_id: messageId,
          protect_content: false, // true = user tidak bisa forward/save
        });

        if (!r.ok) {
          await tg("sendMessage", {
            chat_id: chatId,
            text: "❌ File tidak ditemukan. Mungkin sudah dihapus dari storage.",
          });
        }

        return res.status(200).json({ ok: true });
      }

      // ---- /start biasa (tanpa payload) ----
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
    // selalu balas 200 agar Telegram tidak mengulang update terus-menerus
    return res.status(200).json({ ok: false });
  }
}
