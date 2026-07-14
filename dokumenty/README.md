# Centralny rejestr dokumentów - KDR Asystent v18.5

## Zasada działania

Plik `dokumenty/rejestr-dokumentow.json` jest jedynym miejscem, w którym zapisuje się:
- tytuł dokumentu,
- wersję i datę,
- ścieżkę do PDF,
- liczbę stron,
- status techniczny.

Procedury przechowują tylko `dokument_id`, numer strony i nazwę sekcji.
Jeden PDF może być połączony z wieloma procedurami, a jedna procedura może mieć kilka dokumentów.

## Wymiana dokumentu na nową wersję

1. Dodaj nowy PDF pod nazwą zawierającą wersję lub datę.
2. W `rejestr-dokumentow.json` zmień w jednym wpisie pola `plik`, `wersja`, `data_wydania`, `liczba_stron` i `sha256`.
3. Jeżeli układ stron się nie zmienił, plików procedur nie trzeba edytować.
4. Jeżeli rozdziały przesunęły się na inne strony, popraw tylko pola `strona` w powiązanych procedurach.
5. Uruchom workflow lub `node scripts/build-baza.mjs`.

Zalecane są nowe nazwy plików przy każdej wersji, ponieważ zapobiega to otwieraniu starego PDF z pamięci przeglądarki.

## Ważna uwaga dotycząca pliku „cyjanowodor.PDF”

Przesłany dokument opisuje **cyjanek sodowy (NaCN)**, nie **cyjanowodór (HCN)**.
Został zapisany w rejestrze jako dokument niepowiązany i nie jest wyświetlany w procedurze HCN.

## Kontrola

Skrypt sprawdza:
- istnienie każdego PDF,
- nagłówek `%PDF-`,
- istnienie `dokument_id`,
- aktywność dokumentu,
- poprawność numeru strony względem `liczba_stron`,
- unikalność procedur i haseł wyszukiwania.
