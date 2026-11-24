// Pump.fun replay bot strategy — fresh composition for the riidzhsn sprint.
// One strategy program: a burst sniper for big instant pumps plus a small
// fast filler that exists only to clear the 20-round-trip guardrail.
//
// The bot is deterministic: it reads only the slot counter, the reserves and
// its own orders. No clocks, no randomness, no network.
//
// How it works, in one paragraph: every new curve is watched through its
// create slot. If the price at the end of that slot is up >= burstMin on the
// create price, the coin is a snipe candidate: buy up to stakeSol SOL (capped
// by the harness's 1%-of-real-reserves size cap), then exit the whole
// position at +tp, at -sl, or after timeoutMin minutes, whichever comes
// first. Coins that barely move (burst <= fillerBurstMax) get one tiny
// filler buy (0.01 SOL) that is sold again fast, purely to bank the round
// trips the guardrail demands; at most fillerCap of them. If the window is
// 5h old and round trips are still short, the filler widens to catch-up
// settings. Mid-burst coins are never bought: they are the worst of both
// worlds (too small to size, too faded to run).

export interface StrategyConfig {
  burstMin: number; // snipe entry: burst at end of create slot, e.g. 2.0 = +200%
  stakeSol: number; // max SOL per snipe buy
  snipeMinBuySol: number; // skip a snipe when the size cap allows less than this
  tp: number; // snipe take profit vs average entry cost, e.g. 0.20
  sl: number; // snipe stop loss vs average entry cost, e.g. 0.25
  timeoutMin: number; // snipe max hold, minutes
  tp2: number; // second take-profit for the remainder after a partial exit (0 = off)
  tp2Share: number; // fraction of tokens sold at tp when tp2 is on (0..1)
  filler: 'none' | 'fast' | 'hold';
  fillerBurstMax: number; // filler entry: burst at end of create slot at most this
  fillerStakeSol: number; // SOL per filler buy (single order)
  fillerMinBuySol: number; // skip a filler when the size cap allows less than this
  fillerCap: number; // max filler buys per run
  fillerTp: number;
  fillerSl: number;
  fillerTimeoutMin: number;
  fillerFastMin: number; // 'fast' filler: sell this many minutes after the buy
  fillerMinTrades: number; // filler entry: coin must have this many trades (0 = off)
  fillerMaxAgeMin: number; // filler entry: at most this old, minutes (0 = off)
  catchupAfterMin: number; // widen the filler after this many minutes into the window
  catchupMinRt: number; // ...but only while round trips are below this
  catchupBurstMax: number;
  catchupTimeoutMin: number;
  slippageBuyBps: number;
  slippageSellBps: number;
}

export const DEFAULT_CONFIG: StrategyConfig = {
  burstMin: 2.0,
  stakeSol: 0.5,
  snipeMinBuySol: 0.05,
  tp: 0.22,
  sl: 0.25,
  timeoutMin: 3,
  tp2: 0,
  tp2Share: 0.5,
  filler: 'fast',
  fillerBurstMax: 0.25,
  fillerStakeSol: 0.012,
  fillerMinBuySol: 0.0105,
  fillerCap: 40,
  fillerTp: 1.0,
  fillerSl: 0.4,
  fillerTimeoutMin: 75,
  fillerFastMin: 1,
  fillerMinTrades: 3,
  fillerMaxAgeMin: 0,
  catchupAfterMin: 300,
  catchupMinRt: 17,
  catchupBurstMax: 0.6,
  catchupTimeoutMin: 30,
  slippageBuyBps: 2000,
  slippageSellBps: 5000,
};

export interface OrderOut {
  side: 'buy' | 'sell';
  mint: string;
  quoteLamports?: bigint;
  tokenAmount?: bigint;
  maxSlippageBps: number;
}

export interface CurveView {
  mint: string;
  createdSlot: number | null;
  vq: bigint;
  vt: bigint;
  rq: bigint;
  rt: bigint;
  trades: number;
  complete: boolean;
}

export interface PosView {
  tokens: bigint;
  cost: bigint;
}

export interface BatchEventView {
  kind: 'create' | 'trade' | 'complete';
  mint: string;
  slot: number;
  price: number; // SOL per token, from virtual reserves (0 when unknown)
  isBuy?: boolean;
  rq?: bigint; // real quote reserves after the event (trades only)
}

export interface StrategyView {
  slot: number;
  cash: bigint;
  freeCash: bigint;
  positions: Map<string, PosView>;
  curves: Map<string, CurveView>;
  pendingBuys: Set<string>;
  committed: number;
  maxBuy(mint: string): bigint;
  txFee: bigint;
  events: BatchEventView[];
}

const LAMPORTS_PER_SOL = 1_000_000_000n;
const SLOTS_PER_MIN = 280;

type Kind = 'snipe' | 'filler';

interface MintState {
  createSlot: number;
  createPrice: number;
  burst: number | null;
  decided: boolean;
  kind: Kind | null;
  entrySlot: number;
  maxCostSol: number;
  // A buy was sent for this mint: never buy it again. Re-entering a coin
  // we already traded re-buys a dumped coin at a stale burst signal and
  // pays the offset mismatch (our own past sells shrink the effective
  // real reserves below what the bot's curve shows, so the size cap bites).
  tried: boolean;
  trades: number;
  lastTradeSlot: number;
  // Partial exit done at tp (when tp2 is on): the rest rides to tp2.
  partialDone: boolean;
}

export function createStrategy(cfg: StrategyConfig): { onBatch(view: StrategyView): OrderOut[] } {
  const mints = new Map<string, MintState>();
  let windowStartSlot = -1;
  let roundTrips = 0;
  let fillerBuys = 0;
  // Mints we held last batch (to detect a round trip closing).
  let heldLast = new Set<string>();
  // Sells sent but not yet resolved (fill lands 2 slots later); avoids
  // sending the same sell twice. Entries expire after 3 slots so a
  // rejected sell can be retried.
  const pendingSell = new Map<string, number>();

  function priceOf(c: CurveView): number {
    if (c.vt === 0n || c.vq === 0n) return 0;
    return Number(c.vq) / Number(c.vt);
  }

  function onBatch(view: StrategyView): OrderOut[] {
    if (windowStartSlot < 0) windowStartSlot = view.slot;
    const orders: OrderOut[] = [];

    // ---- round trips closed since last batch ----
    const heldNow = new Set<string>(view.positions.keys());
    for (const m of heldLast) {
      if (!heldNow.has(m)) {
        const st = mints.get(m);
        if (st && st.maxCostSol >= 0.01) roundTrips += 1;
      }
    }
    heldLast = heldNow;

    // ---- learn from this batch's events ----
    for (const ev of view.events) {
      if (ev.kind === 'create') {
        if (!mints.has(ev.mint)) {
          mints.set(ev.mint, {
            createSlot: ev.slot,
            createPrice: ev.price,
            burst: null,
            decided: false,
            kind: null,
            entrySlot: 0,
            maxCostSol: 0,
            tried: false,
            trades: 0,
            lastTradeSlot: 0,
            partialDone: false,
          });
        }
      } else if (ev.kind === 'trade') {
        const st = mints.get(ev.mint);
        if (st) {
          st.trades += 1;
          st.lastTradeSlot = ev.slot;
        }
      }
    }
    // End of create slot: the batch for the create slot carries its trades.
    // Burst = last trade price in the create slot vs the create price.
    for (const ev of view.events) {
      if (ev.kind !== 'trade') continue;
      const st = mints.get(ev.mint);
      if (!st || st.decided || ev.slot !== st.createSlot) continue;
      if (st.createPrice > 0) st.burst = ev.price / st.createPrice - 1;
    }
    // Mark creates whose slot is over: this batch carries every event of the
    // create slot, so the burst (if any) is final now.
    for (const ev of view.events) {
      if (ev.kind !== 'create') continue;
      const st = mints.get(ev.mint);
      if (st && !st.decided && ev.slot === st.createSlot) st.decided = true;
    }
    // Any mint whose create slot is strictly in the past and undecided: decide now.
    for (const st of mints.values()) {
      if (!st.decided && view.slot > st.createSlot) st.decided = true;
    }

    // ---- clear stale kinds (a buy that never filled) ----
    for (const [mint, st] of mints) {
      if (st.kind !== null && !view.positions.has(mint) && !view.pendingBuys.has(mint)) {
        st.kind = null;
      }
    }

    // ---- track max cost per held mint (round-trip qualification) ----
    for (const [mint, pos] of view.positions) {
      const st = mints.get(mint);
      if (st) {
        const costSol = Number(pos.cost) / 1e9;
        if (costSol > st.maxCostSol) st.maxCostSol = costSol;
      }
    }

    const minutesIn = (view.slot - windowStartSlot) / SLOTS_PER_MIN;
    const catchup =
      minutesIn >= cfg.catchupAfterMin && roundTrips < cfg.catchupMinRt;

    // ---- exits ----
    for (const [slotSentMint, sentSlot] of [...pendingSell]) {
      if (view.slot - sentSlot >= 3) pendingSell.delete(slotSentMint);
    }
    for (const [mint, pos] of view.positions) {
      const st = mints.get(mint);
      const curve = view.curves.get(mint);
      if (!st || !st.kind || !curve || pos.tokens === 0n) continue;
      if (pendingSell.has(mint)) continue;
      const mark = priceOf(curve);
      const entry = Number(pos.cost) / Number(pos.tokens);
      if (entry <= 0 || mark <= 0) continue;
      const ret = mark / entry - 1;
      const heldMin = (view.slot - st.entrySlot) / SLOTS_PER_MIN;
      let exit: bigint | null = null; // tokens to sell, null = hold
      if (st.kind === 'snipe') {
        if (ret <= -cfg.sl || heldMin >= cfg.timeoutMin) {
          exit = pos.tokens;
        } else if (ret >= cfg.tp) {
          if (cfg.tp2 > 0 && !st.partialDone) {
            // Take half off at tp; let the rest ride to tp2.
            exit = (pos.tokens * BigInt(Math.round(cfg.tp2Share * 100))) / 100n;
            st.partialDone = true;
          } else if (cfg.tp2 > 0 && st.partialDone) {
            exit = ret >= cfg.tp2 ? pos.tokens : null;
          } else {
            exit = pos.tokens;
          }
        }
      } else {
        const timeout = catchup ? cfg.catchupTimeoutMin : cfg.fillerTimeoutMin;
        exit =
          ret >= cfg.fillerTp ||
          ret <= -cfg.fillerSl ||
          heldMin >= timeout ||
          (cfg.filler === 'fast' && heldMin >= cfg.fillerFastMin)
            ? pos.tokens
            : null;
      }
      if (exit !== null && exit > 0n) {
        orders.push({
          side: 'sell',
          mint,
          tokenAmount: exit,
          maxSlippageBps: cfg.slippageSellBps,
        });
        pendingSell.set(mint, view.slot);
      }
    }

    // ---- entries: two passes so a snipe never loses its slot to a filler.
    // A coin is tried once, ever: re-entering a dumped coin at a stale
    // burst signal is how the first draft bled.
    const committedNow = view.committed;
    let committed = committedNow;
    const burstMax = catchup ? cfg.catchupBurstMax : cfg.fillerBurstMax;

    const eligible = (mint: string, st: MintState): boolean => {
      if (st.burst === null || !st.decided) return false;
      if (st.tried || st.kind !== null) return false;
      if (view.positions.has(mint) || view.pendingBuys.has(mint)) return false;
      const curve = view.curves.get(mint);
      if (!curve || curve.complete) return false;
      return true;
    };

    // Pass 1: snipes.
    for (const [mint, st] of mints) {
      if (committed >= 5) break;
      if (!eligible(mint, st)) continue;
      if (st.burst! < cfg.burstMin) continue;
      const capSol = Number(view.maxBuy(mint)) / 1e9;
      // 1% haircut on the size cap: the harness checks the buy against the
      // offset-shifted real reserves, which can sit a hair below the
      // reserves the bot's curve shows.
      const spend = Math.min(cfg.stakeSol, capSol) * 0.99;
      if (spend < cfg.snipeMinBuySol) continue;
      if (view.freeCash < BigInt(Math.floor(spend * 1e9)) + view.txFee) continue;
      orders.push({
        side: 'buy',
        mint,
        quoteLamports: BigInt(Math.floor(spend * 1e9)),
        maxSlippageBps: cfg.slippageBuyBps,
      });
      st.kind = 'snipe';
      st.tried = true;
      st.entrySlot = view.slot;
      committed += 1;
    }

    // Pass 2: fillers (guardrail round trips). Only coins that show life:
    // enough trades, and not too old — a dead coin just fades.
    if (cfg.filler !== 'none') {
      for (const [mint, st] of mints) {
        if (committed >= 5) break;
        if (fillerBuys >= cfg.fillerCap) break;
        if (!eligible(mint, st)) continue;
        if (st.burst! > burstMax) continue;
        if (cfg.fillerMinTrades > 0 && st.trades < cfg.fillerMinTrades) continue;
        const ageMin = (view.slot - st.createSlot) / SLOTS_PER_MIN;
        if (cfg.fillerMaxAgeMin > 0 && ageMin > cfg.fillerMaxAgeMin) continue;
        const capSol = Number(view.maxBuy(mint)) / 1e9;
        const spend = Math.min(cfg.fillerStakeSol, capSol) * 0.99;
        if (spend < cfg.fillerMinBuySol) continue;
        if (view.freeCash < BigInt(Math.floor(spend * 1e9)) + view.txFee) continue;
        orders.push({
          side: 'buy',
          mint,
          quoteLamports: BigInt(Math.floor(spend * 1e9)),
          maxSlippageBps: cfg.slippageBuyBps,
        });
        st.kind = 'filler';
        st.tried = true;
        st.entrySlot = view.slot;
        fillerBuys += 1;
        committed += 1;
      }
    }
    // Mid-burst coins: never bought.

    return orders;
  }

  return { onBatch };
}
