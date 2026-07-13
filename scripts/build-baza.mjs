import { promises as fs } from "node:fs";
import path from "node:path";

const root = process.cwd();
const proceduresDir = path.join(root, "procedury");
const aggregatePath = path.join(proceduresDir, "baza.json");
const manifestPath = path.join(proceduresDir, "manifest.json");
const reportPath = path.join(proceduresDir, "raport-walidacji.json");

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

        if ([
            "baza.json",
            "manifest.json",
            "raport-walidacji.json"
        ].includes(entry.name)) {
            continue;
        }

        files.push(fullPath);
    }

    return files;
}

function validateProcedure(item, file) {
    const requiredTextFields = [
        "id",
        "prefix",
        "content",
        "slowo_kluczowe"
    ];

    for (const field of requiredTextFields) {
        if (
            typeof item?.[field] !== "string" ||
            !item[field].trim()
        ) {
            throw new Error(
                `Brak lub nieprawidlowe pole ${field}: ${file}`
            );
        }
    }

    if (!Array.isArray(item.aliasy)) {
        throw new Error(`Pole aliasy musi byc tablica: ${file}`);
    }

    if (!Array.isArray(item.tagi_wspolne)) {
        throw new Error(
            `Pole tagi_wspolne musi byc tablica: ${file}`
        );
    }

    if (
        item.pelna_procedura !== undefined &&
        (
            typeof item.pelna_procedura !== "object" ||
            item.pelna_procedura === null
        )
    ) {
        throw new Error(
            `Pole pelna_procedura musi byc obiektem: ${file}`
        );
    }
}

const files = (await walk(proceduresDir))
    .sort((a, b) => a.localeCompare(b, "pl"));

const procedures = [];
const manifestFiles = [];

const idOwners = new Map();
const directOwners = new Map();
const tagOwners = new Map();

for (const file of files) {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
        validateProcedure(item, file);

        if (idOwners.has(item.id)) {
            throw new Error(
                `Powtorzony identyfikator ${item.id}: ` +
                `${idOwners.get(item.id)} oraz ${file}`
            );
        }

        idOwners.set(item.id, file);

        const directTerms = [
            item.slowo_kluczowe,
            ...(item.aliasy || [])
        ];

        for (const term of directTerms) {
            const key = normalize(term);
            if (!key) continue;

            if (directOwners.has(key)) {
                throw new Error(
                    `Powtorzone haslo bezposrednie "${term}": ` +
                    `${directOwners.get(key)} oraz ${item.id}`
                );
            }

            directOwners.set(key, item.id);
        }

        for (const tag of item.tagi_wspolne || []) {
            const key = normalize(tag);
            if (!key) continue;

            if (!tagOwners.has(key)) {
                tagOwners.set(key, []);
            }

            tagOwners.get(key).push(item.id);
        }

        const fullDocument = item.pelna_procedura || {};
        const documentFile = String(
            fullDocument.plik || ""
        ).trim();

        if (documentFile && !/^https?:\/\//i.test(documentFile)) {
            const fullDocumentPath = path.join(root, documentFile);

            try {
                await fs.access(fullDocumentPath);
            } catch {
                throw new Error(
                    `Brak pelnego dokumentu ${documentFile} dla ${item.id}`
                );
            }
        }

        procedures.push(item);
    }

    manifestFiles.push(
        path.relative(root, file).split(path.sep).join("/")
    );
}

for (const [term, owner] of directOwners.entries()) {
    const tagMatches = tagOwners.get(term) || [];

    if (tagMatches.length > 1) {
        throw new Error(
            `Haslo bezposrednie "${term}" koliduje z tagiem wspolnym ` +
            `w procedurach: ${tagMatches.join(", ")}. ` +
            `Wlasciciel hasla: ${owner}`
        );
    }
}

const sharedTags = [...tagOwners.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([tag, owners]) => ({
        tag,
        count: owners.length,
        ids: owners
    }))
    .sort((a, b) =>
        b.count - a.count ||
        a.tag.localeCompare(b.tag, "pl")
    );

await fs.writeFile(
    aggregatePath,
    JSON.stringify(procedures, null, 2) + "\n",
    "utf8"
);

await fs.writeFile(
    manifestPath,
    JSON.stringify(
        {
            generated_at: new Date().toISOString(),
            count: procedures.length,
            files: manifestFiles
        },
        null,
        2
    ) + "\n",
    "utf8"
);

await fs.writeFile(
    reportPath,
    JSON.stringify(
        {
            generated_at: new Date().toISOString(),
            procedure_count: procedures.length,
            unique_direct_terms: directOwners.size,
            shared_tags: sharedTags
        },
        null,
        2
    ) + "\n",
    "utf8"
);

console.log(
    `Baza gotowa: ${procedures.length} procedur, ` +
    `${directOwners.size} unikalnych hasel bezposrednich.`
);
