import { unzipSync } from "fflate";

import { type Coordinates, haversine, projectOnShape, type ShapePoint } from "../utils/geometry.js";

export type { ShapePoint };

const TIME_ZONE = "Europe/Paris";

export type RouteDirection = { directionId: number; headsigns: string[] };

/** Un arrêt dans l'itinéraire d'une ligne : son quai (stopId) et son nom normalisé. */
export type OrderedStop = { stopId: string; name: string };

/**
 * Un arrêt dans l'horaire théorique d'un trip : sa position (stop_sequence), son quai, et son
 * abscisse curviligne sur la shape de la course, en kilomètres. Celle-ci vaut `NaN` lorsqu'on n'a
 * pas su la déterminer — le GTFS ne la déclare pas et l'arrêt n'a pas de coordonnées.
 */
export type TripStop = { stopSequence: number; stopId: string; distance: number };

/**
 * Ce que le GTFS statique dit d'une course : sa ligne, son sens, sa destination affichée, son tracé,
 * et le service qui décide des jours où elle circule.
 */
export type TripMeta = {
	routeId: string;
	directionId: number;
	headsign: string;
	shapeId: string;
	serviceId: string;
};

/**
 * Le calendrier hebdomadaire d'un service : les jours qu'il dessert et l'enveloppe de dates où cela
 * vaut. Les exceptions datées de `calendar_dates.txt` s'y ajoutent ou s'en retranchent ensuite (cf.
 * {@link StaticGtfs.calendarExceptions}).
 */
export type ServiceCalendar = {
	/** Jours desservis, du lundi (indice 0) au dimanche (indice 6), dans l'ordre des colonnes du GTFS. */
	weekdays: boolean[];
	/** Bornes INCLUSES de validité, au format `AAAAMMJJ` du GTFS. Vides si le fichier ne les déclare pas. */
	startDate: string;
	endDate: string;
};

/** Journée ajoutée par une exception de `calendar_dates.txt`. */
export const SERVICE_ADDED = 1;
/** Journée retirée par une exception de `calendar_dates.txt`. */
export const SERVICE_REMOVED = 2;

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
	/**
	 * tripId → départ théorique du premier arrêt, en secondes depuis minuit de la journée de service
	 * — donc au-delà de 86 400 pour une course qui déborde sur le lendemain, comme le GTFS l'écrit.
	 * {@link departureEpoch} en fait un instant.
	 */
	tripDepartures: Map<string, number>;
	/**
	 * tripId → arrivée théorique au dernier arrêt, dans la même unité que {@link tripDepartures}. Les
	 * deux bornent la course, seule façon de dire si elle circule à un instant donné : son départ ne
	 * suffit pas, une course partie il y a vingt minutes dessert encore des arrêts.
	 */
	tripArrivals: Map<string, number>;
	/**
	 * serviceId → jours desservis et enveloppe de validité (`calendar.txt`). Vide lorsque le GTFS ne
	 * publie pas ce fichier — celui du réseau ne porte que des exceptions datées, qui suffisent alors
	 * à elles seules.
	 */
	calendars: Map<string, ServiceCalendar>;
	/**
	 * serviceId → date `AAAAMMJJ` → {@link SERVICE_ADDED} ou {@link SERVICE_REMOVED}, depuis
	 * `calendar_dates.txt`.
	 */
	calendarExceptions: Map<string, Map<string, number>>;
	/**
	 * serviceId → courses de ce service : l'index inverse de `trips.txt`, qui permet de parcourir une
	 * journée de service sans balayer les seize mille courses du GTFS.
	 */
	serviceTrips: Map<string, string[]>;
	/** stopId → libellé de l'arrêt, tel que le GTFS l'écrit. */
	stopNames: Map<string, string>;
	/** stopId → coordonnées du quai. */
	stopCoordinates: Map<string, Coordinates>;
	/** tripId → ligne, sens et destination théoriques (pour contrôler ce qu'annonce le SAE). */
	trips: Map<string, TripMeta>;
	/** shapeId → tracé de la course, chaque point portant son abscisse curviligne en kilomètres. */
	shapes: Map<string, ShapePoint[]>;
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
		tripDepartures: new Map(),
		tripArrivals: new Map(),
		calendars: new Map(),
		calendarExceptions: new Map(),
		serviceTrips: new Map(),
		stopNames: new Map(),
		stopCoordinates: new Map(),
		trips: new Map(),
		shapes: new Map(),
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
			filter: (file) =>
				file.name === "stops.txt" ||
				file.name === "trips.txt" ||
				file.name === "stop_times.txt" ||
				file.name === "shapes.txt" ||
				file.name === "calendar.txt" ||
				file.name === "calendar_dates.txt",
		});

		if (!files["stops.txt"] || !files["trips.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt or trips.txt.");
			return { data: empty, signature: null };
		}

		const decoder = new TextDecoder();
		const { stopNameIndex, stopKeyIndex, idToName, coordinates } = buildStops(decoder.decode(files["stops.txt"]));
		const { routeDirections, tripMeta, serviceTrips } = buildTrips(decoder.decode(files["trips.txt"]));
		const calendars = files["calendar.txt"] ? buildCalendar(decoder.decode(files["calendar.txt"])) : new Map();
		const calendarExceptions = files["calendar_dates.txt"]
			? buildCalendarDates(decoder.decode(files["calendar_dates.txt"]))
			: new Map();
		const { shapes, scales } = files["shapes.txt"]
			? buildShapes(decoder.decode(files["shapes.txt"]))
			: { shapes: new Map<string, ShapePoint[]>(), scales: new Map<string, number>() };
		const { routeStopSequences, tripStopSequences, tripDepartures, tripArrivals, projectedStops } = files[
			"stop_times.txt"
		]
			? buildSequences(decoder.decode(files["stop_times.txt"]), tripMeta, idToName, shapes, scales, coordinates)
			: {
					routeStopSequences: new Map(),
					tripStopSequences: new Map(),
					tripDepartures: new Map(),
					tripArrivals: new Map(),
					projectedStops: 0,
				};

		// Le GTFS actuel déclare une abscisse pour chaque arrêt : qu'il faille en projeter signale une
		// source qui a changé de forme, et un repli nettement plus fragile sur les shapes à boucle.
		if (projectedStops > 0) {
			console.warn(`⚠ ${projectedStops} stop distances projected onto shapes (missing shape_dist_traveled).`);
		}

		let itineraries = 0;
		for (const directions of routeStopSequences.values()) {
			for (const variants of directions.values()) itineraries += variants.length;
		}

		console.log(
			`✓ Loaded ${stopNameIndex.size} stop names, ${routeDirections.size} routes, ${itineraries} route itineraries, ${tripStopSequences.size} trip schedules, ${shapes.size} shapes, ${serviceTrips.size} services from GTFS.`,
		);
		return {
			data: {
				stopNameIndex,
				stopKeyIndex,
				routeDirections,
				routeStopSequences,
				tripStopSequences,
				tripDepartures,
				tripArrivals,
				calendars,
				calendarExceptions,
				serviceTrips,
				stopNames: idToName,
				stopCoordinates: coordinates,
				trips: tripMeta,
				shapes,
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
	coordinates: Map<string, Coordinates>;
} {
	const stopNameIndex = new Map<string, Set<string>>();
	const stopKeyIndex = new Map<string, Set<string>>();
	const idToName = new Map<string, string>();
	const coordinates = new Map<string, Coordinates>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { stopNameIndex, stopKeyIndex, idToName, coordinates };

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	const parentCol = header.indexOf("parent_station");
	const latitudeCol = header.indexOf("stop_lat");
	const longitudeCol = header.indexOf("stop_lon");
	if (idCol === -1 || nameCol === -1) return { stopNameIndex, stopKeyIndex, idToName, coordinates };

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

		const latitude = latitudeCol === -1 ? Number.NaN : Number.parseFloat(row[latitudeCol] ?? "");
		const longitude = longitudeCol === -1 ? Number.NaN : Number.parseFloat(row[longitudeCol] ?? "");
		if (!Number.isNaN(latitude) && !Number.isNaN(longitude)) coordinates.set(stopId, { latitude, longitude });

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

	return { stopNameIndex, stopKeyIndex, idToName, coordinates };
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
	serviceTrips: Map<string, string[]>;
} {
	const tripMeta = new Map<string, TripMeta>();
	const serviceTrips = new Map<string, string[]>();
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeDirections: new Map(), tripMeta, serviceTrips };

	const routeCol = header.indexOf("route_id");
	const tripCol = header.indexOf("trip_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	const shapeCol = header.indexOf("shape_id");
	const serviceCol = header.indexOf("service_id");
	if (routeCol === -1 || directionCol === -1) return { routeDirections: new Map(), tripMeta, serviceTrips };

	// routeId → directionId → set de headsigns
	const grouped = new Map<string, Map<number, Set<string>>>();

	for (const row of rows) {
		const routeId = row[routeCol];
		if (!routeId) continue;

		const directionId = Number.parseInt(row[directionCol] ?? "", 10);
		if (Number.isNaN(directionId)) continue;

		const tripId = tripCol === -1 ? "" : (row[tripCol] ?? "");
		const headsign = headsignCol === -1 ? "" : (row[headsignCol] ?? "");
		const shapeId = shapeCol === -1 ? "" : (row[shapeCol] ?? "");
		const serviceId = serviceCol === -1 ? "" : (row[serviceCol] ?? "");
		if (tripId) {
			tripMeta.set(tripId, { routeId, directionId, headsign, shapeId, serviceId });
			if (serviceId) {
				let trips = serviceTrips.get(serviceId);
				if (trips === undefined) {
					trips = [];
					serviceTrips.set(serviceId, trips);
				}
				trips.push(tripId);
			}
		}

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

	return { routeDirections, tripMeta, serviceTrips };
}

/** Colonnes des jours de `calendar.txt`, du lundi au dimanche — l'ordre de {@link ServiceCalendar.weekdays}. */
const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Calendriers hebdomadaires de `calendar.txt`. Un fichier qui ne déclare pas toutes ses colonnes de
 * jours est ignoré en bloc : un service dont on ne saurait pas quels jours il dessert vaudrait moins
 * que pas de service du tout, puisqu'il ferait circuler des courses n'importe quand.
 */
function buildCalendar(csv: string): Map<string, ServiceCalendar> {
	const calendars = new Map<string, ServiceCalendar>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return calendars;

	const idCol = header.indexOf("service_id");
	const startCol = header.indexOf("start_date");
	const endCol = header.indexOf("end_date");
	const dayCols = DAY_COLUMNS.map((day) => header.indexOf(day));
	if (idCol === -1 || dayCols.some((col) => col === -1)) return calendars;

	for (const row of rows) {
		const serviceId = row[idCol];
		if (!serviceId) continue;

		calendars.set(serviceId, {
			weekdays: dayCols.map((col) => row[col] === "1"),
			startDate: startCol === -1 ? "" : (row[startCol] ?? ""),
			endDate: endCol === -1 ? "" : (row[endCol] ?? ""),
		});
	}

	return calendars;
}

/**
 * Exceptions datées de `calendar_dates.txt`, indexées par service puis par date. Le GTFS du réseau
 * n'emploie que ce fichier — chaque journée de chaque service y est énumérée en ajout — mais rien
 * n'oblige son producteur à s'y tenir, et un GTFS classique s'en sert au contraire pour amender un
 * calendrier hebdomadaire.
 */
function buildCalendarDates(csv: string): Map<string, Map<string, number>> {
	const exceptions = new Map<string, Map<string, number>>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return exceptions;

	const idCol = header.indexOf("service_id");
	const dateCol = header.indexOf("date");
	const typeCol = header.indexOf("exception_type");
	if (idCol === -1 || dateCol === -1 || typeCol === -1) return exceptions;

	for (const row of rows) {
		const serviceId = row[idCol];
		const date = row[dateCol];
		const exceptionType = Number.parseInt(row[typeCol] ?? "", 10);
		if (!serviceId || !date || Number.isNaN(exceptionType)) continue;

		let dates = exceptions.get(serviceId);
		if (dates === undefined) {
			dates = new Map();
			exceptions.set(serviceId, dates);
		}
		dates.set(date, exceptionType);
	}

	return exceptions;
}

/** Une ligne de shapes.txt, avant tri et cumul des distances. */
type ShapeRow = Coordinates & { sequence: number; declared: number };

/**
 * À partir de shapes.txt, construit les tracés des courses et, pour chacun, le facteur qui ramène
 * les `shape_dist_traveled` du GTFS à nos kilomètres.
 *
 * L'abscisse curviligne de chaque point est **recalculée** plutôt que reprise : le GTFS ne spécifie
 * pas l'unité de `shape_dist_traveled`, que le producteur choisit (ici des kilomètres, mais rien ne
 * l'y oblige et rien n'annoncerait un changement). Le rapport entre la longueur déclarée du tracé et
 * celle qu'on vient de mesurer donne cette unité, et le même facteur remet ensuite à l'échelle les
 * abscisses des arrêts (cf. {@link buildSequences}). `NaN` lorsque le tracé n'en déclare aucune.
 */
function buildShapes(csv: string): { shapes: Map<string, ShapePoint[]>; scales: Map<string, number> } {
	const shapes = new Map<string, ShapePoint[]>();
	const scales = new Map<string, number>();

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { shapes, scales };

	const idCol = header.indexOf("shape_id");
	const latitudeCol = header.indexOf("shape_pt_lat");
	const longitudeCol = header.indexOf("shape_pt_lon");
	const seqCol = header.indexOf("shape_pt_sequence");
	const distCol = header.indexOf("shape_dist_traveled");
	if (idCol === -1 || latitudeCol === -1 || longitudeCol === -1 || seqCol === -1) return { shapes, scales };

	const collected = new Map<string, ShapeRow[]>();

	for (const row of rows) {
		const shapeId = row[idCol];
		if (!shapeId) continue;

		const latitude = Number.parseFloat(row[latitudeCol] ?? "");
		const longitude = Number.parseFloat(row[longitudeCol] ?? "");
		const sequence = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(latitude) || Number.isNaN(longitude) || Number.isNaN(sequence)) continue;

		let points = collected.get(shapeId);
		if (points === undefined) {
			points = [];
			collected.set(shapeId, points);
		}
		points.push({
			latitude,
			longitude,
			sequence,
			declared: distCol === -1 ? Number.NaN : Number.parseFloat(row[distCol] ?? ""),
		});
	}

	for (const [shapeId, unordered] of collected) {
		unordered.sort((a, b) => a.sequence - b.sequence);
		// Un point seul ne fait pas un segment : rien à y projeter.
		if (unordered.length < 2) continue;

		const points: ShapePoint[] = [];
		let distance = 0;
		let previous: ShapeRow | undefined;

		for (const point of unordered) {
			if (previous !== undefined) distance += haversine(previous, point);
			points.push({ latitude: point.latitude, longitude: point.longitude, distance });
			previous = point;
		}

		shapes.set(shapeId, points);

		const declared = (unordered.at(-1) as ShapeRow).declared;
		scales.set(shapeId, Number.isFinite(declared) && declared > 0 ? distance / declared : Number.NaN);
	}

	return { shapes, scales };
}

/**
 * À partir de stop_times, construit :
 *  - `routeStopSequences` : par (routeId, directionId), les itinéraires distincts empruntés — sert
 *    à étendre les plages « de X à Y » ;
 *  - `tripStopSequences` : par tripId, l'horaire théorique ordonné — sert à réinsérer un arrêt
 *    supprimé absent du GTFS-RT, avec son stop_sequence, et à situer un véhicule sur sa course ;
 *  - `tripDepartures` et `tripArrivals` : par tripId, le départ du premier arrêt et l'arrivée au
 *    dernier — le premier sert à distinguer le véhicule qui attend son départ de celui que la source
 *    a perdu (cf. `useVehicleRegistry`), les deux ensemble à dire quelles courses circulent dans
 *    l'heure à venir (cf. `scheduledTripUpdates`).
 *
 * Chaque arrêt y reçoit son abscisse curviligne sur la shape de la course, remise à l'échelle de nos
 * kilomètres par le facteur qu'a déduit {@link buildShapes}. `projectedStops` compte les arrêts pour
 * lesquels il a fallu se rabattre sur une projection des coordonnées, faute d'abscisse déclarée.
 */
function buildSequences(
	csv: string,
	tripMeta: Map<string, TripMeta>,
	idToName: Map<string, string>,
	shapes: Map<string, ShapePoint[]>,
	scales: Map<string, number>,
	stopCoordinates: Map<string, Coordinates>,
): {
	routeStopSequences: Map<string, Map<number, OrderedStop[][]>>;
	tripStopSequences: Map<string, TripStop[]>;
	tripDepartures: Map<string, number>;
	tripArrivals: Map<string, number>;
	projectedStops: number;
} {
	const routeStopSequences = new Map<string, Map<number, OrderedStop[][]>>();
	const tripStopSequences = new Map<string, TripStop[]>();
	const tripDepartures = new Map<string, number>();
	const tripArrivals = new Map<string, number>();
	let projectedStops = 0;

	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return { routeStopSequences, tripStopSequences, tripDepartures, tripArrivals, projectedStops };

	const tripCol = header.indexOf("trip_id");
	const stopCol = header.indexOf("stop_id");
	const seqCol = header.indexOf("stop_sequence");
	const distCol = header.indexOf("shape_dist_traveled");
	const timeCol = header.indexOf("departure_time");
	const arrivalCol = header.indexOf("arrival_time");
	if (tripCol === -1 || stopCol === -1 || seqCol === -1) {
		return { routeStopSequences, tripStopSequences, tripDepartures, tripArrivals, projectedStops };
	}

	// Rangs des arrêts qui ont fourni le départ et l'arrivée retenus pour chaque course : le fichier
	// n'est pas tenu d'être ordonné, et seuls le premier et le dernier arrêt bornent la course.
	const departureSequences = new Map<string, number>();
	const arrivalSequences = new Map<string, number>();

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

		const departure = timeCol === -1 ? Number.NaN : parseServiceTime(row[timeCol] ?? "");
		if (Number.isFinite(departure) && stopSequence < (departureSequences.get(tripId) ?? Number.POSITIVE_INFINITY)) {
			departureSequences.set(tripId, stopSequence);
			tripDepartures.set(tripId, departure);
		}

		const arrival = arrivalCol === -1 ? Number.NaN : parseServiceTime(row[arrivalCol] ?? "");
		if (Number.isFinite(arrival) && stopSequence > (arrivalSequences.get(tripId) ?? Number.NEGATIVE_INFINITY)) {
			arrivalSequences.set(tripId, stopSequence);
			tripArrivals.set(tripId, arrival);
		}

		let stops = perTrip.get(tripId);
		if (stops === undefined) {
			stops = [];
			perTrip.set(tripId, stops);
		}
		// Abscisse encore dans l'unité du producteur : elle est remise à l'échelle plus bas, une fois
		// la course rattachée à sa shape.
		stops.push({
			stopSequence,
			stopId,
			distance: distCol === -1 ? Number.NaN : Number.parseFloat(row[distCol] ?? ""),
		});
	}

	// Itinéraires distincts de chaque (route, sens), dédupliqués par suite de quais.
	const seen = new Map<string, Set<string>>();
	const variants = new Map<string, OrderedStop[][]>();
	// Un même quai revient sur toutes les courses d'une shape : sa projection ne se calcule qu'une fois.
	const projected = new Map<string, number>();

	for (const [tripId, stops] of perTrip) {
		stops.sort((a, b) => a.stopSequence - b.stopSequence);
		tripStopSequences.set(tripId, stops);

		const meta = tripMeta.get(tripId);
		if (meta === undefined) continue;

		const shape = shapes.get(meta.shapeId);
		const scale = scales.get(meta.shapeId) ?? Number.NaN;
		for (const stop of stops) {
			if (Number.isFinite(scale) && Number.isFinite(stop.distance)) {
				stop.distance *= scale;
				continue;
			}

			stop.distance =
				shape === undefined ? Number.NaN : projectStop(shape, meta.shapeId, stop.stopId, stopCoordinates, projected);
			if (Number.isFinite(stop.distance)) projectedStops += 1;
		}

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

	return { routeStopSequences, tripStopSequences, tripDepartures, tripArrivals, projectedStops };
}

/**
 * Abscisse d'un quai sur une shape, obtenue en y projetant ses coordonnées. Repli employé quand
 * stop_times.txt ne déclare pas d'abscisse exploitable : il est nettement moins sûr que la valeur
 * déclarée, un quai desservi deux fois par une shape à boucle s'y projetant indifféremment sur l'un
 * ou l'autre passage.
 */
function projectStop(
	shape: ShapePoint[],
	shapeId: string,
	stopId: string,
	stopCoordinates: Map<string, Coordinates>,
	cache: Map<string, number>,
): number {
	const key = `${shapeId}|${stopId}`;
	const cached = cache.get(key);
	if (cached !== undefined) return cached;

	const coordinates = stopCoordinates.get(stopId);
	const distance =
		coordinates === undefined ? Number.NaN : (projectOnShape(shape, coordinates)?.distance ?? Number.NaN);

	cache.set(key, distance);
	return distance;
}

/**
 * Un horaire GTFS (« 07:04:00 ») en secondes depuis minuit de la journée de service, ou `NaN` s'il
 * ne s'écrit pas ainsi. Les heures au-delà de 24 sont légitimes et se conservent telles quelles :
 * « 25:10:00 » est une course de la journée de la veille qui déborde sur le lendemain.
 */
function parseServiceTime(value: string): number {
	const parts = value.split(":");
	if (parts.length < 2) return Number.NaN;

	const hours = Number.parseInt(parts[0] ?? "", 10);
	const minutes = Number.parseInt(parts[1] ?? "", 10);
	const seconds = parts.length > 2 ? Number.parseInt(parts[2] ?? "", 10) : 0;
	if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.NaN;

	return hours * 3600 + minutes * 60 + seconds;
}

/**
 * L'instant, en secondes epoch, où tombe un horaire théorique donné en secondes depuis minuit.
 *
 * Le GTFS-RT ne dit pas à quelle journée de service appartient la course qu'il annonce, et l'horaire
 * seul ne le dit pas davantage : un départ à « 25:10:00 » et un départ à « 01:10:00 » nomment le
 * même instant à une journée près. On retient donc, des trois journées de service qui peuvent
 * l'englober, celle qui place le départ au plus près de maintenant — la seule qui puisse concerner
 * un véhicule en service à cet instant.
 *
 * Les bornes se calculent avec `startOfDay` et non par tranches de 86 400 s : les jours de
 * changement d'heure ne durent pas vingt-quatre heures, et un départ y serait décalé d'une heure.
 */
export function departureEpoch(secondsFromMidnight: number, nowSeconds: number): number {
	const today = Temporal.Now.zonedDateTimeISO(TIME_ZONE).startOfDay();

	let closest = Number.NaN;
	for (const days of [-1, 0, 1]) {
		const departure = Math.floor(today.add({ days }).epochMilliseconds / 1000) + secondsFromMidnight;
		if (Number.isNaN(closest) || Math.abs(departure - nowSeconds) < Math.abs(closest - nowSeconds)) {
			closest = departure;
		}
	}

	return closest;
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
