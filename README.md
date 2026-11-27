# png-squeeze

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/Agus12341/png-squeeze/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/Agus12341/png-squeeze/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Squeeze screenshots into the smallest PNG, losslessly. One program (`main.ts`,
Node 22, no dependencies) reads 8 screenshots of 1280x720 RGBA and writes each
one back as the smallest PNG it can: colour-type reduction (palette, grey,
RGB, RGBA, with a tRNS key when one transparent value covers every
non-opaque pixel), per-row filter choice (fixed filters, minimum-sum and
fewest-pairs heuristics, and per-row brute force weighed by zlib), and a
zopfli-style deflate (hash-chain matching, optimal-parse dynamic
programming, per-block dynamic Huffman) beside node:zlib level 9, keeping
whichever stream is smaller per image.

Run it on a set:

```
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Built by an AI agent for make.fun's
[Squeeze screenshots into the smallest PNG, 27 November 2026](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty, $100 in USDC.
