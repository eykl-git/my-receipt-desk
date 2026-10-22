# My Receipt Desk

A browser-only prototype for matching receipts to card-statement transactions. It demonstrates one loop:

**Correct once. Approve what should be remembered. Reuse safely next time.**

You look at the data, the desk proposes a decision, you correct or confirm it, and you can turn that correction into a rule you approve. The next batch is handled with that rule, and the cases it can't settle safely still come back to you. The Knowledge Space holds "The rules and preferences you have approved." Nothing learns in the background: "Your approved rules are reused. The AI model is not being retrained."

It runs entirely in the browser. There is no server, no bank connection, no account and no analytics.

## The 60-second demo

Open the site and click **Try the 60-second demo** (or open `?demo=1`). Everything in the demo is fictional. The tour bar at the top always says what to click next.

1. **Step 1, Batch 1: First encounter.** Five fictional receipts and a card statement load. One receipt is ready. Four need you: two because the card shows "MC COFFEE HK", a name the desk doesn't know yet, one with an unclear amount, and one with two equal payments. The Knowledge Space points out the gap. Click **Continue**.
2. **Step 2: correct once, then teach.** Open R-102, click **Confirm this case only**, then **Confirm and record**. Click **Propose reusable knowledge**, then **Preview impact** to see which pending receipts the rule would affect, then **Activate rule**. Close the drawer: the new rule K-ALIAS-0001 v1 and the receipts it now helps are highlighted.
3. **Step 3, Batch 2: Knowledge reused.** Click **Next batch**. Two new Morning Cup receipts are ready because of K-ALIAS-0001 v1, and a re-uploaded file is caught and not added.
4. **Step 4, Batch 3: The boundary still holds.** Click **Next batch**. A known name still can't pick between two equal payments, a USD receipt is not converted, and text printed on a receipt can't change your rules.

That is 10 clicks. Afterwards you can click **Record all ready**, open **Compare without this rule** ("Illustrative fixture replay—not measured productivity", which writes nothing), or switch to **Spreadsheet view**. "Ready to record" is a proposal; nothing is recorded until you click. To see what happens without teaching, use **Restart demo** and choose only "Confirm this case only" at step 2: the Batch 2 receipts then still need your decision.

## Install and run

Requires Node.js 22.12 or later on the 22 line (`.nvmrc` says 22) and npm.

```sh
npm ci                  # install exactly what package-lock.json pins
npm run dev             # dev server at http://localhost:5173 (copies OCR assets first)
npm run build           # production build into dist/ (base "/")
npm run build:pages     # production build with base /my-receipt-desk/ (.env.pages)
npm run preview:pages   # serve that build at http://localhost:4173/my-receipt-desk/
npm run typecheck
npm run lint
npm test                # Vitest unit, property and guard tests
npx playwright install chromium   # once, for the browser tests
npm run e2e             # Playwright: dev-server suite, then the Pages build suite
npm run check           # typecheck, lint, test, build and e2e in order
npm audit --audit-level=high
```

`npm run ocr:assets` copies the OCR worker, engine and language files from `node_modules` into `public/ocr/` (gitignored). `dev`, `build` and `build:pages` run it for you.

## Architecture

React + TypeScript + Vite with plain CSS. idb for IndexedDB, papaparse for CSV, zod for schemas, tesseract.js for the optional local OCR. Vitest and Playwright for tests. Versions are pinned exactly in `package.json` and `package-lock.json`.

- `src/domain/`: pure TypeScript with no React, storage or UI imports (enforced by ESLint).
  - `capture/`: receipt fields, duplicate detection, the extraction adapter contract, the OCR text parser and locale evidence.
  - `imports/`: card CSV parsing and row validation.
  - `matching/`: `evaluateWorkspace`, `revalidate`, manual resolution and case views.
  - `knowledge/`: rule schemas, `validateDraft`, `previewImpact`, the built-in safety checks, the plain-English phrase parser and knowledge-gap discovery.
  - `ledger/`: totals, exports and formula escaping.
  - `audit/`: audit event builders.
- `src/demo/`: fictional fixtures, coach text and the comparison replay. Imports the domain only.
- `src/ocr/`: the tesseract.js engine wrapper and the OCR extraction adapter.
- `src/persistence/`: repositories and commands. The only code that touches IndexedDB. Each command is one unit of work: a match, its ledger entry and its audit event are written together or not at all.
- `src/ui/`: React components and the store. All UI strings are in `src/ui/copy.ts`.

Matching and rule evaluation are synchronous pure functions, deterministic and independent of input order. Money is held as integer minor units and dates as `YYYY-MM-DD` values. Proposals are derived from stored facts and are never stored; every commit re-checks its proposal inside the write. Rule versions are immutable once approved or discarded. The JSON rule records are the only executable source of truth; `KNOWLEDGE.md` is generated from them.

Requirements, design and tasks: `.kiro/specs/my-receipt-desk/`. Steering: `.kiro/steering/`. Assurance checklist: [ASSURANCE.md](ASSURANCE.md).

## Privacy boundaries

- Everything you add stays in your own browser's IndexedDB on your device. Nothing is uploaded and there is no server.
- On the public site, each visitor's data lives only in that visitor's own browser. Nobody else, including the site owner, can see it.
- The OCR language files are downloaded from the site itself the first time you use "Read automatically" and are cached in this browser (IndexedDB) so they work offline later. They hold no receipt data, and "Delete all data in this browser" removes them.
- There are no analytics, tracking, API keys or calls to other sites. A Content-Security-Policy in the production build allows the site's own origin only.
- Don't upload real sensitive receipts on a shared or public device. Clearing browser data or private browsing can remove what you added, so export anything you want to keep.

## Supported formats

- Receipts: JPEG and PNG images. You enter or correct merchant, date, amount and currency by hand ("Manual entry—automatic extraction is not enabled").
- Optional local OCR: "Read automatically" on an uploaded receipt, in English, Malay, Simplified Chinese and Traditional Chinese ("English + Malay", "简体中文 + English", "繁體中文 + English"). It runs in your browser only. Its results are proposals labelled "Read automatically, check before saving" and stay unconfirmed until you save the fields.
- Invoices (My files only): "Invoice (not yet paid)" in "Add receipts", using the same image checks.
- Workspaces: the demo is always HKD. My files uses HKD (default) or MYR, chosen while it is still empty. Other currencies are flagged and never converted.
- Card statements: UTF-8 `.csv` files, one card account per import. You map the columns and choose the date format and amount sign; ambiguous dates are never guessed.
- Not supported: PDF, XLSX, HEIC, bank connections, Tamil OCR, foreign-exchange conversion, split or partial payments, refunds and credit notes.

Fictional samples are built in: "Download example CSV" (HKD), and in My files "Try a sample Malaysian receipt" and "Download example CSV (Malaysia, MYR)".

## Documented limits

| Item | Limit |
|---|---|
| Receipt file | JPEG/PNG only (extension, MIME type and file signature checked), up to 10 MB, up to 20 per selection |
| Card CSV | `.csv`, UTF-8, up to 2 MB, 2,000 data rows, 30 columns, 500 characters per cell, 200 per description |
| Workspace | up to 500 receipts, 2,000 card transactions, 200 rules |
| Text fields | merchant 1–120, reason 3–500, account name 1–40, invoice number up to 40, printed text up to 2,000; file names over 1,000 characters are refused, and names are shown up to 200 |
| Money | 0.01 to 9,999,999.99 per item, in the workspace currency |
| Dates | 2000-01-01 to 2099-12-31 |
| "Record all ready" | up to 50 cases per run, no retries |
| Knowledge JSON | up to 1 MB and 200 rules |
| Posting window | 0–7 days after the receipt date (demo policy: 0–3) |

The constants live in `src/domain/limits.ts`; each one has a test and an error message that names it.

## Reset and export

- **Reset** menu: "Reset demo" deletes the demo workspace only. "Delete my files data" deletes My files only. "Delete all data in this browser" deletes both, the cached OCR language files and the remembered workspace, and returns to the first screen. Each asks for confirmation.
- **Restart demo** (tour bar) deletes the demo workspace and loads Batch 1 again. My files is not affected.
- **Exports** menu: "Export ledger CSV", "Export exceptions CSV", "Export knowledge JSON", "Import knowledge JSON" (creates drafts in My files only; nothing activates) and "Download KNOWLEDGE.md". CSV files are UTF-8 with a BOM so spreadsheet apps read them correctly.

## Formula-injection protection

Card labels, merchants and file names are untrusted text. In every exported CSV, a text cell whose first character, or first character after leading spaces, is `=`, `+`, `-`, `@`, a tab or a carriage return gets a leading `'`, so a spreadsheet shows it as text instead of running it. Line breaks inside text cells become spaces. Amount and date columns are not escaped: the app writes them only from validated numbers and dates (`-?\d+\.\d{2}` and `YYYY-MM-DD`, or empty when unknown), so they stay typed. Test T18 and browser flow E6 check this. Opening CSV files that came from someone else still needs care, because this protects only the files this app writes.

## Limitations

- Prototype only. This prototype makes no production security claims.
- No cold offline reload. A loaded tab keeps working offline, including the remaining demo batches and the example CSV, but there is no service worker, so reloading while offline fails.
- OCR is optional and imperfect. Chinese recognition is noticeably weaker than Latin script, especially on thermal receipts (faded print, small fonts, curled paper). Even on the clean fictional Hong Kong sample the merchant name comes back unclear and must be typed. Hard-to-read fields are marked unclear, and every OCR field must be checked and saved before anything can match. There is no deskew or contrast correction; angled photos and handwriting read poorly.
- The first "Read automatically" for a language option downloads about 8–9 MB from the site. A slow connection can hit the 60-second time limit on that first read; a retry works once the files are cached. Offline OCR works only after that first download.
- Known console warnings: when the Traditional Chinese model (`chi_tra`) loads in Chromium, the OCR engine logs about eight console errors beginning "Warning: Parameter not found: ". They come from the engine's model loader and don't change OCR results. The browser tests allow exactly that prefix during OCR and fail on any other console error.
- The local audit log is inspectable but not tamper-proof. Anyone with access to the browser can delete or edit IndexedDB.
- Approval by the single local owner shows intent and provenance; it is not segregation of duties.
- Browser tests run in Chromium only. Firefox and Safari are untested.
- The production bundle is about 674 kB (about 200 kB gzipped) in one chunk, because dynamic imports are banned so a loaded tab keeps working offline.
- No multi-user access, sync between devices, bank feeds, accounting-system writes, tax advice, currency conversion, refunds, credit notes or split payments.

## Accessibility

The app is built for keyboard use, labelled inputs, visible focus, readable contrast and reduced motion, with tabs below 1024 px. The browser tests run axe (automated WCAG 2.0/2.1 A and AA rules) on the main states and drive the tour by keyboard. Automated checks find only part of the issues: full WCAG validation needs manual testing with assistive technologies (screen readers, magnification, voice control) and an expert accessibility review, which has not been done.

## Publish on GitHub Pages

The repository includes `.github/workflows/ci.yml` (checks on every push and pull request) and `.github/workflows/deploy.yml` (deploys to Pages on every push to `main` and on manual runs). They run only on GitHub.

1. Create an empty repository on GitHub, for example `my-receipt-desk` (no README, licence or .gitignore, so the first push doesn't conflict).
2. In this folder (git is already initialised on branch `main`), make the first commit:
   ```sh
   git add .
   git status            # check node_modules/, dist/ and public/ocr/ are not listed
   git commit -m "Initial commit: My Receipt Desk prototype"
   ```
3. Add the remote and push:
   ```sh
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```
4. On GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**. If the first deploy run started before this was set and failed, re-run it from the **Actions** tab ("Deploy to GitHub Pages" → "Run workflow").
5. The site is at `https://<user>.github.io/<repo>/`. For a repository named `<user>.github.io` it is at `https://<user>.github.io/`.

**Base path.** `deploy.yml` sets `VITE_BASE` from the repository name: `/` for a repository named `<owner>.github.io`, otherwise `/<repo>/`. Renaming the repository needs no file change; the next deploy uses the new name. The local Pages build is separate: `.env.pages` sets `VITE_BASE=/my-receipt-desk/`, and `playwright.pages.config.ts` and the E7 specs expect that path. CI uses that local path too, so it passes whatever the repository is called. To preview locally under your own repository name, change `.env.pages`, the two URLs in `playwright.pages.config.ts` and the `/my-receipt-desk/` paths in `tests/e2e/e7-*.spec.ts` together. A shell variable also overrides it for a one-off build: `VITE_BASE=/<repo>/ npm run build`.

**Repository settings a workflow file can't enforce.**
- The Pages source must be set to "GitHub Actions" (step 4).
- Actions must be enabled for the repository (Settings → Actions → General).
- Deploy doesn't wait for CI. To stop a failing commit from reaching `main`, protect `main` with a branch protection rule or ruleset that requires the CI "check" job to pass and changes to arrive through pull requests. Steering files, skills and workflow files can't enforce that on their own.
- GitHub creates the `github-pages` environment on the first deployment. Its deployment-branch rule (Settings → Environments) controls which branches may deploy; keep it limited to `main`.
