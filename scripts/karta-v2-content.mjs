// Generuje pole "content" kart w wzorcu v2 z pól strukturalnych.
// "content" jest potrzebne wyszukiwarce, AI i starszym wersjom aplikacji.
// Użycie: node scripts/karta-v2-content.mjs <plik-karty.json> [...]
// (docelowo: wywołanie z scripts/build-baza.mjs dla kart z "wzorzec": 2)

import { promises as fs } from "node:fs";

export function contentFromV2(card) {
    const text = point => (typeof point === "string" ? point : String(point?.t || ""));
    const lines = [];
    const add = (label, body) => {
        if (body) lines.push(`${lines.length + 1}. ${label}: ${body}`);
    };

    add("NAJPIERW", (card.najpierw || []).map(text).join(" "));
    add("PARAMETRY", (card.parametry || []).map(p => `${p.nazwa} — ${p.wartosc}`).join("; "));
    for (const section of card.sekcje || []) {
        add(String(section.etykieta || "").toUpperCase(), (section.punkty || []).map(text).join(" "));
    }
    add("WEZWIJ WSPARCIE, GDY", (card.wsparcie || []).map(text).join(" "));
    add("NIE RÓB", (card.nie_rob || []).map(text).join(" "));
    return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
    for (const file of process.argv.slice(2)) {
        const card = JSON.parse(await fs.readFile(file, "utf8"));
        if (Number(card.wzorzec) !== 2) continue;
        card.content = contentFromV2(card);
        await fs.writeFile(file, JSON.stringify(card, null, 2) + "\n");
        console.log(`content: ${file} (${card.content.length} znaków)`);
    }
}
