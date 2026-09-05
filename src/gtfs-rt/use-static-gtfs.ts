import { unzipSync } from "fflate";

export type RouteDirection = { directionId: number; headsigns: string[] };

/** Un arrêt dans l'itinéraire d'une ligne : son quai (stopId) et son nom normalisé. */
export type OrderedStop = { stopId: string; name: string };

/** Un arrêt dans l'horaire théorique d'un trip : sa position (stop_sequence) et son quai. */
export type TripStop = { stopSequence: number; stopId: string };

/** Ce que le GTFS statique dit d'une course : sa ligne, son sens, sa destination affichée. */
export type TripMeta = { routeId: string; directionId: number; headsign: string };

export type StaticGtfs = {
	/** Nom d'arrêt normalisé → identifiants des quais (enfants) portant ce nom. */
	stopNameIndex: Map<string, Set<string>>;
	/** Clé tolérante ({@link stopNameKey}) → noms normalisés qui la produisent (clés de `stopNameIndex`). */
	stopKeyIndex: Map<string, Set<string>>;
	/** routeId → directions desservies avec leurs terminus (headsigns). */
	routeDirections: Map<string, RouteDirection[]>;
	/**
	 * routeId → directionId → itinéraires ordonnés des arrêts (pour étendre les plages « de X à Y »).
	 * Plusieurs par sens : une ligne à branches (le métro vers Technopôle ou Georges Braque) ne se
	 * résume pas à un seul parcours, et une plage citée sur une branche resterait introuvable.
	 */
	routeStopSequences: Map<string, Map<number, OrderedStop[][]>>;
	/** tripId → horaire théorique ordonné (pour réinsérer un arrêt supprimé absent du GTFS-RT). */
	tripStopSequences: Map<string, TripStop[]>;
	/** stopId → libellé de l'arrêt, tel que le GTFS l'écrit. */
	stopNames: Map<string, string>;
	/** tripId → ligne, sens et destination théoriques (pour contrôler ce qu'annonce le SAE). */
	trips: Map<string, TripMeta>;
};

let currentInterval: NodeJS.Timeout | undefined;

export async function useStaticGtfs(url: string, checkInterval: number, onReload?: () => void) {
	const loaded = await loadGtfs(url);
	const resource = {
		data: loaded.data,
		importedAt: Temporal.Now.instant(),
	};
	// Signature de la version chargée (ETag/Last-Modified) : sert à détecter un changement sans
	// retélécharger l'archive à chaque vérification.
	let signature = loaded.signature;

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		// Vérification légère par HEAD : on ne retélécharge que si la version publiée a changé.
		const remote = await fetchSignature(url);
		if (remote === null || remote === signature) return; // inchangé, ou signature indisponible → on garde

		const next = await loadGtfs(url);
		if (next.data.stopNameIndex.size === 0) return; // chargement échoué → on garde l'ancien
		resource.data = next.data;
		resource.importedAt = Temporal.Now.instant();
		signature = next.signature;
		console.log("✓ Static GTFS updated (new version published).");
		onReload?.();
	}, checkInterval);

	return resource;
}

/** Normalise un nom d'arrêt : minuscules, sans accents, alphanumérique compacté. */
export function normalizeStopName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

/** Mots-outils sans valeur discriminante, ignorés par {@link stopNameTokens}. */
const FILLER_WORDS = new Set(["a", "au", "aux", "d", "de", "des", "du", "en", "et", "l", "la", "le", "les", "sur"]);

/** Abréviations courantes de l'info trafic, développées avant comparaison. */
const ABBREVIATIONS = new Map([
	["st", "saint"],
	["ste", "sainte"],
	["av", "avenue"],
	["bd", "boulevard"],
	["pl", "place"],
	["pce", "place"],
]);

/**
 * Découpe un nom d'arrêt en mots comparables : mots-outils retirés, abréviations développées,
 * pluriels et zéros initiaux rabotés. Absorbe les approximations de la source, qui n'écrit pas
 * toujours les noms comme le GTFS (« Champs de Mars » et « Champ de Mars » donnent tous deux
 * `["champ", "mar"]`).
 */
export function stopNameTokens(name: string): string[] {
	const tokens: string[] = [];
	for (const word of mergeInitials(normalizeStopName(name).split(" "))) {
		if (!word || FILLER_WORDS.has(word)) continue;
		tokens.push(stem(unpadNumber(ABBREVIATIONS.get(word) ?? word)));
	}
	return tokens;
}

/**
 * Recolle les initiales que la ponctuation a détachées : la source et le GTFS n'écrivent pas le même
 * sigle de la même façon (« J.F. Kennedy » pour « JF Kennedy », « Z.A. La Maine » pour « ZA La
 * Maine »), et sans cela le nom compte un mot de plus que le libellé — il ne s'y retrouve donc jamais.
 * Seules les suites d'AU MOINS deux lettres isolées sont fusionnées : une lettre seule est le plus
 * souvent un mot-outil (« rue de l'Hôtel de Ville ») ou une initiale de prénom, que le GTFS écrit
 * lui aussi détachée.
 */
function mergeInitials(words: string[]): string[] {
	const merged: string[] = [];

	for (let index = 0; index < words.length; index += 1) {
		let end = index;
		while (end < words.length && /^[a-z]$/.test(words[end] as string)) end += 1;

		if (end - index >= 2) {
			merged.push(words.slice(index, end).join(""));
			index = end - 1;
		} else {
			merged.push(words[index] as string);
		}
	}

	return merged;
}

/** Clé de rapprochement tolérant d'un nom d'arrêt. Vide si le nom ne porte aucun mot discriminant. */
export function stopNameKey(name: string): string {
	return stopNameTokens(name).join(" ");
}

/** Rabote les marques de pluriel : « champs » → « champ ». Les mots courts sont laissés intacts. */
function stem(word: string): string {
	return word.length > 3 ? word.replace(/[sx]$/, "") : word;
}

/**
 * Rabote les zéros initiaux d'un nombre : l'info trafic reprend parfois le code interne de l'arrêt
 * plutôt que son libellé (« 08-Mai » pour « Rue du 8-Mai »). Sans cela, les mots « 08 » et « 8 »,
 * trop courts pour la tolérance d'une faute, ne se rapprochent jamais.
 */
function unpadNumber(word: string): string {
	return /^\d+$/.test(word) ? word.replace(/^0+(?=\d)/, "") : word;
}

/**
 * Rapproche un nom court d'un libellé plus long (tous deux normalisés). Vrai si `name` apparaît comme
 * une sous-séquence contiguë de mots de `within` — gère les libellés abrégés de l'info trafic
 * (« Piscine » → « Piscine de Bihorel », « Michelet » → « Collège Michelet ») et le rapprochement d'une
 * destination citée avec le terminus d'une ligne. La comparaison porte sur les tokens
 * ({@link stopNameTokens}), à une faute de frappe près par mot : l'appel se fait dans un contexte
 * restreint (les arrêts d'une ligne, les terminus d'une ligne), où le risque de confusion est faible.
 *
 * Le rapprochement est volontairement à SENS UNIQUE : un nom plus précis que le libellé ne matche pas.
 * Les mots en trop désignent presque toujours un autre lieu — « Pôle Multimodal-Cotoni » n'est pas
 * l'arrêt « Pôle Multimodal ».
 */
export function stopNameMatches(name: string, within: string): boolean {
	if (name === within) return true;
	return containsRun(stopNameTokens(name), stopNameTokens(within));
}

/** Vrai si `needle` apparaît comme une suite contiguë de mots dans `haystack`. */
function containsRun(needle: string[], haystack: string[]): boolean {
	if (needle.length === 0 || needle.length > haystack.length) return false;

	for (let i = 0; i <= haystack.length - needle.length; i += 1) {
		let match = true;
		for (let j = 0; j < needle.length; j += 1) {
			if (!tokenMatches(haystack[i + j] as string, needle[j] as string)) {
				match = false;
				break;
			}
		}
		if (match) return true;
	}
	return false;
}

/** Longueur à partir de laquelle un mot tolère deux fautes plutôt qu'une. */
const LONG_WORD_LENGTH = 9;

/**
 * Vrai si deux mots sont identiques, ou à une faute près. La tolérance est réservée aux mots assez
 * longs : sur les courts, une faute d'écart confond des noms bel et bien distincts. Les mots vraiment
 * longs en tolèrent deux — la source écrit parfois un nom de travers (« Sente d'Houppeville » pour
 * « Sente d'Houdeville ») — sans qu'aucun couple d'arrêts du réseau ne s'y confonde.
 */
function tokenMatches(a: string, b: string): boolean {
	if (a === b) return true;
	if (a.length < 5 && b.length < 5) return false;
	return withinEdits(a, b, Math.min(a.length, b.length) >= LONG_WORD_LENGTH ? 2 : 1);
}

/** Vrai si au plus `max` insertions, suppressions ou substitutions suffisent à passer de `a` à `b`. */
function withinEdits(a: string, b: string, max: number): boolean {
	if (Math.abs(a.length - b.length) > max) return false;

	// Levenshtein ligne à ligne, abandonné dès qu'une ligne entière dépasse le seuil.
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i += 1) {
		const current = [i];
		let best = i;
		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			const distance = Math.min(
				(previous[j] as number) + 1,
				(current[j - 1] as number) + 1,
				(previous[j - 1] as number) + cost,
			);
			current[j] = distance;
			if (distance < best) best = distance;
		}
		if (best > max) return false;
		previous = current;
	}

	return (previous[b.length] as number) <= max;
}

// ---

/** Version publiée du GTFS (ETag de préférence, sinon Last-Modified). `null` si aucun en-tête exploitable. */
function signatureOf(response: { headers: Headers }): string | null {
	return response.headers.get("etag") ?? response.headers.get("last-modified");
}

/** Requête HEAD légère : renvoie la signature de la version publiée, ou `null` si indisponible. */
async function fetchSignature(url: string): Promise<string | null> {
	try {
		const response = await fetch(url, { method: "HEAD" });
		if (!response.ok) return null;
		return signatureOf(response);
	} catch {
		return null;
	}
}

async function loadGtfs(url: string): Promise<{ data: StaticGtfs; signature: string | null }> {
	console.log("➔ Fetching static GTFS.");

	const empty: StaticGtfs = {
		stopNameIndex: new Map(),
		stopKeyIndex: new Map(),
		routeDirections: new Map(),
		routeStopSequences: new Map(),
		tripStopSequences: new Map(),
		stopNames: new Map(),
		trips: new Map(),
	};

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch static GTFS (HTTP ${response.status}).`);
			return { data: empty, signature: null };
		}

		const signature = signatureOf(response);
		const buffer = new Uint8Array(await response.arrayBuffer());
		const files = unzipSync(buffer, {
			filter: (file) => file.name === "stops.txt" || file.name === "trips.txt" || file.name === "stop_times.txt",
		});

		if (!files["stops.txt"] || !files["trips.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt or trips.txt.");
			return { data: empty, signature: null };
		}

		const decoder = new TextDecoder();
		const { stopNameIndex, stopKeyIndex, idToName } = buildStops(decoder.decode(files["stops.txt"]));
		const { routeDirections, tripMeta } = buildTrips(decoder.decode(files["trips.txt"]));
		const { routeStopSequences, tripStopSequences } = files["stop_times.txt"]
			? buildSequences(decoder.decode(files["stop_times.txt"]), tripMeta, idToName)
			: { routeStopSequences: new Map(), tripStopSequences: new Map() };

		let itineraries = 0;
		for (const directions of routeStopSequences.values()) {
			for (const variants of directions.values()) itineraries += variants.length;
		}

		console.log(
			`✓ Loaded ${stopNameIndex.size} stop names, ${routeDirections.size} routes, ${itineraries} route itineraries, ${tripStopSequences.size} trip schedules from GTFS.`,
		);
		return {
			data: {
				stopNameIndex,
				stopKeyIndex,
				routeDirections,
				routeStopSequences,
				tripStopSequences,
				stopNames: idToName,
				trips: tripMeta,
			},
			signature,
		};
	} catch (cause) {
		console.error("✘ Failed to load static GTFS!", cause);
		return { data: empty, signature: null };
	}
}

function buildStops(csv: string): {
	stopNameIndex: Map<string, Set<string>>;
	stopKeyIndex: Map<string, Set<string>>;
	idToName: Map<string, string>;
} {
	const stopNameIndex = new Map<string, Set<string>>();
	const stopKeyIndex = new Map<string, Set<string>>();
	const idToName = new Map<string, string>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { stopNameIndex, stopKeyIndex, idToName };

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	const parentCol = header.indexOf("parent_station");
	if (idCol === -1 || nameCol === -1) return { stopNameIndex, stopKeyIndex, idToName };

	const stationNames = new Map<string, string>();
	const stationStopIds = new Map<string, Set<string>>();

	for (const row of rows) {
		const stopId = row[idCol];
		const stopName = row[nameCol];
		if (!stopId || !stopName) continue;

		// Les stations parentes ne sont pas des quais : on les met de côté pour n'indexer que leur
		// nom (cf. plus bas), jamais leur identifiant.
		if (stopId.startsWith("TCAR:ST:")) {
			stationNames.set(stopId, stopName);
			continue;
		}

		idToName.set(stopId, stopName);

		const parent = parentCol === -1 ? "" : (row[parentCol] ?? "");
		if (parent) {
			let siblings = stationStopIds.get(parent);
			if (siblings === undefined) {
				siblings = new Set();
				stationStopIds.set(parent, siblings);
			}
			siblings.add(stopId);
		}

		indexStopName(stopNameIndex, stopKeyIndex, stopName, [stopId]);
	}

	// Le nom du pôle diffère parfois de celui de ses quais (« Pôle Multimodal d'Oissel » pour des
	// quais « Pôle Multimodal », « Duclair Centre » pour « Centre ») : l'info trafic emploie l'un ou
	// l'autre. On rattache donc le nom de la station à ses quais — sauf s'il désigne déjà un arrêt
	// bien réel, auquel cas on ne touche à rien.
	for (const [stationId, stationName] of stationNames) {
		const key = normalizeStopName(stationName);
		if (!key || stopNameIndex.has(key)) continue;

		const stopIds = stationStopIds.get(stationId);
		if (stopIds === undefined) continue;

		indexStopName(stopNameIndex, stopKeyIndex, stationName, stopIds);
	}

	return { stopNameIndex, stopKeyIndex, idToName };
}

function indexStopName(
	stopNameIndex: Map<string, Set<string>>,
	stopKeyIndex: Map<string, Set<string>>,
	stopName: string,
	stopIds: Iterable<string>,
) {
	const key = normalizeStopName(stopName);
	if (!key) return;

	let ids = stopNameIndex.get(key);
	if (ids === undefined) {
		ids = new Set();
		stopNameIndex.set(key, ids);
	}
	for (const stopId of stopIds) ids.add(stopId);

	const fuzzyKey = stopNameKey(stopName);
	if (!fuzzyKey) return;

	let names = stopKeyIndex.get(fuzzyKey);
	if (names === undefined) {
		names = new Set();
		stopKeyIndex.set(fuzzyKey, names);
	}
	names.add(key);
}

function buildTrips(csv: string): {
	routeDirections: Map<string, RouteDirection[]>;
	tripMeta: Map<string, TripMeta>;
} {
	const tripMeta = new Map<string, TripMeta>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeDirections: new Map(), tripMeta };

	const routeCol = header.indexOf("route_id");
	const tripCol = header.indexOf("trip_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	if (routeCol === -1 || directionCol === -1) return { routeDirections: new Map(), tripMeta };

	// routeId → directionId → set de headsigns
	const grouped = new Map<string, Map<number, Set<string>>>();

	for (const row of rows) {
		const routeId = row[routeCol];
		if (!routeId) continue;

		const directionId = Number.parseInt(row[directionCol] ?? "", 10);
		if (Number.isNaN(directionId)) continue;

		const tripId = tripCol === -1 ? "" : (row[tripCol] ?? "");
		const headsign = headsignCol === -1 ? "" : (row[headsignCol] ?? "");
		if (tripId) tripMeta.set(tripId, { routeId, directionId, headsign });

		let directions = grouped.get(routeId);
		if (directions === undefined) {
			directions = new Map();
			grouped.set(routeId, directions);
		}

		let headsigns = directions.get(directionId);
		if (headsigns === undefined) {
			headsigns = new Set();
			directions.set(directionId, headsigns);
		}
		if (headsign) headsigns.add(headsign);
	}

	const routeDirections = new Map<string, RouteDirection[]>();
	for (const [routeId, directions] of grouped) {
		routeDirections.set(
			routeId,
			[...directions.entries()].map(([directionId, headsigns]) => ({ directionId, headsigns: [...headsigns] })),
		);
	}

	return { routeDirections, tripMeta };
}

/**
 * À partir de stop_times, construit :
 *  - `routeStopSequences` : par (routeId, directionId), les itinéraires distincts empruntés — sert
 *    à étendre les plages « de X à Y » ;
 *  - `tripStopSequences` : par tripId, l'horaire théorique ordonné — sert à réinsérer un arrêt
 *    supprimé absent du GTFS-RT, avec son stop_sequence.
 */
function buildSequences(
	csv: string,
	tripMeta: Map<string, TripMeta>,
	idToName: Map<string, string>,
): { routeStopSequences: Map<string, Map<number, OrderedStop[][]>>; tripStopSequences: Map<string, TripStop[]> } {
	const routeStopSequences = new Map<string, Map<number, OrderedStop[][]>>();
	const tripStopSequences = new Map<string, TripStop[]>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeStopSequences, tripStopSequences };

	const tripCol = header.indexOf("trip_id");
	const stopCol = header.indexOf("stop_id");
	const seqCol = header.indexOf("stop_sequence");
	if (tripCol === -1 || stopCol === -1 || seqCol === -1) return { routeStopSequences, tripStopSequences };

	// Regroupe les arrêts par trip (uniquement les trips connus).
	const perTrip = new Map<string, TripStop[]>();
	for (const row of rows) {
		const tripId = row[tripCol];
		const stopId = row[stopCol];
		if (!tripId || !stopId) continue;
		const meta = tripMeta.get(tripId);
		if (meta === undefined) continue;
		const stopSequence = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(stopSequence)) continue;

		let stops = perTrip.get(tripId);
		if (stops === undefined) {
			stops = [];
			perTrip.set(tripId, stops);
		}
		stops.push({ stopSequence, stopId });
	}

	// Itinéraires distincts de chaque (route, sens), dédupliqués par suite de quais.
	const seen = new Map<string, Set<string>>();
	const variants = new Map<string, OrderedStop[][]>();

	for (const [tripId, stops] of perTrip) {
		stops.sort((a, b) => a.stopSequence - b.stopSequence);
		tripStopSequences.set(tripId, stops);

		const meta = tripMeta.get(tripId);
		if (meta === undefined) continue;
		const key = `${meta.routeId}:${meta.directionId}`;

		let signatures = seen.get(key);
		if (signatures === undefined) {
			signatures = new Set();
			seen.set(key, signatures);
		}
		const signature = stops.map(({ stopId }) => stopId).join(">");
		if (signatures.has(signature)) continue;
		signatures.add(signature);

		const ordered = stops.map(({ stopId }) => ({ stopId, name: normalizeStopName(idToName.get(stopId) ?? "") }));
		let list = variants.get(key);
		if (list === undefined) {
			list = [];
			variants.set(key, list);
		}
		list.push(ordered);
	}

	for (const [key, list] of variants) {
		const [routeId, direction] = splitSequenceKey(key);
		const directionId = Number.parseInt(direction, 10);
		if (Number.isNaN(directionId)) continue;

		let directions = routeStopSequences.get(routeId);
		if (directions === undefined) {
			directions = new Map();
			routeStopSequences.set(routeId, directions);
		}
		directions.set(directionId, maximalVariants(list));
	}

	return { routeStopSequences, tripStopSequences };
}

/** Sépare `routeId:directionId` — le routeId porte lui-même des « : » (« TCAR:90 »). */
function splitSequenceKey(key: string): [string, string] {
	const colon = key.lastIndexOf(":");
	return [key.slice(0, colon), key.slice(colon + 1)];
}

/**
 * Ne garde que les itinéraires qui ne sont pas déjà contenus dans un plus long : un service partiel
 * (« Boulingrin > Saint-Sever ») n'apporte rien face au parcours complet de sa branche, alors que
 * deux branches distinctes se conservent l'une l'autre. Les listes restent ainsi courtes (une à deux
 * entrées par sens, le plus souvent une seule).
 */
function maximalVariants(list: OrderedStop[][]): OrderedStop[][] {
	const sorted = [...list].sort((a, b) => b.length - a.length);

	const kept: OrderedStop[][] = [];
	for (const variant of sorted) {
		if (!kept.some((candidate) => isSubsequence(variant, candidate))) kept.push(variant);
	}
	return kept;
}

/** Vrai si tous les quais de `needle` apparaissent dans `haystack`, dans le même ordre. */
function isSubsequence(needle: OrderedStop[], haystack: OrderedStop[]): boolean {
	let index = 0;
	for (const stop of haystack) {
		if (index < needle.length && (needle[index] as OrderedStop).stopId === stop.stopId) index += 1;
	}
	return index === needle.length;
}

/** Parseur CSV minimal gérant les champs entre guillemets. */
function* parseCsv(csv: string): Generator<string[]> {
	for (const line of csv.split("\n")) {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (trimmed.length === 0) continue;
		yield parseCsvLine(trimmed);
	}
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			out.push(current);
			current = "";
		} else {
			current += char;
		}
	}

	out.push(current);
	return out;
}
