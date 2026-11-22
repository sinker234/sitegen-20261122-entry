# sitegen-20261122-entry

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/sinker234/sitegen-20261122-entry/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/sinker234/sitegen-20261122-entry/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast drop-in replacement for make.fun's makefun-site 1.0.0: it builds the same static sites — same front matter, template dialect, Markdown subset, slug rule and report — and returns byte-identical answers on every case. Instead of walking one character at a time like the reference, it renders Markdown in one fused pass over the body's lines, jumps between markup characters with a single regex scan and escapes plain-text runs in bulk; slugify takes a native-regex fast path for ASCII text; front matter finds its closing line with indexOf and slices the body out; templates render into one shared output array with loop scopes reused across iterations. About 3.4× faster than makefun-site on the practice set (median 145 ms vs 500 ms for the three cases, ~2.7 MB of sources), verified identical on all 3 practice cases, 3 further drawn instances (9 cases), and 122 hand-built edge cases against the reference.

## Run it

```sh
MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=output node main.ts
```

Node 22.18 or later, standard library only. The program reads every case from `input/cases.json`, answers each with `run` from `solve.js`, and writes `output/answers.json`, byte for byte the same on every run.

---

<sub>Entered on [make.fun](https://make.fun/?ref=1c94brae&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
