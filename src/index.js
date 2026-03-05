import "dotenv/config";
import { Telegraf, Markup } from "telegraf";
import { q, getSetting, setSetting } from "./db.js";
import { makeRefCode, nowPlusMinutes, isDeletedUser, shareLink } from "./utils.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

const ADMIN_TG_ID = Number(process.env.ADMIN_TG_ID);
const INVITE_EXPIRE_MINUTES = Number(process.env.INVITE_EXPIRE_MINUTES || 30);

const PAY_BASE = Number(process.env.PAY_BASE || 3);
const PAY_STEP = Number(process.env.PAY_STEP || 0.001);
const PAY_SLOTS = Number(process.env.PAY_SLOTS || 200);
const PAY_EXPIRE_MINUTES = Number(process.env.PAY_EXPIRE_MINUTES || 30);
const USDT_ADDRESS_TRC20 = process.env.USDT_ADDRESS_TRC20 || "";

/**
 * SECURITY MODE:
 * - If you enable Join Requests in the group, the bot can approve/decline requests.
 * - If not enabled, the bot still uses 1-use invite links, but someone can still share it within its lifetime.
 */
const ENFORCE_JOIN_REQUESTS = (process.env.ENFORCE_JOIN_REQUESTS || "true").toLowerCase() === "true";

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_TG_ID;
}

/* -----------------------------
   UI centralisée: edit ou reply
--------------------------------*/
async function upsertPanel(ctx, text, keyboard, opts = {}) {
  try {
    if (!opts.forceNew && ctx.updateType === "callback_query") {
      return await ctx.editMessageText(text, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard });
    }
  } catch (e) {
    // fallback si edit impossible
    console.log("edit failed -> reply fallback:", e?.message);
  }
  return ctx.reply(text, { parse_mode: "HTML", disable_web_page_preview: true, ...keyboard });
}

/* -----------------------------
   DB helpers
--------------------------------*/
async function ensureUser(ctx, referredByCode = null) {
  const u = ctx.from;
  const deleted = isDeletedUser(u);

  const existing = await q("select tg_id, ref_code from users where tg_id=$1", [u.id]);
  if (existing.rowCount === 0) {
    const refCode = makeRefCode();
    let referredBy = null;

    if (referredByCode) {
      const ref = await q("select tg_id from users where ref_code=$1", [referredByCode]);
      if (ref.rowCount > 0 && ref.rows[0].tg_id !== u.id) {
        referredBy = ref.rows[0].tg_id;
      }
    }

    await q(
      `insert into users (tg_id, username, first_name, ref_code, referred_by, is_deleted)
       values ($1,$2,$3,$4,$5,$6)`,
      [u.id, u.username || null, u.first_name || null, refCode, referredBy, deleted]
    );

    // Referral credit (MVP anti-fraud):
    // - no deleted accounts
    // - no self referral already handled
    // - referred_tg_id unique prevents double credits
    if (referredBy && !deleted) {
      const already = await q("select 1 from referrals where referred_tg_id=$1", [u.id]);
      if (already.rowCount === 0) {
        await q("insert into referrals (referrer_tg_id, referred_tg_id) values ($1,$2)", [referredBy, u.id]);

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
  const res = await q("select count(*)::int as cnt from referrals where referrer_tg_id=$1", [tgId]);
  return res.rows[0].cnt;
}

async function hasConfirmedPayment(tgId) {
  const res = await q("select 1 from payments where tg_id=$1 and status='confirmed' limit 1", [tgId]);
  return res.rowCount > 0;
}

async function getEligibility(tgId) {
  const refs = await referralStats(tgId);
  const paid = await hasConfirmedPayment(tgId);
  return { refs, paid, eligible: paid || refs >= 3 };
}

/* -----------------------------
   Settings for group rotation
--------------------------------*/
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

/* -----------------------------
   Keyboards
--------------------------------*/
function kbBackToHome(label = "🏠 Menu") {
  return Markup.inlineKeyboard([[Markup.button.callback(label, "PAGE_HOME")]]);
}

function kbHomeUser(refLink, eligible) {
  if (!eligible) {
    // Pas de partage ici (tu voulais éviter les doublons)
    return Markup.inlineKeyboard([
      [Markup.button.callback("👥 Inviter 3 personnes", "PAGE_REF")],
      [Markup.button.callback("💳 Payer 3$ (USDT)", "PAGE_PAY")],
      [Markup.button.callback("❓ FAQ", "PAGE_FAQ")],
      [Markup.button.callback("📩 Contact Team", "PAGE_CONTACT")]
    ]);
  }

  // Adhérent: bouton permanent “Rejoindre”
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Rejoindre le groupe", "ACTION_ACCESS")],
    [Markup.button.callback("ℹ️ Infos", "PAGE_INFO")],
    [Markup.button.callback("❓ FAQ", "PAGE_FAQ")],
    [Markup.button.callback("📩 Contact Team", "PAGE_CONTACT")]
  ]);
}

function kbReferral(refLink) {
  return Markup.inlineKeyboard([
    [Markup.button.url("📤 Partager mon lien", shareLink(refLink))],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")]
  ]);
}

function kbPay() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Vérifier / Rejoindre", "ACTION_ACCESS")],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")]
  ]);
}

function kbContact() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💡 Recommandation", "CONTACT_REC")],
    [Markup.button.callback("🤝 Collaboration Projet", "CONTACT_COLLAB")],
    [Markup.button.callback("🛠 Remonter un problème", "CONTACT_BUG")],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")]
  ]);
}

function kbAdmin() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📌 Principal", "ADMIN_BIND_MAIN_HELP"), Markup.button.callback("🛟 Backup", "ADMIN_BIND_BACKUP_HELP")],
    [Markup.button.callback("🔁 Activer Backup", "ADMIN_SWITCH_BACKUP"), Markup.button.callback("👀 Config", "ADMIN_CONFIG")],
    [Markup.button.callback("🔁 Activer Principal", "ADMIN_SWITCH_MAIN"), Markup.button.callback("📊 Stats", "ADMIN_STATS")],
    [Markup.button.callback("📣 Broadcast", "ADMIN_BROADCAST_HELP")]
  ]);
}

/* -----------------------------
   Pages: USER
--------------------------------*/
async function renderHomeUser(ctx, opts = {}) {
  const refLink = await getUserRefLink(ctx);
  const { refs, paid, eligible } = await getEligibility(ctx.from.id);

  const text =
`<b>👋 Bienvenue !</b>

<b>🔒 Accès au groupe premium :</b>
• 💳 Paiement 3$
OU
• 👥 Inviter 3 personnes (qui cliquent Start)

<b>📌 Ton lien :</b>
${refLink}

<b>📈 Invitations :</b> ${refs}/3
<b>💳 Paiement :</b> ${paid ? "OK" : "non"}
<b>✅ Statut :</b> ${eligible ? "Adhérent" : "Non adhérent"}`;

  return upsertPanel(ctx, text, kbHomeUser(refLink, eligible), opts);
}

async function renderReferral(ctx) {
  const refLink = await getUserRefLink(ctx);
  const refs = await referralStats(ctx.from.id);

  const text =
`<b>👥 Inviter 3 personnes</b>

Partage ce lien :
${refLink}

✅ Invitations validées : <b>${refs}/3</b>

⚠️ Compte uniquement si la personne appuie sur Start.`;

  return upsertPanel(ctx, text, kbReferral(refLink));
}

async function renderPay(ctx) {
  if (isAdmin(ctx)) {
    return renderAdminHome(ctx);
  }

  if (!USDT_ADDRESS_TRC20) {
    return upsertPanel(ctx, "⚠️ Paiement non configuré (USDT_ADDRESS_TRC20 manquant).", kbBackToHome());
  }

  // pending existant ?
  const existing = await q(
    "select * from payments where tg_id=$1 and status='pending' and expires_at > now() order by created_at desc limit 1",
    [ctx.from.id]
  );
  if (existing.rowCount > 0) {
    const p = existing.rows[0];
    const text =
`<b>💳 Paiement en attente</b>

Envoie exactement : <b>${p.expected_amount} USDT</b> (TRC20)
Adresse : <code>${USDT_ADDRESS_TRC20}</code>

⏳ Valable jusqu’à : ${new Date(p.expires_at).toLocaleString()}

Ensuite clique “🔄 Vérifier / Rejoindre”.`;

    return upsertPanel(ctx, text, kbPay());
  }

  // réserve un montant unique
  const pending = await q("select expected_amount from payments where status='pending' and expires_at > now()");
  const used = new Set(pending.rows.map(r => String(r.expected_amount)));

  let amount = null;
  for (let i = 1; i <= PAY_SLOTS; i++) {
    const candidate = (PAY_BASE + i * PAY_STEP).toFixed(6);
    if (!used.has(candidate)) { amount = candidate; break; }
  }
  if (!amount) return upsertPanel(ctx, "❌ Trop de paiements en attente. Réessaie dans quelques minutes.", kbBackToHome());

  const expiresAt = nowPlusMinutes(PAY_EXPIRE_MINUTES);
  await q(
    "insert into payments (tg_id, expected_amount, status, expires_at) values ($1,$2,'pending',$3)",
    [ctx.from.id, amount, expiresAt]
  );

  const text =
`<b>💳 Paiement (USDT TRC20)</b>

1) Envoie exactement : <b>${amount} USDT</b>
2) À l’adresse : <code>${USDT_ADDRESS_TRC20}</code>
3) Valable <b>${PAY_EXPIRE_MINUTES} minutes</b>

Ensuite clique “🔄 Vérifier / Rejoindre”.

⚠️ Envoie sur le bon réseau (TRC20).`;

  return upsertPanel(ctx, text, kbPay());
}

async function renderFAQ(ctx) {
  const text =
`<b>❓ FAQ</b>

<b>• Accès :</b>
Paiement 3$ (USDT) OU inviter 3 personnes (Start).

<b>• Liens temporaires ?</b>
Oui, pour éviter les fuites.

<b>• Problème ?</b>
📩 Contact Team.`;

  return upsertPanel(ctx, text, kbBackToHome());
}

async function renderInfo(ctx) {
  const user = await q("select created_at from users where tg_id=$1", [ctx.from.id]);
  const createdAt = user.rows[0]?.created_at;

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);
  const method = paid ? "Paiement (USDT)" : (refs >= 3 ? "Invitations (3)" : "Non adhérent");

  const text =
`<b>ℹ️ Tes infos</b>

🗓 Inscription : ${new Date(createdAt).toLocaleString()}
✅ Statut : <b>${eligible ? "Adhérent" : "Non adhérent"}</b>
🔑 Mode d’accès : <b>${method}</b>
👥 Invitations : <b>${refs}/3</b>`;

  return upsertPanel(ctx, text, kbBackToHome());
}

/* -----------------------------
   ACCESS (create invite link)
--------------------------------*/
async function actionAccess(ctx) {
  if (isAdmin(ctx)) {
    return renderAdminHome(ctx);
  }

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);
  if (!eligible) {
    const refLink = await getUserRefLink(ctx);
    const text =
`⛔ <b>Accès non validé</b>

👥 Invitations : <b>${refs}/3</b>
💳 Paiement : <b>${paid ? "OK" : "non"}</b>`;

    return upsertPanel(ctx, text, kbHomeUser(refLink, false));
  }

  const activeChatId = await getActiveChatId();
  if (!activeChatId) {
    return upsertPanel(
      ctx,
      "⚠️ Groupe non configuré. Demande à l’admin de binder le principal (/bind_main) et/ou backup (/bind_backup).",
      kbBackToHome()
    );
  }

  // 1-use invite link + expiry
  const expireDate = Math.floor(Date.now() / 1000) + INVITE_EXPIRE_MINUTES * 60;

  try {
    const link = await ctx.telegram.createChatInviteLink(activeChatId, {
      expire_date: expireDate,
      member_limit: 1
    });

    const text =
`✅ <b>Prêt !</b>

🔗 Lien (1 seule utilisation, expire dans <b>${INVITE_EXPIRE_MINUTES} min</b>) :
${link.invite_link}

${ENFORCE_JOIN_REQUESTS ? "🔐 Si le groupe est en <b>demande d’adhésion</b>, ton entrée sera approuvée automatiquement." : ""}`;

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

/* -----------------------------
   Anti-partage “fort”: Join Requests
   Works ONLY if Join Requests are enabled in the group.
--------------------------------*/
bot.on("chat_join_request", async (ctx) => {
  try {
    if (!ENFORCE_JOIN_REQUESTS) return;

    const userId = ctx.from.id;

    // Allow only eligible users
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

/* -----------------------------
   Contact flow: categories -> user types text -> send to admin
--------------------------------*/
const CONTACT_STATE = new Map(); // tg_id -> type

async function renderContact(ctx) {
  const text = `<b>📩 Contact Team</b>\n\nChoisis un sujet :`;
  return upsertPanel(ctx, text, kbContact());
}

async function promptContactText(ctx, type) {
  CONTACT_STATE.set(ctx.from.id, type);

  const label = {
    CONTACT_REC: "Recommandation",
    CONTACT_COLLAB: "Collaboration Projet",
    CONTACT_BUG: "Remonter un problème"
  }[type];

  const text =
`<b>✍️ ${label}</b>

Écris ton message ici. Il sera envoyé à l’équipe.`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback("🏠 Annuler", "PAGE_HOME")]]);
  return upsertPanel(ctx, text, kb);
}

/* -----------------------------
   Pages: ADMIN
--------------------------------*/
async function renderAdminHome(ctx, opts = {}) {
  if (!isAdmin(ctx)) return renderHomeUser(ctx, opts);

  const text =
`<b>🛠 Mode Admin</b>

Tout se règle ici.`;

  return upsertPanel(ctx, text, kbAdmin(), opts);
}

async function renderAdminConfig(ctx) {
  const main = await getSetting("main_chat_id");
  const backup = await getSetting("backup_chat_id");
  const active = await getSetting("active_chat_id");

  const text =
`<b>👀 Config</b>

📌 main_chat_id: <code>${main || "—"}</code>
🛟 backup_chat_id: <code>${backup || "—"}</code>
✅ active_chat_id: <code>${active || "—"}</code>

${ENFORCE_JOIN_REQUESTS ? "🔐 Join Requests: <b>ENFORCED</b>" : "🔐 Join Requests: <b>OFF</b>"}`;

  return upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛠 Admin", "ADMIN_HOME"), Markup.button.callback("🏠 Menu", "PAGE_HOME")]
    ])
  );
}

async function renderAdminStats(ctx) {
  const users = await q("select count(*)::int as n from users");
  const refs = await q("select count(*)::int as n from referrals");
  const paid = await q("select count(*)::int as n from payments where status='confirmed'");

  const eligible = await q(`
    select count(*)::int as n
    from users u
    where (exists(select 1 from payments p where p.tg_id=u.tg_id and p.status='confirmed')
           or (select count(*) from referrals r where r.referrer_tg_id=u.tg_id) >= 3)
  `);

  const conv = users.rows[0].n > 0 ? ((eligible.rows[0].n / users.rows[0].n) * 100).toFixed(1) : "0.0";

  const text =
`<b>📊 Stats</b>

👤 Users : <b>${users.rows[0].n}</b>
👥 Referrals : <b>${refs.rows[0].n}</b>
💳 Paiements confirmés : <b>${paid.rows[0].n}</b>
✅ Adhérents : <b>${eligible.rows[0].n}</b>
📈 Conversion : <b>${conv}%</b>`;

  return upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("🛠 Admin", "ADMIN_HOME"), Markup.button.callback("🏠 Menu", "PAGE_HOME")]
    ])
  );
}

/* -----------------------------
   Broadcast admin
--------------------------------*/
const ADMIN_BROADCAST_STATE = new Map(); // admin_id -> true/false

async function renderBroadcastHelp(ctx) {
  const text =
`<b>📣 Broadcast</b>

Envoie un message à tous les utilisateurs (ceux qui ont fait Start).

✅ Exemple utile quand tu switches de groupe :
"⚠️ Le groupe a changé. Ouvre le bot et clique 🔄 Rejoindre le groupe."

Clique “✍️ Écrire” puis tape ton message.`;

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("✍️ Écrire", "ADMIN_BROADCAST_WRITE"), Markup.button.callback("🛠 Admin", "ADMIN_HOME")]
  ]);

  return upsertPanel(ctx, text, kb);
}

async function broadcastGroupChange() {
  const text =
`⚠️ Le groupe a changé.

Pour accéder au nouveau groupe :

1️⃣ Ouvre le bot
2️⃣ Clique sur
🔄 Rejoindre le groupe`;

  return doBroadcast(text);
}

async function doBroadcast(text) {
  const users = await q("select tg_id from users");
  let ok = 0, fail = 0;

  // Throttle simple (Telegram rate limits)
  for (const row of users.rows) {
    try {
      await bot.telegram.sendMessage(row.tg_id, text, { disable_web_page_preview: true });
      ok++;
    } catch {
      fail++;
    }
    await new Promise(r => setTimeout(r, 40)); // ~25 msg/sec
  }
  return { ok, fail, total: users.rows.length };
}

/* -----------------------------
   Routes / Start
--------------------------------*/
bot.start(async (ctx) => {
  const payload = (ctx.startPayload || "").trim();
  const referredByCode = payload.startsWith("ref_") ? payload.slice(4) : null;
  await ensureUser(ctx, referredByCode);

  if (isAdmin(ctx)) {
    return renderAdminHome(ctx, { forceNew: true });
  }
  return renderHomeUser(ctx, { forceNew: true });
});

/* -----------------------------
   Navigation callbacks
--------------------------------*/
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

/* -----------------------------
   Contact callbacks
--------------------------------*/
bot.action(["CONTACT_REC", "CONTACT_COLLAB", "CONTACT_BUG"], async (ctx) => {
  await ctx.answerCbQuery();
  return promptContactText(ctx, ctx.callbackQuery.data);
});

/* -----------------------------
   Admin callbacks
--------------------------------*/
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

  const text =
`<b>📌 Binder le groupe PRINCIPAL</b>

1) Ajoute le bot dans le groupe en admin
2) Tape <code>/bind_main</code> <b>dans le groupe</b> (pas en privé)

Ensuite clique “👀 Config”.`;

  return upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("👀 Config", "ADMIN_CONFIG"), Markup.button.callback("🛠 Admin", "ADMIN_HOME")]
    ])
  );
});

bot.action("ADMIN_BIND_BACKUP_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const text =
`<b>🛟 Binder le groupe BACKUP</b>

1) Ajoute le bot dans le groupe en admin
2) Tape <code>/bind_backup</code> <b>dans le groupe</b> (pas en privé)

Ensuite clique “👀 Config”.`;

  return upsertPanel(
    ctx,
    text,
    Markup.inlineKeyboard([
      [Markup.button.callback("👀 Config", "ADMIN_CONFIG"), Markup.button.callback("🛠 Admin", "ADMIN_HOME")]
    ])
  );
});

// typed inside groups
bot.command("bind_main", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat.type === "private") return ctx.reply("⚠️ Tape /bind_main dans le groupe (pas en privé).");

  await setSetting("main_chat_id", ctx.chat.id);
  await setSetting("active_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe PRINCIPAL bind : ${ctx.chat.id}\n(Et activé)`);
});

bot.command("bind_backup", async (ctx) => {
  if (!isAdmin(ctx)) return;
  if (ctx.chat.type === "private") return ctx.reply("⚠️ Tape /bind_backup dans le groupe (pas en privé).");

  await setSetting("backup_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe BACKUP bind : ${ctx.chat.id}`);
});

bot.action("ADMIN_SWITCH_BACKUP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const backup = await getSetting("backup_chat_id");
  if (!backup) {
    return upsertPanel(ctx, "❌ Pas de backup configuré. Fais /bind_backup dans le groupe backup.", kbAdmin());
  }
  await setSetting("active_chat_id", backup);
  return upsertPanel(ctx, `🔁 OK. Groupe actif = BACKUP (<code>${backup}</code>)`, kbAdmin());
  await setSetting("active_chat_id", backup);

  await upsertPanel(
  ctx,
  `🔁 Groupe actif = BACKUP (<code>${backup}</code>)\n\n📣 Notification envoyée aux membres.`,
  kbAdmin()
  );

  broadcastGroupChange();
  });

bot.action("ADMIN_SWITCH_MAIN", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const main = await getSetting("main_chat_id");
  if (!main) {
    return upsertPanel(ctx, "❌ Pas de principal configuré. Fais /bind_main dans le groupe principal.", kbAdmin());
  }
  await setSetting("active_chat_id", main);

  await upsertPanel(
  ctx,
  `🔁 Groupe actif = PRINCIPAL (<code>${main}</code>)\n\n📣 Notification envoyée aux membres.`,
  kbAdmin()
  );

  broadcastGroupChange();
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
  const text =
`<b>✍️ Broadcast</b>

Tape maintenant le message à envoyer à tous les utilisateurs.

⚠️ Conseil : garde-le court.`;

  return upsertPanel(ctx, text, Markup.inlineKeyboard([[Markup.button.callback("🛠 Annuler", "ADMIN_HOME")]]));
});

/* -----------------------------
   Text handler: contact + broadcast
--------------------------------*/
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
      CONTACT_BUG: "🛠 Problème"
    }[type];

    await ctx.telegram.sendMessage(
      ADMIN_TG_ID,
      `${label}\nDe: @${ctx.from.username || "sans_username"} (tg_id: ${ctx.from.id})\n\n${ctx.message.text}`
    );

    return ctx.reply("✅ Merci ! Ton message a été transmis à l’équipe.", { disable_web_page_preview: true });
  }
});

/* -----------------------------
   Global error catcher
--------------------------------*/
bot.catch((err, ctx) => {
  console.error("BOT ERROR:", err);
  try {
    if (ctx?.updateType === "callback_query") {
      ctx.answerCbQuery("⚠️ Erreur interne (logs).", { show_alert: true }).catch(() => {});
    }
  } catch {}
});

/* -----------------------------
   Run
--------------------------------*/
bot.launch()
  .then(() => console.log("Bot running (polling)"))
  .catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));

