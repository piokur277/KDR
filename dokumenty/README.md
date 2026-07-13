# Pełne dokumenty procedur

Umieszczaj pełne dokumenty w tym katalogu, najlepiej jako pliki PDF.

Przykład:

```text
dokumenty/pojazdy-elektryczne/procedura-ev.pdf
```

Następnie w odpowiednim pliku JSON procedury uzupełnij:

```json
"pelna_procedura": {
  "tytul": "Pełna nazwa dokumentu",
  "plik": "dokumenty/pojazdy-elektryczne/procedura-ev.pdf",
  "strona": 12
}
```

Pole `strona` może mieć wartość `null`, gdy dokument ma otwierać się od pierwszej strony.

Dopóki pole `plik` jest puste, aplikacja wyświetla nieaktywny przycisk
„Pełna procedura — plik niepodłączony”.
