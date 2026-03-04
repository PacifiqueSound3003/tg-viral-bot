import "dotenv/config";
import axios from "axios";
import { q } from "./db.js";

const USDT_ADDRESS = process.env.USDT_ADDRESS_TRC20;
const TRONSCAN_BASE = process.env.TRONSCAN_BASE;
const TRONSCAN_API_KEY = process.env.TRONSCAN_API_KEY;

async function expireOld() {
  await q("update payments set status='expired' where status='pending' and expires_at <= now()");
}

async function fetchIncomingUSDT() {
  // ⚠️ Endpoint/provider à adapter selon ton choix réel.
  // Objectif: récupérer transferts TRC20 entrants vers USDT_ADDRESS.
  const headers = TRONSCAN_API_KEY ? { "TRON-PRO-API-KEY": TRONSCAN_API_KEY } : {};
  const url = `${TRONSCAN_BASE}/api/token_trc20/transfers?limit=50&start=0&sort=-timestamp&toAddress=${USDT_ADDRESS}`;
  const r = await axios.get(url, { headers });

  const items = r.data?.token_transfers || r.data?.data || [];
  return items.map(it => ({
    to: it.to_address || it.toAddress,
    tx: it.transaction_id || it.transactionId || it.hash,
    amount: String(it.quant || it.amount || it.value || ""),
    timestamp: it.block_ts || it.timestamp || Date.now()
  })).filter(x => x.to && x.tx && x.amount);
}

async function confirmPayments(transfers) {
  const pending = await q(
    "select id, tg_id, expected_amount from payments where status='pending' and expires_at > now()"
  );

  for (const p of pending.rows) {
    const expected = String(p.expected_amount);
    // ⚠️ selon provider, amount peut être en "raw" (sans décimales).
    // Ici c’est volontairement simple: à ajuster une fois la source choisie.
    const match = transfers.find(t => t.to === USDT_ADDRESS && String(t.amount).startsWith(expected));
    if (match) {
      await q("update payments set status='confirmed', tx_hash=$2 where id=$1", [p.id, match.tx]);
      console.log("confirmed", p.tg_id, expected, match.tx);
    }
  }
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function loop() {
  while (true) {
    try {
      await expireOld();
      const transfers = await fetchIncomingUSDT();
      await confirmPayments(transfers);
    } catch (e) {
      console.error(e?.response?.data || e.message || e);
    }
    await sleep(15000); // 15s
  }
}

loop();