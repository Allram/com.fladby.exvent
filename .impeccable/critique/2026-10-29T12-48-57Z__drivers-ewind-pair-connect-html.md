---
target: exvent pair view
total_score: 25
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/config/workspace/com.fladby.exvent/drivers/eWind/pair/connect.html"
target_fingerprint: "sha256:7314e3dea7c752498c3201037c9a912385f3adc604eca1d2e4887cd01cf9f26e"
target_path: /config/workspace/com.fladby.exvent/drivers/eWind/pair/connect.html
timestamp: 2026-10-29T12-48-57Z
slug: drivers-ewind-pair-connect-html
---
# Critique: Exvent pairing view (drivers/*/pair/connect.html)
Method: dual-agent (A design review, B detector + headless Chromium). Mode: Operate.

## Heuristics (25/40, Acceptable)
1 Status 2 – test 10–12 s with only button text, no spinner/announcement
2 Real world 3 – "IP address" accepts hostnames; "Connect" tests and adds
3 Control 2 – no cancel; "Add anyway" also on duplicate
4 Consistency 2 – not Homey pair classes/--homey-*; dark mode follows OS
5 Error prevention 3 – good host/port validation; duplicate check only after the tap
6 Recognition 2 – IP from router, steps scroll away
7 Efficiency 3 – Enter submits, autofocus, port 502
8 Aesthetics 3 – clean, EDA intro ~70 words
9 Error recovery 3 – invalidip vague, raw code in failed
10 Help 2 – only intro paragraph

## Priority issues
- [P1] Duplicate can be added "anyway" (connect.html:273-278 vs ExventDriver.ts:55) – harden
- [P1] Contrast: button 3.23:1, error text 4.15:1, input border 1.47:1 – audit
- [P2] Prerequisites least emphasized (intro 14px grey, connect.html:89) – clarify
- [P2] Does not follow Homey pair styles/theme – adapt
- [P2] Weak/non-announced status during test, no success confirmation, alert in display:none – harden

## Detector
CLI: 0 findings in all three. In-page: 1 straggler ("router." alone).

## Personas
Jordan: jargon first, no IP help, silent add. Sam: testing not announced, no aria-invalid, outline:none. Casey: error under button behind keyboard, inputmode=url.

## Minor
intro without fallback; test.failed without period; anlegg/aggregat; key connecting; type=number on port; max-width 340/4px padding.
