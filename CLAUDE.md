# tothemoonsoon — Project Context for Claude

## WAŻNE — jak zacząć każdą sesję
1. Przeczytaj ten plik
2. Pobierz aktualny `index.html` z GitHub przed jakimikolwiek zmianami
3. Wprowadź zmiany
4. Commituj bezpośrednio do `main` przez GitHub MCP
5. Zmiany są od razu live — nie trzeba nic robić ręcznie

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

## Struktura plików
```
moonsoon/
├── index.html       ← główna strona (Seeker Season 2 checklist)
├── CLAUDE.md        ← ten plik
└── README.md
```

## Aktualny stan projektu
- Jeden plik `index.html` — wszystko inline (HTML + CSS + JS)
- **Nie ma osobnych plików CSS/JS** — wszystko jest w `index.html`
- Poprzednia sesja próbowała rozbić na osobne pliki, ale to nie zostało wdrożone

## Co robi index.html
- Interaktywna codzienna checklista dla posiadaczy Solana Seeker (Season 2)
- Tracker postępów z paskiem i poziomami on-chain (Lv 0–5)
- Licznik dziennych swapów
- Siatka featured dApps z filtrowaniem po kategorii
- Kalkulator stakingu SKR z wykresem (Chart.js)
- Sekcja latest news
- Sekcja wsparcia projektu z QR kodem (Solana wallet)
- Pobieranie cen SOL/SKR z CoinGecko API

## Tech stack
- Czysty HTML/CSS/JS (zero frameworków, zero build step)
- Chart.js 4.4.0 (CDN)
- QRCodeJS 1.0.0 (CDN)
- Umami Analytics: `data-website-id="289eb289-b024-4df5-b133-5c2b376c29de"`
- Hosting: statyczny (Cloudflare Pages lub podobny)

## Design system
- Background: `#0d0d1a` (dark navy)
- Purple: `#9945FF` (Solana purple)
- Teal: `#14F195` (Solana green)
- Blue: `#00C2FF`
- Font: system-ui / -apple-system stack
- CSS variables w `:root`

## Kluczowe wzorce w kodzie
- Sekcje zwijane: `toggleSection(id)`
- Taski: `toggleTask(id)` — ID z prefiksem `t-`
- dAppy: `toggleDapp(id)` — ID z prefiksem `d-`
- Filtrowanie dApps: `setDappCat(cat, btn)` via `data-cat` attribute
- Stan in-memory (brak localStorage)
- Ceny z CoinGecko na load

## Workflow zmian
```
User opisuje zmianę
→ Claude czyta aktualny index.html z GitHub (zawsze!)
→ Claude wprowadza zmiany
→ Claude commituje do main przez GitHub MCP
→ Live bez żadnych kroków ręcznych
```

## Zaplanowane (coming soon)
- Podstrony z strategiami dla innych projektów (Jupiter, Kamino, Drift, Meteora)
- Osobne URL-e per strategia dla SEO
