# tothemoonsoon — Project Context for Claude

## WAŻNE — jak zacząć każdą sesję
1. Przeczytaj ten plik
2. Pobierz aktualny plik który chcesz edytować z GitHub przed zmianami
3. Wprowadź zmiany
4. Commituj bezpośrednio do `main` przez GitHub MCP — zmiany są od razu live

## Dane właściciela
- Twitter/X: @m00nsoon (https://x.com/m00nsoon)
- GitHub user: `tothemoonsoon1`
- Website: https://tothemoonsoon.xyz
- Solana address: `C5maywT6FNqLZVi9m94yKc1RCstd18gYs6Cv1bzFPyD3`
- SKR domain: `moonsoon.skr`

## Repozytorium
- GitHub: https://github.com/tothemoonsoon1/moonsoon
- Owner: `tothemoonsoon1`
- Repo: `moonsoon`
- Branch: `main`
- Deployed at: https://tothemoonsoon.xyz
- Hosting: statyczny (Cloudflare Pages lub podobny) — commit = live

## Struktura plików
```
moonsoon/
├── index.html              ← główna strona (Seeker S2 checklist)
│                             UWAGA: <style> i <script> są inline — patrz niżej
├── assets/
│   ├── css/
│   │   ├── tokens.css      ← CSS variables (kolory, fonty) — EDYTUJ TU aby zmienić design
│   │   ├── layout.css      ← 3-col layout, nav, topbar, panel, responsive
│   │   └── components.css  ← wszystkie komponenty UI (taski, karty, tabs, kalkulator...)
│   └── js/
│       ├── checklist.js    ← logika tasków, stan, render, QR
│       ├── prices.js       ← CoinGecko price fetch
│       ├── calculator.js   ← SKR staking kalkulator + Chart.js
│       └── ui.js           ← drawer, bottom sheet, dApp filter, init
├── sitemap.xml
├── robots.txt
└── CLAUDE.md               ← ten plik
```

## WAŻNE: index.html ma inline style i skrypty
Plik `index.html` zawiera `<style>` i `<script>` wbudowane inline (dla podglądu w Claude artifacts).
Osobne pliki w `assets/` to **źródło prawdy** — tam wprowadzaj zmiany, potem zaktualizuj też inline w index.html.

Gdy edytujesz index.html bezpośrednio (np. HTML, tweety, dAppy) — wystarczy zaktualizować index.html.
Gdy edytujesz CSS/JS — zaktualizuj plik w assets/ ORAZ odpowiedni blok `<style>`/`<script>` w index.html.

## Tech stack
- Czysty HTML/CSS/JS (zero frameworków, zero build step)
- Chart.js 4.4.0 (CDN)
- QRCodeJS 1.0.0 (CDN)
- Umami Analytics: `data-website-id="289eb289-b024-4df5-b133-5c2b376c29de"`

## Design system
- Tło: `#0d0d1a` | Purple: `#9945FF` | Teal: `#14F195` | Blue: `#00C2FF`
- Wszystkie kolory jako CSS variables w `tokens.css`
- Font: system-ui / -apple-system stack

## Kluczowe wzorce w kodzie
- Sekcje zwijane: `toggleSection(id)`
- Taski: `toggleTask(id)` — ID z prefiksem `t-`
- dAppy: `toggleDapp(id)` — ID z prefiksem `d-`
- Filtrowanie dApps: `setDappCat(cat, btn)` via `data-cat` attribute
- Stan in-memory (brak localStorage)
- Ceny z CoinGecko na load

## Layout (desktop 3 kolumny)
- **Lewa kolumna** (180px): nawigacja `.nav` — linki do stron, coming soon
- **Środek** (max 680px): główna treść `.main` — checklist, kalkulator
- **Prawa kolumna** (360px): panel `.panel` — newsy, support/QR
- **Mobile** (<768px): topbar + drawer + bottom sheet dla newsów

## Zaplanowane
- Podstrony z strategiami dla innych projektów (Jupiter, Kamino, Drift, Meteora)
- Osobne URL-e per strategia dla SEO
