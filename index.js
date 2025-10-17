// index.js (nad.fun 専用・超省リクエスト版 + MC修正 + 購読2本集約)
// - BUY/SELL 通知のみ（TX DETECTED/Approveなし）
// - Transfer logs を「方向ごと2本」に集約（from配列/to配列の OR で購読）
// - HTTPは初見トークンのときだけ：/token/metadata + /trade/market + (流動性RPC 1回)
// - 表示: Price 8桁 / Amount 8桁 / Qty 2桁 / Age(d h m s) / Liquidity, MC は K/M/B/T
// - MCは price18 × totalSupplyRaw(最小単位) ÷ 1e18 で算出

import 'dotenv/config';
import axios from 'axios';
import {
  createPublicClient,
  http,
  webSocket,
  parseAbiItem,
  parseAbi,
  isAddressEqual,
  getAddress,
  formatUnits,
  erc20Abi,
} from 'viem';

/* ========= ENV ========= */
const {
  RPC_WSS_URL,
  RPC_HTTP_URL,
  DISCORD_WEBHOOK_URL,
  DISCORD_ROLE_ID = '',
  WATCH_WALLETS: WATCH_WALLETS_RAW = '',
  WALLET_LABELS: WALLET_LABELS_RAW = '',
  ADDR_LABELS: ADDR_LABELS_RAW = '',
  EXPLORER_TX_PREFIX = 'https://testnet.monadexplorer.com/tx/',
  EXPLORER_ADDR_PREFIX = 'https://testnet.monadexplorer.com/address/',
  NADFUN_API_BASE = 'https://testnet-v3-api.nad.fun/',
  USE_EMBEDS = 'true',
  RATE_LIMIT_NOTIFS_PER_MIN = '0', // 0=無制限（必要ならDiscord送信だけ間引けます）
} = process.env;

if (!RPC_WSS_URL || !RPC_HTTP_URL || !DISCORD_WEBHOOK_URL) {
  console.error('ENV不足: RPC_WSS_URL, RPC_HTTP_URL, DISCORD_WEBHOOK_URL は必須です。');
  process.exit(1);
}
const useEmbeds = String(USE_EMBEDS).toLowerCase() === 'true';
const NOTIF_CAP = Math.max(0, Number(RATE_LIMIT_NOTIFS_PER_MIN) || 0); // 0=無制限

/* ========= 正規化/辞書 ========= */
const WATCH_WALLETS = WATCH_WALLETS_RAW
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .map(s => {
    try { return getAddress(s); } catch { return null; }
  })
  .filter(Boolean);

const WALLET_NAMES = {};
WALLET_LABELS_RAW.split(';').forEach(pair => {
  const [addr, name] = pair.split('=').map(s => s?.trim()).filter(Boolean);
  if (!addr || !name) return;
  try { WALLET_NAMES[getAddress(addr)] = name; } catch {}
});

const ADDR_LABELS = {};
ADDR_LABELS_RAW.split(';').forEach(pair => {
  const [addr, label] = pair.split('=').map(s => s?.trim()).filter(Boolean);
  if (!addr || !label) return;
  try { ADDR_LABELS[getAddress(addr)] = label; } catch {}
});

/* ========= viem clients ========= */
const wsClient  = createPublicClient({ transport: webSocket(RPC_WSS_URL) });
const httpCli   = createPublicClient({ transport: http(RPC_HTTP_URL) });

/* ========= ABI ========= */
const transferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)'
);
const bondingCurveAbi = parseAbi([
  'function curves(address token) view returns (uint256 realMonReserve, uint256 realTokenReserve, uint256 virtualMonReserve, uint256 virtualTokenReserve, uint256 k, uint256 targetTokenAmount, uint256 initVirtualMonReserve, uint256 initVirtualTokenReserve)',
]);

/* ========= 既知アドレス（nad.fun） ========= */
const WMON = getAddress('0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701');
const BONDING_CURVE = getAddress('0x52D34d8536350Cd997bCBD0b9E9d722452f341F5');

const NAD_KNOWN = new Set([
  getAddress('0x52D34d8536350Cd997bCBD0b9E9d722452f341F5'), // BondingCurve
  getAddress('0x4F5A3518F082275edf59026f72B66AC2838c0414'), // BondingCurveRouter
  getAddress('0x4FBDC27FAE5f99E7B09590bEc8Bf20481FCf9551'), // DexRouter
  getAddress('0x961235a9020B05C44DF1026D956D1F4D78014276'), // Factory
  getAddress('0x760AfE86e5de5fa0Ee542fc7B7B713e1c5425701'), // WMON
]);
for (const [addr, label] of Object.entries(ADDR_LABELS)) {
  if (String(label).toLowerCase().includes('nad.fun')) {
    try { NAD_KNOWN.add(getAddress(addr)); } catch {}
  }
}

/* ========= キャッシュ/重複 ========= */
const seenLogKey = new Set();
const tokenInfoCache = new Map();   // key=token -> { … , price, market_type, market_id, total_supply, … }

/* ========= Utils ========= */
const short = (a) => (a ? `${a.slice(0,6)}...${a.slice(-4)}` : '');
const labelOf = (addr) => (addr && ADDR_LABELS[addr]) ? ADDR_LABELS[addr] : null;
const walletNameOf = (addr) => (addr && WALLET_NAMES[addr]) ? WALLET_NAMES[addr] : null;
const isWatched = (addr) => WATCH_WALLETS.some(w => addr && isAddressEqual(w, addr));
const explorerTx = (h) => `${EXPLORER_TX_PREFIX}${h}`;
const explorerAddr = (a) => `${EXPLORER_ADDR_PREFIX}${a}`;
const nadTokenPage = (token) => `https://testnet.nad.fun/tokens/${getAddress(token)}`;

// 18 → 2桁
function toFixed2From18(rawBigInt) {
  const s = formatUnits(rawBigInt, 18);
  let [i, d=''] = s.split('.');
  if (!d) d = '00';
  if (d.length >= 2) d = d.slice(0,2);
  if (d.length === 1) d = d + '0';
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${i}.${d}`;
}
// 18 → 任意桁（価格/金額 8桁）
function from18ToDecimals(rawBigInt, decimals = 8) {
  const s = formatUnits(rawBigInt, 18);
  let [i, d=''] = s.split('.');
  d = (d + '0'.repeat(decimals)).slice(0, decimals);
  i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${i}${decimals>0?'.':''}${d}`;
}
// 文字列(科学記法可)→18桁 (価格など“スケールが必要な値”)
function decimalStrToBigInt18(s) {
  s = String(s).trim();
  if (/e/i.test(s)) {
    const [mant, e] = s.toLowerCase().split('e');
    const exp = parseInt(e, 10);
    let [i, d=''] = mant.split('.');
    const pure = (i + d).replace('-', '');
    const sign = mant.startsWith('-') ? -1n : 1n;
    const shift = exp - d.length;
    if (shift >= 0) return sign * BigInt(pure + '0'.repeat(shift)) * 10n**18n;
    const cut = pure.length + shift;
    const left = cut > 0 ? pure.slice(0, cut) : '0';
    const right = cut > 0 ? pure.slice(cut) : pure.padStart(pure.length + (-shift), '0');
    return decimalStrToBigInt18(`${left}.${right}`);
  }
  const neg = s.startsWith('-'); if (neg) s = s.slice(1);
  let [i, d=''] = s.split('.');
  d = d.padEnd(18, '0').slice(0,18);
  const bi = BigInt(i || '0') * 10n**18n + BigInt(d || '0');
  return neg ? -bi : bi;
}
// 文字列(科学記法可)→ “そのまま整数 BigInt”（total_supply のような最小単位）
function parseScientificToBigIntRaw(s) {
  s = String(s).trim();
  if (!s) return null;
  if (/e/i.test(s)) {
    let [mant, e] = s.toLowerCase().split('e');
    const exp = parseInt(e, 10);
    const neg = mant.startsWith('-');
    if (neg) mant = mant.slice(1);
    let [i, d=''] = mant.split('.');
    const digits = (i + d).replace(/^0+/, '') || '0';
    const shift = exp - d.length;
    if (shift >= 0) {
      const val = (digits === '0') ? '0' : (digits + '0'.repeat(shift));
      const bi = BigInt(val);
      return neg ? -bi : bi;
    } else {
      const cut = digits.length + shift;
      const left = cut > 0 ? digits.slice(0, cut) : '0';
      const bi = BigInt(left || '0');
      return neg ? -bi : bi;
    }
  }
  if (!/^\d+$/.test(s)) return null;
  return BigInt(s);
}
// 18*18 / 1e18
const mul18 = (a18, b18) => (a18 * b18) / 10n**18n;

// Age 表示（d h m s）
function ageHuman(unixSec) {
  if (!unixSec) return '-';
  const created = new Date(Number(unixSec) * 1000);
  const now = new Date();
  let diff = Math.max(0, Math.floor((now - created) / 1000));
  const d = Math.floor(diff / 86400); diff -= d*86400;
  const h = Math.floor(diff / 3600);  diff -= h*3600;
  const m = Math.floor(diff / 60);    diff -= m*60;
  const s = diff;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// K/M/B/T 短縮（MON）
function formatMonShort(big18) {
  const s = formatUnits(big18, 18);
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  const abs = Math.abs(n);
  const fmt = (val, unit) => `${val.toFixed(val>=100?0:val>=10?1:2)}${unit}`;
  if (abs >= 1e12) return fmt(n/1e12, 'T');
  if (abs >= 1e9)  return fmt(n/1e9,  'B');
  if (abs >= 1e6)  return fmt(n/1e6,  'M');
  if (abs >= 1e3)  return fmt(n/1e3,  'K');
  return n.toFixed(n>=100?0:n>=10?1:2);
}

function isNadAddress(addr) {
  if (!addr) return false;
  try { if (NAD_KNOWN.has(getAddress(addr))) return true; } catch {}
  const lab = labelOf(addr) || '';
  return lab.toLowerCase().includes('nad.fun');
}

/* ===== REST: メタ & マーケット（初見だけ） ===== */
async function getTokenInfo(tokenAddress) {
  const key = tokenAddress.toLowerCase();
  if (tokenInfoCache.has(key)) return tokenInfoCache.get(key);

  const base = NADFUN_API_BASE.endsWith('/') ? NADFUN_API_BASE : (NADFUN_API_BASE + '/');
  let meta = null, mkt = null;
  try { meta = (await axios.get(`${base}token/metadata/${tokenAddress}`, { timeout: 6000 }))?.data?.token_metadata || null; } catch {}
  try { mkt  = (await axios.get(`${base}trade/market/${tokenAddress}`,   { timeout: 6000 }))?.data || null; } catch {}

  const info = {
    token_address: tokenAddress,
    name: meta?.name || null,
    symbol: meta?.symbol || null,
    image_uri: meta?.image_uri || null,
    created_at: meta?.created_at || null,
    total_supply: meta?.total_supply || mkt?.total_supply || null, // (最小単位Raw)
    market_type: mkt?.market_type || null,   // 'CURVE' | 'DEX'
    market_id: mkt?.market_id || null,
    price: mkt?.price || null,               // (MON/1 token)
  };
  tokenInfoCache.set(key, info);
  return info;
}

/* ===== 流動性(MON, 18桁 BigInt) ===== */
async function getLiquidityMon(token, marketType, marketId) {
  try {
    if (marketType === 'CURVE') {
      const [realMonReserve] = await httpCli.readContract({
        address: BONDING_CURVE,
        abi: bondingCurveAbi,
        functionName: 'curves',
        args: [getAddress(token)],
      });
      return BigInt(realMonReserve);
    }
    if (marketType === 'DEX' && marketId) {
      const wmonBal = await httpCli.readContract({
        address: WMON,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [getAddress(marketId)],
      });
      return BigInt(wmonBal);
    }
  } catch (_) {}
  return null;
}

/* ===== Discord送信（役職メンション先頭） ===== */
let sentInWindow = 0;
let windowStart = Date.now();
async function notifyDiscord({ content, embed }) {
  if (NOTIF_CAP > 0) {
    const now = Date.now();
    if (now - windowStart >= 60_000) { windowStart = now; sentInWindow = 0; }
    if (sentInWindow >= NOTIF_CAP) return;
    sentInWindow++;
  }
  const prefix = DISCORD_ROLE_ID ? `<@&${DISCORD_ROLE_ID}> ` : '';
  try {
    if (useEmbeds && embed) {
      await axios.post(DISCORD_WEBHOOK_URL, { content: prefix + (content || ''), embeds: [embed] }, { timeout: 10000 });
    } else {
      await axios.post(DISCORD_WEBHOOK_URL, { content: prefix + (content || '(no content)') }, { timeout: 10000 });
    }
  } catch (e) {
    if (e.response?.status === 429) {
      const retry = Number(e.response.headers['retry-after'] || 1) * 1000;
      await new Promise(r => setTimeout(r, retry));
      return notifyDiscord({ content, embed });
    }
    console.error('Discord通知エラー:', e.message);
  }
}

/* ===== BUY/SELL 通知（nad.fun専用） ===== */
async function emitNadBuySell({ token, from, to, txHash, rawValue }) {
  const tokenAddr = getAddress(token);
  const info = await getTokenInfo(tokenAddr).catch(() => null);

  const qty2 = toFixed2From18(rawValue);

  // Price (MON) [8桁]
  const price18 = (info?.price != null) ? decimalStrToBigInt18(info.price) : null;
  const priceStr8 = (price18 != null) ? from18ToDecimals(price18, 8) : '-';

  // Amount (MON) = price × qty [8桁表示]
  const notion18 = (price18 != null) ? mul18(price18, rawValue) : null;
  const amountStr = (notion18 != null) ? from18ToDecimals(notion18, 8) : '-';

  // Age
  const ageStr = info?.created_at ? ageHuman(info.created_at) : '-';

  // Market Cap：price18 × totalSupplyRaw(最小単位) ÷ 1e18
  let mcapShort = '-';
  try {
    if (price18 != null && info?.total_supply) {
      const totalRaw = parseScientificToBigIntRaw(info.total_supply);
      if (totalRaw != null) {
        const mc18 = mul18(price18, totalRaw);
        mcapShort = formatMonShort(mc18);
      }
    }
  } catch (_) {}

  // 流動性(MON, 短縮)
  let liqShort = '-';
  try {
    const liq18 = await getLiquidityMon(tokenAddr, info?.market_type, info?.market_id);
    if (liq18 != null) liqShort = formatMonShort(liq18);
  } catch (_) {}

  const isBuy = isWatched(to);            // BUY: to=自分 / SELL: from=自分
  const trader = isBuy ? to : from;
  const traderName = walletNameOf(trader) || short(trader);

  const embed = {
    title: isBuy ? '🟢 **BUY DETECTED**' : '🔴 **SELL DETECTED**',
    description: `**[nad.fun Trade Alert](${nadTokenPage(tokenAddr)})**\n> ${info?.name || 'Unknown Token'} (\`${info?.symbol || 'N/A'}\`)`,
    url: explorerTx(txHash),
    color: isBuy ? 0x00ff88 : 0xff4444,
    thumbnail: info?.image_uri ? { url: info.image_uri } : undefined,
    fields: [
      { name: '👤 Trader', value: `**${traderName}**\n[\`${trader}\`](${explorerAddr(trader)})`, inline: false },
      { name: '\u200B', value: '\u200B', inline: false },
      { name: '📊 Quantity',      value: `\`\`\`${qty2}\`\`\``,     inline: true },
      { name: '💰 Price (MON)',   value: `\`\`\`${priceStr8}\`\`\``, inline: true },
      { name: '💵 Amount (MON)',  value: `\`\`\`${amountStr}\`\`\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: false },
      { name: '💧 Liquidity',     value: `**${liqShort}** MON`,      inline: true },
      { name: '📈 Market Cap',    value: `**${mcapShort}** MON`,     inline: true },
      { name: '⏰ Age',            value: `\`${ageStr}\``,            inline: true },
    ],
    footer: { text: `Monad Testnet • nad.fun • ${new Date().toLocaleTimeString('ja-JP')}` },
    timestamp: new Date().toISOString(),
  };
  await notifyDiscord({ content: '', embed });
}

/* ===== Transfer購読（topics ORで2本に集約） ===== */
async function handleTransferLogs(logs) {
  for (const log of logs) {
    const { address: token, args, transactionHash, logIndex } = log;
    const from = getAddress(args.from);
    const to   = getAddress(args.to);
    const key  = `${transactionHash}-${logIndex}`;
    if (seenLogKey.has(key)) continue;
    seenLogKey.add(key);

    const watchFrom = isWatched(from);
    const watchTo   = isWatched(to);
    if (!(watchFrom || watchTo)) continue;

    // nad.fun に関係する取引だけ通知：
    // 1) 送受どちらかが既知の nad.fun アドレス
    // 2) それ以外でも token の market_type が 'DEX' or 'CURVE'
    let nadRelated = isNadAddress(from) || isNadAddress(to);
    if (!nadRelated) {
      try {
        const tinfo = await getTokenInfo(getAddress(token));
        if (tinfo?.market_type === 'DEX' || tinfo?.market_type === 'CURVE') {
          nadRelated = true;
        }
      } catch (_) {}
    }
    if (!nadRelated) continue;

    // 🔒 bigint安全化（環境差対策）
    const raw = (typeof args.value === 'bigint') ? args.value : BigInt(args.value ?? 0);
    await emitNadBuySell({ token, from, to, txHash: transactionHash, rawValue: raw });
  }
}

function subscribeTransfersAggregated(watchAddrs) {
  if (!watchAddrs.length) {
    console.warn('WATCH_WALLETS が空です。購読を開始しません。');
    return;
  }
  const ADDRS = watchAddrs.map(a => getAddress(a));

  // BUY候補（to ∈ 監視ウォレット）
  wsClient.watchEvent({
    event: transferEvent,
    args: { to: ADDRS },       // ← OR 配列
    onLogs: handleTransferLogs,
    onError: (e) => console.error('watchEvent(to[]) error:', e?.message || e),
  });

  // SELL候補（from ∈ 監視ウォレット）
  wsClient.watchEvent({
    event: transferEvent,
    args: { from: ADDRS },     // ← OR 配列
    onLogs: handleTransferLogs,
    onError: (e) => console.error('watchEvent(from[]) error:', e?.message || e),
  });
}

/* ===== 起動 ===== */
subscribeTransfersAggregated(WATCH_WALLETS);
console.log('Watcher started: nad.fun BUY/SELL only (Transfer logs, 2 subscriptions total).');
console.log('WATCH_WALLETS:', WATCH_WALLETS.map(short).join(', '));
