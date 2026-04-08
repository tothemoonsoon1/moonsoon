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
- Hosting: statyczny (Netlify) — commit = live

## Release flow
1. Claude pushuje zmiany na branch `dev`
2. Netlify automatycznie deployuje → https://dev--moonsoon.netlify.app/
3. Właściciel testuje na tym URL
4. Właściciel mówi "OK"
5. Claude robi merge `dev` → `main`
6. Netlify deployuje na produkcję → tothemoonsoon.xyz

## Struktura plików
```
moonsoon/
├── index.html              ← główna strona (Seeker S2 checklist)
│                             UWAGA: <style> i <script> są inline — patrz niżej
├── news.json               ← dane newsów ładowane przez fetch w JS
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

## ⚠️ KRYTYCZNE — inline `<script>` i błędy parsowania

**Jeden błąd składniowy w bloku `<script>` = cała strona nie działa.**

Przeglądarka parsuje `<script>` jako jeden blok. Jeśli gdziekolwiek jest błąd składniowy,
cały skrypt jest odrzucany — żadna funkcja nie istnieje, żaden button nie reaguje,
żaden fetch nie odpala. Objawia się to tym że strona wygląda dobrze wizualnie,
ale jest kompletnie martwa (przyciski, newsfeed, kalkulator — nic nie działa).

**Najczęstsze przyczyny:**
- Wklejanie danych JSON z HTML entities wewnątrz stringa JS (np. `&#128241;`, `&amp;`)
- Zagnieżdżone cudzysłowy bez prawidłowego escapowania (`"` w środku `"..."`)
- HTML w stringach JS (tagi `<strong style="...">` wewnątrz apostrofów)

**Zasada:** dane z HTML (entities, tagi, cudzysłowy) nie powinny być hardkodowane
bezpośrednio w bloku `<script>`. Lepiej trzymać je w osobnym pliku (np. `news.json`)
i ładować fetchem — wtedy błąd w danych nie niszczy całego skryptu.

## ⚠️ KRYTYCZNE — jak naprawić zepsutą wersję dev

Jeśli `dev` przestał działać (biała strona, martwe przyciski, brak newsów):

**Nie próbuj naprawiać kodu na dev.** Zamiast tego:
1. Pobierz czysty `index.html` z `main` (prod)
2. Wprowadź tylko te zmiany które były planowane (np. nowy link w nawigacji)
3. Wrzuć na `dev`

`main` jest zawsze źródłem prawdy. Dev to tylko środowisko testowe.

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
- Newsfeed: fetch z `/news.json` na load event

## Layout (desktop 3 kolumny)
- **Lewa kolumna** (180px): nawigacja `.nav` — linki do stron, coming soon
- **Środek** (max 680px): główna treść `.main` — checklist, kalkulator
- **Prawa kolumna** (360px): panel `.panel` — newsy, support/QR
- **Mobile** (<768px): topbar + drawer + bottom sheet dla newsów

## Zaplanowane
- Podstrony z strategiami dla innych projektów (Jupiter, Kamino, Drift, Meteora)
- Osobne URL-e per strategia dla SEO
