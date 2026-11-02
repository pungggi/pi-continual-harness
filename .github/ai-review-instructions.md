# Review-Regeln für den AI-Reviewer (Repo: pi-continual-harness)

Der Bot liest diese Datei vom PR-Head. Kurze, konkrete Regeln, eine pro Zeile.

## Projekt

- Single-Package-npm-Repo (kein Monorepo): `src/` Runtime + Extension-Entry, `test/` Vitest, `scripts/`, `docs/`.
- `dist/` ist vorkompiliert und comitted (Issue #36): nach jeder `src/`-Änderung mit `npm run build` neu bauen und mitcommitten; ein `dist`-Diff ohne zugehörige `src`-Änderung (oder umgekehrt) ist ein Finding.
- `package-lock.json` wird nicht reviewt (automatisch ausgeschlossen).
- Releases sind tag-getrieben (`release.yml`, npm Trusted Publishing); manuelles `npm publish` ist bewusst blockiert (`prepublishOnly`-Guard) — kein Finding.

## Regeln

- Keine Secrets, Keys oder Token in Code, Configs oder Logs.
- Kein `any` und kein `as never` in neuem Code ohne Begründung (Biome `noExplicitAny` ist an).
- Neue Logik braucht Vitest-Tests; Coverage-Schwellen: 95 % Statements gesamt, 100 % für die puren Policy-Module (`select.ts`, `lessons.ts`, `cadence.ts`, `vmodel.ts`).
- `src/schemas.ts` und `src/entry.ts` dürfen zur Laufzeit keine Imports von `typebox` oder `pi-ai` haben (Startup-Budget #36; `import type` ist erlaubt).
- Tool-Schemas in `src/schemas.ts` sind absichtlich hand-geschriebenes Plain-JSON-Schema: jede Änderung muss `test/schemas.test.ts` (TypeBox-Äquivalenz + pi-schema-Konformität) mitpflegen.
- Jede Verhaltensänderung bekommt einen Eintrag in `CHANGELOG.md` unter `Unreleased`.
- Keine stillen Fehlerpfade: keine leeren catch-Blöcke; Soft-Fail (durable I/O) warnt einmalig pro Session statt zu crashen.
- `peerDependencies` (`>=1.2.0`) nur anheben, wenn runtime-relevante APIs wirklich gebraucht werden.
- Neue Flags/Positionals von `/harness`-Subcommands müssen ins `ARG_SPECS`/`checkRest`-Grammar-Gate (`src/harness.ts`), damit ungültige Argumente warnen statt still fallen.
- Die Store-Snapshot-Struktur (`appendEntry("harness-state", …)`, `makePersist`) nicht ändern, ohne den `/tree`-Rollback-Pfad mitzudenken.

## Bekannte Kontexte (nicht als Finding melden)

- Der einzelne `execute as ToolDefinition<TSchema, unknown>["execute"]`-Cast in `src/schemas.ts` ist der dokumentierte Schema↔Typ-Bridge, geprüft durch `test/schemas.test.ts`.
- Historische `as never`-Casts in Tests (z. B. `classify.test.ts`) sind Bestand: keine neuen anlegen, aber auch kein Migrations-Finding.
- `.github/workflows/ai-review.yml` ist ein bewusst dünner Stub: der `pr_number`-Vertrag mit dem zentralen reusable Workflow in `pungggi/ai-review` ist bekannt und verifiziert — leere Inputs bei `pull_request`-Events sind beabsichtigt.
- `dist/`-Dateien werden nicht inhaltlich reviewt — nur die Konsistenz mit `src/` (siehe Projekt).
- Single-Owner-Repo: Fork-PR-`secrets: inherit`-Szenarien sind strukturell nicht möglich.
