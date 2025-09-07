# AGENTS.md — Codex CLI Operating Guide (Tauri v2 · React 19)
Based on OpenAI Cookbook “Maximizing coding performance, from planning to execution”. This file is the authoritative guide for AI agents (Codex CLI) working in this repository.

— Scope: Applies to the entire repository. Follow the most specific AGENTS.md if nested; direct maintainer instructions override this file.

## 0) Project Brief (Context for the Agent)

Product: Nurse Call Response System (NCRS) — desktop app to receive, queue, and acknowledge nurse-call events with serial-port input, real‑time UI, and audio alerts.

Hard Constraints (Target Device)
- Windows 10 (64‑bit)
- Pipo X9S: Intel Celeron N4020, 3–4 GB RAM, eMMC 64 GB
- Display 1366×768. Optimize for low CPU/RAM; no cramped UI.

Tech Stack
- Desktop: Tauri v2 (Rust) with plugins: autostart, logging, updater, process, fs, shell, dialog, os, notification, deep‑link, window‑state, single‑instance, store, serial‑port
- Frontend: React 19 + TypeScript, Mantine v8, React Router v7, i18next (EN/ID/FR)
- Styling: CSS Modules (*.module.css*), Mantine theme
- Audio: HTML5 Audio API (queued/sequenced playback)
- Build/Test: Vite v6; Mocha/Chai; Selenium WebDriver
- Storage: localforage; Tauri store; js-cookie

Domain I/O & SLO
- Serial → parse → queue → UI + audio
- Events: serial-connected, serial-disconnected, nurse-call, nurse-call-response
- E2E event→paint→sound p95 ≤ 100 ms on target hardware; resilient reconnect & backpressure

## 1) Plan → Implement → Verify → Reflect (required loop)
Always run this loop; keep diffs small and verifiable.

- Plan: clarify task, list constraints, acceptance criteria, risks/unknowns, test plan. Use update_plan.
- Implement: apply minimal, typed changes; small functions; clear diffs with apply_patch; update docs when needed.
- Verify: build/test locally; measure performance against budgets; validate UX at 1366×768.
- Reflect: summarize outcomes, trade‑offs, regressions, and next steps in the handoff message.

## 2) Codex CLI—Operating Protocol

Progress & Preambles
- Before running groups of commands, send a short preamble (8–12 words) describing what you’ll do next.
- Share brief progress updates on longer tasks. Keep it concise.

Planning Tool
- Use update_plan to create and maintain a short plan with 3–7 steps.
- Exactly one step should be in_progress until complete.

Shell & File Access
- Use rg/rg --files to search; read files in ≤250‑line chunks.
- Prefer safe “read” commands first. For actions needing escalation (writes outside workspace, network, destructive ops), request with with_escalated_permissions=true and a one‑sentence justification.

Patching Policy
- Use apply_patch for all edits. Keep changes minimal, focused, and style‑consistent.
- Do not reformat unrelated code, add licenses, or fix unrelated issues.
- No one‑letter variable names; avoid inline comments unless requested.

Execution Discipline
- Align with scripts in package.json: `pnpm dev`, `pnpm build`, `pnpm tauri build`, `pnpm test`.
- Only run heavier commands when beneficial to validate your change.

## 3) Task Intake Template (fill before coding)

- Objective: concise statement of what to deliver.
- Scope: files/modules likely affected; out‑of‑scope items.
- Constraints: performance, UX, platform, API contracts.
- Acceptance Criteria: observable, testable results.
- Risks/Unknowns: list and mitigation plan.
- Test/Validation Plan: unit/integration/E2E, manual checks, perf probes.

## 4) Verification & Budgets

Correctness & Safety
- Commands permission‑scoped in tauri.conf.json. Serial open/close idempotent and hot‑plug safe.
- Parser rejects malformed frames; fuzz if feasible. No UI freezes under burst traffic.

Performance (Pipo X9S)
- E2E p95 ≤ 100 ms; Idle CPU ≤ 3%; Active CPU ≤ 25%; stable heap over 10‑minute bursts.
- Respect bundle budgets; lazy‑load noncritical routes.

UX at 1366×768
- AppShell fits without scroll traps; hit targets ≥ 40 px.
- Clear call states (color + label + icon); both themes supported.
- Keyboard‑first flows; screen reader labels present.

Tests & Docs
- Mocha/Chai pass; Selenium smoke green where applicable.
- Update README_run.md/BENCH.md as needed.

## 5) File/Module Contracts (preferred layout)

Rust (Tauri)
- `src-tauri/src/serial/mod.rs`
  - `list_ports() -> Vec<PortInfo>`
  - `connect(port: String, baud: u32) -> Result<()>`
  - `disconnect() -> Result<()>`
  - `write(bytes: Vec<u8>) -> Result<()>`
  - Emits: `serial-connected`, `serial-disconnected`, `nurse-call {code, source, ts}`

TypeScript
- `src/lib/serial/types.ts` — `ConnectionState`, `NurseCallEvent`, `Metrics`
- `src/lib/serial/useSerial.ts` — subscribe to Tauri events; buffered queue; reconnection with backoff
- `src/components/StatusBar.tsx` — Mantine AppShell slot; small‑screen friendly
- `src/lib/audio/queue.ts` — validated playlist, sequential playback, error hooks

## 6) Guardrails (what NOT to do)

- Do not introduce heavy state libs; prefer hooks/context.
- No blocking loops on the UI thread.
- No unbounded queues; always apply backpressure.
- Don’t expand scope without updating the plan and verify steps.
- Don’t break i18n keys or theme tokens.

## 7) Golden Prompts (drop‑ins for Codex CLI)

Feature Scaffold (Serial)
```
You are a Tauri v2 (Rust) + React 19 TS engineer optimizing for 3–4 GB RAM and 1366×768.

Goal: Create a robust serial pipeline:
- Rust: tauri::command { list_ports, connect(port, baud), disconnect(), write(bytes) }, event emitters for serial-connected|disconnected|nurse-call.
- TS: useSerial() hook with connection state, event subscription, backpressure‑safe queue, and reconnection.
- UI: Mantine StatusBar (left: port/baud, center: latency p50/p95, right: connect/disconnect), responsive at 1366×768.

Constraints:
- E2E latency ≤ 100 ms; avoid blocking on main thread.
- Typed interfaces, small pure functions, error boundaries, no global mutable state.
- Handle edge cases: hot‑plug, timeouts, partial frames, invalid bytes.

Deliverables:
1) Rust module with commands + parser tests.
2) TS hook + types + tests.
3) Minimal Mantine components; CSS modules for small screens.
4) Doc: how to run, env flags, failure modes.
```

Performance Tuning (Cookbook‑style)
```
Task: Reduce input‑to‑paint and event‑to‑sound latency.

Plan→Execute:
1) Identify critical path (serial read → parse → state update → React render → audio play).
2) Insert measurement points; output BENCH.md table (p50/p95).
3) Apply micro‑fixes: batch state updates; use useSyncExternalStore for event feeds; memoize heavy components; virtualize lists; prefer CSS over JS; consider Rust‑side parsing.
4) Re‑measure; keep diffs small; justify any regressions.
Output: patch + updated BENCH.md.
```

Test Authoring
```
Write:
- Unit: parser framing, invalid bytes, burst sequences, reconnect logic.
- Integration: Tauri command contracts; mock serial driver.
- E2E (Selenium): 1366×768 viewport, keyboard‑only flows, color‑contrast checks.
Report coverage and flaky candidates; add minimal serial‑sim generator.
```

## 8) Example Acceptance Criteria (Serial Manager)

- Open/close port reliably; emits serial-connected|disconnected
- Parses call frames with checksum; drops invalid frames
- Queues audio FIFO; never overlaps streams
- Displays live metrics: port, baud, queue depth, p50/p95 latency
- Survives cable pull/reinsert; auto‑reconnect ≤ 2 s

## 9) Codex CLI Invocation Templates (optional)
Replace placeholders; adapt to your CLI setup.

Plan a Feature
```
codex-cli prompt \
  --role "Senior Full‑Stack (Tauri/React/TS) + Perf Engineer" \
  --context ./AGENTS.md ./docs/arch.md ./src-tauri ./src \
  --task "PLAN: Build Serial Connection Manager + event pipeline. Output: (1) task graph, (2) public TS/Rust interfaces, (3) acceptance criteria, (4) risk list, (5) test plan."
```

Implement Incrementally
```
codex-cli prompt \
  --role "Implementor" \
  --context ./AGENTS.md ./PLAN.md ./src ./src-tauri \
  --task "IMPL: Add SerialManager (Rust + Tauri commands), TS hooks, and Mantine status bar. Diff‑only patches; small typed functions with brief JSDoc." \
  --apply-diff
```

Verify + Benchmark
```
codex-cli prompt \
  --role "Verifier" \
  --context ./AGENTS.md ./src ./src-tauri ./test \
  --task "VERIFY: Write Mocha/Chai unit tests for parsers; Selenium smoke for AppShell; add serial‑sim harness. Report: build size, cold start, CPU idle/active, E2E latency p50/p95."
```

Reflect + Next Steps
```
codex-cli prompt \
  --role "Reviewer" \
  --context ./AGENTS.md ./BENCH.md \
  --task "REFLECT: Summarize regressions, propose refactors, list tech debt, and create a 3‑step improvement plan (perf, reliability, UX at 1366×768)."
```

— End of file.

