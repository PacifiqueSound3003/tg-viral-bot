// src/index.js (V4.2)
// - UI centralisée (editMessageText partout)
// - Date/heure format FR + timezone Europe/Paris
// - Copier l'adresse: reste dans le même panneau
// - Vérifier/Rejoindre: si paiement pending -> message "en attente de confirmation"
// - Menu paiement limité: Menu + FAQ + Contact
// - Admin panel + bind/switch/config/stats + broadcast (manuel)

import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { q, getSetting, setSetting } from "./db.js";
import axios from "axios";
import { makeRefCode, nowPlusMinutes, isDeletedUser, shareLink } from "./utils.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_TG_ID = Number(process.env.ADMIN_TG_ID);
const INVITE_EXPIRE_MINUTES = Number(process.env.INVITE_EXPIRE_MINUTES || 30);

const PAY_BASE = Number(process.env.PAY_BASE || 3);
const PAY_STEP = Number(process.env.PAY_STEP || 0.001);
const PAY_SLOTS = Number(process.env.PAY_SLOTS || 200);
const PAY_EXPIRE_MINUTES = Number(process.env.PAY_EXPIRE_MINUTES || 30);
const USDT_ADDRESS_TRC20 = process.env.USDT_ADDRESS_TRC20 || "";

const ENFORCE_JOIN_REQUESTS =
  (process.env.ENFORCE_JOIN_REQUESTS || "true").toLowerCase() === "true";

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_TG_ID;
}

// ---------- Date formatter (FR + Europe/Paris) ----------
const fmtFR = (d) =>
  new Date(d).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// ---------- UI centralisée: edit ou reply ----------
async function upsertPanel(ctx, text, keyboard, opts = {}) {
  try {
    if (!opts.forceNew && ctx.updateType === "callback_query") {
      return await ctx.editMessageText(text, {
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...keyboard,
      });
    }
  } catch (e) {
    console.log("edit failed -> reply fallback:", e?.message);
  }
  return ctx.reply(text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard,
  });
}

// ---------- DB helpers ----------
async function ensureUser(ctx, referredByCode = null) {
  const u = ctx.from;
  const deleted = isDeletedUser(u);

  const existing = await q("select tg_id, ref_code from users where tg_id=$1", [
    u.id,
  ]);

  if (existing.rowCount === 0) {
    const refCode = makeRefCode();
    let referredBy = null;

    if (referredByCode) {
      const ref = await q("select tg_id from users where ref_code=$1", [
        referredByCode,
      ]);
      if (ref.rowCount > 0 && ref.rows[0].tg_id !== u.id) {
        referredBy = ref.rows[0].tg_id;
      }
    }

    await q(
      `insert into users (tg_id, username, first_name, ref_code, referred_by, is_deleted)
       values ($1,$2,$3,$4,$5,$6)`,
      [u.id, u.username || null, u.first_name || null, refCode, referredBy, deleted]
    );

    // Credit referral (MVP anti-fraud):
    // - no deleted accounts
    // - referred_tg_id unique prevents double credits
    if (referredBy && !deleted) {
      const already = await q(
        "select 1 from referrals where referred_tg_id=$1",
        [u.id]
      );
      if (already.rowCount === 0) {
        await q(
          "insert into referrals (referrer_tg_id, referred_tg_id) values ($1,$2)",
          [referredBy, u.id]
        );

        // Notify referrer (best effort)
        try {
          const cnt = await referralStats(referredBy);
          await bot.telegram.sendMessage(
            referredBy,
            `✅ 1 ami a rejoint via ton lien.\n👥 Invitations: ${cnt}/3`
          );
        } catch {}
      }
    }
  } else {
    await q(
      "update users set username=$2, first_name=$3, is_deleted=$4 where tg_id=$1",
      [u.id, u.username || null, u.first_name || null, deleted]
    );
  }
}

async function getUserRefLink(ctx) {
  const me = await q("select ref_code from users where tg_id=$1", [ctx.from.id]);
  const refCode = me.rows[0]?.ref_code;
  return `https://t.me/${ctx.me}?start=ref_${refCode}`;
}

async function referralStats(tgId) {
  const res = await q(
    "select count(*)::int as cnt from referrals where referrer_tg_id=$1",
    [tgId]
  );
  return res.rows[0].cnt;
}

async function hasConfirmedPayment(tgId) {
  const res = await q(
    "select 1 from payments where tg_id=$1 and status='confirmed' limit 1",
    [tgId]
  );
  return res.rowCount > 0;
}

async function hasPendingPayment(tgId) {
  const r = await q(
    "select expected_amount, expires_at from payments where tg_id=$1 and status='pending' and expires_at > now() order by created_at desc limit 1",
    [tgId]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function getEligibility(tgId) {
  const refs = await referralStats(tgId);
  const paid = await hasConfirmedPayment(tgId);
  return { refs, paid, eligible: paid || refs >= 3 };
}

// ---------- Settings: group rotation ----------
async function getActiveChatId() {
  const active = await getSetting("active_chat_id");
  if (active) return Number(active);

  const main = await getSetting("main_chat_id");
  if (main) {
    await setSetting("active_chat_id", main);
    return Number(main);
  }
  return null;
}

// ---------- Keyboards ----------
function kbHomeUser(eligible) {
  if (!eligible) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("👥 Inviter 3 personnes", "PAGE_REF")],
      [Markup.button.callback("💳 Payer 3$ (USDT)", "PAGE_PAY")],
      [Markup.button.callback("❓ FAQ", "PAGE_FAQ")],
      [Markup.button.callback("📩 Contact Team", "PAGE_CONTACT")],
    ]);
  }

  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Rejoindre le groupe", "ACTION_ACCESS")],
    [Markup.button.callback("ℹ️ Infos", "PAGE_INFO")],
    [Markup.button.callback("❓ FAQ", "PAGE_FAQ")],
    [Markup.button.callback("📩 Contact Team", "PAGE_CONTACT")],
  ]);
}

function kbReferral(refLink) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📤 Partager mon lien", shareLink(refLink))],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
  ]);
}

function kbPay() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Vérifier / Rejoindre", "ACTION_ACCESS")],
    [Markup.button.callback("📋 Copier l'adresse", "COPY_ADDRESS")],
    [
      Markup.button.callback("❓ FAQ", "PAGE_FAQ"),
      Markup.button.callback("📩 Contact", "PAGE_CONTACT"),
    ],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
  ]);
}

function kbAdmin() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("📌 Principal", "ADMIN_BIND_MAIN_HELP"),
      Markup.button.callback("🛟 Backup", "ADMIN_BIND_BACKUP_HELP"),
    ],
    [
      Markup.button.callback("🔁 Activer Backup", "ADMIN_SWITCH_BACKUP"),
      Markup.button.callback("👀 Config", "ADMIN_CONFIG"),
    ],
    [
      Markup.button.callback("🔁 Activer Principal", "ADMIN_SWITCH_MAIN"),
      Markup.button.callback("📊 Stats", "ADMIN_STATS"),
    ],
    [Markup.button.callback("📣 Broadcast", "ADMIN_BROADCAST_HELP")],
  ]);
}

function kbBackToHome() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu", "PAGE_HOME")]]);
}

// ---------- Pages: USER ----------
async function renderHomeUser(ctx, opts = {}) {
  const refLink = await getUserRefLink(ctx);
  const { refs, paid, eligible } = await getEligibility(ctx.from.id);

  const text = `<b>👋 Bienvenue !</b>

<b>🔒 Accès au groupe premium :</b>
• 💳 Paiement 3$
OU
• 👥 Inviter 3 personnes (qui cliquent Start)

<b>📌 Ton lien :</b>
${refLink}

<b>📈 Invitations :</b> ${refs}/3
<b>💳 Paiement :</b> ${paid ? "OK" : "non"}
<b>✅ Statut :</b> ${eligible ? "Adhérent" : "Non adhérent"}`;

  return upsertPanel(ctx, text, kbHomeUser(eligible), opts);
}

async function renderReferral(ctx) {
  const refLink = await getUserRefLink(ctx);
  const refs = await referralStats(ctx.from.id);

  const text = `<b>👥 Inviter 3 personnes</b>

Partage ce lien :
${refLink}

✅ Invitations validées : <b>${refs}/3</b>

⚠️ Compte uniquement si la personne appuie sur Start.`;

  return upsertPanel(ctx, text, kbReferral(refLink));
}

async function renderPay(ctx) {
  if (isAdmin(ctx)) return renderAdminHome(ctx);

  if (!USDT_ADDRESS_TRC20) {
    return upsertPanel(
      ctx,
      "⚠️ Paiement non configuré (USDT_ADDRESS_TRC20 manquant).",
      kbBackToHome()
    );
  }

  const existing = await q(
    "select * from payments where tg_id=$1 and status='pending' and expires_at > now() order by created_at desc limit 1",
    [ctx.from.id]
  );

  if (existing.rowCount > 0) {
    const p = existing.rows[0];
    const text = `💳 <b>Paiement en attente</b>

Envoie exactement : <b>${p.expected_amount} USDT</b> (TRC20)
Adresse :
<code>${USDT_ADDRESS_TRC20}</code>

⏳ Valable jusqu’à : ${fmtFR(p.expires_at)}

Ensuite clique “🔄 Vérifier / Rejoindre”.`;

    return upsertPanel(ctx, text, kbPay());
  }

  // réserve un montant unique
  const pending = await q(
    "select expected_amount from payments where status='pending' and expires_at > now()"
  );
  const used = new Set(pending.rows.map((r) => String(r.expected_amount)));

  let amount = null;
  for (let i = 1; i <= PAY_SLOTS; i++) {
    const candidate = (PAY_BASE + i * PAY_STEP).toFixed(6);
    if (!used.has(candidate)) {
      amount = candidate;
      break;
    }
  }

  if (!amount) {
    return upsertPanel(
      ctx,
      "❌ Trop de paiements en attente. Réessaie dans quelques minutes.",
      kbBackToHome()
    );
  }

  const expiresAt = nowPlusMinutes(PAY_EXPIRE_MINUTES);
  await q(
    "insert into payments (tg_id, expected_amount, status, expires_at) values ($1,$2,'pending',$3)",
    [ctx.from.id, amount, expiresAt]
  );

  const text = `💳 <b>Paiement (USDT TRC20)</b>

1) Envoie exactement : <b>${amount} USDT</b>
2) À l’adresse :
<code>${USDT_ADDRESS_TRC20}</code>
3) Valable <b>${PAY_EXPIRE_MINUTES} minutes</b>

Ensuite clique “🔄 Vérifier / Rejoindre”.

⚠️ Envoie sur le bon réseau (TRC20).`;

  return upsertPanel(ctx, text, kbPay());
}

async function renderFAQ(ctx) {
  const text = `<b>❓ FAQ</b>

<b>• Accès :</b>
Paiement 3$ (USDT) OU inviter 3 personnes (Start).

<b>• Pourquoi un lien temporaire ?</b>
Pour éviter les fuites.

<b>• Problème ?</b>
📩 Contact Team.`;

  return upsertPanel(ctx, text, kbBackToHome());
}

async function renderInfo(ctx) {
  const user = await q("select created_at from users where tg_id=$1", [ctx.from.id]);
  const createdAt = user.rows[0]?.created_at;

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);
  const method = paid ? "Paiement (USDT)" : refs >= 3 ? "Invitations (3)" : "Non adhérent";

  const text = `<b>ℹ️ Tes infos</b>

🗓 Inscription : ${fmtFR(createdAt)}
✅ Statut : <b>${eligible ? "Adhérent" : "Non adhérent"}</b>
🔑 Mode d’accès : <b>${method}</b>
👥 Invitations : <b>${refs}/3</b>`;

  return upsertPanel(ctx, text, kbBackToHome());
}

// ---------- Copier l'adresse (centralisé) ----------
bot.action("COPY_ADDRESS", async (ctx) => {
  await ctx.answerCbQuery();

  const text = `<b>📋 Adresse USDT (TRC20)</b>

<code>${USDT_ADDRESS_TRC20 || "—"}</code>

👉 Appuie longuement sur l’adresse pour copier.`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Retour paiement", "PAGE_PAY")],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
  ]);

  return upsertPanel(ctx, text, kb);
});

// ---------- ACCESS ----------
async function actionAccess(ctx) {
  if (isAdmin(ctx)) return renderAdminHome(ctx);

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);

  if (!eligible) {
    // Si paiement pending => message "en attente de confirmation"
    const pending = await hasPendingPayment(ctx.from.id);
    if (pending) {
      const text = `⏳ <b>Paiement en attente de confirmation</b>

Ton paiement est <b>en cours de confirmation</b> par nos algorithmes.

Montant : <b>${pending.expected_amount} USDT</b>
Valable jusqu’à : ${fmtFR(pending.expires_at)}

✅ Réessaie dans 1-2 minutes.`;

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("🔄 Vérifier à nouveau", "ACTION_ACCESS")],
        [
          Markup.button.callback("❓ FAQ", "PAGE_FAQ"),
          Markup.button.callback("📩 Contact", "PAGE_CONTACT"),
        ],
        [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
      ]);

      return upsertPanel(ctx, text, kb);
    }

    // Sinon: vrai non-validé
    const refLink = await getUserRefLink(ctx);
    const text = `⛔ <b>Accès non validé</b>

👥 Invitations : <b>${refs}/3</b>
💳 Paiement : <b>${paid ? "OK" : "non"}</b>

Choisis une option dans le menu.`;

    return upsertPanel(ctx, text, kbHomeUser(false));
  }

  const activeChatId = await getActiveChatId();
  if (!activeChatId) {
    return upsertPanel(
      ctx,
      "⚠️ Groupe non configuré. Demande à l’admin de binder le principal (/bind_main) et/ou backup (/bind_backup).",
      kbBackToHome()
    );
  }

  const expireDate = Math.floor(Date.now() / 1000) + INVITE_EXPIRE_MINUTES * 60;

  try {
    const link = await ctx.telegram.createChatInviteLink(activeChatId, {
      expire_date: expireDate,
      member_limit: 1,
    });

    const text = `✅ <b>Prêt !</b>

🔗 Lien (1 seule utilisation, expire dans <b>${INVITE_EXPIRE_MINUTES} min</b>) :
${link.invite_link}

${
  ENFORCE_JOIN_REQUESTS
    ? "🔐 Si le groupe est en <b>demande d’adhésion</b>, ton entrée sera approuvée automatiquement."
    : ""
}`;

    return upsertPanel(ctx, text, kbBackToHome());
  } catch (e) {
    console.error(e);
    return upsertPanel(
      ctx,
      "❌ Impossible de créer le lien. Vérifie que le bot est admin du groupe actif et a le droit de créer des liens d’invitation.",
      kbBackToHome()
    );
  }
}

// Join Requests enforcement (si activé dans le groupe)
bot.on("chat_join_request", async (ctx) => {
  try {
    if (!ENFORCE_JOIN_REQUESTS) return;

    const userId = ctx.from.id;
    const { eligible } = await getEligibility(userId);

    if (!eligible) {
      await ctx.telegram.declineChatJoinRequest(ctx.chat.id, userId);
      return;
    }
    await ctx.telegram.approveChatJoinRequest(ctx.chat.id, userId);
  } catch (e) {
    console.error("chat_join_request error:", e?.message || e);
  }
});

// ---------- Contact flow ----------
const CONTACT_STATE = new Map(); // tg_id -> type

async function renderContact(ctx) {
  const text = `<b>📩 Contact Team</b>\n\nChoisis un sujet :`;
  return upsertPanel(ctx, text, Markup.inlineKeyboard([
    [Markup.button.callback("💡 Recommandation", "CONTACT_REC")],
    [Markup.button.callback("🤝 Collaboration Projet", "CONTACT_COLLAB")],
    [Markup.button.callback("🛠 Remonter un problème", "CONTACT_BUG")],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
  ]));
}

async function promptContactText(ctx, type) {
  CONTACT_STATE.set(ctx.from.id, type);

  const label = {
    CONTACT_REC: "Recommandation",
    CONTACT_COLLAB: "Collaboration Projet",
    CONTACT_BUG: "Remonter un problème",
  }[type];

  const text = `<b>✍️ ${label}</b>

Écris ton message ici. Il sera envoyé à l’équipe.`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback("🏠 Annuler", "PAGE_HOME")]]);
  return upsertPanel(ctx, text, kb);
}

// ---------- Admin pages ----------
async function renderAdminHome(ctx, opts = {}) {
  if (!isAdmin(ctx)) return renderHomeUser(ctx, opts);

  const text = `<b>🛠 Mode Admin</b>

Tout se règle ici.`;
  return upsertPanel(ctx, text, kbAdmin(), opts);
}

async function renderAdminConfig(ctx) {
  const main = await getSetting("main_chat_id");
  const backup = await getSetting("backup_chat_id");
  const active = await getSetting("active_chat_id");

  const text = `<b>👀 Config</b>

📌 main_chat_id: <code>${main || "—"}</code>
🛟 backup_chat_id: <code>${backup || "—"}</code>
✅ active_chat_id: <code>${active || "—"}</code>

🔐 Join Requests: <b>${ENFORCE_JOIN_REQUESTS ? "ENFORCED" : "OFF"}</b>`;

  return upsertPanel(ctx, text, kbAdmin());
}

async function renderAdminStats(ctx) {
  const users = await q("select count(*)::int as n from users");
  const refs = await q("select count(*)::int as n from referrals");
  const paid = await q(
    "select count(*)::int as n from payments where status='confirmed'"
  );

  const eligible = await q(`
    select count(*)::int as n
    from users u
    where (exists(select 1 from payments p where p.tg_id=u.tg_id and p.status='confirmed')
           or (select count(*) from referrals r where r.referrer_tg_id=u.tg_id) >= 3)
  `);

  const conv =
    users.rows[0].n > 0
      ? ((eligible.rows[0].n / users.rows[0].n) * 100).toFixed(1)
      : "0.0";

  const text = `<b>📊 Stats</b>

👤 Users : <b>${users.rows[0].n}</b>
👥 Referrals : <b>${refs.rows[0].n}</b>
💳 Paiements confirmés : <b>${paid.rows[0].n}</b>
✅ Adhérents : <b>${eligible.rows[0].n}</b>
📈 Conversion : <b>${conv}%</b>`;

  return upsertPanel(ctx, text, kbAdmin());
}

// ---------- Broadcast admin (manuel) ----------
const ADMIN_BROADCAST_STATE = new Map(); // admin_id -> true/false

async function renderBroadcastHelp(ctx) {
  const text = `<b>📣 Broadcast</b>

Envoie un message à tous les utilisateurs (ceux qui ont fait Start).

✅ Exemple:
⚠️ Le groupe a changé. Ouvre le bot et clique 🔄 Rejoindre le groupe.`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✍️ Écrire", "ADMIN_BROADCAST_WRITE"),
      Markup.button.callback("🛠 Admin", "ADMIN_HOME"),
    ],
  ]);

  return upsertPanel(ctx, text, kb);
}

async function doBroadcast(text) {
  const users = await q("select tg_id from users");
  let ok = 0,
    fail = 0;

  // Throttle ~25 msg/sec
  for (const row of users.rows) {
    try {
      await bot.telegram.sendMessage(row.tg_id, text, {
        disable_web_page_preview: true,
      });
      ok++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  return { ok, fail, total: users.rows.length };
}

// ---------- Routes / start ----------
bot.start(async (ctx) => {
  const payload = (ctx.startPayload || "").trim();
  const referredByCode = payload.startsWith("ref_") ? payload.slice(4) : null;

  await ensureUser(ctx, referredByCode);

  if (isAdmin(ctx)) return renderAdminHome(ctx, { forceNew: true });
  return renderHomeUser(ctx, { forceNew: true });
});

// ---------- Navigation callbacks ----------
bot.action("PAGE_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return renderAdminHome(ctx);
  return renderHomeUser(ctx);
});

bot.action("PAGE_REF", async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return renderAdminHome(ctx);
  return renderReferral(ctx);
});

bot.action("PAGE_PAY", async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return renderAdminHome(ctx);
  return renderPay(ctx);
});

bot.action("PAGE_FAQ", async (ctx) => {
  await ctx.answerCbQuery();
  return renderFAQ(ctx);
});

bot.action("PAGE_INFO", async (ctx) => {
  await ctx.answerCbQuery();
  if (isAdmin(ctx)) return renderAdminHome(ctx);
  return renderInfo(ctx);
});

bot.action("PAGE_CONTACT", async (ctx) => {
  await ctx.answerCbQuery();
  return renderContact(ctx);
});

bot.action("ACTION_ACCESS", async (ctx) => {
  await ctx.answerCbQuery();
  return actionAccess(ctx);
});

// ---------- Contact callbacks ----------
bot.action(["CONTACT_REC", "CONTACT_COLLAB", "CONTACT_BUG"], async (ctx) => {
  await ctx.answerCbQuery();
  return promptContactText(ctx, ctx.callbackQuery.data);
});

// ---------- Admin callbacks ----------
bot.command("admin", async (ctx) => {
  if (!isAdmin(ctx)) return;
  return renderAdminHome(ctx, { forceNew: true });
});

bot.action("ADMIN_HOME", async (ctx) => {
  await ctx.answerCbQuery();
  return renderAdminHome(ctx);
});

bot.action("ADMIN_CONFIG", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  return renderAdminConfig(ctx);
});

bot.action("ADMIN_STATS", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  return renderAdminStats(ctx);
});

bot.action("ADMIN_BIND_MAIN_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const text = `<b>📌 Binder le groupe PRINCIPAL</b>

1) Ajoute le bot dans le groupe en admin
2) Tape <code>/bind_main</code> <b>dans le groupe</b> (pas en privé)`;

  return upsertPanel(ctx, text, kbAdmin());
});

bot.action("ADMIN_BIND_BACKUP_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const text = `<b>🛟 Binder le groupe BACKUP</b>

1) Ajoute le bot dans le groupe en admin
2) Tape <code>/bind_backup</code> <b>dans le groupe</b> (pas en privé)`;

  return upsertPanel(ctx, text, kbAdmin());
});

// typed inside groups
bot.command("bind_main", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat.type === "private")
    return ctx.reply("⚠️ Tape /bind_main dans le groupe (pas en privé).");

  await setSetting("main_chat_id", ctx.chat.id);
  await setSetting("active_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe PRINCIPAL bind : ${ctx.chat.id}\n(Et activé)`);
});

bot.command("bind_backup", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat.type === "private")
    return ctx.reply("⚠️ Tape /bind_backup dans le groupe (pas en privé).");

  await setSetting("backup_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe BACKUP bind : ${ctx.chat.id}`);
});

bot.action("ADMIN_SWITCH_BACKUP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const backup = await getSetting("backup_chat_id");
  if (!backup) {
    return upsertPanel(
      ctx,
      "❌ Pas de backup configuré. Fais /bind_backup dans le groupe backup.",
      kbAdmin()
    );
  }
  await setSetting("active_chat_id", backup);
  return upsertPanel(
    ctx,
    `🔁 Groupe actif = BACKUP (<code>${backup}</code>)`,
    kbAdmin()
  );
});

bot.action("ADMIN_SWITCH_MAIN", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const main = await getSetting("main_chat_id");
  if (!main) {
    return upsertPanel(
      ctx,
      "❌ Pas de principal configuré. Fais /bind_main dans le groupe principal.",
      kbAdmin()
    );
  }
  await setSetting("active_chat_id", main);
  return upsertPanel(
    ctx,
    `🔁 Groupe actif = PRINCIPAL (<code>${main}</code>)`,
    kbAdmin()
  );
});

// Broadcast
bot.action("ADMIN_BROADCAST_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;
  return renderBroadcastHelp(ctx);
});

bot.action("ADMIN_BROADCAST_WRITE", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  ADMIN_BROADCAST_STATE.set(ctx.from.id, true);
  const text = `<b>✍️ Broadcast</b>

Tape maintenant le message à envoyer à tous les utilisateurs.

⚠️ Conseil : garde-le court.`;

  return upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([[Markup.button.callback("🛠 Annuler", "ADMIN_HOME")]])
  );
});

// ---------- Text handler: contact + broadcast ----------
bot.on("text", async (ctx) => {
  // Broadcast mode
  if (isAdmin(ctx) && ADMIN_BROADCAST_STATE.get(ctx.from.id)) {
    ADMIN_BROADCAST_STATE.delete(ctx.from.id);

    const msg = ctx.message.text;
    const start = Date.now();
    const res = await doBroadcast(msg);
    const secs = ((Date.now() - start) / 1000).toFixed(1);

    return ctx.reply(
      `✅ Broadcast terminé.\n\nTotal: ${res.total}\nOK: ${res.ok}\nFail: ${res.fail}\nDurée: ${secs}s`,
      { disable_web_page_preview: true }
    );
  }

  // Contact mode
  const type = CONTACT_STATE.get(ctx.from.id);
  if (type) {
    CONTACT_STATE.delete(ctx.from.id);

    const label = {
      CONTACT_REC: "💡 Recommandation",
      CONTACT_COLLAB: "🤝 Collaboration Projet",
      CONTACT_BUG: "🛠 Problème",
    }[type];

    await ctx.telegram.sendMessage(
      ADMIN_TG_ID,
      `${label}\nDe: @${ctx.from.username || "sans_username"} (tg_id: ${ctx.from.id})\n\n${ctx.message.text}`
    );

    return ctx.reply("✅ Merci ! Ton message a été transmis à l’équipe.", {
      disable_web_page_preview: true,
    });
  }
});

// ---------- Global error catcher ----------
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err);
  try {
    if (ctx?.updateType === "callback_query") {
      ctx
        .answerCbQuery("⚠️ Erreur interne (logs).", { show_alert: true })
        .catch(() => {});
    }
  } catch {}
});

// ---------- Si modification le faire a partir d'ici ----------
const TRONSCAN_BASE = process.env.TRONSCAN_BASE || "https://apilist.tronscanapi.com";
const TRONSCAN_API_KEY = process.env.TRONSCAN_API_KEY || "";
const USDT_CONTRACT_TRON =
  process.env.USDT_CONTRACT_TRON || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const PAY_WATCH_INTERVAL_SEC = Number(process.env.PAY_WATCH_INTERVAL_SEC || 20);
const PAY_CONFIRM_MIN = Number(process.env.PAY_CONFIRM_MIN || 1);

function toSunUSDT(amountStr) {
  // USDT TRC20 = 6 decimals
  const [a, b = ""] = String(amountStr).split(".");
  const frac = (b + "000000").slice(0, 6);
  return BigInt(a) * 1000000n + BigInt(frac);
}

async function fetchTrc20TransfersLatest(addressBase58, limit = 50) {
  // Endpoint TronScan courant pour TRC20 transfers
  // Note: Selon TronScan, le JSON peut être { data: [...] } ou { token_transfers: [...] }
  const url =
    `${TRONSCAN_BASE}/api/token_trc20/transfers` +
    `?limit=${limit}&start=0&sort=-timestamp&relatedAddress=${encodeURIComponent(addressBase58)}`;

  const headers = {};
  if (TRONSCAN_API_KEY) headers["TRON-PRO-API-KEY"] = TRONSCAN_API_KEY;

  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data?.data || data?.token_transfers || data?.transfers || [];
}

function pickFields(t) {
  // Normalise un peu les champs TronScan (varie selon endpoint)
  const tokenId =
    t?.tokenInfo?.tokenId ||
    t?.tokenInfo?.address ||
    t?.contract_address ||
    t?.contractAddress ||
    "";

  const toAddr = t?.to_address || t?.toAddress || t?.to || t?.recipient || "";
  const fromAddr = t?.from_address || t?.fromAddress || t?.from || t?.sender || "";

  const ts =
    Number(t?.block_ts || t?.timestamp || t?.transferTime || t?.time || 0);

  const tx =
    t?.transaction_id || t?.hash || t?.transactionHash || t?.transactionId || null;

  // Amount: parfois "quant" (sun), parfois "amount_str"/"amount"
  const quant = t?.quant ?? t?.amount_in_sun ?? null;
  const amountStr = t?.amount_str ?? t?.amount ?? t?.value ?? null;

  const conf =
    Number(t?.confirmations || t?.confirmation || 0);

  // status: parfois "finalResult" / "contractRet" / "result"
  const status =
    (t?.finalResult || t?.contractRet || t?.result || "").toString().toUpperCase();

  return { tokenId, toAddr, fromAddr, ts, tx, quant, amountStr, conf, status };
}

async function autoConfirmPayments() {
  if (!USDT_ADDRESS_TRC20) return;

  // 1) pending payments (non expirés)
  const pending = await q(
    `select id, tg_id, expected_amount, created_at
     from payments
     where status='pending' and expires_at > now()
     order by created_at asc
     limit 200`
  );
  if (!pending.rowCount) return;

  // 2) fetch latest transfers once
  const transfers = await fetchTrc20TransfersLatest(USDT_ADDRESS_TRC20, 60);

  // 3) loop pending
  for (const p of pending.rows) {
    const expectedSun = toSunUSDT(p.expected_amount);
    const createdTs = new Date(p.created_at).getTime();

    const hit = transfers.find((raw) => {
      const t = pickFields(raw);

      // Must be USDT contract
      if (t.tokenId && t.tokenId !== USDT_CONTRACT_TRON) return false;

      // Must be incoming to our address
      if (t.toAddr && t.toAddr !== USDT_ADDRESS_TRC20) return false;

      // Must be after payment creation
      if (t.ts && t.ts < createdTs) return false;

      // Confirmations if available
      if (PAY_CONFIRM_MIN > 0 && t.conf && t.conf < PAY_CONFIRM_MIN) return false;

      // If status is provided and not success, ignore
      if (t.status && t.status.includes("FAIL")) return false;

      // Amount match
      if (t.quant != null) {
        try { return BigInt(t.quant) === expectedSun; } catch { return false; }
      }
      if (t.amountStr != null) {
        const s = String(t.amountStr);
        if (s.includes(".")) return toSunUSDT(s) === expectedSun;
        try { return BigInt(s) === expectedSun; } catch { return false; }
      }
      return false;
    });

    if (!hit) continue;

    const txHash =
      hit?.transaction_id || hit?.hash || hit?.transactionHash || null;

    // 4) confirm
    await q(
      "update payments set status='confirmed', tx_hash=$2 where id=$1",
      [p.id, txHash]
    );

    // 5) notify user
    try {
      await bot.telegram.sendMessage(
        p.tg_id,
        `✅ Paiement confirmé (${p.expected_amount} USDT).\nTu peux maintenant cliquer “🔄 Rejoindre le groupe”.`
      );
    } catch {}
  }
}

// 6) run loop
setInterval(() => {
  autoConfirmPayments().catch((e) =>
    console.error("autoConfirmPayments:", e?.response?.data || e?.message || e)
  );
}, PAY_WATCH_INTERVAL_SEC * 1000);

// ---------- Run ----------
bot
  .launch()
  .then(() => console.log("Bot running (polling)"))
  .catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));


