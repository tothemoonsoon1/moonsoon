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
├── strategies/
│   ├── TEMPLATE.html       ← szablon dla nowych stron strategii (NIE deployować!)
│   ├── huma.html           ← Huma Finance strategy page
│   └── (przyszłe: jupiter.html, kamino.html, meteora.html...)
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
├── sitemap.xml             ← ZAWSZE aktualizuj przy nowej stronie!
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

---

## Strategy pages — struktura i template

Każda strategia to osobny plik HTML pod `strategies/[protocol].html`.
Wszystkie strony strategii są oparte na wspólnym szablonie: `strategies/TEMPLATE.html`.

### Jak stworzyć nową stronę strategii
1. Skopiuj `strategies/TEMPLATE.html` jako `strategies/[protocol].html`
2. Znajdź wszystkie `[PLACEHOLDERS]` w nawiasach kwadratowych i zastąp je prawdziwymi danymi
3. Zmień `--accent` na kolor akcentu protokołu
4. Dostosuj liczbę kart modów (1–4) i tip boxów
5. Dodaj nowy link w nawigacji na **wszystkich** stronach (index.html + huma.html + nowa strona)
6. Wypełnij SEO (patrz sekcja niżej) — **obowiązkowo**
7. Dodaj stronę do `sitemap.xml` — **obowiązkowo**
8. Pushuj na `dev`, testuj, potem `main`

### Zasady spójności nawigacji
Każda strona ma identyczny `<nav>` z pełną listą strategii.
Kiedy dodajesz nową strategię:
- Dodaj link `.nav-link` do nav na **wszystkich istniejących stronach**
- Na własnej stronie nowa strategia ma klasę `.active`
- Na pozostałych stronach — bez `.active`
- Zaktualizuj "Coming Soon" blok żeby nie wymieniał już dodanej strategii

### Struktura strony strategii (kolejność sekcji)
1. **Hero** — nazwa protokołu, tag kategorii (np. "PayFi Strategy"), opis jednym zdaniem, 2–4 meta-facts
2. **Stats bar** — 2–3 karty z kluczowymi metrykami (APY, TVL, itp.)
3. **CTA banner** — przycisk do apki + opcjonalny referral link
4. **Mode cards** — 1–4 karty z trybami/strategiami, każda z APY, opisem, risk dots
5. **Tip boxes** — amber (tipsy), blue (info), green (dobre wieści), red (ryzyko)
6. **Panel prawy** — live price box (jeśli jest token), official links, opcjonalne dodatkowe sekcje

### CSS — kluczowe klasy strony strategii
- `.panel::before` — **NIE UŻYWAĆ** — powoduje spurious border line niezależną od layoutu. Zamiast tego border-left na `.panel` wystarczy.
- Panel width: `360px` — identyczny z `index.html` (prawa kolumna)
- Breakpoint chowania panelu: `@media(max-width:1100px)`
- Breakpoint mobilny: `@media(max-width:768px)`

### CoinGecko price fetch — przykłady ID
- HUMA: `huma-finance`
- JUP (Jupiter): `jupiter-exchange-solana`
- KMNO (Kamino): `kamino-finance`
- Format: jeśli cena < $0.01 → `.toFixed(5)`, < $1 → `.toFixed(4)`, >= $1 → `.toFixed(2)`

---

## ⚠️ SEO — obowiązkowe przy każdej nowej stronie

Każda nowa strona strategii MUSI mieć kompletne SEO zanim trafi na `main`.
Nie jest to opcjonalne — bez tego Google nie zaindeksuje strony poprawnie.

### Wymagane tagi `<head>` dla każdej strony strategii

```html
<!-- 1. Primary SEO -->
<title>[PROTOCOL] Strategy Guide | tothemoonsoon</title>
<meta name="description" content="[1–2 zdania opisujące strategię, max 155 znaków]">
<meta name="keywords" content="[PROTOCOL], [TOKEN], Solana DeFi, airdrop strategy, tothemoonsoon, [inne słowa kluczowe]">
<meta name="author" content="tothemoonsoon">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#0d0d1a">
<link rel="canonical" href="https://tothemoonsoon.xyz/strategies/[protocol-slug]">

<!-- 2. Open Graph -->
<meta property="og:type" content="article">
<meta property="og:url" content="https://tothemoonsoon.xyz/strategies/[protocol-slug]">
<meta property="og:title" content="[PROTOCOL] Strategy Guide | tothemoonsoon">
<meta property="og:description" content="[ten sam opis co meta description]">
<meta property="og:image" content="https://pbs.twimg.com/profile_images/1716881356209467393/Q07vWOFt_400x400.jpg">
<meta property="og:image:width" content="400">
<meta property="og:image:height" content="400">
<meta property="og:site_name" content="tothemoonsoon Strategies Hub">
<meta property="og:locale" content="en_US">
<meta property="article:author" content="https://x.com/m00nsoon">

<!-- 3. Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@m00nsoon">
<meta name="twitter:creator" content="@m00nsoon">
<meta name="twitter:title" content="[PROTOCOL] Strategy Guide | tothemoonsoon">
<meta name="twitter:description" content="[opis]">
<meta name="twitter:image" content="https://pbs.twimg.com/profile_images/1716881356209467393/Q07vWOFt_400x400.jpg">

<!-- 4. JSON-LD Structured Data -->
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "[PROTOCOL] Strategy Guide",
  "description": "[opis]",
  "url": "https://tothemoonsoon.xyz/strategies/[slug]",
  "author": {
    "@type": "Person",
    "name": "tothemoonsoon",
    "url": "https://x.com/m00nsoon"
  },
  "publisher": {
    "@type": "Person",
    "name": "tothemoonsoon",
    "url": "https://tothemoonsoon.xyz"
  },
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://tothemoonsoon.xyz/strategies/[slug]"
  },
  "about": {
    "@type": "Thing",
    "name": "[PROTOCOL]",
    "url": "[APP_URL]"
  },
  "breadcrumb": {
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "Strategies Hub", "item": "https://tothemoonsoon.xyz"},
      {"@type": "ListItem", "position": 2, "name": "[PROTOCOL] Strategy", "item": "https://tothemoonsoon.xyz/strategies/[slug]"}
    ]
  }
}
</script>

<!-- 5. Performance -->
<link rel="dns-prefetch" href="https://api.coingecko.com">
<!-- dodaj dns-prefetch dla każdej zewnętrznej domeny linkowanej ze strony -->
```

### Obowiązkowa aktualizacja sitemap.xml

Każda nowa strona = nowy wpis w `sitemap.xml`. Rób to **w tym samym commicie** co publikacja strony.

```xml
<url>
  <loc>https://tothemoonsoon.xyz/strategies/[protocol-slug]</loc>
  <lastmod>YYYY-MM-DD</lastmod>  <!-- data dzisiejsza -->
  <changefreq>monthly</changefreq>
  <priority>0.9</priority>
</url>
```

### Aktualny stan sitemap.xml
Strony już zaindeksowane:
- `https://tothemoonsoon.xyz/` — Seeker S2 Checklist
- `https://tothemoonsoon.xyz/strategies/huma` — Huma Finance Strategy

### Checklist SEO przed każdym publishem nowej strony
- [ ] `<title>` unikalny, zawiera nazwę protokołu i "tothemoonsoon"
- [ ] `<meta description>` 120–155 znaków, opisuje co użytkownik znajdzie
- [ ] `<link rel="canonical">` z pełnym URL
- [ ] Open Graph — wszystkie 7 tagów
- [ ] Twitter Card — wszystkie 5 tagów
- [ ] JSON-LD Article + BreadcrumbList
- [ ] `sitemap.xml` zaktualizowany z nowym wpisem
- [ ] Wszystkie `target="_blank"` mają `rel="noopener noreferrer"`
- [ ] Obrazki mają `alt` i `loading="lazy"` (poza LCP)
- [ ] Script owinięty w IIFE `(function(){...})()`

---

## Zaplanowane
- Podstrony z strategiami dla innych projektów (Jupiter, Kamino, Drift, Meteora)
- Osobne URL-e per strategia dla SEO
