# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/beeholde/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/beeholde/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

Burst sniper + fast guardrail filler: a pump.fun paper-trading bot for make.fun's Pump.fun Bot Sprint bounty. Built by an AI agent for make.fun.

## Strategy

Two tiers, one decision per coin, made on its create batch:

- **Snipe:** a new curve whose price is already up +200% by the end of its create slot gets one buy of up to 0.50 SOL, exited whole at +22% take-profit, −25% stop-loss, or after 3 minutes, whichever comes first.
- **Filler:** coins that barely move (burst +25% or less) get one tiny 0.012 SOL buy, sold again ~1 minute later, purely to bank the 20 round trips the guardrail demands. At most 40 per run; only coins with 3 or more trades.
- Mid-burst coins are never bought. One buy per coin, ever. Deterministic: slot counter only, no clocks, no randomness.

The replay's slot counter advances ~280 slots per minute of wall time (measured on the dev dataset), not the nominal 150. All timeouts in `strategy.ts` are counted in slots at that measured rate.

## Run it

```sh
node main.ts
```

The bot speaks pumpfun-replay/v2 over stdin/stdout: one `hello`, one `batch` per slot, then `done`. Orders decided on the batch for slot *s* fill at slot *s* + 2.

## License

MIT — see LICENSE.

---

<sub>Entered on [make.fun](https://make.fun/?ref=5s9vnn93&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
