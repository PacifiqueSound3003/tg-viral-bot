import "dotenv/config";
import axios from "axios";
import { Telegraf, Markup } from "telegraf";
import { q, getSetting, setSetting } from "./db.js";
import { makeRefCode, nowPlusMinutes, isDeletedUser, shareLink } from "./utils.js";

const bot = new Telegraf(process.env.BOT_TOKEN);

// --------------------
// ENV / Config
// --------------------
const ADMIN_TG_ID = Number(process.env.ADMIN_TG_ID);
const INVITE_EXPIRE_MINUTES = Number(process.env.INVITE_EXPIRE_MINUTES || 30);

const PAY_BASE = Number(process.env.PAY_BASE || 3);
const PAY_STEP = Number(process.env.PAY_STEP || 0.001);
const PAY_SLOTS = Number(process.env.PAY_SLOTS || 200);
const PAY_EXPIRE_MINUTES = Number(process.env.PAY_EXPIRE_MINUTES || 30);

const USDT_ADDRESS_TRC20 = process.env.USDT_ADDRESS_TRC20 || "";

// TronScan watcher
const TRONSCAN_BASE = process.env.TRONSCAN_BASE || "https://apilist.tronscanapi.com";
const TRONSCAN_API_KEY = process.env.TRONSCAN_API_KEY || "";
const PAY_WATCH_INTERVAL_SEC = Number(process.env.PAY_WATCH_INTERVAL_SEC || 20);
const PAY_CONFIRM_MIN = Number(process.env.PAY_CONFIRM_MIN || 1);
const USDT_CONTRACT_TRON =
  process.env.USDT_CONTRACT_TRON || "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

function isAdmin(ctx) {
  return ctx.from?.id === ADMIN_TG_ID;
}

// --------------------
// Formatting (FR)
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

// --------------------
// Central UI
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
    // fallback to reply
  }
  return ctx.reply(text, {
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...keyboard,
  });
}

// --------------------
// DB helpers
async function ensureUser(ctx, referredByCode = null) {
  const u = ctx.from;
  const deleted = isDeletedUser(u);

  const existing = await q("select tg_id from users where tg_id=$1", [u.id]);

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

    // credit referral (MVP)
    if (referredBy && !deleted) {
      const already = await q("select 1 from referrals where referred_tg_id=$1", [u.id]);
      if (already.rowCount === 0) {
        await q(
          "insert into referrals (referrer_tg_id, referred_tg_id) values ($1,$2)",
          [referredBy, u.id]
        );
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

async function hasPendingPayment(tgId) {
  const r = await q(
    `select expected_amount, expires_at
     from payments
     where tg_id=$1 and status='pending' and expires_at > now()
     order by created_at desc
     limit 1`,
    [tgId]
  );
  return r.rowCount ? r.rows[0] : null;
}

// --------------------
// Settings: group rotation
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

// --------------------
// Keyboards
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

function kbBackToHome() {
  return Markup.inlineKeyboard([[Markup.button.callback("🏠 Menu", "PAGE_HOME")]]);
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

// --------------------
// Broadcast (manuel) + auto-broadcast switch
const ADMIN_BROADCAST_STATE = new Map();

async function doBroadcast(text) {
  const users = await q("select tg_id from users");
  let ok = 0, fail = 0;

  for (const row of users.rows) {
    try {
      await bot.telegram.sendMessage(row.tg_id, text, { disable_web_page_preview: true });
      ok++;
    } catch {
      fail++;
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 msg/sec
  }
  return { ok, fail, total: users.rows.length };
}

function autoBroadcastGroupChange(mode) {
  const text =
`⚠️ Mise à jour : le groupe a changé.

Pour accéder au nouveau groupe :
1) Ouvre le bot
2) Clique sur : 🔄 Rejoindre le groupe

✅ (Mode: ${mode})`;

  doBroadcast(text)
    .then((res) => console.log("[AUTO_BROADCAST] done:", res))
    .catch((e) => console.error("[AUTO_BROADCAST] error:", e?.message || e));
}

async function renderBroadcastHelp(ctx) {
  const text = `<b>📣 Broadcast</b>

Envoie un message à tous les utilisateurs (ceux qui ont fait Start).`;
  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback("✍️ Écrire", "ADMIN_BROADCAST_WRITE"),
      Markup.button.callback("🛠 Admin", "ADMIN_HOME"),
    ],
  ]);
  return upsertPanel(ctx, text, kb);
}

// --------------------
// Payment V5: nonce-based reservation (change after expiry)
async function reservePaymentAmount(tgId) {
  // expire old pending
  await q(
    "update payments set status='expired' where tg_id=$1 and status='pending' and expires_at <= now()",
    [tgId]
  );

  // keep existing pending active (stable until expiry)
  const existing = await q(
    `select * from payments
     where tg_id=$1 and status='pending' and expires_at > now()
     order by created_at desc
     limit 1`,
    [tgId]
  );
  if (existing.rowCount) return existing.rows[0];

  // new payment => increment nonce
  const nonceRes = await q(
    "update users set pay_nonce = pay_nonce + 1 where tg_id=$1 returning pay_nonce",
    [tgId]
  );
  const nonce = nonceRes.rows[0]?.pay_nonce || 1;

  const expiresAt = nowPlusMinutes(PAY_EXPIRE_MINUTES);

  // base slot depends on tgId + nonce => changes each new payment
  const baseSlot =
    ((Number(BigInt(tgId) % BigInt(PAY_SLOTS)) + nonce - 1) % PAY_SLOTS) + 1; // 1..PAY_SLOTS

  // try insert atomically; on collision => next slot
  for (let k = 0; k < PAY_SLOTS; k++) {
    const slot = ((baseSlot + k - 1) % PAY_SLOTS) + 1;
    const amount = (PAY_BASE + slot * PAY_STEP).toFixed(6);

    try {
      const ins = await q(
        `insert into payments (tg_id, expected_amount, status, expires_at, slot)
         values ($1, $2, 'pending', $3, $4)
         returning *`,
        [tgId, amount, expiresAt, slot]
      );
      return ins.rows[0];
    } catch (e) {
      if (e?.code === "23505") continue; // unique violation
      throw e;
    }
  }

  throw new Error("No free payment slots");
}

// --------------------
// Pages: user
async function renderHomeUser(ctx, opts = {}) {
  const { refs, paid, eligible } = await getEligibility(ctx.from.id);

  const text = eligible
    ? `<b>🎉 Félicitations !</b>

Tu es maintenant <b>adhérent</b>.

Notre système garantit que le groupe reste
toujours accessible même si Telegram supprime
un lien ou si le groupe change.

Il te suffit simplement de cliquer sur :

🔄 <b>Rejoindre le groupe</b>

Le bot générera automatiquement
un lien sécurisé et temporaire.

Bienvenue dans la communauté.`
    : `<b>👋 Bienvenue sur 🇫🇷  &lt;LIBERTYLEAK&gt; 🇫🇷 </b>

Ce groupe de LEAK  construit <b>par ses membres et pour ses membres</b>.

🇫🇷 Réservé aux Francais uniquement 🇫🇷

Dans la plupart des communautés en ligne :
90% des personnes restent passives
et seulement 10% contribuent réellement.

Ici nous faisons l’inverse.

Nous voulons un groupe <b>actif, utile et qualitatif</b>,
où chaque membre apporte quelque chose.

Pour maintenir cette qualité,
un petit filtre d’entrée est mis en place.

🔒 <b>Accès au groupe :</b>

• 💳 Paiement 3$
OU
• 👥 Inviter 3 personnes 

Ce filtre permet de garder un groupe actif 

💡 Le moyen le plus simple d'accéder au groupe est simplement d'inviter 3 personnes.

📊 <b>Ton statut actuel :</b>

📈 Invitations : ${refs}/3
💳 Paiement : ${paid ? "OK" : "non"}
✅ Statut : Non adhérent

❓ Pour plus d'informations consulte la FAQ.`;

  return upsertPanel(ctx, text, kbHomeUser(eligible), opts);
}

async function renderReferral(ctx) {
  const refLink = await getUserRefLink(ctx);
  const refs = await referralStats(ctx.from.id);

  const text = `<b>👥 Inviter 3 personnes</b>

Partage ce lien :
${refLink}

✅ Invitations validées : <b>${refs}/3</b>

⚠️ Invite 3 personnes à rejoindre le groupe, puis actualise la page : ton accès sera débloqué.`;

  return upsertPanel(ctx, text, kbReferral(refLink));
}

async function renderPay(ctx) {
  if (isAdmin(ctx)) return renderAdminHome(ctx);

  if (!USDT_ADDRESS_TRC20) {
    return upsertPanel(ctx, "⚠️ Paiement non configuré (USDT_ADDRESS_TRC20 manquant).", kbBackToHome());
  }

  const p = await reservePaymentAmount(ctx.from.id);

  const text = `💳 <b>Paiement (USDT TRC20)</b>

1) Envoie exactement : <b>${p.expected_amount} USDT</b>
2) À l’adresse :
<code>${USDT_ADDRESS_TRC20}</code>
3) Valable jusqu’à : <b>${fmtFR(p.expires_at)}</b>

Ensuite clique “🔄 Vérifier / Rejoindre”.

⚠️ Envoie sur le bon réseau (TRC20).`;

  return upsertPanel(ctx, text, kbPay());
}

async function renderFAQ(ctx) {
  const text = `<b>❓ FAQ</b>

<b>• Qui est derrière ce programme ?</b>
Ce programme a été développé par un groupe indépendant et est mis à la disposition de tous.

<b>• Paiement & anonymat :</b>
Le paiement s’effectue en crypto (USDT) afin de préserver l’anonymat de chacun. Cela permet également de limiter l’exposition des informations personnelles, Telegram n’étant pas une plateforme totalement sécurisée.

<b>• Collaboration :</b>
Nous sommes ouverts aux collaborations avec des personnes ou des équipes partageant la même vision.

<b>• Développement de projets :</b>
Nous sommes également ouverts au développement et à l’accompagnement de nouveaux projets.

<b>• Sécurité & algorithmes :</b>
Nos algorithmes sont conçus pour garantir l’anonymat et la sécurité des utilisateurs.  
Ils analysent en permanence l’activité afin de détecter les fraudes grâce à l’IA et empêchent le téléchargement ou l’extraction de contenus, y compris via Telegram Web.

<b>• Modération automatisée :</b>
Aucune personne ne dirige ou ne prend des décisions arbitraires.  
Les systèmes automatisés et les bots analysent les activités afin d’assurer un fonctionnement équitable et sécurisé du groupe.

<b>• Accès :</b>
Accès possible via :
• Paiement de 3$ (USDT)  
OU  
• Invitation de 3 personnes via Start.

<b>• Système d’accès sécurisé :</b>
Un système d’accès sécurisé et inviolable permet aux membres d’échanger en toute confidentialité, en garantissant anonymat et protection.

<b>• Bannissement :</b>
Tout bannissement est définitif et irréversible.  
Toute tentative de retour avec un autre compte sera automatiquement détectée et bloquée.

<b>• Problème ou question ?</b>
📩 Contact Team.`;

  return upsertPanel(ctx, text, kbBackToHome());
}

async function renderInfo(ctx) {
  const user = await q("select created_at from users where tg_id=$1", [ctx.from.id]);
  const createdAt = user.rows[0]?.created_at;

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);
  const method = paid ? "Paiement (USDT)" : refs >= 3 ? "Invitations (3)" : "Non adhérent";

  const text = `<b>ℹ️ Tes infos</b>

🗓 Inscription : ${createdAt ? fmtFR(createdAt) : "—"}
✅ Statut : <b>${eligible ? "Adhérent" : "Non adhérent"}</b>
🔑 Mode d’accès : <b>${method}</b>
👥 Invitations : <b>${refs}/3</b>`;

  return upsertPanel(ctx, text, kbBackToHome());
}

// Copy address panel (centralized)
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

// --------------------
// Access action
async function actionAccess(ctx) {
  if (isAdmin(ctx)) return renderAdminHome(ctx);

  const { refs, paid, eligible } = await getEligibility(ctx.from.id);

  if (!eligible) {
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
${link.invite_link}`;

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

// --------------------
// Contact flow
const CONTACT_STATE = new Map();

async function renderContact(ctx) {
  const text = `<b>📩 Contact Team</b>\n\nChoisis un sujet :`;
  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("💡 Recommandation", "CONTACT_REC")],
    [Markup.button.callback("🤝 Collaboration Projet", "CONTACT_COLLAB")],
    [Markup.button.callback("🛠 Remonter un problème", "CONTACT_BUG")],
    [Markup.button.callback("🏠 Menu", "PAGE_HOME")],
  ]);
  return upsertPanel(ctx, text, kb);
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

// --------------------
// Admin pages
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

<b>Paiement :</b>
PAY_BASE=${PAY_BASE}, PAY_STEP=${PAY_STEP}, PAY_SLOTS=${PAY_SLOTS}, PAY_EXPIRE_MINUTES=${PAY_EXPIRE_MINUTES}
Watcher every ${PAY_WATCH_INTERVAL_SEC}s, min conf ${PAY_CONFIRM_MIN}`;

  return upsertPanel(ctx, text, kbAdmin());
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

  const conv =
    users.rows[0].n > 0 ? ((eligible.rows[0].n / users.rows[0].n) * 100).toFixed(1) : "0.0";

  const text = `<b>📊 Stats</b>

👤 Users : <b>${users.rows[0].n}</b>
👥 Referrals : <b>${refs.rows[0].n}</b>
💳 Paiements confirmés : <b>${paid.rows[0].n}</b>
✅ Adhérents : <b>${eligible.rows[0].n}</b>
📈 Conversion : <b>${conv}%</b>`;

  return upsertPanel(ctx, text, kbAdmin());
}

// --------------------
// TronScan logging + confirmation (no late recovery)
function toSunUSDT(amountStr) {
  const [a, b = ""] = String(amountStr).split(".");
  const frac = (b + "000000").slice(0, 6);
  return BigInt(a) * 1000000n + BigInt(frac);
}

async function fetchTrc20TransfersLatest(addressBase58, limit = 60) {
  const url =
    `${TRONSCAN_BASE}/api/token_trc20/transfers` +
    `?limit=${limit}&start=0&sort=-timestamp&relatedAddress=${encodeURIComponent(addressBase58)}`;

  const headers = {};
  if (TRONSCAN_API_KEY) headers["TRON-PRO-API-KEY"] = TRONSCAN_API_KEY;

  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data?.data || data?.token_transfers || data?.transfers || [];
}

function normalizeTronScanTransfer(raw) {
  const tokenId =
    raw?.tokenInfo?.tokenId ||
    raw?.tokenInfo?.address ||
    raw?.contract_address ||
    raw?.contractAddress ||
    "";

  const toAddr = raw?.to_address || raw?.toAddress || raw?.to || raw?.recipient || "";
  const fromAddr = raw?.from_address || raw?.fromAddress || raw?.from || raw?.sender || "";

  const ts = Number(raw?.block_ts || raw?.timestamp || raw?.transferTime || raw?.time || 0);

  const tx =
    raw?.transaction_id ||
    raw?.hash ||
    raw?.transactionHash ||
    raw?.transactionId ||
    null;

  const conf = Number(raw?.confirmations || raw?.confirmation || 0);

  let quantSun = null;
  if (raw?.quant != null) {
    try { quantSun = BigInt(raw.quant); } catch {}
  } else if (raw?.amount_in_sun != null) {
    try { quantSun = BigInt(raw.amount_in_sun); } catch {}
  } else if (raw?.amount_str != null) {
    try { quantSun = toSunUSDT(raw.amount_str); } catch {}
  } else if (raw?.amount != null) {
    const s = String(raw.amount);
    try { quantSun = s.includes(".") ? toSunUSDT(s) : BigInt(s); } catch {}
  } else if (raw?.value != null) {
    const s = String(raw.value);
    try { quantSun = s.includes(".") ? toSunUSDT(s) : BigInt(s); } catch {}
  }

  return { tx, tokenId, toAddr, fromAddr, ts, conf, quantSun };
}

async function logTransfer({ tx, tokenId, fromAddr, toAddr, ts, quantSun, raw }) {
  if (!tx || !toAddr || quantSun == null || !ts) return;
  try {
    await q(
      `insert into tron_transfers
        (tx_hash, token_contract, from_address, to_address, amount_sun, block_ts, raw)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (tx_hash) do nothing`,
      [tx, tokenId, fromAddr || null, toAddr, quantSun.toString(), ts, JSON.stringify(raw)]
    );
  } catch (e) {
    console.error("logTransfer error:", e?.message || e);
  }
}

async function tryConfirmPayment(p) {
  const expectedSun = toSunUSDT(p.expected_amount);

  const hit = await q(
    `select tx_hash
     from tron_transfers
     where to_address = $1
       and token_contract = $2
       and amount_sun = $3
       and block_ts >= $4
     order by block_ts asc
     limit 1`,
    [
      USDT_ADDRESS_TRC20,
      USDT_CONTRACT_TRON,
      expectedSun.toString(),
      new Date(p.created_at).getTime(),
    ]
  );

  if (!hit.rowCount) return null;
  return hit.rows[0].tx_hash;
}

async function autoConfirmPaymentsV5() {
  if (!USDT_ADDRESS_TRC20) return;

  // pending non expirés
  const pending = await q(
    `select id, tg_id, expected_amount, created_at
     from payments
     where status='pending' and expires_at > now()
     order by created_at asc
     limit 200`
  );
  if (!pending.rowCount) return;

  // fetch transfers + log
  const transfers = await fetchTrc20TransfersLatest(USDT_ADDRESS_TRC20, 60);

  for (const raw of transfers) {
    const t = normalizeTronScanTransfer(raw);
    if (!t.tx || !t.ts || t.quantSun == null) continue;
    if (t.tokenId && t.tokenId !== USDT_CONTRACT_TRON) continue;
    if (t.toAddr && t.toAddr !== USDT_ADDRESS_TRC20) continue;

    if (PAY_CONFIRM_MIN > 0 && t.conf && t.conf < PAY_CONFIRM_MIN) continue;

    await logTransfer({ ...t, raw });
  }

  // confirm
  for (const p of pending.rows) {
    const txHash = await tryConfirmPayment(p);
    if (!txHash) continue;

    await q(
      `update payments
       set status='confirmed', tx_hash=$2
       where id=$1 and status='pending'`,
      [p.id, txHash]
    );

    try {
      await bot.telegram.sendMessage(
        p.tg_id,
        `✅ Paiement confirmé (${p.expected_amount} USDT).\nTu peux maintenant cliquer “🔄 Rejoindre le groupe”.`
      );
    } catch {}
  }
}

// start watcher
setInterval(() => {
  autoConfirmPaymentsV5().catch((e) =>
    console.error("autoConfirmPaymentsV5:", e?.response?.data || e?.message || e)
  );
}, PAY_WATCH_INTERVAL_SEC * 1000);

// --------------------
// Admin bind/switch commands
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

// --------------------
// START + Navigation
bot.start(async (ctx) => {

  const payload = (ctx.startPayload || "").trim();
  const referredByCode = payload.startsWith("ref_") ? payload.slice(4) : null;

  await ensureUser(ctx, referredByCode);

  if (isAdmin(ctx)) {
    return renderAdminHome(ctx, { forceNew: true });
  }

  // IMAGE DE BIENVENUE
  await ctx.replyWithPhoto(
    "https://img.telemetr.io/c/2dIIta/5888598990193279412?ty=l",
  );

  return renderHomeUser(ctx, { forceNew: true });
});

// User navigation
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

// Contact
bot.action(["CONTACT_REC", "CONTACT_COLLAB", "CONTACT_BUG"], async (ctx) => {
  await ctx.answerCbQuery();
  return promptContactText(ctx, ctx.callbackQuery.data);
});

bot.command("give_ref", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const parts = ctx.message.text.split(" ");

  if (parts.length < 3) {
    return ctx.reply("Usage:\n/give_ref <tg_id> <nombre>");
  }

  const tgId = Number(parts[1]);
  const count = Number(parts[2]);

  if (!tgId || !count) {
    return ctx.reply("Paramètres invalides.");
  }

  for (let i = 0; i < count; i++) {
    const fakeUser = Math.floor(Math.random() * 1e12);

    try {
      await q(
        `insert into referrals (referrer_tg_id, referred_tg_id)
         values ($1,$2)
         on conflict do nothing`,
        [tgId, fakeUser]
      );
    } catch {}
  }

  const stats = await referralStats(tgId);

  ctx.reply(`✅ Invitations ajoutées.\nTotal actuel: ${stats}/3`);
});

bot.command("reset_ref", async (ctx) => {
  if (!isAdmin(ctx)) return;

  const parts = ctx.message.text.split(" ");
  const tgId = Number(parts[1]);

  if (!tgId) {
    return ctx.reply("Usage:\n/reset_ref <tg_id>");
  }

  await q("delete from referrals where referrer_tg_id=$1", [tgId]);

  ctx.reply("♻️ Invitations reset.");
});

// Admin entry
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

bot.action("ADMIN_SWITCH_BACKUP", async (ctx) => {
  await ctx.answerCbQuery();
  if (!isAdmin(ctx)) return;

  const backup = await getSetting("backup_chat_id");
  if (!backup) {
    return upsertPanel(ctx, "❌ Pas de backup configuré. Fais /bind_backup dans le groupe backup.", kbAdmin());
  }

  await setSetting("active_chat_id", backup);

  await upsertPanel(
    ctx,
    `🔁 Groupe actif = BACKUP (<code>${backup}</code>)\n\n📣 Notification envoyée automatiquement.`,
    kbAdmin()
  );

  autoBroadcastGroupChange("BACKUP");
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
    `🔁 Groupe actif = PRINCIPAL (<code>${main}</code>)\n\n📣 Notification envoyée automatiquement.`,
    kbAdmin()
  );

  autoBroadcastGroupChange("PRINCIPAL");
});

// Admin broadcast UI
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

Tape maintenant le message à envoyer à tous les utilisateurs.`;

  const kb = Markup.inlineKeyboard([[Markup.button.callback("🛠 Annuler", "ADMIN_HOME")]]);
  return upsertPanel(ctx, text, kb);
});

// --------------------
// Text handler (broadcast + contact)
bot.on("text", async (ctx) => {
  // Broadcast admin
  if (isAdmin(ctx) && ADMIN_BROADCAST_STATE.get(ctx.from.id)) {
    ADMIN_BROADCAST_STATE.delete(ctx.from.id);

    const msg = ctx.message.text;
    const start = Date.now();
    const res = await doBroadcast(msg);
    const secs = ((Date.now() - start) / 1000).toFixed(1);

    return ctx.reply(`✅ Broadcast terminé.\n\nTotal: ${res.total}\nOK: ${res.ok}\nFail: ${res.fail}\nDurée: ${secs}s`);
  }

  // Contact messages
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

    return ctx.reply("✅ Merci ! Ton message a été transmis à l’équipe.");
  }
});

// --------------------
// Error catcher
bot.catch((err) => {
  console.error("BOT ERROR:", err);
});

// --------------------
// Run
bot
  .launch()
  .then(() => console.log("Bot running (polling)"))
  .catch(console.error);

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));














