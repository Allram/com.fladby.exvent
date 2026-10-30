# com.fladby.exvent

Homey app (SDK 3, TypeScript) for Exvent eWind, eAir and EDA ventilation units over Modbus TCP. Used by Homey Pro owners; published in the Homey App Store.

## Kart
- `lib/`: the logic. `ExventDevice.ts` (polling and writes, largest file), `ExventDriver.ts` (pairing test), `modbus.ts` (block reads), `eda.ts`, `exvent.ts` (register maps), `flowCards.ts`, `settings.ts`.
- `drivers/eWind`, `drivers/eAir`, `drivers/eda`: per-model driver, `pair/connect.html`, flow compose files.
- `.homeycompose/` is the source for `app.json`; `app.json` is generated from it by the Homey CLI but committed: keep both in step.
- `test/`: node tests with a fake device (`device-harness.ts`). `docs/` holds the register PDF and notes.

## Kommandoer
```
npm ci
npm test            # tsc + node --test, as CI
npm run lint
npx homey app validate --level publish
```

## Utgivelse
Push to `main` runs tests and validation (`validate.yml`). A tag `vX.Y.Z` runs `publish.yml` and publishes to the Homey App Store. It fails unless the tag equals the version in `.homeycompose/app.json`, `app.json` and `package.json`, `.homeychangelog.json` has both `en` and `no` text for that version, and the tagged commit is on `main`. Do not tag or bump for repo-file changes.

## Feller
- `.homeyignore` decides what goes into the published app: new repo-only files (like this one) must be listed there.
- There is deliberately no `SECURITY.md` in git (it is in `.gitignore`).
- Modbus unit ID and register differ per model (`pairUnitId`, `pairTestRegister`); the units tolerate reads across unmapped registers, but a unit that refuses gets register-by-register reads.

## Se også
`README.md`: features and modes. `CONTRIBUTING.md`: upstream-style contribution rules. `docs/README.md`: register notes.
