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
const USDT_ADDRESS_TRC20 = process.env.USDT_ADDRESS_TRC20;
const WELCOME_IMAGE_URL = process.env.WELCOME_IMAGE_URL || null;

function contactMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("💡 Recommandation", "CONTACT_REC")],
    [Markup.button.callback("🤝 Collaboration Projet", "CONTACT_COLLAB")],
    [Markup.button.callback("🛠 Remonter un problème", "CONTACT_BUG")],
    [Markup.button.callback("🏠 Menu", "MENU")]
  ]);
}
function adminMenu() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📊 Statistiques", "ADMIN_STATS")],
    [Markup.button.callback("📌 Bind groupe PRINCIPAL", "ADMIN_BIND_MAIN_HELP")],
    [Markup.button.callback("🛟 Bind groupe BACKUP", "ADMIN_BIND_BACKUP_HELP")],
    [Markup.button.callback("🔁 Basculer vers BACKUP", "ADMIN_SWITCH_BACKUP")],
    [Markup.button.callback("↩️ Revenir au PRINCIPAL", "ADMIN_SWITCH_MAIN")],
    [Markup.button.callback("👀 Voir config", "ADMIN_CONFIG")]
  ]);
}

const CONTACT_STATE = new Map(); // tg_id -> type

async function ensureUser(ctx, referredByCode = null) {
  const u = ctx.from;
  const deleted = isDeletedUser(u);

  const existing = await q("select * from users where tg_id=$1", [u.id]);
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

    if (referredBy && !deleted) {
      const already = await q("select 1 from referrals where referred_tg_id=$1", [u.id]);
      if (already.rowCount === 0) {
        await q("insert into referrals (referrer_tg_id, referred_tg_id) values ($1,$2)", [referredBy, u.id]);
      }
    }
  } else {
    await q(
      "update users set username=$2, first_name=$3, is_deleted=$4 where tg_id=$1",
      [u.id, u.username || null, u.first_name || null, deleted]
    );
  }
}

async function referralStats(tgId) {
  const res = await q("select count(*)::int as cnt from referrals where referrer_tg_id=$1", [tgId]);
  return res.rows[0].cnt;
}

async function hasConfirmedPayment(tgId) {
  const res = await q("select 1 from payments where tg_id=$1 and status='confirmed' limit 1", [tgId]);
  return res.rowCount > 0;
}

async function getUserRefLink(ctx) {
  const me = await q("select ref_code from users where tg_id=$1", [ctx.from.id]);
  const refCode = me.rows[0].ref_code;
  return `https://t.me/${ctx.me}?start=ref_${refCode}`;
}

function menuNonAdherent(refLink) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("👥 Inviter 3 personnes", "REF_INFO")],
    [Markup.button.callback("💳 Payer 3$ (USDT)", "PAY_START")],
    [Markup.button.url("📤 Partager mon lien", shareLink(refLink))],
    [Markup.button.callback("❓ FAQ", "FAQ")],
    [Markup.button.callback("📩 Contact Team", "CONTACT")]
  ]);
}

function menuAdherent(refLink) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔐 Générer le lien du groupe", "GET_ACCESS")],
    [Markup.button.url("📤 Partager mon lien", shareLink(refLink))],
    [Markup.button.callback("ℹ️ Infos", "MY_INFO")],
    [Markup.button.callback("❓ FAQ", "FAQ")],
    [Markup.button.callback("📩 Contact Team", "CONTACT")]
  ]);
}

async function sendWelcome(ctx) {
  const refLink = await getUserRefLink(ctx);
  const refs = await referralStats(ctx.from.id);
  const paid = await hasConfirmedPayment(ctx.from.id);
  const eligible = paid || refs >= 3;

  const text =
`👋 Bienvenue !

🔒 Accès au groupe premium :
• 💳 Paiement 3$
OU
• 👥 Inviter 3 personnes (qui cliquent Start)

📌 Ton lien :
${refLink}

📈 Invitations : ${refs}/3
💳 Paiement : ${paid ? "OK" : "non"}
✅ Statut : ${eligible ? "Adhérent" : "Non adhérent"}
`;

  const kb = eligible ? menuAdherent(refLink) : menuNonAdherent(refLink);

  if (WELCOME_IMAGE_URL) {
    return ctx.replyWithPhoto(WELCOME_IMAGE_URL, { caption: text, ...kb });
  }
  return ctx.reply(text, kb);
}

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

async function grantAccessLink(ctx) {
  const tgId = ctx.from.id;
  const refs = await referralStats(tgId);
  const paid = await hasConfirmedPayment(tgId);
  const eligible = paid || refs >= 3;

  if (!eligible) {
    return ctx.reply(
      `⛔ Accès non validé.\n\n👥 Invitations validées: ${refs}/3\n💳 Paiement: ${paid ? "OK" : "non"}\n\nChoisis une option :`,
      menuNonAdherent(await getUserRefLink(ctx))
    );
  }

  const activeChatId = await getActiveChatId();
  if (!activeChatId) {
    return ctx.reply("⚠️ Groupe non configuré. Admin: utilise /admin puis bind le groupe principal et/ou backup.");
  }

  const expireDate = Math.floor(Date.now() / 1000) + INVITE_EXPIRE_MINUTES * 60;
  try {
    const link = await ctx.telegram.createChatInviteLink(activeChatId, {
      expire_date: expireDate,
      member_limit: 1
    });

    return ctx.reply(
      `✅ Accès débloqué !\n\n🔗 Lien (1 seule utilisation, expire dans ${INVITE_EXPIRE_MINUTES} min) :\n${link.invite_link}`
    );
  } catch (e) {
    console.error(e);
    return ctx.reply("❌ Impossible de créer le lien. Vérifie que le bot est admin du groupe actif et a le droit de créer des liens d’invitation.");
  }
}

/* ----------- START ----------- */
bot.start(async (ctx) => {
  const payload = (ctx.startPayload || "").trim();
  const referredByCode = payload.startsWith("ref_") ? payload.slice(4) : null;
  await ensureUser(ctx, referredByCode);

  // Admin landing
  if (ctx.from.id === ADMIN_TG_ID) {
    await ctx.reply("🛠 Mode Admin", adminMenu());
  }
  return sendWelcome(ctx);
});

/* ----------- USER ACTIONS ----------- */
bot.action("MENU", async (ctx) => {
  await ctx.answerCbQuery();
  return sendWelcome(ctx);
});

bot.action("REF_INFO", async (ctx) => {
  await ctx.answerCbQuery();
  const refLink = await getUserRefLink(ctx);
  const refs = await referralStats(ctx.from.id);

  return ctx.reply(
`👥 Parrainage

Partage ce lien :
${refLink}

✅ Invitations validées: ${refs}/3

⚠️ Comptent seulement les personnes qui appuient sur Start (1 seule fois par compte).
`,
    Markup.inlineKeyboard([
      [Markup.button.url("📤 Partager mon lien", shareLink(refLink))],
      [Markup.button.callback("🏠 Menu", "MENU")]
    ])
  );
});

bot.action("FAQ", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply(
`❓ FAQ

• Accès : Paiement 3$ (USDT) OU inviter 3 personnes (Start).
• Les liens sont temporaires pour éviter les fuites.
• Problème ? Va dans “📩 Contact Team”.
`,
    Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu", "MENU")]])
  );
});

bot.action("CONTACT", async (ctx) => {
  await ctx.answerCbQuery();
  return ctx.reply("📩 Contact Team — choisis un sujet :", contactMenu());
});

bot.action(["CONTACT_REC","CONTACT_COLLAB","CONTACT_BUG"], async (ctx) => {
  await ctx.answerCbQuery();
  const type = ctx.callbackQuery.data;
  CONTACT_STATE.set(ctx.from.id, type);

  const label = {
    CONTACT_REC: "Recommandation",
    CONTACT_COLLAB: "Collaboration Projet",
    CONTACT_BUG: "Remonter un problème"
  }[type];

  return ctx.reply(`✍️ ${label}\n\nÉcris ton message ici. Il sera envoyé à l’équipe.`);
});

bot.on("text", async (ctx) => {
  const type = CONTACT_STATE.get(ctx.from.id);
  if (!type) return;

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

  return ctx.reply("✅ Merci ! Ton message a été transmis à l’équipe.", Markup.inlineKeyboard([
    [Markup.button.callback("🏠 Menu", "MENU")]
  ]));
});

bot.action("MY_INFO", async (ctx) => {
  await ctx.answerCbQuery();
  const user = await q("select created_at from users where tg_id=$1", [ctx.from.id]);
  const createdAt = user.rows[0]?.created_at;

  const refs = await referralStats(ctx.from.id);
  const paid = await hasConfirmedPayment(ctx.from.id);
  const eligible = paid || refs >= 3;
  const method = paid ? "Paiement (USDT)" : (refs >= 3 ? "Invitations (3)" : "Non adhérent");

  return ctx.reply(
`ℹ️ Tes infos

🗓 Inscription : ${new Date(createdAt).toLocaleString()}
✅ Statut : ${eligible ? "Adhérent" : "Non adhérent"}
🔑 Mode d’accès : ${method}
👥 Invitations : ${refs}/3
`,
    Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu", "MENU")]])
  );
});

bot.action("GET_ACCESS", async (ctx) => {
  await ctx.answerCbQuery();
  return grantAccessLink(ctx);
});

/* ----------- PAYMENTS (reserve amount) ----------- */
bot.action("PAY_START", async (ctx) => {
  await ctx.answerCbQuery();

  const existing = await q(
    "select * from payments where tg_id=$1 and status='pending' and expires_at > now() order by created_at desc limit 1",
    [ctx.from.id]
  );
  if (existing.rowCount > 0) {
    const p = existing.rows[0];
    return ctx.reply(
`💳 Paiement en attente

Envoie exactement : ${p.expected_amount} USDT (TRC20)
Adresse : ${USDT_ADDRESS_TRC20}

⏳ Valable jusqu’à : ${new Date(p.expires_at).toLocaleString()}

Puis clique “🔐 Générer le lien du groupe”.
`,
      Markup.inlineKeyboard([[Markup.button.callback("🔐 Générer le lien du groupe", "GET_ACCESS")]])
    );
  }

  const pending = await q("select expected_amount from payments where status='pending' and expires_at > now()");
  const used = new Set(pending.rows.map(r => String(r.expected_amount)));

  let amount = null;
  for (let i = 1; i <= PAY_SLOTS; i++) {
    const candidate = (PAY_BASE + i * PAY_STEP).toFixed(6);
    if (!used.has(candidate)) { amount = candidate; break; }
  }
  if (!amount) return ctx.reply("❌ Trop de paiements en attente. Réessaie dans quelques minutes.");

  const expiresAt = nowPlusMinutes(PAY_EXPIRE_MINUTES);
  await q(
    "insert into payments (tg_id, expected_amount, status, expires_at) values ($1,$2,'pending',$3)",
    [ctx.from.id, amount, expiresAt]
  );

  return ctx.reply(
`💳 Paiement (USDT TRC20)

1) Envoie exactement : ${amount} USDT
2) À l’adresse : ${USDT_ADDRESS_TRC20}
3) Valable ${PAY_EXPIRE_MINUTES} minutes

Ensuite clique “🔐 Générer le lien du groupe”.

⚠️ Envoie sur le bon réseau (TRC20).
`,
    Markup.inlineKeyboard([[Markup.button.callback("🔐 Générer le lien du groupe", "GET_ACCESS")]])
  );
});

/* ----------- ADMIN ----------- */
bot.command("admin", async (ctx) => {
  if (ctx.from.id !== ADMIN_TG_ID) return;
  return ctx.reply("🛠 Mode Admin", adminMenu());
});

// Bind help: tell admin to type command in group
bot.action("ADMIN_BIND_MAIN_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;
  return ctx.reply("📌 Pour binder le groupe PRINCIPAL : ajoute le bot en admin dans le groupe, puis tape /bind_main DANS ce groupe.");
});

bot.action("ADMIN_BIND_BACKUP_HELP", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;
  return ctx.reply("🛟 Pour binder le groupe BACKUP : ajoute le bot en admin dans le groupe, puis tape /bind_backup DANS ce groupe.");
});

// These must be typed inside the target group
bot.command("bind_main", async (ctx) => {
  if (ctx.from.id !== ADMIN_TG_ID) return;
  if (ctx.chat.type === "private") return ctx.reply("⚠️ Tape /bind_main dans le groupe (pas en privé).");
  await setSetting("main_chat_id", ctx.chat.id);
  await setSetting("active_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe PRINCIPAL bind : ${ctx.chat.id}\n(Et activé)`);
});

bot.command("bind_backup", async (ctx) => {
  if (ctx.from.id !== ADMIN_TG_ID) return;
  if (ctx.chat.type === "private") return ctx.reply("⚠️ Tape /bind_backup dans le groupe (pas en privé).");
  await setSetting("backup_chat_id", ctx.chat.id);
  return ctx.reply(`✅ Groupe BACKUP bind : ${ctx.chat.id}`);
});

bot.action("ADMIN_SWITCH_BACKUP", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;

  const backup = await getSetting("backup_chat_id");
  if (!backup) return ctx.reply("❌ Pas de backup configuré. Fais /bind_backup dans le groupe backup.");
  await setSetting("active_chat_id", backup);
  return ctx.reply(`🔁 OK. Groupe actif = BACKUP (${backup})`);
});

bot.action("ADMIN_SWITCH_MAIN", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;

  const main = await getSetting("main_chat_id");
  if (!main) return ctx.reply("❌ Pas de principal configuré. Fais /bind_main dans le groupe principal.");
  await setSetting("active_chat_id", main);
  return ctx.reply(`↩️ OK. Groupe actif = PRINCIPAL (${main})`);
});

bot.action("ADMIN_CONFIG", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;

  const main = await getSetting("main_chat_id");
  const backup = await getSetting("backup_chat_id");
  const active = await getSetting("active_chat_id");

  return ctx.reply(
`👀 Config

📌 main_chat_id: ${main || "—"}
🛟 backup_chat_id: ${backup || "—"}
✅ active_chat_id: ${active || "—"}
`
  );
});

bot.action("ADMIN_STATS", async (ctx) => {
  await ctx.answerCbQuery();
  if (ctx.from.id !== ADMIN_TG_ID) return;

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

  return ctx.reply(
`📊 Statistiques

👤 Users : ${users.rows[0].n}
👥 Invitations (totales) : ${refs.rows[0].n}
💳 Paiements confirmés : ${paid.rows[0].n}
✅ Adhérents : ${eligible.rows[0].n}
📈 Conversion : ${conv}%
`
  );
});

/* ----------- RUN ----------- */
bot.launch()
  .then(() => console.log("Bot running (polling)"))
  .catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));