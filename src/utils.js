export function makeRefCode() {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
}
export function nowPlusMinutes(min) {
  return new Date(Date.now() + min * 60 * 1000);
}
export function isDeletedUser(tgUser) {
  const fn = (tgUser?.first_name || "").toLowerCase();
  return fn.includes("deleted");
}
export function shareLink(refLink) {
  const text = encodeURIComponent("🔗 Rejoins via mon lien (et clique Start) :");
  const url = encodeURIComponent(refLink);
  return `https://t.me/share/url?url=${url}&text=${text}`;
}