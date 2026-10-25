#!/usr/bin/env node
// Kontrola aktualności danych i treści KDR AI.
//
// Uruchomienie z katalogu głównego repozytorium (Node 20+, bez dodatkowych pakietów):
//   node kontrola/kontrola-aktualnosci.mjs --tryb=pelny       pełny przegląd (miesięcznie)
//   node kontrola/kontrola-aktualnosci.mjs --tryb=tygodniowy  tylko zmiany źródeł online
//   dodatkowo: --bez-sieci  (pomija sprawdzanie stron), --dzis=RRRR-MM-DD (do testów)
//
// Skrypt niczego nie zmienia w treści kart ani w rejestrze. Zapisuje tylko:
//   kontrola/stan.json  — odciski źródeł online (do wykrywania zmian),
//   kontrola/raport.md  — raport do przeglądu i zatwierdzenia przez człowieka.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

// ---------- parametry ----------
const args = Object.fromEntries(
    process.argv.slice(2).map(arg => {
        const [key, value] = arg.replace(/^--/, "").split("=");
        return [key, value ?? true];
    })
);
const TRYB = args.tryb === "tygodniowy" ? "tygodniowy" : "pelny";
const BEZ_SIECI = Boolean(args["bez-sieci"]);
const BEZ_PLIKOW = Boolean(args["bez-plikow"]); // tylko do testów poza repozytorium
const DZIS = args.dzis ? new Date(`${args.dzis}T12:00:00Z`) : new Date();
const DZIS_TXT = DZIS.toISOString().slice(0, 10);
const KATALOG = process.cwd();

const config = readJson("kontrola/konfiguracja.json");
const P = config.sciezki;
const progi = config.progi;

// ---------- pomocnicze ----------
function readJson(rel, fallback) {
    const file = path.join(KATALOG, rel);
    if (!fs.existsSync(file)) {
        if (fallback !== undefined) return fallback;
        throw new Error(`Brak pliku: ${rel}`);
    }
    return JSON.parse(fs.readFileSync(file, "utf8"));
}

function sha256(data) {
    return crypto.createHash("sha256").update(data).digest("hex");
}

// Daty w danych mają postać RRRR, RRRR-MM albo RRRR-MM-DD.
function parseDate(value) {
    const text = String(value || "").trim();
    const m = text.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/);
    if (!m) return null;
    return new Date(Date.UTC(Number(m[1]), Number(m[2] || 1) - 1, Number(m[3] || 1)));
}

function monthsBetween(from, to) {
    return (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
}

function daysBetween(from, to) {
    return Math.floor((to - from) / 86400000);
}

function verifiedDate(status) {
    const m = String(status || "").match(/zweryfikowano_(\d{4}-\d{2}-\d{2})/);
    return m ? parseDate(m[1]) : null;
}

// Tekst strony bez skryptów, stylów i elementów zmiennych (formularze, liczniki).
function normalizePage(html) {
    const main = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html;
    return main
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<form[\s\S]*?<\/form>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

// Załączniki i dokumenty podlinkowane na stronie: nowy link = często nowe wydanie.
function extractDocumentLinks(html, baseUrl) {
    const links = new Map();
    const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(html))) {
        const href = m[1];
        if (!/\/attachment\/|\.pdf(\?|$)|\.zip(\?|$)|\.docx?(\?|$)/i.test(href)) continue;
        let url;
        try { url = new URL(href, baseUrl).href; } catch { continue; }
        const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        links.set(url, text || url);
    }
    return Object.fromEntries([...links].sort());
}

async function fetchSource(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
        const response = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: { "User-Agent": "KDR-AI-kontrola-aktualnosci/1.0 (+GitHub Actions)" }
        });
        const buffer = Buffer.from(await response.arrayBuffer());
        const type = response.headers.get("content-type") || "";
        return { ok: response.ok, status: response.status, buffer, type, finalUrl: response.url };
    } finally {
        clearTimeout(timer);
    }
}

// ---------- dane ----------
const rejestr = readJson(P.rejestr);
const dokumenty = rejestr.dokumenty || rejestr;
const baza = readJson(P.baza).filter(item => item && item.id && item.wycofana !== true);
const stan = readJson(P.stan, { wersja: 1, zrodla: {}, strony: {} });
stan.zrodla ||= {};
stan.strony ||= {};
stan.pliki ||= {};

const ustalenia = [];
// priorytet: 1 = wysoki (pilne), 2 = średni, 3 = niski
function dodaj(priorytet, rodzaj, opis, szczegoly = {}) {
    ustalenia.push({ priorytet, rodzaj, opis, ...szczegoly });
}

const kartyWgDokumentu = new Map();
for (const karta of baza) {
    for (const ref of karta.dokumenty_zrodlowe || []) {
        if (!kartyWgDokumentu.has(ref.dokument_id)) kartyWgDokumentu.set(ref.dokument_id, []);
        kartyWgDokumentu.get(ref.dokument_id).push(karta.id);
    }
}

// ---------- A. spójność i wiek (tryb pełny) ----------
function kontrolaOffline() {
    for (const karta of baza) {
        const refs = karta.dokumenty_zrodlowe || [];
        const legacy = String(karta?.pelna_procedura?.plik || "").trim();

        if (!refs.length && !legacy && karta.zrodlo_dostepnosc === "niedostepne_publicznie") {
            dodaj(3, "Źródło niedostępne publicznie",
                `${karta.id} — dokumentu nie ma na gov.pl ani w repozytorium. Dołącz skan, gdy będzie dostępny.`,
                { obiekt: karta.id });
        } else if (!refs.length && !legacy) {
            dodaj(1, "Karta bez dokumentu źródłowego",
                `${karta.id} — w aplikacji pokazuje „plik niepodłączony”. Podłącz dokument źródłowy w rejestrze.`,
                { obiekt: karta.id });
        }

        for (const ref of refs) {
            if (!dokumenty[ref.dokument_id]) {
                dodaj(1, "Brak dokumentu w rejestrze",
                    `${karta.id} wskazuje „${ref.dokument_id}”, którego nie ma w rejestrze.`,
                    { obiekt: karta.id });
            }
        }

        const dataKarty = parseDate(karta.data_przegladu || karta.data_aktualizacji);
        if (!dataKarty) {
            dodaj(3, "Karta bez daty aktualizacji",
                `${karta.id} — uzupełnij \`data_aktualizacji\` albo \`data_przegladu\` po sprawdzeniu treści.`,
                { obiekt: karta.id });
        } else {
            const mies = monthsBetween(dataKarty, DZIS);
            if (mies >= progi.przeglad_karty_miesiecy) {
                dodaj(3, "Okresowy przegląd karty",
                    `${karta.id} — ostatni przegląd ${mies} mies. temu (próg: ${progi.przeglad_karty_miesiecy}). Porównaj treść z dokumentem źródłowym i wpisz \`data_przegladu\`.`,
                    { obiekt: karta.id });
            }

            for (const ref of refs) {
                const doc = dokumenty[ref.dokument_id];
                const dataDok = parseDate(doc?.data_wydania);
                // Karta starsza niż dokument → treść mogła nie uwzględnić wydania.
                if (doc && dataDok && parseDate(karta.data_aktualizacji) &&
                    parseDate(karta.data_aktualizacji) < dataDok) {
                    dodaj(2, "Karta starsza niż dokument źródłowy",
                        `${karta.id} (karta: ${karta.data_aktualizacji}) — dokument „${doc.tytul}” ma datę ${doc.data_wydania}. Sprawdź, czy karta uwzględnia to wydanie.`,
                        { obiekt: karta.id });
                }
            }
        }
    }

    for (const [id, doc] of Object.entries(dokumenty)) {
        const karty = kartyWgDokumentu.get(id) || [];
        const status = String(doc.aktualnosc_merytoryczna || "");

        if (!karty.length) {
            dodaj(3, "Dokument nieużywany", `${id} — żadna karta go nie wskazuje.`, { obiekt: id });
        }

        if (/wymaga|do_potwierdzenia|pomocniczy|zmiana_wykryta/i.test(status)) {
            dodaj(2, "Dokument oznaczony do weryfikacji",
                `${id} „${doc.tytul}” — status: \`${status}\`.`,
                { karty, obiekt: id });
        }

        if (doc.status_techniczny && doc.status_techniczny !== "aktywny") {
            dodaj(2, "Dokument nieaktywny technicznie", `${id} — status techniczny: ${doc.status_techniczny}.`, { karty });
        }

        const dataDok = parseDate(doc.data_wydania);
        const limitLat = progi.wiek_dokumentu_lat[doc.rodzaj] ?? progi.wiek_dokumentu_lat.domyslnie;
        if (dataDok && monthsBetween(dataDok, DZIS) >= limitLat * 12) {
            dodaj(2, "Dokument starszy niż próg",
                `${id} „${doc.tytul}” z ${doc.data_wydania} (próg ${limitLat} lat). Sprawdź, czy wydawca nie opublikował nowszego wydania.`,
                { karty, obiekt: id });
        } else if (!dataDok && doc.typ !== "url") {
            dodaj(3, "Dokument bez daty wydania", `${id} „${doc.tytul}” — brak daty wydania; trudno ocenić aktualność.`, { karty, obiekt: id });
        }

        if (doc.typ === "url") {
            const zweryf = verifiedDate(status);
            const dni = zweryf ? daysBetween(zweryf, DZIS) : null;
            if (dni === null || dni >= progi.weryfikacja_zrodla_url_dni) {
                dodaj(3, "Źródło internetowe do ponownej weryfikacji",
                    `${id} „${doc.tytul}” — ${dni === null ? "brak daty weryfikacji" : `zweryfikowano ${dni} dni temu`} (próg ${progi.weryfikacja_zrodla_url_dni} dni).`,
                    { karty, url: doc.plik, obiekt: id });
            }
        } else if (doc.sha256 && doc.plik && !BEZ_PLIKOW) {
            const plik = path.join(KATALOG, doc.plik);
            if (fs.existsSync(plik)) {
                const hash = sha256(fs.readFileSync(plik));
                if (hash !== doc.sha256) {
                    dodaj(1, "Plik PDF różni się od rejestru",
                        `${id} — suma SHA-256 pliku \`${doc.plik}\` nie zgadza się z rejestrem (plik podmieniony lub uszkodzony).`,
                        { karty });
                }
            } else {
                dodaj(1, "Brak pliku dokumentu", `${id} — w repozytorium nie ma pliku \`${doc.plik}\`.`, { karty });
            }
        }
    }
}

// ---------- B. zmiany źródeł online (oba tryby) ----------
async function kontrolaOnline() {
    const cele = [];

    for (const [id, doc] of Object.entries(dokumenty)) {
        if (doc.typ === "url" && /^https?:/i.test(doc.plik || "")) {
            cele.push({ klucz: id, grupa: "zrodla", url: doc.plik, opis: doc.tytul, karty: kartyWgDokumentu.get(id) || [] });
        }
    }
    for (const strona of config.obserwowane_strony || []) {
        const karty = baza
            .filter(k => (strona.dotyczy_kart || []).some(prefix => k.id.startsWith(prefix)))
            .map(k => k.id);
        cele.push({ klucz: strona.id, grupa: "strony", url: strona.url, opis: strona.opis, karty });
    }

    for (const cel of cele) {
        const poprzedni = stan[cel.grupa][cel.klucz];
        let wynik;
        try {
            wynik = await fetchSource(cel.url);
        } catch (error) {
            const przyczyna = error.name === "AbortError" ? "przekroczono czas 60 s" : (error.cause?.code || error.cause?.message || error.message);
            dodaj(2, "Źródło niedostępne", `${cel.opis} — błąd połączenia (${przyczyna}).`, { url: cel.url, karty: cel.karty });
            continue;
        }

        if (!wynik.ok) {
            dodaj(wynik.status === 404 || wynik.status === 410 ? 1 : 2, "Źródło niedostępne",
                `${cel.opis} — odpowiedź HTTP ${wynik.status}${wynik.status === 404 ? " (strona usunięta lub przeniesiona)" : ""}.`,
                { url: cel.url, karty: cel.karty });
            continue;
        }

        const isHtml = /html/i.test(wynik.type);
        const html = isHtml ? wynik.buffer.toString("utf8") : "";
        const odcisk = isHtml ? sha256(normalizePage(html)) : sha256(wynik.buffer);
        const linki = isHtml ? extractDocumentLinks(html, wynik.finalUrl || cel.url) : {};

        const nowy = {
            odcisk,
            linki,
            sprawdzono: DZIS_TXT,
            zmieniono: poprzedni?.zmieniono || DZIS_TXT
        };

        if (!poprzedni) {
            stan[cel.grupa][cel.klucz] = nowy;
            continue; // pierwszy pomiar — punkt odniesienia, bez zgłoszenia
        }

        const dodane = Object.keys(linki).filter(u => !(u in (poprzedni.linki || {})));
        const usuniete = Object.keys(poprzedni.linki || {}).filter(u => !(u in linki));

        if (dodane.length || usuniete.length) {
            const lista = [
                ...dodane.map(u => `nowy: [${linki[u]}](${u})`),
                ...usuniete.map(u => `usunięty: ${poprzedni.linki[u]}`)
            ].join("; ");
            dodaj(1, "Nowe lub usunięte dokumenty na stronie",
                `${cel.opis} — ${lista}. Możliwe nowe wydanie — sprawdź i zdecyduj o aktualizacji kart.`,
                { url: cel.url, karty: cel.karty });
            nowy.zmieniono = DZIS_TXT;
        } else if (odcisk !== poprzedni.odcisk) {
            dodaj(isHtml ? 2 : 1, isHtml ? "Zmieniona treść strony źródłowej" : "Zmieniony plik źródłowy",
                `${cel.opis} — treść różni się od pomiaru z ${poprzedni.zmieniono}. Przejrzyj zmiany.`,
                { url: cel.url, karty: cel.karty });
            nowy.zmieniono = DZIS_TXT;
        }

        stan[cel.grupa][cel.klucz] = nowy;
    }
}

// ---------- C. pliki w repozytorium a oryginały na stronach KG PSP ----------
// Nowa wersja pliku pod tym samym adresem = nowe wydanie (priorytet wysoki).
// W przeglądzie miesięcznym zgłaszana jest też trwała różnica między plikiem
// w repozytorium a oryginałem (np. skan albo inne wydanie), chyba że w
// konfiguracji ustawiono "akceptuj_roznice": true.
async function kontrolaPlikowOficjalnych() {
    for (const wpis of config.pliki_oficjalne?.lista || []) {
        const doc = dokumenty[wpis.dokument_id];
        if (!doc) {
            dodaj(2, "Błędna konfiguracja", `pliki_oficjalne: brak dokumentu „${wpis.dokument_id}” w rejestrze.`);
            continue;
        }
        const karty = kartyWgDokumentu.get(wpis.dokument_id) || [];
        let wynik;
        try {
            wynik = await fetchSource(wpis.url);
        } catch (error) {
            const przyczyna = error.name === "AbortError" ? "przekroczono czas 60 s" : (error.cause?.code || error.cause?.message || error.message);
            dodaj(2, "Źródło niedostępne", `Oryginał „${doc.tytul}” — błąd połączenia (${przyczyna}).`, { url: wpis.url, karty });
            continue;
        }
        if (!wynik.ok) {
            dodaj(1, "Źródło niedostępne",
                `Oryginał „${doc.tytul}” — odpowiedź HTTP ${wynik.status}. KG PSP mogła usunąć plik lub zastąpić go nowym wydaniem — sprawdź stronę ${wpis.strona || ""}.`,
                { url: wpis.url, karty });
            continue;
        }
        const odcisk = sha256(wynik.buffer);
        const poprzedni = stan.pliki[wpis.dokument_id];

        if (poprzedni && poprzedni.odcisk !== odcisk) {
            dodaj(1, "Nowa wersja pliku na stronie KG PSP",
                `„${doc.tytul}” — plik pod oficjalnym adresem różni się od pomiaru z ${poprzedni.sprawdzono}. Prawdopodobnie nowe wydanie: porównaj z kartami i zaktualizuj dokument w repozytorium.`,
                { url: wpis.url, karty, obiekt: wpis.dokument_id });
        }

        if (TRYB === "pelny" && doc.sha256 && odcisk !== doc.sha256 && !wpis.akceptuj_roznice) {
            dodaj(2, "Plik w repozytorium różni się od oryginału KG PSP",
                `„${doc.tytul}” (\`${doc.plik}\`) nie jest identyczny z plikiem na stronie KG PSP. Może to być skan, inne wydanie albo wersja wyodrębniona. Porównaj; jeśli różnica jest właściwa, ustaw w konfiguracji \`"akceptuj_roznice": true\`.`,
                { url: wpis.url, karty, obiekt: wpis.dokument_id });
        }

        stan.pliki[wpis.dokument_id] = {
            odcisk,
            rozmiar: wynik.buffer.length,
            sprawdzono: DZIS_TXT,
            zmieniono: poprzedni && poprzedni.odcisk === odcisk ? poprzedni.zmieniono : DZIS_TXT
        };
    }
}

// ---------- raport ----------
function raport() {
    const nazwyPriorytetu = { 1: "Wysoki — wymaga decyzji", 2: "Średni — do sprawdzenia", 3: "Niski — porządkowe" };
    const posortowane = [...ustalenia].sort((a, b) => a.priorytet - b.priorytet || a.rodzaj.localeCompare(b.rodzaj, "pl"));
    const liczba = p => ustalenia.filter(u => u.priorytet === p).length;

    const linie = [
        `# Kontrola aktualności KDR AI — ${DZIS_TXT}`,
        "",
        `Tryb: **${TRYB === "pelny" ? "pełny przegląd" : "tygodniowy (zmiany źródeł online)"}**${BEZ_SIECI ? ", bez sprawdzania sieci" : ""}. ` +
        `Karty: ${baza.length}, dokumenty w rejestrze: ${Object.keys(dokumenty).length}.`,
        "",
        `| Priorytet | Liczba |`,
        `| --- | --- |`,
        `| Wysoki | ${liczba(1)} |`,
        `| Średni | ${liczba(2)} |`,
        `| Niski | ${liczba(3)} |`,
        ""
    ];

    if (!ustalenia.length) {
        linie.push("Brak ustaleń. Źródła bez zmian.");
    }

    for (const p of [1, 2, 3]) {
        const grupa = posortowane.filter(u => u.priorytet === p);
        if (!grupa.length) continue;
        linie.push(`## ${nazwyPriorytetu[p]}`, "");
        // Priorytet niski: jedna linia na rodzaj (lista obiektów), aby
        // raport pozostał czytelny przy dziesiątkach drobnych pozycji.
        if (p === 3) {
            const wgRodzaju = new Map();
            for (const u of grupa) {
                if (!wgRodzaju.has(u.rodzaj)) wgRodzaju.set(u.rodzaj, []);
                wgRodzaju.get(u.rodzaj).push(u.obiekt || u.opis);
            }
            for (const [rodzajNiski, obiekty] of wgRodzaju) {
                linie.push(`- [ ] **${rodzajNiski}** (${obiekty.length}): ${obiekty.join(", ")}`);
            }
            linie.push("");
            continue;
        }
        let rodzaj = "";
        for (const u of grupa) {
            if (u.rodzaj !== rodzaj) {
                rodzaj = u.rodzaj;
                linie.push(`**${rodzaj}**`, "");
            }
            const pokazKarty = u.karty?.length && !(u.karty.length === 1 && u.opis.includes(u.karty[0]));
            const karty = pokazKarty ? ` _Karty (${u.karty.length}): ${u.karty.slice(0, 8).join(", ")}${u.karty.length > 8 ? ", …" : ""}_` : "";
            const url = u.url && !u.opis.includes(u.url) ? ` [źródło](${u.url})` : "";
            linie.push(`- [ ] ${u.opis}${url}${karty}`);
        }
        linie.push("");
    }

    linie.push(
        "## Jak zamknąć ustalenie",
        "",
        "1. Sprawdź źródło i porównaj z treścią karty.",
        "2. Jeśli treść wymaga zmiany — popraw kartę w `procedury/` i wpisz `data_aktualizacji`.",
        "3. Jeśli treść jest aktualna — wpisz w karcie `\"data_przegladu\": \"RRRR-MM-DD\"`, a w rejestrze dokumentu `\"aktualnosc_merytoryczna\": \"zweryfikowano_RRRR-MM-DD\"`.",
        "4. Zaznacz punkt w tym zgłoszeniu. Zamknij zgłoszenie, gdy wszystkie wysokie i średnie punkty są rozstrzygnięte.",
        "",
        "Automat niczego nie zmienia w treści kart — każda zmiana wymaga Twojej decyzji."
    );
    return linie.join("\n");
}

// ---------- uruchomienie ----------
if (TRYB === "pelny") kontrolaOffline();
if (!BEZ_SIECI) {
    await kontrolaOnline();
    await kontrolaPlikowOficjalnych();
}

const tresc = raport();
fs.mkdirSync(path.dirname(path.join(KATALOG, P.raport)), { recursive: true });
fs.writeFileSync(path.join(KATALOG, P.raport), tresc + "\n");

// Treść zgłoszenia na GitHubie ma limit 65 536 znaków. Dłuższy raport jest
// skracany, a pełna wersja zostaje w repozytorium (kontrola/raport.md).
const LIMIT_ZGLOSZENIA = 60000;
const zgloszenie = tresc.length <= LIMIT_ZGLOSZENIA
    ? tresc
    : tresc.slice(0, LIMIT_ZGLOSZENIA).replace(/\n[^\n]*$/, "") +
      "\n\n_Raport skrócony — pełna wersja: `kontrola/raport.md` w repozytorium._\n";
fs.writeFileSync(path.join(KATALOG, "kontrola/zgloszenie.md"), zgloszenie + "\n");
fs.writeFileSync(path.join(KATALOG, P.stan), JSON.stringify(stan, null, 2) + "\n");

// Zgłoszenie (Issue): tryb pełny — zawsze gdy są ustalenia; tygodniowy — tylko przy priorytecie 1–2.
const doZgloszenia = TRYB === "pelny"
    ? ustalenia.length > 0
    : ustalenia.some(u => u.priorytet <= 2);
const tytul = TRYB === "pelny"
    ? `Przegląd miesięczny aktualności — ${DZIS_TXT}`
    : `Zmiany w źródłach — ${DZIS_TXT}`;

if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `do_zgloszenia=${doZgloszenia}\ntytul=${tytul}\n`);
}

const p1 = ustalenia.filter(u => u.priorytet === 1).length;
console.log(`Kontrola (${TRYB}): ${ustalenia.length} ustaleń, w tym wysokich: ${p1}. Raport: ${P.raport}`);
