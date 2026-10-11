# Publishing `pi-continual-harness` to npm

`pi-continual-harness` (repo `pi-continual-harness`) ships **precompiled
JavaScript** (`dist/`, built by `npm run build` / the `prepack` hook — issue
#36: pi awaits every extension factory at startup, and jiti-transpiling the
raw TypeScript graph cost ~0.8s per launch). The pi entry is the thin
`dist/entry.js`; `main` points at `dist/index.js` (full public API for
companion packages). Releases are **CI-driven**: push a `v*.*.*` git tag and
GitHub Actions publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements) (SLSA).

Manual `npm publish` is intentionally blocked by the `prepublishOnly` guard in
`package.json` so every release goes through CI (guarantees version sync +
provenance + a clean test run).

```
git tag v0.18.0 && git push origin v0.18.0
        │
        ▼
release.yml  ──►  npm ci → typecheck → test → build → verify dist → version-sync check → npm publish --provenance
                                                                                  │
                                                                                  ▼
                                                            npmjs.com/package/pi-continual-harness
```

---

## 0. Bootstrap status (one-time, DONE)

The very first publish was done **manually from a laptop** without provenance
(npm Trusted Publishing cannot *create* a package — it can only be attached to
an existing one):

- `pi-continual-harness@0.1.0` is live on npm (owner `ngsoftware`).
- `0.1.0` has **no** provenance badge — expected for the bootstrap publish.

What remains is the **Trusted Publisher** wiring on npmjs.com (§2 Option A) so
that **every** release from `0.2.0` onward is CI-only with provenance. The
`release.yml` workflow and the `prepublishOnly` guard are already in place.

---

## 1. Prerequisites (one-time)

1. An **npm account** that owns `pi-continual-harness` (maintainer: `ngsoftware`).
2. **2FA enabled** on the account (required for modern publish).
3. Confirm ownership:
   ```bash
   npm view pi-continual-harness version
   npm view pi-continual-harness maintainers
   ```
4. **Repo must be public** for `--provenance` (already is).

---

## 2. Auth for CI (pick ONE)

### Option A — Trusted Publishing / OIDC (preferred, no long-lived token)

No `NPM_TOKEN`. GitHub Actions proves identity via OIDC (`id-token: write` is
already in `release.yml`). Requires **npm ≥ 11.5.1** (the workflow upgrades
npm automatically) and **must not** set an empty `NODE_AUTH_TOKEN`.

1. Sign in at [npmjs.com](https://www.npmjs.com) as the package owner
   (`ngsoftware`).
2. Open `https://www.npmjs.com/package/pi-continual-harness` →
   **Settings → Trusted Publisher** → Add GitHub Actions:
   - **Organization or user:** `pungggi`
   - **Repository:** `pi-continual-harness`
   - **Workflow filename:** `release.yml` (exact name, no path)
   - Environment: leave empty unless you use GitHub Environments
3. On GitHub, make sure there is **no** `NPM_TOKEN` secret (or it is empty):
   ```bash
   gh secret list --repo pungggi/pi-continual-harness
   # if NPM_TOKEN is listed and you want pure OIDC:
   gh secret delete NPM_TOKEN --repo pungggi/pi-continual-harness
   ```
4. Re-run the release job (see §4).

Docs: https://docs.npmjs.com/trusted-publishers

### Option B — Classic **Automation** token (works immediately)

`EOTP` means the token still requires an authenticator code. CI cannot type OTP.

1. npmjs.com → avatar → **Access Tokens** → **Generate New Token**.
2. Choose **Classic token → Automation**
   - **Not** “Publish”
   - **Not** “Read-only”
   - Automation exists specifically to **bypass 2FA on publish** in CI.
3. Copy `npm_…` (shown once).
4. Set the GitHub secret:
   ```bash
   gh secret set NPM_TOKEN --repo pungggi/pi-continual-harness
   # paste token, Enter
   gh secret list --repo pungggi/pi-continual-harness
   ```
5. Re-run the release job (see §5).

---

## 3. Publish a release (each time)

Keep `package.json` version and the git tag in sync (`release.yml` enforces it).

```bash
# already bumped package.json to 0.2.0, committed on main:
git tag v0.2.0
git push origin main --follow-tags
gh run watch
```

Or atomically via npm:
```bash
npm version patch -m "release: %s"   # or minor / major
git push origin main --follow-tags
gh run watch
```

---

## 4. Re-run a failed tag release (do not retag)

```bash
gh run list --workflow=release.yml --limit 5
gh run rerun <run-id> --failed
gh run watch <run-id>
npm view pi-continual-harness version
```

Do **not** delete/recreate the tag unless you must move it (discouraged).

---

## 5. Verify a release

```bash
npm view pi-continual-harness
npm view pi-continual-harness version
```

On the npm page you should see a **Provenance** badge linking to the Actions
run (from `0.2.0` onward — `0.1.0` was the manual bootstrap and has none).

Install / update:
```bash
pi update npm:pi-continual-harness
# or fresh:
pi install npm:pi-continual-harness
```

---

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| **`EOTP` / one-time password** | Token is not Automation. Use **Classic → Automation**, or delete `NPM_TOKEN` and use **Trusted Publisher** OIDC. |
| **`E401` / invalid token** | Local `~/.npmrc` token expired — irrelevant for CI. Fix `NPM_TOKEN` secret or OIDC. |
| **`E404` on PUT** | Not logged in as package owner / no publish rights. |
| `version drift: tag != package.json` | Align versions, retag only if necessary. |
| Provenance `ENOTSUPPORTED` | Needs GHA + `id-token: write` + public repo (already set). |
| Local emergency publish | `CI=1 npm publish --access public --provenance` after `npm login` (interactive OTP OK). Prefer CI. |

---

## 7. Why not only manual `npm publish`?

Manual publish skips the CI test gate, can desync tags, and needs laptop OTP /
a valid local token. Tag → `release.yml` keeps tests, version sync, and
provenance. Keep `prepublishOnly` blocking non-CI publishes.
