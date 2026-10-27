// Weryfikacja spójności tematycznej kart KDR AI.
//
// Cel: wykryć przed aktualizacją błędy typu „karta w złej zakładce”
// albo „jedna karta łączy dwa osobne tematy”.
//
// Sprawdzenia (błąd = budowa bazy / Pull Request zatrzymany):
//  1. Każda karta trafia do DOKŁADNIE jednej zakładki aplikacji
//     (reguły PROCEDURE_GROUPS z index.html + pole "grupa").
//  2. Pole "grupa" nie może przeczyć regule zakładki wynikającej z ID karty.
//  3. Dokumenty źródłowe karty pochodzą z jednej dziedziny (folder dokumenty/<dziedzina>/)
//     – chyba że karta ma "laczy_dziedziny" z uzasadnieniem.
//  4. Dziedzina dokumentów pasuje do zakładki karty (kontrola/zasady-tematyczne.json).
//  5. (tryb CLI) Dane wbudowane w index.html są zgodne z procedury/baza.json i rejestrem.
//
// Użycie:
//   node scripts/weryfikacja-kart.mjs                 – pełna weryfikacja
//   node scripts/weryfikacja-kart.mjs --porownaj REF  – dodatkowo raport zmian względem REF (np. origin/main)
// W trybie GitHub Actions raport trafia też do podsumowania zadania ($GITHUB_STEP_SUMMARY).

import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

export function wczytajZakladki(html) {
    const m = html.match(/const PROCEDURE_GROUPS = (\[[\s\S]*?\n\s*\]);/);
    if (!m) throw new Error("Nie znaleziono PROCEDURE_GROUPS w index.html");
    // Tablica zawiera wyłącznie literały i funkcje testujące ID – kod z naszego repozytorium.
    return (0, eval)(m[1]);
}

function dziedzinaDokumentu(doc) {
    const plik = String(doc?.plik || "");
    const m = plik.match(/^dokumenty\/([^/]+)\//);
    return m ? m[1] : null; // null = źródło internetowe / brak pliku – nie oceniamy
}

export function zakladkaKarty(karta, zakladki) {
    const wgId = zakladki.filter(z => z.test(String(karta.id || "")));
    const jawna = String(karta.grupa || "").trim();
    return { wgId, jawna, wynik: jawna ? zakladki.filter(z => z.key === jawna) : wgId };
}

export function weryfikujKarty(karty, rejestr, zakladki, zasady) {
    const bledy = [];
    const razem = (zasady.dziedziny_dozwolone_razem || []).map(g => new Set(g));
    for (const karta of karty) {
        const { wgId, jawna, wynik } = zakladkaKarty(karta, zakladki);
        if (jawna && !wynik.length) bledy.push(`${karta.id}: pole "grupa" = "${jawna}" nie istnieje w zakładkach aplikacji.`);
        if (!jawna && wgId.length === 0) bledy.push(`${karta.id}: nie pasuje do żadnej zakładki (trafiłaby do „Inne”). Dodaj regułę w PROCEDURE_GROUPS albo pole "grupa".`);
        if (!jawna && wgId.length > 1) bledy.push(`${karta.id}: pasuje do kilku zakładek naraz (${wgId.map(z => z.label).join(", ")}). Popraw reguły PROCEDURE_GROUPS.`);
        if (jawna && wgId.length && !wgId.some(z => z.key === jawna)) {
            bledy.push(`${karta.id}: pole "grupa" = "${jawna}", ale reguła ID przypisuje kartę do „${wgId.map(z => z.label).join(", ")}”. Ujednolić.`);
        }
        const zakladka = wynik[0];
        if (!zakladka) continue;

        const dziedziny = [...new Set((karta.dokumenty_zrodlowe || [])
            .map(r => dziedzinaDokumentu(rejestr[r.dokument_id]))
            .filter(Boolean))];
        const uzasadnienie = String(karta.laczy_dziedziny || "").trim();
        if (uzasadnienie && uzasadnienie.length < 30) {
            bledy.push(`${karta.id}: "laczy_dziedziny" wymaga konkretnego uzasadnienia (min. 30 znaków).`);
        }
        const dozwoloneRazem = dziedziny.length > 1 && razem.some(g => dziedziny.every(d => g.has(d)));
        if (dziedziny.length > 1 && !dozwoloneRazem && !uzasadnienie) {
            bledy.push(`${karta.id}: łączy dokumenty z różnych dziedzin (${dziedziny.join(" + ")}) – prawdopodobnie dwa tematy w jednej karcie. Rozdziel kartę albo dodaj "laczy_dziedziny" z uzasadnieniem.`);
        }
        const dozwolone = zasady.dziedziny_zakladek?.[zakladka.key];
        if (Array.isArray(dozwolone) && !uzasadnienie) {
            for (const d of dziedziny) {
                if (!dozwolone.includes(d)) {
                    bledy.push(`${karta.id}: dokumenty z dziedziny „${d}” nie pasują do zakładki „${zakladka.label}” (dozwolone: ${dozwolone.join(", ") || "tylko źródła internetowe"}).`);
                }
            }
        }
    }
    return bledy;
}

function wbudowane(html, nazwa) {
    const linia = html.split("\n").find(l => l.trimStart().startsWith(`const ${nazwa} = `));
    if (!linia) return null;
    const t = linia.trim();
    return JSON.parse(t.slice(`const ${nazwa} = `.length, -1));
}

function z(ref, plik) {
    try { return execFileSync("git", ["show", `${ref}:${plik}`], { encoding: "utf8", maxBuffer: 1 << 28 }); }
    catch { return null; }
}

async function cli() {
    const root = process.cwd();
    const args = process.argv.slice(2);
    const ref = args.includes("--porownaj") ? args[args.indexOf("--porownaj") + 1] : null;
    const html = await fs.readFile(path.join(root, "index.html"), "utf8");
    const baza = JSON.parse(await fs.readFile(path.join(root, "procedury/baza.json"), "utf8"));
    const rej = JSON.parse(await fs.readFile(path.join(root, "dokumenty/rejestr-dokumentow.json"), "utf8"));
    const zasady = JSON.parse(await fs.readFile(path.join(root, "kontrola/zasady-tematyczne.json"), "utf8"));
    const zakladki = wczytajZakladki(html);

    const bledy = weryfikujKarty(baza, rej.dokumenty, zakladki, zasady);

    const embP = wbudowane(html, "EMBEDDED_PROCEDURES");
    const embR = wbudowane(html, "EMBEDDED_DOCUMENT_REGISTRY");
    if (JSON.stringify(embP) !== JSON.stringify(baza)) bledy.push("index.html: EMBEDDED_PROCEDURES różni się od procedury/baza.json (aplikacja offline pokaże stare karty).");
    if (JSON.stringify(embR) !== JSON.stringify(rej)) bledy.push("index.html: EMBEDDED_DOCUMENT_REGISTRY różni się od dokumenty/rejestr-dokumentow.json.");

    const linie = ["## Weryfikacja kart KDR AI", ""];
    linie.push(bledy.length ? `**Błędy: ${bledy.length}** — nie scalać przed poprawą.` : "**Błędy: 0** — spójność tematyczna i dane wbudowane w porządku.", "");
    bledy.forEach(b => linie.push(`- ❌ ${b}`));

    if (ref) {
        const stHtml = z(ref, "index.html"), stBaza = z(ref, "procedury/baza.json"), stRej = z(ref, "dokumenty/rejestr-dokumentow.json");
        if (stHtml && stBaza && stRej) {
            const stZak = wczytajZakladki(stHtml);
            const stare = new Map(JSON.parse(stBaza).map(k => [k.id, k]));
            const stareRej = JSON.parse(stRej).dokumenty;
            const nowe = new Map(baza.map(k => [k.id, k]));
            // Porównanie po kluczu zakładki (zmiana samej etykiety nie jest przeniesieniem karty).
            const klucz = (k, zak) => zakladkaKarty(k, zak).wynik[0]?.key || "inne";
            const etykieta = key => (zakladki.find(x => x.key === key) || stZak.find(x => x.key === key))?.label || "Inne";
            const nazwa = (k, zak) => etykieta(klucz(k, zak));
            const zrodla = (k, r) => (k.dokumenty_zrodlowe || []).map(x => r[x.dokument_id]?.tytul || x.dokument_id).join("; ") || "—";
            linie.push("", `## Zmiany kart względem \`${ref}\``, "", "| Karta | Zmiana | Zakładka | Dokumenty źródłowe |", "|---|---|---|---|");
            let n = 0;
            for (const [id, k] of nowe) {
                const s = stare.get(id);
                if (s && JSON.stringify(s) === JSON.stringify(k)) continue;
                const zakNowa = nazwa(k, zakladki), zakStara = s ? nazwa(s, stZak) : null;
                const zak = !s || klucz(s, stZak) === klucz(k, zakladki) ? zakNowa : `⚠️ **${etykieta(klucz(s, stZak))} → ${zakNowa}**`;
                linie.push(`| ${id}<br>${String(k.prefix || "").slice(0, 120)} | ${s ? "zmieniona" : "**nowa**"} | ${zak} | ${zrodla(k, rej.dokumenty)} |`);
                n++;
            }
            for (const [id, s] of stare) if (!nowe.has(id)) { linie.push(`| ${id} | **usunięta** | ${nazwa(s, stZak)} | ${zrodla(s, stareRej)} |`); n++; }
            // Karty, które zmieniły zakładkę wyłącznie przez zmianę reguł w index.html
            for (const [id, k] of nowe) {
                const s = stare.get(id);
                if (!s || JSON.stringify(s) !== JSON.stringify(k)) continue;
                if (klucz(s, stZak) !== klucz(k, zakladki)) { linie.push(`| ${id} | reguła zakładki | ⚠️ **${nazwa(s, stZak)} → ${nazwa(k, zakladki)}** | ${zrodla(k, rej.dokumenty)} |`); n++; }
            }
            if (!n) linie.push("| — | brak zmian kart | | |");
            const zmianyNazw = zakladki.filter(x => { const st = stZak.find(y => y.key === x.key); return st && st.label !== x.label; });
            if (zmianyNazw.length) linie.push("", "Zmienione nazwy zakładek: " + zmianyNazw.map(x => `„${stZak.find(y => y.key === x.key).label}” → „${x.label}”`).join(", ") + ".");
            linie.push("", "Przed scaleniem sprawdź: czy każda zmieniona karta dotyczy **jednego tematu** i czy jej **zakładka** jest właściwa (⚠️ = zmiana zakładki).");
        } else {
            linie.push("", `(Brak danych do porównania z \`${ref}\`.)`);
        }
    }

    const tekst = linie.join("\n");
    console.log(tekst);
    if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, tekst + "\n");
    if (bledy.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await cli();
