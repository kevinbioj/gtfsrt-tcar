import { type Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import type { AlertScope, AlertScopeIndex } from "../gtfs-rt/use-service-alerts.js";
import { normalizeStopName, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import { sanitizeHtml } from "../utils/sanitize-html.js";
import { ADMIN_PAGE } from "./admin-page.js";
import { deduceBounds, overlappingSegments } from "./bounds.js";
import { countSelectableTrips } from "./build-entities.js";
import { type DetourInput, type DetourSegment, type DetourStore, detourKey } from "./store.js";

/**
 * Nombre de quais que la recherche d'arrêts renvoie au plus. Un libellé court — « gare » — en touche
 * des dizaines, et la liste cesse d'être lisible bien avant d'être longue.
 */
const STOP_SEARCH_LIMIT = 50;

/** Bornes larges du réseau, qui n'écartent qu'une coordonnée manifestement fautive. */
const LATITUDE_RANGE = [48, 51] as const;
const LONGITUDE_RANGE = [-1, 3] as const;

export type AdminDependencies = {
	username: string;
	password: string;
	store: DetourStore;
	gtfs: { data: StaticGtfs };
	serviceAlerts: { alertScopes: AlertScopeIndex };
	/** Réassemble les entités du feed, pour qu'un enregistrement se voie sans attendre le relevé suivant. */
	rebuild: () => void;
};

/**
 * L'interface de déclaration des déviations, et l'API qu'elle consomme.
 *
 * Le sous-routeur est monté sous `/admin` et s'ouvre par son authentification : tout ce qui suit est
 * en accès restreint, y compris la page elle-même — elle porte les textes des infos trafic et la
 * géographie du réseau, rien de secret, mais rien qui ait à traîner non plus.
 */
export function adminRoutes(deps: AdminDependencies): Hono {
	const admin = new Hono();
	admin.use(basicAuth({ username: deps.username, password: deps.password }));

	admin.get("/", (c) => c.html(ADMIN_PAGE));

	admin.get("/api/detours", (c) => {
		const scopes = [...deps.serviceAlerts.alertScopes.values()].sort(compareScopes);
		return c.json(scopes.map((scope) => summarize(scope, deps)));
	});

	/**
	 * Les arrêts désignables, du GTFS comme de la base provisoire, dans une seule liste. C'est la même
	 * chose du point de vue d'une déviation — un endroit où le véhicule s'arrête — et les séparer
	 * obligerait à savoir d'avance dans laquelle des deux chercher.
	 *
	 * La recherche passe par `normalizeStopName` : on cherche « champ de mars » sans se soucier des
	 * accents ni de la casse, comme le fait déjà le rapprochement des noms d'info trafic.
	 */
	admin.get("/api/stops", (c) => {
		const query = normalizeStopName(c.req.query("q") ?? "");
		if (query.length < 2) return c.json([]);

		const gtfs = deps.gtfs.data;
		const matches: { stopId: string; name: string; latitude: number; longitude: number; provisional: boolean }[] = [];

		// Les arrêts provisoires passent devant : ils sont peu nombreux, et c'est précisément eux qu'on
		// cherche quand on en réemploie un.
		for (const stop of deps.store.provisionalStops.values()) {
			if (normalizeStopName(stop.name).includes(query)) matches.push({ ...stop, provisional: true });
		}

		for (const [stopId, name] of gtfs.stopNames) {
			if (matches.length >= STOP_SEARCH_LIMIT) break;
			if (!normalizeStopName(name).includes(query)) continue;

			const coordinates = gtfs.stopCoordinates.get(stopId);
			// Un quai sans coordonnées ne se pose pas sur la carte : il n'a rien à faire dans la liste.
			if (coordinates === undefined) continue;

			matches.push({ stopId, name, ...coordinates, provisional: false });
		}

		return matches.length === 0 ? c.json([]) : c.json(matches);
	});

	// La base des arrêts provisoires. Un arrêt y vit indépendamment des déviations qui le désignent :
	// le même point de report sert souvent aux deux sens, et parfois à deux infos trafic successives.
	admin.post("/api/provisional-stops", async (c) => {
		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const { name, latitude, longitude } = parsed;
		return c.json(deps.store.createProvisionalStop(name, latitude, longitude, Math.floor(Date.now() / 1000)));
	});

	admin.put("/api/provisional-stops/:stopId", async (c) => {
		const stopId = c.req.param("stopId");
		const parsed = await parseProvisionalStop(c);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const { name, latitude, longitude } = parsed;
		if (!deps.store.updateProvisionalStop(stopId, name, latitude, longitude)) {
			return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);
		}

		// Le libellé ou la position d'un arrêt publié viennent de changer : le feed doit suivre.
		deps.rebuild();
		return c.json(deps.store.provisionalStops.get(stopId));
	});

	admin.delete("/api/provisional-stops/:stopId", (c) => {
		if (!deps.store.deleteProvisionalStop(c.req.param("stopId"))) {
			return c.json({ code: 409, message: "Arrêt inconnu, ou encore désigné par une déviation." }, 409);
		}

		return c.json({ code: 200, message: "Arrêt provisoire supprimé." });
	});

	admin.get("/api/detours/:key", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		return c.json(detail(scope, deps));
	});

	/**
	 * Combien de courses ces bornes-là modifieraient, sans rien enregistrer. L'interface l'interroge dès
	 * qu'on change une borne : avec plusieurs tronçons, un compte figé au chargement de la page dirait
	 * n'importe quoi, et c'est précisément le chiffre qui dit si le tronçon sortira du feed.
	 */
	admin.get("/api/detours/:key/trip-count", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		const startStopId = c.req.query("start") ?? null;
		const endStopId = c.req.query("end") ?? null;
		return c.json({ matchingTrips: countMatchingTrips({ startStopId, endStopId }, scope, deps) });
	});

	admin.put("/api/detours/:key", async (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const parsed = parseInput(body, scope, deps.gtfs.data, deps.store);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		deps.store.save(scope.alertNumber, scope.routeId, scope.directionId, parsed.input, Math.floor(Date.now() / 1000));
		deps.rebuild();

		return c.json(detail(scope, deps));
	});

	admin.delete("/api/detours/:key", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		deps.store.remove(scope.alertNumber, scope.routeId, scope.directionId);
		deps.rebuild();

		return c.json({ code: 200, message: "Déclaration effacée." });
	});

	return admin;
}

// ---

/** En vigueur d'abord, puis par ligne et par sens : l'ordre dans lequel on veut les traiter. */
function compareScopes(a: AlertScope, b: AlertScope): number {
	if (a.active !== b.active) return a.active ? -1 : 1;
	if (a.routeId !== b.routeId) return a.routeId.localeCompare(b.routeId);
	if (a.directionId !== b.directionId) return a.directionId - b.directionId;
	return a.alertNumber.localeCompare(b.alertNumber);
}

/** Ce que la liste affiche d'une déviation, sans la géographie que seul le détail demande. */
function summarize(scope: AlertScope, deps: AdminDependencies) {
	const record = deps.store.records.get(detourKey(scope.alertNumber, scope.routeId, scope.directionId));
	const gtfs = deps.gtfs.data;
	const segments = record?.segments ?? [];

	return {
		key: scope.key,
		alertNumber: scope.alertNumber,
		routeId: scope.routeId,
		line: scope.routeId.split(":").at(-1),
		directionId: scope.directionId,
		headsigns:
			gtfs.routeDirections.get(scope.routeId)?.find((d) => d.directionId === scope.directionId)?.headsigns ?? [],
		headerText: scope.headerText,
		periods: scope.periods,
		active: scope.active,
		removedStopCount: scope.removedStopIds.size,
		declared: record !== undefined,
		segmentCount: segments.length,
		publishableSegments: segments.filter(isSegmentPublishable).length,
		stopCount: segments.reduce((total, segment) => total + segment.stops.length, 0),
		pathPointCount: segments.reduce((total, segment) => total + segment.path.length, 0),
		updatedAt: record?.updatedAt ?? null,
		publishable: segments.some(isSegmentPublishable),
	};
}

/**
 * Un tronçon n'entre dans le feed qu'avec ses deux bornes, et de quoi dire quelque chose : des arrêts
 * de substitution, un tracé, ou les deux. Le tracé seul suffit — le segment est alors supprimé sans
 * report, et c'est l'itinéraire qui porte toute l'information.
 */
function isSegmentPublishable(segment: DetourSegment): boolean {
	if (segment.startStopId === null || segment.endStopId === null) return false;
	return segment.stops.length > 0 || segment.path.length >= 2;
}

/**
 * Tout ce que la carte doit dessiner, en un seul aller-retour : les itinéraires de la ligne/sens avec
 * leurs arrêts, les tracés d'origine des courses, les bornes déduites, et les tronçons déclarés.
 *
 * Les tracés partent en polylignes encodées plutôt qu'en tableaux de coordonnées : une ligne de bus
 * en compte quelques milliers de points, et la page sait les décoder en quinze lignes.
 */
function detail(scope: AlertScope, deps: AdminDependencies) {
	const gtfs = deps.gtfs.data;
	const record = deps.store.records.get(detourKey(scope.alertNumber, scope.routeId, scope.directionId));

	const sequences = (gtfs.routeStopSequences.get(scope.routeId)?.get(scope.directionId) ?? []).map((sequence) =>
		sequence.map((stop) => ({
			stopId: stop.stopId,
			name: gtfs.stopNames.get(stop.stopId) ?? stop.name,
			...(gtfs.stopCoordinates.get(stop.stopId) ?? { latitude: null, longitude: null }),
			removed: scope.removedStopIds.has(stop.stopId),
		})),
	);

	// Les tracés d'origine des courses de la ligne/sens : ce sont eux que la déviation quitte, et il
	// faut les voir pour dessiner. Distincts seulement — plusieurs centaines de courses les partagent.
	const shapeIds = new Set<string>();
	for (const meta of gtfs.trips.values()) {
		if (meta.routeId === scope.routeId && meta.directionId === scope.directionId) shapeIds.add(meta.shapeId);
	}

	const shapes = [...shapeIds].flatMap((shapeId) => {
		const points = gtfs.shapes.get(shapeId);
		return points === undefined ? [] : [{ shapeId, encodedPolyline: encodePolyline(points) }];
	});

	// Rien n'a encore été déclaré : les suites d'arrêts supprimés du meilleur itinéraire proposent
	// d'emblée un tronçon chacune — c'est très exactement ce qu'il y a à dessiner.
	const boundsCandidates = deduceBounds(gtfs, scope.routeId, scope.directionId, scope.removedStopIds);
	const proposed = boundsCandidates.filter((bounds) => bounds.itinerary === boundsCandidates[0]?.itinerary);
	const segments =
		record !== undefined && record.segments.length > 0
			? record.segments
			: proposed.map((bounds) => ({
					startStopId: bounds.startStopId,
					endStopId: bounds.endStopId,
					propagatedDelay: 0,
					stops: [],
					path: [],
				}));

	return {
		...summarize(scope, deps),
		// Le texte d'une info trafic est du HTML : le flux amont reprend ce que le CMS de l'exploitant a
		// saisi, listes et plans de déviation compris. Il part nettoyé plutôt qu'échappé — la page
		// l'affiche tel quel, et n'a pas à savoir d'où il vient (cf. `sanitizeHtml`).
		descriptionHtml: sanitizeHtml(scope.descriptionText),
		removedStopIds: [...scope.removedStopIds],
		sequences,
		shapes,
		boundsCandidates,
		// Un arrêt n'est plus décrit dans la déclaration, seulement désigné : son libellé et sa position
		// se relisent à l'affichage, du GTFS ou de la base provisoire. Un arrêt provisoire déplacé depuis
		// une autre déviation se voit donc tout de suite, sans rien avoir à recopier.
		//
		// `matchingTrips` dit combien de courses ces bornes-là modifieraient. Zéro veut dire que le
		// tronçon ne sortira pas du tout dans le feed, et c'est exactement ce qu'il faut voir AVANT
		// d'enregistrer : des bornes prises sur une autre branche, ou des quais renumérotés par un GTFS
		// plus récent, ne sélectionnent rien.
		segments: segments.map((segment) => ({
			startStopId: segment.startStopId,
			endStopId: segment.endStopId,
			propagatedDelay: segment.propagatedDelay,
			stops: segment.stops.map((stop) => ({ ...stop, ...describeStop(stop.stopId, deps) })),
			path: segment.path,
			publishable: isSegmentPublishable(segment),
			matchingTrips: countMatchingTrips(segment, scope, deps),
		})),
	};
}

/** Combien de courses les bornes d'un tronçon désignent, ou zéro tant qu'elles ne sont pas arrêtées. */
function countMatchingTrips(
	segment: { startStopId: string | null; endStopId: string | null },
	scope: AlertScope,
	deps: AdminDependencies,
): number {
	if (segment.startStopId === null || segment.endStopId === null) return 0;

	return countSelectableTrips(
		deps.gtfs.data,
		scope.routeId,
		scope.directionId,
		segment.startStopId,
		segment.endStopId,
		Math.floor(Date.now() / 1000),
	);
}

/**
 * Relit et contrôle ce que l'interface envoie. Tout est vérifié ici : au-delà, on écrit en base et on
 * publie dans le feed, où une coordonnée fantaisiste ou un temps de parcours qui recule se verrait
 * chez tous les consommateurs.
 */
function parseInput(
	body: unknown,
	scope: AlertScope,
	gtfs: StaticGtfs,
	store: DetourStore,
): { input: DetourInput } | { message: string } {
	if (typeof body !== "object" || body === null) return { message: "Corps de requête attendu : un objet." };
	const payload = body as Record<string, unknown>;

	if (!Array.isArray(payload.segments)) return { message: "Liste de tronçons attendue." };
	if (payload.segments.length === 0) return { message: "Une déclaration compte au moins un tronçon." };

	const segments: DetourSegment[] = [];
	// Deux entrées qui désignent le même arrêt donneraient deux `replacement_stops` de même `stop_id` :
	// la course s'y arrêterait deux fois. Tous tronçons confondus — ils se suivent sur la même course.
	const designated = new Set<string>();

	for (const [index, raw] of payload.segments.entries()) {
		const parsed = parseSegment(raw, `Tronçon ${index + 1}`, designated, gtfs, store);
		if ("message" in parsed) return parsed;
		segments.push(parsed.segment);
	}

	const overlap = overlappingSegments(gtfs, scope.routeId, scope.directionId, segments);
	if (overlap !== undefined) {
		return {
			message:
				`Tronçons ${overlap[0] + 1} et ${overlap[1] + 1} : leurs plages se recoupent sur l'itinéraire de la ` +
				"ligne. Un même arrêt ne peut être supprimé deux fois — fondre les deux tronçons, ou reprendre " +
				"les bornes.",
		};
	}

	return { input: { segments } };
}

/** Un tronçon tel que l'interface l'envoie, contrôlé de bout en bout. */
function parseSegment(
	raw: unknown,
	label: string,
	designated: Set<string>,
	gtfs: StaticGtfs,
	store: DetourStore,
): { segment: DetourSegment } | { message: string } {
	if (typeof raw !== "object" || raw === null) return { message: `${label} : illisible.` };
	const payload = raw as Record<string, unknown>;

	const startStopId = payload.startStopId ?? null;
	const endStopId = payload.endStopId ?? null;
	if (startStopId !== null && (typeof startStopId !== "string" || !gtfs.stopNames.has(startStopId))) {
		return { message: `${label} : borne amont inconnue du GTFS.` };
	}
	if (endStopId !== null && (typeof endStopId !== "string" || !gtfs.stopNames.has(endStopId))) {
		return { message: `${label} : borne aval inconnue du GTFS.` };
	}

	const propagatedDelay = payload.propagatedDelay ?? 0;
	if (!Number.isInteger(propagatedDelay)) {
		return { message: `${label} : le délai propagé doit être un entier de secondes.` };
	}

	if (!Array.isArray(payload.stops)) return { message: `${label} : liste d'arrêts de substitution attendue.` };
	const stops: DetourSegment["stops"] = [];
	let previousTravelTime = Number.NEGATIVE_INFINITY;

	for (const [index, entry] of payload.stops.entries()) {
		if (typeof entry !== "object" || entry === null) return { message: `${label}, arrêt ${index + 1} : illisible.` };
		const stop = entry as Record<string, unknown>;

		// Un tronçon ne fait que DÉSIGNER des arrêts : ce qu'ils sont — leur nom, leur position — vit
		// dans le GTFS ou dans la base provisoire, jamais ici. Rien à valider de plus que l'existence.
		const stopId = stop.stopId;
		if (typeof stopId !== "string" || stopId.length === 0) {
			return { message: `${label}, arrêt ${index + 1} : identifiant manquant.` };
		}
		if (!gtfs.stopNames.has(stopId) && !store.provisionalStops.has(stopId)) {
			return {
				message: `${label}, arrêt ${index + 1} : « ${stopId} » n'existe ni dans le GTFS ni dans les arrêts provisoires.`,
			};
		}
		if (designated.has(stopId)) {
			return { message: `${label}, arrêt ${index + 1} : cet arrêt figure déjà dans la déclaration.` };
		}
		designated.add(stopId);

		const travelTime = stop.travelTime;
		if (!Number.isInteger(travelTime)) {
			return { message: `${label}, arrêt ${index + 1} : temps de parcours attendu en secondes.` };
		}
		// La spec l'exige croissant : c'est un temps cumulé depuis l'arrêt de référence, pas un intervalle.
		if ((travelTime as number) <= previousTravelTime) {
			return {
				message: `${label}, arrêt ${index + 1} : le temps de parcours doit dépasser celui de l'arrêt précédent.`,
			};
		}
		previousTravelTime = travelTime as number;

		stops.push({ stopId, travelTime: travelTime as number });
	}

	if (!Array.isArray(payload.path)) return { message: `${label} : tracé attendu, une liste de points.` };
	const path = [];
	for (const [index, entry] of payload.path.entries()) {
		const point = Array.isArray(entry) ? readCoordinates(entry[0], entry[1]) : undefined;
		if (point === undefined) return { message: `${label}, point ${index + 1} du tracé : coordonnées hors du réseau.` };
		path.push(point);
	}
	// Un tracé d'un seul point ne décrit rien, et `Shape` en réclame deux au minimum.
	if (path.length === 1) return { message: `${label} : un tracé doit compter au moins deux points.` };

	return {
		segment: {
			startStopId: startStopId as string | null,
			endStopId: endStopId as string | null,
			propagatedDelay: propagatedDelay as number,
			stops,
			path,
		},
	};
}

/** Ce qu'un arrêt désigné est, pour l'affichage : son libellé, sa position, et d'où il vient. */
function describeStop(stopId: string, deps: AdminDependencies) {
	const provisional = deps.store.provisionalStops.get(stopId);
	if (provisional !== undefined) {
		return {
			name: provisional.name,
			latitude: provisional.latitude,
			longitude: provisional.longitude,
			provisional: true,
		};
	}

	const coordinates = deps.gtfs.data.stopCoordinates.get(stopId);
	return {
		name: deps.gtfs.data.stopNames.get(stopId) ?? stopId,
		latitude: coordinates?.latitude ?? null,
		longitude: coordinates?.longitude ?? null,
		provisional: false,
	};
}

/** Relit le corps d'une création ou d'une modification d'arrêt provisoire. */
async function parseProvisionalStop(
	c: Context,
): Promise<{ name: string; latitude: number; longitude: number } | { message: string }> {
	let body: unknown;
	try {
		body = await c.req.json();
	} catch {
		return { message: "Corps de requête illisible." };
	}

	if (typeof body !== "object" || body === null) return { message: "Corps de requête attendu : un objet." };
	const payload = body as Record<string, unknown>;

	const name = typeof payload.name === "string" ? payload.name.trim() : "";
	if (name.length === 0) return { message: "Le nom de l'arrêt est obligatoire." };

	const coordinates = readCoordinates(payload.latitude, payload.longitude);
	if (coordinates === undefined) return { message: "Coordonnées hors du réseau." };

	return { name, ...coordinates };
}

function readCoordinates(latitude: unknown, longitude: unknown) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	if (latitude < LATITUDE_RANGE[0] || latitude > LATITUDE_RANGE[1]) return undefined;
	if (longitude < LONGITUDE_RANGE[0] || longitude > LONGITUDE_RANGE[1]) return undefined;
	return { latitude, longitude };
}
