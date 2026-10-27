# Kontrola aktualności danych KDR AI

Automat sprawdza, czy dokumenty źródłowe i karty są aktualne, i zgłasza, co wymaga Twojej decyzji. Niczego nie zmienia w treści kart.

## Cykl

| Kiedy | Co sprawdza | Powiadomienie |
| --- | --- | --- |
| Każdy poniedziałek | Strony i pliki źródłowe online: nowe lub usunięte dokumenty na stronach KG PSP / MSWiA, zmieniona treść, niedziałające linki | Zgłoszenie (Issue) tylko przy zmianach o priorytecie wysokim lub średnim |
| Pierwszy poniedziałek miesiąca | Wszystko powyżej oraz: karty bez źródła lub daty, karty starsze niż dokument, dokumenty starsze niż próg, statusy „do weryfikacji”, zgodność sum SHA-256 plików PDF | Zgłoszenie z pełnym raportem |
| Co 12 miesięcy dla każdej karty | Karta wraca w raporcie miesięcznym jako „Okresowy przegląd karty” | W raporcie miesięcznym |

GitHub wysyła e-mail o nowym zgłoszeniu właścicielowi repozytorium. Jeśli go nie dostajesz, sprawdź Settings → Notifications na GitHubie.

## Instalacja (jednorazowo)

1. Skopiuj do repozytorium folder `kontrola/` oraz plik `.github/workflows/kontrola-aktualnosci.yml`.
2. Sprawdź w `kontrola/konfiguracja.json`, czy ścieżki do `rejestr-dokumentow.json` i `baza.json` zgadzają się z Twoim repozytorium.
3. Na GitHubie: zakładka **Actions** → „Kontrola aktualności” → **Run workflow** (tryb „pelny”). Pierwsze uruchomienie zapisuje punkt odniesienia dla stron online i tworzy pierwsze zgłoszenie.

Uwaga: GitHub może wyłączyć harmonogram w repozytorium bez aktywności przez 60 dni. Wtedy przyśle e-mail z przyciskiem ponownego włączenia.

## Jak rozstrzygnąć zgłoszenie

1. Otwórz źródło z linku i porównaj z kartą.
2. Treść wymaga zmiany → popraw kartę, ustaw `data_aktualizacji`.
3. Treść aktualna → w karcie wpisz `"data_przegladu": "RRRR-MM-DD"`, a w rejestrze dokumentu `"aktualnosc_merytoryczna": "zweryfikowano_RRRR-MM-DD"`.
4. Nowe wydanie dokumentu → dodaj je do rejestru (nowy `id`, `data_wydania`, `sha256`), przepnij karty, a stary dokument usuń z kart.
5. Zaznacz punkt w zgłoszeniu; zamknij zgłoszenie, gdy wysokie i średnie punkty są rozstrzygnięte.

Aplikacja pokazuje stan na karcie: datę aktualizacji i przeglądu karty, a przy dokumencie „zweryfikowano RRRR-MM-DD”, „do weryfikacji” lub „materiał pomocniczy”.

## Pola danych używane przez automat

| Plik | Pole | Znaczenie |
| --- | --- | --- |
| karta | `data_aktualizacji` | Kiedy zmieniono treść karty |
| karta | `data_przegladu` (nowe, opcjonalne) | Kiedy potwierdzono, że karta jest aktualna |
| rejestr | `data_wydania` | Data wydania dokumentu |
| rejestr | `aktualnosc_merytoryczna` | `zweryfikowano_RRRR-MM-DD`, `wymaga_…`, `do_potwierdzenia_…`, `pomocniczy_…`, `zmiana_wykryta_RRRR-MM-DD` |
| rejestr | `sha256` | Kontrola, czy plik PDF nie został podmieniony |

## Ustawienia (`konfiguracja.json`)

- `progi.wiek_dokumentu_lat` — po ilu latach dokument trafia do sprawdzenia, czy jest nowsze wydanie (karty charakterystyki: 5, pozostałe: 6).
- `progi.ponowne_sprawdzenie_wydania_miesiecy` — gdy starszy dokument ma w rejestrze `"aktualnosc_merytoryczna": "zweryfikowano_RRRR-MM-DD"` młodsze niż ta liczba miesięcy (domyślnie 12), trafia do priorytetu niskiego jako „aktualność potwierdzona”; po upływie okresu wraca do sprawdzenia.
- Stan plików oficjalnych zapamiętuje adres; po zmianie adresu w konfiguracji porównanie zaczyna się od nowa (bez fałszywego alarmu o nowym wydaniu).
- `progi.weryfikacja_zrodla_url_dni` — jak często potwierdzać źródła internetowe (180 dni).
- `progi.przeglad_karty_miesiecy` — okres przeglądu karty (12 miesięcy).
- `obserwowane_strony` — strony z wykazami dokumentów; `dotyczy_kart` wskazuje karty (po początku ID), których dotyczy zmiana.

## Uruchomienie na komputerze

```
node kontrola/kontrola-aktualnosci.mjs --tryb=pelny
```

Raport: `kontrola/raport.md`.


## Weryfikacja przed każdą aktualizacją kart

Każda zmiana kart przechodzi trzy niezależne sprawdzenia:

1. **Przy budowie bazy** (`node scripts/build-baza.mjs`) – budowa zostaje przerwana, gdy:
   - karta pasuje do żadnej albo do kilku zakładek aplikacji naraz,
   - pole `"grupa"` przeczy regule zakładki wynikającej z ID karty,
   - karta cytuje dokumenty z różnych dziedzin (folder `dokumenty/<dziedzina>/`) – czyli łączy dwa tematy,
   - dziedzina dokumentów nie pasuje do zakładki (`kontrola/zasady-tematyczne.json`).
   Świadome połączenie dziedzin wymaga w karcie pola `"laczy_dziedziny"` z uzasadnieniem (min. 30 znaków).
2. **Przy każdym Pull Requeście** (workflow „Weryfikacja kart”) – to samo oraz zgodność danych wbudowanych w `index.html` z bazą; w zakładce *Checks* jest raport: które karty się zmieniły, w jakiej zakładce są, z jakich dokumentów korzystają; zmiana zakładki jest oznaczona ⚠️. **Czerwony ✗ = nie scalać.**
3. **Przegląd przed zatwierdzeniem** – opis Pull Requesta zawiera raport zmian i podgląd karty w zakładce, w której pojawi się w aplikacji.

Zasada nadrzędna: **jedna karta = jeden temat = jedna zakładka**. Tematy powiązane (np. zdarzenie masowe i pojazdy elektryczne) łączy się odsyłaczem do osobnej karty, nie wspólną treścią.
