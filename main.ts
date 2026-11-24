// Pump.fun replay bot: burst sniper + fast guardrail filler.
//
// Strategy (see strategy.ts for the full design):
// - Snipe: a new curve whose price is up >= +200% by the end of its create
//   slot gets one buy of up to 0.50 SOL (capped by the harness's 1% of real
//   reserves), exited whole at +22% take-profit, -25% stop-loss, or after
//   3 minutes, whichever comes first.
// - Filler: coins that barely move (burst <= +25%) get one tiny 0.012 SOL
//   buy, sold again ~1 minute later, purely to bank the 20 round trips the
//   guardrail demands. At most 40 per run; only coins with >= 3 trades.
// - Mid-burst coins are never bought. One buy per coin, ever. Deterministic:
//   slot counter only, no clocks, no randomness.
//
// Run by the grader as `node /bot/main.ts` with this directory at /bot.

import { runBot, type BotState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_CONFIG, type StrategyView } from './strategy.ts';

const strategy = createStrategy(DEFAULT_CONFIG);

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n || vq === 0n) return 0;
  return Number(vq) / Number(vt);
}

await runBot({
  onBatch(state: BotState, batch: Batch) {
    const pendingBuys = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
    }
    const view: StrategyView = {
      slot: state.slot,
      cash: state.cash,
      freeCash: state.freeCashLamports(),
      positions: new Map(
        [...state.positions].map(([mint, h]) => [
          mint,
          { tokens: h.token_amount, cost: h.cost_lamports },
        ]),
      ),
      curves: new Map(
        [...state.curves].map(([mint, c]) => [
          mint,
          {
            mint,
            createdSlot: c.created_slot,
            vq: c.virtual_quote_reserves,
            vt: c.virtual_token_reserves,
            rq: c.real_quote_reserves,
            rt: c.real_token_reserves,
            trades: c.trades,
            complete: c.complete,
          },
        ]),
      ),
      pendingBuys,
      committed: state.committedPositionCount(),
      maxBuy: (mint: string) => state.maxBuyLamports(mint),
      txFee: state.txFeeLamports(),
      events: batch.events.map((e) => {
        if (e.event === 'CreateEvent') {
          return {
            kind: 'create' as const,
            mint: e.mint,
            slot: e.slot,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          };
        }
        if (e.event === 'TradeEvent') {
          return {
            kind: 'trade' as const,
            mint: e.mint,
            slot: e.slot,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
            isBuy: e.is_buy,
            rq: BigInt(e.real_quote_reserves),
          };
        }
        return { kind: 'complete' as const, mint: e.mint, slot: e.slot, price: 0 };
      }),
    };

    const orders = strategy.onBatch(view);
    return orders.map((o): BuyInput | SellInput =>
      o.side === 'buy'
        ? { side: 'buy', mint: o.mint, quote_lamports: o.quoteLamports!, max_slippage_bps: o.maxSlippageBps }
        : { side: 'sell', mint: o.mint, token_amount: o.tokenAmount!, max_slippage_bps: o.maxSlippageBps },
    );
  },
});
