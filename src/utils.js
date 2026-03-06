import crypto from "crypto";

// code referral court, stable, URL-safe
export function makeRefCode() {
  // 10 chars environ
  return crypto.randomBytes(8).toString("base64url").slice(0, 10);
}

export function nowPlusMinutes(min) {
  return new Date(Date.now() + Number(min) * 60_000);
}

// Telegram peut renvoyer {first_name:"Deleted Account"} ou sans nom
export function isDeletedUser(u) {
  const fn = (u?.first_name || "").toLowerCase();
  const un = (u?.username || "").toLowerCase();
  return fn.includes("deleted") || un.includes("deleted");
}

// Génère une URL de partage Telegram avec texte + lien
export function shareLink(url) {
  const text = `Nouveau groupe d'échange 100% automatisé avec du contenu exclusif +30Gb de Leak👉 ${url}`;
  return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}
