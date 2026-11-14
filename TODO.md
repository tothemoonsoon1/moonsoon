# TODO — otwarte sprawy (stan: 14.11.2026)

Lista rzeczy rozpoczętych albo odłożonych w poprzednich sesjach. Po zrobieniu punktu usuń go stąd (albo przenieś do „Zrobione”) w tym samym commicie.

## 1. Alerty cenowe Mad Lads (Trait Alerts) — gotowe, nieprzetestowane
- Kod na gałęzi `feature/trait-alerts` (ostatni commit `519e75c`): zakładka „Alerts” w `madlads.html`, `assets/js/alerts.js`, edge function `netlify/edge-functions/me-proxy.ts` (proxy `/api/me/*` do API Magic Eden, cache 25 s — ME blokuje CORS), wpis w `netlify.toml`.
- Działa tylko przy otwartej karcie (reguły w `localStorage`, brak serwera). Hamulec: po 30 min bezczynności co 5 min, po 12 h stop z przyciskiem „Resume”.
- Koszt: ustawienie alertu 0; ok. 1 kredyt Netlify na 48 h otwartej karty z alertem.
- **Gałąź ma konflikty z `main`** (od tamtej pory zmieniły się `madlads.html`, menu, nazwy zakładek). Trzeba ją przenieść na obecny kod, dodać „Alerts” do zakładek i do podmenu `.nav-sub` na wszystkich pięciu stronach, potem wrzucić na `dev`.
- Do sprawdzenia tylko na prawdziwym Netlify (`dev--moonsoon.netlify.app/madlads.html#alerts`): czy działa proxy `/api/me/*` i czy przeglądarka pyta o zgodę na powiadomienia i je pokazuje.

## 2. Backfill historii sprzedaży Mad Lads
- Etap 1 w toku (szczegóły w `CLAUDE.md`). Po zakończeniu: sprawdzić, czy wykres miesięczny 2026 się wyrównał.
- Etap 2: kod gotowy i wyłączony. Włączyć **po resecie limitu Heliusa** (decyzja właściciela z 13.11) — ok. 580 tys. kredytów.
- Po obu etapach: cron `backfill-madlads.yml` przestawić na raz dziennie.
- Sprawdzić, czy zrzut `update-madlads.yml` rusza sam co 3 h (13.11 GitHub nie uruchomił go z harmonogramu, odpalony ręcznie).

## 3. Odłożone na słowo właściciela
- Webhook Helius ze sprzedażami na żywo.
- Bieżące sprzedaże z łańcucha (z Tensorem) w „Recent sales” — dziś są tylko z API Magic Eden. Właściciel 12.11: „zostawmy jak jest”.
- Sprzedaże z przyjętej oferty są zawyżone o ~6% (cena już z opłatami, a strona dolicza ×1,062). Poprawka: zapisywać typ sprzedaży przy backfillu.

## 4. Posty na X o stronie Skulls
- Szkice (krótki i długi) są w sesji „Traits w zakładce ze skullami” (7–11.11). Przed publikacją poprawić „this week” i „hourly” (Skulls synchronizuje się teraz co godzinę o :47 i raz dziennie pełny zrzut).

## 5. Po przeglądzie z 14.11 — do decyzji właściciela
- **Limit Netlify:** bot commituje dane na `main` ok. 30 razy na dobę i każdy commit to wdrożenie produkcyjne. Sprawdzić w panelu Netlify (Usage) zużycie minut/kredytów. Jeśli jest blisko limitu darmowego planu: rzadziej commitować dane (np. Skulls co 3 h) albo serwować JSON-y spoza wdrożeń.
- **Checklist:** „Daily progress” nigdy się nie zeruje — zadania dzienne i tygodniowe zostają odhaczone na zawsze. Propozycja: dzienne zerować o północy, tygodniowe w poniedziałek.
- **Duża karta na X:** grafika 1200×630 (logo + Skull) i powrót do `summary_large_image`.
- Strona 404 w stylu serwisu (dziś domyślna Netlify).
- `mica.html`: wiersz Backpack (link polecający) otwiera się tylko kliknięciem myszą; `Article` w JSON-LD nie ma `dateModified`.
- Workflowy: usunąć stare wyzwalacze `push` na gałęzie `claude/bold-thompson-jy7fuk` i `claude/tender-hopper-p8opwh`; `update-skulls.yml` i `update-madlads.yml` pushują bez `git pull --rebase` (przebieg pada, jeśli w tym czasie ktoś zmerguje `dev` → `main`; następny przebieg nadrabia).
- Po zakończeniu backfillu: `madlads-data.json` (236 KB po kompresji, z czego 210 KB to adresy portfeli) to teraz najcięższy plik strony Mad Lads — można rozważyć skrócone adresy na pierwsze ładowanie.

## Zrobione
- 14.11: przegląd kodu, designu, SEO i wydajności — wspólny `gallery.css`, czcionki z własnej domeny, lżejsze dane Mad Lads (ok. 1,07 MB → 0,47 MB na pierwsze wejście), Skulls bez zmyślonych danych zastępczych, poprawki dostępności i metadanych.
- 13.11: znacznik „MYSTERY” (MadLads Team Wallet) ma kontrast 5,3:1 — kolor `#c2365a` w `owner-tags.json`; kolory tagów nie są już używane jako kolor tekstu.
- 13.11: domena ewip.eu wskazuje na Netlify i działa.
