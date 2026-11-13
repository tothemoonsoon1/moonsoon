# tothemoonsoon — Project Context for Claude

## WAŻNE — jak zacząć każdą sesję
1. Przeczytaj ten plik
2. Pobierz aktualny plik który chcesz edytować z GitHub przed zmianami
3. Wprowadź zmiany
4. Pushuj na `dev` (patrz Release flow); `main` tylko po akceptacji właściciela

## Zasada pracy
- Rób sam wszystko, co możesz zrobić swoimi narzędziami (uruchomienie serwera, zrzuty, publikacja podglądu, edycje). Nie każ właścicielowi wykonywać kroków, które możesz wykonać sam.
- Gdy właściciel prosi o pracę „lokalnie”, a chce coś zobaczyć: localhost w kontenerze nie jest dla niego dostępny — opublikuj prywatny podgląd (Artifact) lub wyślij zrzuty, zamiast podawać localhost.

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
├── index.html, skulls.html, madlads.html, checklist.html, mica.html  ← pięć stron (style/skrypty stron inline)
├── assets/css/tokens.css, base.css   ← kolory i wspólne style
├── assets/js/common.js               ← wspólne funkcje (escAttr/esc, toggleTheme, timeAgo, tpFind)
├── assets/img/
├── *.json                            ← dane (część commituje bot)
├── scripts/                          ← generatory danych (GitHub Actions)
├── sitemap.xml, robots.txt, netlify.toml
└── CLAUDE.md
```

## ⚠️ KRYTYCZNE — inline `<script>`
Jeden błąd składniowy w bloku `<script>` = cała strona martwa. Danych z HTML (entities, tagi) nie hardkoduj w skryptach — trzymaj je w JSON i ładuj fetchem. Wszystko z zewnątrz, co trafia do `innerHTML`, przepuszczaj przez `esc`/`escAttr`.

Jeśli `dev` się zepsuł: nie łataj go — weź czysty plik z `main`, nanieś tylko planowane zmiany.

## Tech stack
- Czysty HTML/CSS/JS (zero frameworków, zero build step)
- Umami Analytics: `data-website-id="289eb289-b024-4df5-b133-5c2b376c29de"`

## Design system
- Strony w menu: Home (`index.html`), Mad Lads (`madlads.html`), Skulls (`skulls.html`), Seeker Checklist (`checklist.html`), EU Licenses (`mica.html`). Nawigacja jest identyczna na wszystkich pięciu — zmieniaj ją wszędzie naraz.
- Home czyta postęp checklisty z `localStorage` (`moonsoon_checklist_summary`, zapisywany przez `checklist.html`); stary adres `/#checklist` przekierowuje na `/checklist.html`
- Wspólne style (reset, nawigacja, przyciski, przełącznik motywu, fokus, stopka) są w `/assets/css/base.css` — zmieniaj je tam, nie w stronach. Style specyficzne dla strony zostają inline w jej `<style>`. Po zmianie `base.css` podbij `?v=` tak jak przy `tokens.css`.
- Wszystkie kolory (motyw ciemny i jasny) są w `/assets/css/tokens.css` — jedyne źródło dla pięciu stron. Nie kopiuj `:root` do stron.
- UWAGA: `/assets/css/*` jest cache'owane na rok (`netlify.toml`). Po każdej zmianie `tokens.css` podbij `?v=` w tagu `<link>` na wszystkich pięciu stronach.
- Tło `#0b0d12`, jeden akcent `#4fd8ff` (jasny motyw `#066682`, dobrany tak, by tekst miał kontrast co najmniej 4.5:1); kolory znaczeniowe: `--gold`, `--rare`, `--uncommon`, `--up`, `--down`, `--warn`, `--me`
- Motyw jasny: każdy nowy kolor tekstu sprawdź też na jasnym tle (min. 4.5:1). Złoty tekst używa `--gold-text`, nie `--gold`. Motyw jest ustawiany skryptem w `<head>` przed arkuszami, żeby nie było mignięcia ciemnego tła.
- Fonty: Space Grotesk (treść, nagłówki), JetBrains Mono (logo, kickery, etykiety)
- Skala tekstu: 12, 13, 14, 15, 16, 18, 20, 24, 28px (+ hero 34/48). Minimum 12px, bez wartości połówkowych.
- Promienie: 6 (znaczniki), 8 (przyciski, pola), 12 (wiersze), 14 (karty), 20 (pigułki)
- Nagłówek strony: kicker tekstowy (mono, akcent) + tytuł 28px (24px na telefonie) + opis, do lewej
- Telefon: nawigacja sticky w dwóch rzędach, cele dotykowe min. 44px
- Pełny opis: design system https://claude.ai/artifact/GKACuCg96FVQCGJUiHVsS9

## Mad Lads (`madlads.html`) — dane
- Cała kolekcja (~10k) NIE może być czytana per-NFT jak Skulls: jeden Lad ma ~6 000 transakcji (bidy), pełny odczyt to ~62 mln kredytów Helius.
- `scripts/generate-madlads-data.mjs` (workflow `update-madlads.yml`, co 3 h, ~200 kredytów na przebieg): jeden zrzut kolekcji (`getAssetsByGroup`) + listingi i ostatnie sprzedaże z darmowego API Magic Eden.
- Pliki: `madlads-static.json` (mint + cechy, niezmienne), `madlads-data.json` (właściciele, listingi, ruchy holderów), `madlads-sales-ROK.json` (sprzedaże, scalane po sygnaturze).
- Obrazki: miniatury z CDN Magic Eden (`img-cdn.magiceden.dev`), nic w repo. Oryginały mają ~5 MB.
- Etykiety portfeli: wspólny `owner-tags.json` (ten sam co Skulls).
- Progi: whale = 20+ Ladów, shark = 5–19.
- Rzadkość: rangi z HowRare (te same pokazuje Magic Eden), zapisane w `madlads-static.json` (`rank`). Poziomy wg rangi: Mythic top 1%, Legendary 5%, Epic 15%, Rare 35%, Uncommon 60%, Common.
- Historia sprzedaży: `scripts/backfill-madlads-sales.mjs` (workflow `backfill-madlads.yml`). Idzie po łańcuchu kont, które trzymały NFT, po kolei numerami; stan w `madlads-backfill.json`. W plikach zapisana jest cena wystawienia lub oferty, bez opłat; strony (Mad Lads i Skulls) pokazują wszystkie ceny — floor, listingi i sprzedaże — z opłatami (×1,062, `PRICE_FEE`), czyli kwotę, którą płaci kupujący.
- Backfill — jak działa teraz (listopad 2026):
  - Helius jest na planie **Free: 1M kredytów/mc, 10 zapytań/s**. Skrypt chodzi równolegle (`WORKERS=3`) ze wspólnym limitem `RPS=9`. Nie podnoś RPS powyżej 9 na tym planie.
  - Workflow startuje co 3 h (cron `12 */3 * * *`), każdy przebieg trwa do 145 min, bez limitu kredytów (ogranicza czas i RPS). Dzieli grupę `concurrency` z dziennym snapshotem, żeby nie pushowały naraz.
  - **Etap 1 (w toku):** każdy Lad tylko do granicy `state.cutoff` (365 dni wstecz, ustalona raz), ok. 21 kredytów na Lada. W tym miejscu zapisywany jest kursor do `madlads-backfill-deep.json` (jeden Lad na linię). `fullNext` = Lady przed tym indeksem mają pełną historię do mintu (#1–169).
  - **Etap 2 (kod gotowy, wyłączony):** `STAGE2=1` — po zakończeniu etapu 1 idzie po kursorach z `madlads-backfill-deep.json` do mintu (ok. 60 kredytów na Lada, ~580 tys. za całość). Włącza się ręcznie (Run workflow → stage2) albo zmianą `STAGE2` w `backfill-madlads.yml` na `'1'`. Na koniec skrypt usuwa `cutoff`, ustawia `stage2Done` i strona pokazuje pełną historię. Decyzja właściciela: teraz czy po resecie limitu Heliusa.
  - Po zakończeniu etapu 1 przebiegi kończą się w kilka sekund; cron można wtedy przestawić na raz dziennie.
  - **Nie edytuj ręcznie** `madlads-backfill*.json`, `madlads-sales-*.json` ani `madlads-data.json`, gdy backfill trwa — bot commituje je na `main` co kilka godzin (z `git pull --rebase`). Zmiany w HTML/CSS/JS się z nimi nie gryzą.
  - Postęp: podsumowanie każdego przebiegu w zakładce Actions (krok „Coverage”) i `next`/`total` w `madlads-backfill.json`.
- Przed pracą na `dev`: zsynchronizuj go z `main` (bot commituje dane na `main`, więc `dev` szybko zostaje w tyle).
- Skulls ma te same wzorce co Mad Lads: zakładka Holders (whale = 3+, shark = 2) i filtr cech jako rozwijane sekcje.
- Rzadkość cech na stronie Skulls liczona jest wśród CAŁEJ kolekcji (~10k), tak samo jak w Mad Lads, żeby ten sam Skull pokazywał identyczne poziomy/% na obu stronach. Globalne liczniki są wstrzyknięte w `skulls-traits.json` (`global`, `globalAbsent`, `globalTotal`) — niezmienne. Ranga Skulla pozostaje liczona wśród 99.

## Inne zasady
- Skrypty stron są w IIFE; funkcje używane w `onclick` wystawiaj przez `window.nazwa = nazwa`.
- `escAttr`/`esc`, `toggleTheme`, `timeAgo`, `tpFind` są w `/assets/js/common.js` — nie kopiuj ich do stron. Po zmianie podbij `?v=` w pięciu tagach `<script>`.
- Motyw: zapisany wybór w `localStorage` (`moonsoon_theme`), a bez niego ustawienie systemu (`prefers-color-scheme`).
- Wiersze/karty z `role="button"` obsługują Enter i Spację.
- Nagłówki bezpieczeństwa są w `netlify.toml` dla `/*` (także adresy bez `.html`).
- Strony strategii zostały usunięte (listopad 2026).
