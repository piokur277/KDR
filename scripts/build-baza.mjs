import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const proceduresDir = path.join(root, "procedury");
const documentsDir = path.join(root, "dokumenty");
const aggregatePath = path.join(proceduresDir, "baza.json");
const manifestPath = path.join(proceduresDir, "manifest.json");
const reportPath = path.join(proceduresDir, "raport-walidacji.json");
const registryPath = path.join(documentsDir, "rejestr-dokumentow.json");
const documentReportPath = path.join(documentsDir, "raport-rejestru.json");

function normalize(value) {
    return String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

async function walk(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await walk(fullPath));
            continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        if (["baza.json", "manifest.json", "raport-walidacji.json"].includes(entry.name)) continue;
        files.push(fullPath);
    }
    return files;
}

function validateProcedure(item, file) {
    for (const field of ["id", "prefix", "content", "slowo_kluczowe"]) {
        if (typeof item?.[field] !== "string" || !item[field].trim()) {
            throw new Error(`Brak lub nieprawidlowe pole ${field}: ${file}`);
        }
    }
    if (!Array.isArray(item.aliasy)) throw new Error(`Pole aliasy musi byc tablica: ${file}`);
    if (!Array.isArray(item.tagi_wspolne)) throw new Error(`Pole tagi_wspolne musi byc tablica: ${file}`);
    if (item.dokumenty_zrodlowe !== undefined && !Array.isArray(item.dokumenty_zrodlowe)) {
        throw new Error(`Pole dokumenty_zrodlowe musi byc tablica: ${file}`);
    }
    if (item.pelna_procedura !== undefined && (typeof item.pelna_procedura !== "object" || item.pelna_procedura === null)) {
        throw new Error(`Pole pelna_procedura musi byc obiektem: ${file}`);
    }
}

async function loadDocumentRegistry() {
    const parsed = JSON.parse(await fs.readFile(registryPath, "utf8"));
    const docs = parsed?.dokumenty;
    if (!docs || typeof docs !== "object" || Array.isArray(docs)) {
        throw new Error("rejestr-dokumentow.json nie zawiera obiektu dokumenty");
    }

    for (const [id, doc] of Object.entries(docs)) {
        if (!doc || typeof doc !== "object") throw new Error(`Nieprawidlowy dokument ${id}`);
        if (doc.id !== id) throw new Error(`Id dokumentu nie zgadza sie z kluczem: ${id}`);
        for (const field of ["tytul", "plik", "status_techniczny"]) {
            if (typeof doc[field] !== "string" || !doc[field].trim()) {
                throw new Error(`Brak pola ${field} w dokumencie ${id}`);
            }
        }
        if (!Number.isInteger(doc.liczba_stron) || doc.liczba_stron < 1) {
            throw new Error(`Nieprawidlowa liczba stron dokumentu ${id}`);
        }
        if (!/^https?:\/\//i.test(doc.plik)) {
            const filePath = path.join(root, doc.plik);
            const bytes = await fs.readFile(filePath);
            if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
                throw new Error(`Plik dokumentu ${id} nie jest prawidlowym PDF: ${doc.plik}`);
            }
        }
    }
    return { raw: parsed, docs };
}

const { raw: registryRaw, docs: documentRegistry } = await loadDocumentRegistry();
const files = (await walk(proceduresDir)).sort((a, b) => a.localeCompare(b, "pl"));
const procedures = [];
const manifestFiles = [];
const idOwners = new Map();
const directOwners = new Map();
const tagOwners = new Map();
const documentUsage = new Map(Object.keys(documentRegistry).map(id => [id, []]));

for (const file of files) {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
        validateProcedure(item, file);
        if (idOwners.has(item.id)) throw new Error(`Powtorzony identyfikator ${item.id}: ${idOwners.get(item.id)} oraz ${file}`);
        idOwners.set(item.id, file);

        for (const term of [item.slowo_kluczowe, ...(item.aliasy || [])]) {
            const key = normalize(term);
            if (!key) continue;
            if (directOwners.has(key)) throw new Error(`Powtorzone haslo bezposrednie "${term}": ${directOwners.get(key)} oraz ${item.id}`);
            directOwners.set(key, item.id);
        }

        for (const tag of item.tagi_wspolne || []) {
            const key = normalize(tag);
            if (!key) continue;
            if (!tagOwners.has(key)) tagOwners.set(key, []);
            tagOwners.get(key).push(item.id);
        }

        for (const ref of item.dokumenty_zrodlowe || []) {
            if (!ref || typeof ref !== "object") throw new Error(`Nieprawidlowe odwolanie do dokumentu w ${item.id}`);
            const documentId = String(ref.dokument_id || "").trim();
            if (!documentId || !documentRegistry[documentId]) {
                throw new Error(`Procedura ${item.id} wskazuje nieistniejacy dokument: ${documentId || "(brak id)"}`);
            }
            const doc = documentRegistry[documentId];
            if (doc.status_techniczny !== "aktywny") {
                throw new Error(`Procedura ${item.id} wskazuje dokument nieaktywny: ${documentId}`);
            }
            const page = Number(ref.strona);
            if (!Number.isInteger(page) || page < 1 || page > doc.liczba_stron) {
                throw new Error(`Procedura ${item.id} wskazuje nieprawidlowa strone ${ref.strona} dokumentu ${documentId} (1-${doc.liczba_stron})`);
            }
            documentUsage.get(documentId).push({ procedure_id: item.id, strona: page, sekcja: ref.sekcja || "" });
        }

        const legacy = item.pelna_procedura || {};
        const legacyFile = String(legacy.plik || "").trim();
        if (legacyFile && !/^https?:\/\//i.test(legacyFile)) {
            try { await fs.access(path.join(root, legacyFile)); }
            catch { throw new Error(`Brak pelnego dokumentu ${legacyFile} dla ${item.id}`); }
        }

        procedures.push(item);
    }
    manifestFiles.push(path.relative(root, file).split(path.sep).join("/"));
}

for (const [term, owner] of directOwners.entries()) {
    const tagMatches = tagOwners.get(term) || [];
    if (tagMatches.length > 1) throw new Error(`Haslo bezposrednie "${term}" koliduje z tagiem wspolnym w procedurach: ${tagMatches.join(", ")}. Wlasciciel hasla: ${owner}`);
}

const sharedTags = [...tagOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([tag, owners]) => ({ tag, count: owners.length, ids: owners }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag, "pl"));

const documentSummary = Object.entries(documentRegistry).map(([id, doc]) => ({
    id,
    tytul: doc.tytul,
    status_techniczny: doc.status_techniczny,
    liczba_stron: doc.liczba_stron,
    liczba_powiazan: documentUsage.get(id)?.length || 0,
    powiazania: documentUsage.get(id) || []
}));

await fs.writeFile(aggregatePath, JSON.stringify(procedures, null, 2) + "\n", "utf8");
await fs.writeFile(manifestPath, JSON.stringify({ generated_at: new Date().toISOString(), count: procedures.length, files: manifestFiles }, null, 2) + "\n", "utf8");
await fs.writeFile(reportPath, JSON.stringify({ generated_at: new Date().toISOString(), procedure_count: procedures.length, unique_direct_terms: directOwners.size, linked_procedure_count: procedures.filter(p => (p.dokumenty_zrodlowe || []).length).length, document_count: Object.keys(documentRegistry).length, shared_tags: sharedTags }, null, 2) + "\n", "utf8");
await fs.writeFile(documentReportPath, JSON.stringify({ generated_at: new Date().toISOString(), registry_version: registryRaw.wersja_rejestru || "", document_count: documentSummary.length, active_document_count: documentSummary.filter(d => d.status_techniczny === "aktywny").length, linked_document_count: documentSummary.filter(d => d.liczba_powiazan > 0).length, unlinked_documents: documentSummary.filter(d => d.liczba_powiazan === 0).map(d => d.id), documents: documentSummary }, null, 2) + "\n", "utf8");

console.log(`Baza gotowa: ${procedures.length} procedur, ${directOwners.size} unikalnych hasel bezposrednich, ${documentSummary.length} dokumentow w rejestrze.`);
