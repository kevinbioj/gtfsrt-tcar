import { type Context, Hono } from "hono";
import { basicAuth } from "hono/basic-auth";

import { ROAD_ROUTING_MAX_EXPANSIONS, ROAD_SMOOTHING_TOLERANCE, ROAD_SNAP_RADIUS } from "../config.js";
import {
	type AlertScope,
	type AlertScopeIndex,
	type AnalyzedAlert,
	hasEnded,
	isActive,
} from "../gtfs-rt/use-service-alerts.js";
import { normalizeStopName, type RoutePattern, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import type { RoadGraph, RoadGraphHandle } from "../routing/road-graph.js";
import { routeOnRoad } from "../routing/route-on-road.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import { sanitizeHtml } from "../utils/sanitize-html.js";
import { ADMIN_PAGE } from "./admin-page.js";
import { deduceBounds, overlappingSegments, removesStops, type SegmentScope, targets } from "./bounds.js";
import { countSelectableTrips } from "./build-entities.js";
import {
	type DetourInput,
	type DetourSegment,
	type DetourStore,
	detourKey,
	type StandalonePeriod,
	standaloneUid,
} from "./store.js";

/**
 * Nombre de quais que la recherche d'arrêts renvoie au plus. Un libellé court — « gare » — en touche
 * des dizaines, et la liste cesse d'être lisible bien avant d'être longue.
 */
const STOP_SEARCH_LIMIT = 50;

/** Bornes larges du réseau, qui n'écartent qu'une coordonnée manifestement fautive. */
const LATITUDE_RANGE = [48, 51] as const;
const LONGITUDE_RANGE = [-1, 3] as const;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export type AdminDependencies = {
	username: string;
	password: string;
	store: DetourStore;
	gtfs: { data: StaticGtfs };
	serviceAlerts: {
		alertScopes: AlertScopeIndex;
		/** Les infos trafic analysées : c'est là qu'on trouve une ligne que l'analyse n'a pas retenue. */
		alerts: AnalyzedAlert[];
	};
	/** Le graphe routier, pour accrocher un tracé aux rues. Son absence désarme le mode, rien de plus. */
	roadGraph: RoadGraphHandle;
	/** Réassemble les entités du feed, pour qu'un enregistrement se voie sans attendre le relevé suivant. */
	rebuild: () => void;
	/** Rebâtit le périmètre des perturbations après une saisie — à appeler AVANT {@link rebuild}. */
	reindexAlerts: () => void;
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
		const scopes = [...deps.serviceAlerts.alertScopes.values()].sort((a, b) => compareScopes(a, b, deps.gtfs.data));
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
	/**
	 * La base des arrêts provisoires, chacun avec les déviations qui le désignent. C'est ce qu'il faut
	 * voir avant d'en renommer ou d'en déplacer un : le changement vaudra pour toutes, et un arrêt que
	 * rien ne désigne plus est le seul qu'on puisse retirer.
	 */
	admin.get("/api/provisional-stops", (c) => {
		const usages = new Map<string, ReturnType<typeof describeUsage>[]>();

		for (const record of deps.store.records.values()) {
			const designated = new Set(record.segments.flatMap((segment) => segment.stops.map((stop) => stop.stopId)));
			for (const stopId of designated) {
				if (!deps.store.provisionalStops.has(stopId)) continue;
				const list = usages.get(stopId);
				const usage = describeUsage(record.alertNumber, record.routeId, record.directionId, deps);
				if (list === undefined) usages.set(stopId, [usage]);
				else list.push(usage);
			}
		}

		const stops = [...deps.store.provisionalStops.values()].map((stop) => ({
			...stop,
			usages: usages.get(stop.stopId) ?? [],
		}));

		return c.json(stops.sort((a, b) => a.name.localeCompare(b.name, "fr")));
	});

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

	/** Retire un arrêt provisoire, et le retire au passage de toutes les déviations qui le désignent. */
	admin.delete("/api/provisional-stops/:stopId", (c) => {
		const withdrawn = deps.store.deleteProvisionalStop(c.req.param("stopId"), Math.floor(Date.now() / 1000));
		if (withdrawn === undefined) return c.json({ code: 404, message: "Arrêt provisoire inconnu." }, 404);

		// Des déviations publiées viennent de perdre un arrêt de substitution : le feed doit suivre.
		if (withdrawn > 0) deps.rebuild();
		return c.json({ code: 200, message: "Arrêt provisoire supprimé.", withdrawn });
	});

	/**
	 * Les infos trafic analysées, avec les lignes qu'elles citent et, pour chaque sens, ce que l'on en
	 * sait déjà : un périmètre tiré de l'analyse, un périmètre saisi, ou rien du tout.
	 *
	 * C'est de là que part une saisie : le sens qui n'apparaît nulle part dans la liste des déviations
	 * est précisément celui qu'il faut pouvoir déclarer concerné.
	 */
	admin.get("/api/alerts", (c) => {
		const gtfs = deps.gtfs.data;
		const now = Temporal.Now.instant();

		const alerts = deps.serviceAlerts.alerts.map((alert) => ({
			alertNumber: alert.alertNumber,
			headerText: alert.headerText,
			periods: alert.periods,
			active: isActive(alert.periods, now),
			routes: [...alert.routeIds]
				.sort((a, b) => compareLines(gtfs, a, b))
				.map((routeId) => ({
					routeId,
					line: lineName(gtfs, routeId),
					lineCode: lineCode(routeId),
					directions: (gtfs.routeDirections.get(routeId) ?? []).map((direction) => {
						const key = detourKey(alert.alertNumber, routeId, direction.directionId);
						const scope = deps.serviceAlerts.alertScopes.get(key);
						return {
							key,
							directionId: direction.directionId,
							headsigns: direction.headsigns,
							scoped: scope !== undefined,
							manual: deps.store.scopeOverrides.has(key),
							dismissed: deps.store.dismissedScopes.has(key),
							removedStopCount: scope?.removedStopIds.size ?? 0,
							declared: deps.store.records.has(key),
						};
					}),
				})),
		}));

		return c.json(alerts);
	});

	/**
	 * Saisit le périmètre d'une info trafic sur une ligne et un sens : la liste des arrêts supprimés,
	 * éventuellement vide. Elle REMPLACE ce que l'analyse en dit — c'est la seule règle, et elle vaut
	 * aussi bien pour corriger une suppression de trop que pour déclarer concerné un sens que
	 * l'analyse n'a pas vu.
	 *
	 * Le périmètre étant ce qui ouvre la déclaration, il faut le réindexer avant de republier : le
	 * feed suivant doit voir le nouveau périmètre et la déclaration qui s'y rattache d'un seul coup.
	 */
	admin.put("/api/scopes/:key", async (c) => {
		const target = parseKey(c.req.param("key"), deps);
		if ("message" in target) return c.json({ code: 400, message: target.message }, 400);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const payload = (body ?? {}) as Record<string, unknown>;
		if (!Array.isArray(payload.removedStopIds)) {
			return c.json({ code: 400, message: "Liste d'arrêts supprimés attendue." }, 400);
		}

		const stopIds: string[] = [];
		for (const stopId of payload.removedStopIds) {
			if (typeof stopId !== "string" || !deps.gtfs.data.stopNames.has(stopId)) {
				return c.json({ code: 400, message: `Arrêt « ${String(stopId)} » inconnu du GTFS.` }, 400);
			}
			stopIds.push(stopId);
		}

		deps.store.saveScopeOverride(
			target.alertNumber,
			target.routeId,
			target.directionId,
			stopIds,
			Math.floor(Date.now() / 1000),
		);
		deps.reindexAlerts();
		deps.rebuild();

		const scope = deps.serviceAlerts.alertScopes.get(target.key);
		// L'info trafic n'est plus au flux : la saisie est en base, mais rien ne la porte — il n'y a
		// pas de détail à rendre.
		if (scope === undefined) {
			return c.json({ code: 409, message: "Aucune info trafic ne porte ce numéro dans le flux courant." }, 409);
		}

		return c.json(detail(scope, deps));
	});

	/** Rend la main à l'analyse pour ce couple ligne/sens. La déclaration de déviation, elle, reste. */
	admin.delete("/api/scopes/:key", (c) => {
		const target = parseKey(c.req.param("key"), deps);
		if ("message" in target) return c.json({ code: 400, message: target.message }, 400);

		if (!deps.store.removeScopeOverride(target.alertNumber, target.routeId, target.directionId)) {
			return c.json({ code: 404, message: "Aucun périmètre saisi pour cette ligne et ce sens." }, 404);
		}

		deps.reindexAlerts();
		deps.rebuild();
		return c.json({ code: 200, message: "Périmètre rendu à l'analyse." });
	});

	/**
	 * Retire une entrée de la liste : l'info trafic ne concerne pas cette ligne dans ce sens, quoi
	 * qu'en dise l'analyse. Sa déclaration, son périmètre saisi et sa désactivation partent avec.
	 *
	 * Une modification sans info trafic n'a pas d'analyse qui la ferait revenir : la retirer, c'est
	 * l'effacer tout entière, comme depuis son détail.
	 */
	admin.put("/api/dismissed/:key", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		const uid = scope.standalone ? standaloneUid(scope.alertNumber) : undefined;
		if (uid !== undefined) deps.store.removeStandalone(uid);
		else deps.store.dismiss(scope.alertNumber, scope.routeId, scope.directionId, Math.floor(Date.now() / 1000));

		deps.reindexAlerts();
		deps.rebuild();
		return c.json({ code: 200, message: uid !== undefined ? "Modification supprimée." : "Entrée retirée." });
	});

	/** Rétablit une entrée retirée : l'analyse en redit ce qu'elle voit, ou rien si elle n'y voit rien. */
	admin.delete("/api/dismissed/:key", (c) => {
		const target = parseKey(c.req.param("key"), deps);
		if ("message" in target) return c.json({ code: 400, message: target.message }, 400);

		if (!deps.store.restore(target.alertNumber, target.routeId, target.directionId)) {
			return c.json({ code: 404, message: "Cette ligne et ce sens n'ont pas été retirés." }, 404);
		}

		deps.reindexAlerts();
		deps.rebuild();
		return c.json({ code: 200, message: "Entrée rétablie." });
	});

	/** Les lignes du réseau et leurs sens : de quoi choisir où porte une modification sans info trafic. */
	admin.get("/api/routes", (c) => {
		const gtfs = deps.gtfs.data;
		const routes = [...gtfs.routeDirections]
			.sort(([a], [b]) => compareLines(gtfs, a, b))
			.map(([routeId, directions]) => ({
				routeId,
				line: lineName(gtfs, routeId),
				lineCode: lineCode(routeId),
				directions: directions.map((direction) => ({
					directionId: direction.directionId,
					headsigns: direction.headsigns,
				})),
			}));

		return c.json(routes);
	});

	/**
	 * Déclare une modification sans info trafic : une ligne, un sens, une période. Elle tient ensuite
	 * lieu d'info trafic en tout point, et sa déviation se saisit comme les autres, par sa clé.
	 */
	admin.post("/api/modifications", async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		if (typeof body !== "object" || body === null) {
			return c.json({ code: 400, message: "Corps de requête attendu : un objet." }, 400);
		}
		const payload = body as Record<string, unknown>;

		const routeId = payload.routeId;
		const directionId = payload.directionId;
		const directions = typeof routeId === "string" ? deps.gtfs.data.routeDirections.get(routeId) : undefined;
		if (typeof routeId !== "string" || directions === undefined) {
			return c.json({ code: 400, message: `Ligne « ${String(routeId)} » inconnue du GTFS.` }, 400);
		}
		if (!directions.some((direction) => direction.directionId === directionId)) {
			return c.json({ code: 400, message: `La ligne ${routeId} n'a pas de sens ${String(directionId)}.` }, 400);
		}

		const parsed = parseModification(payload);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		const modification = deps.store.createStandalone(
			routeId,
			directionId as number,
			parsed.label,
			parsed.period,
			Math.floor(Date.now() / 1000),
		);
		deps.reindexAlerts();
		deps.rebuild();

		return c.json({ key: detourKey(modification.alertNumber, routeId, modification.directionId) });
	});

	/** Reprend l'intitulé ou la période d'une modification sans info trafic. */
	admin.put("/api/modifications/:number", async (c) => {
		const number = c.req.param("number");
		const uid = standaloneUid(number);
		const existing = deps.store.standaloneModifications.get(number);
		if (uid === undefined || existing === undefined) {
			return c.json({ code: 404, message: "Modification sans info trafic inconnue." }, 404);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}
		if (typeof body !== "object" || body === null) {
			return c.json({ code: 400, message: "Corps de requête attendu : un objet." }, 400);
		}

		const parsed = parseModification(body as Record<string, unknown>);
		if ("message" in parsed) return c.json({ code: 400, message: parsed.message }, 400);

		deps.store.updateStandalone(uid, parsed.label, parsed.period);
		// La période décide de la mise en vigueur : le périmètre se rejauge, et le feed avec lui.
		deps.reindexAlerts();
		deps.rebuild();

		const scope = deps.serviceAlerts.alertScopes.get(detourKey(number, existing.routeId, existing.directionId));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);
		return c.json(detail(scope, deps));
	});

	/**
	 * Désactive ou réactive une modification, qu'une info trafic la porte ou non. Désactivée, elle est
	 * tenue pour hors période : ni sa modification ni ses arrêts supprimés ne sortent dans le feed.
	 */
	admin.put("/api/detours/:key/disabled", async (c) => {
		const key = c.req.param("key");
		const scope = deps.serviceAlerts.alertScopes.get(key);
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const disabled = (body as Record<string, unknown> | null)?.disabled;
		if (typeof disabled !== "boolean") return c.json({ code: 400, message: "Booléen « disabled » attendu." }, 400);

		deps.store.setDisabled(
			scope.alertNumber,
			scope.routeId,
			scope.directionId,
			disabled,
			Math.floor(Date.now() / 1000),
		);
		// Le `skipIndex` en dépend autant que la modification : on réindexe avant de republier.
		deps.reindexAlerts();
		deps.rebuild();

		const next = deps.serviceAlerts.alertScopes.get(key);
		if (next === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);
		return c.json(detail(next, deps));
	});

	admin.get("/api/detours/:key", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		return c.json(detail(scope, deps));
	});

	/**
	 * Combien de courses ces bornes-là modifieraient, sans rien enregistrer. L'interface l'interroge dès
	 * qu'on change une borne ou un tracé visé : avec plusieurs tronçons, un compte figé au chargement de
	 * la page dirait n'importe quoi, et c'est précisément le chiffre qui dit si le tronçon sortira du
	 * feed. Le détail par tracé dit lesquels desservent ces bornes, qu'ils soient visés ou non.
	 */
	admin.get("/api/detours/:key/trip-count", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		const segment: SegmentScope = {
			startStopId: c.req.query("start") ?? null,
			endStopId: c.req.query("end") ?? null,
			patternIds: (c.req.query("patterns") ?? "").split(",").filter((patternId) => patternId.length > 0),
		};
		const counts = countTripsByPattern(segment, scope, deps);
		return c.json({ matchingTrips: sumTargeted(counts, segment), tripsByPattern: Object.fromEntries(counts) });
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

	/**
	 * Une jambe de tracé, accrochée aux rues : deux points cliqués, et l'itinéraire routier qui les
	 * joint.
	 *
	 * Une jambe par appel, et non le tracé entier : déplacer un point de passage ne remet en cause que
	 * les deux jambes qui le touchent, et l'interface n'a alors qu'à redemander celles-là.
	 */
	admin.post("/api/route", async (c) => {
		// Le graphe s'ouvre à la première demande, et peut refuser de s'ouvrir : fichier tronqué par un
		// transfert, ou d'une version que ce code ne sait plus lire. On rend alors la raison telle
		// quelle — l'éditeur l'affiche sur la jambe, et elle dit quoi faire.
		let graph: RoadGraph | undefined;
		try {
			graph = deps.roadGraph.graph();
		} catch (cause) {
			return c.json({ code: 500, message: cause instanceof Error ? cause.message : "Graphe routier illisible." }, 500);
		}

		if (graph === undefined) {
			return c.json({ code: 503, message: "Graphe routier absent : le mode accrochage est indisponible." }, 503);
		}

		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ code: 400, message: "Corps de requête illisible." }, 400);
		}

		const payload = (body ?? {}) as Record<string, unknown>;
		const from = readPoint(payload.from);
		const to = readPoint(payload.to);
		if (from === undefined || to === undefined) {
			return c.json({ code: 400, message: "Deux points attendus, chacun en [latitude, longitude]." }, 400);
		}

		const route = routeOnRoad(graph, from, to, {
			snapRadius: ROAD_SNAP_RADIUS,
			maxExpansions: ROAD_ROUTING_MAX_EXPANSIONS,
			smoothingTolerance: ROAD_SMOOTHING_TOLERANCE,
		});

		if ("failure" in route) {
			const message =
				route.failure === "no-road" ? "Point trop éloigné d'une rue." : "Aucun itinéraire entre ces deux points.";
			return c.json({ code: 422, message }, 422);
		}

		// Les points partent en paires [latitude, longitude], comme le tracé d'un tronçon : l'interface
		// les recoud bout à bout sans rien convertir.
		return c.json({
			path: route.path.map((point) => [point.latitude, point.longitude]),
			distance: Math.round(route.distance * 1000),
			fromOffset: Math.round(route.from.offset * 1000),
			toOffset: Math.round(route.to.offset * 1000),
		});
	});

	admin.delete("/api/detours/:key", (c) => {
		const scope = deps.serviceAlerts.alertScopes.get(c.req.param("key"));
		if (scope === undefined) return c.json({ code: 404, message: "Déviation inconnue." }, 404);

		// Une modification sans info trafic n'est rien d'autre que ce qu'on y a déclaré : effacer la
		// déclaration l'efface tout entière, période et périmètre compris.
		const uid = scope.standalone ? standaloneUid(scope.alertNumber) : undefined;
		if (uid !== undefined) {
			deps.store.removeStandalone(uid);
			deps.reindexAlerts();
			deps.rebuild();
			return c.json({ code: 200, message: "Modification supprimée." });
		}

		deps.store.remove(scope.alertNumber, scope.routeId, scope.directionId);
		deps.rebuild();

		return c.json({ code: 200, message: "Déclaration effacée." });
	});

	return admin;
}

// ---

/**
 * Relit une clé `<numéro>:<routeId>:<sens>` : le numéro d'abord, le sens en dernier, la ligne au
 * milieu — un identifiant de ligne porte lui-même des deux-points (« TCAR:07 »), et c'est le seul
 * découpage qui ne s'y perde pas.
 */
function parseKey(
	key: string,
	deps: AdminDependencies,
): { key: string; alertNumber: string; routeId: string; directionId: number } | { message: string } {
	const parts = key.split(":");
	if (parts.length < 3) return { message: "Clé attendue : « numéro:ligne:sens »." };

	const alertNumber = parts[0] as string;
	const directionId = Number(parts.at(-1));
	const routeId = parts.slice(1, -1).join(":");

	if (directionId !== 0 && directionId !== 1) return { message: "Sens attendu : 0 ou 1." };

	const directions = deps.gtfs.data.routeDirections.get(routeId);
	if (directions === undefined) return { message: `Ligne « ${routeId} » inconnue du GTFS.` };
	if (!directions.some((direction) => direction.directionId === directionId)) {
		return { message: `La ligne ${routeId} n'a pas de sens ${directionId}.` };
	}

	// Une modification sans info trafic ne porte que sur sa ligne et son sens : une clé qui en
	// désignerait d'autres ouvrirait un périmètre ailleurs, sous son numéro.
	const standalone = deps.store.standaloneModifications.get(alertNumber);
	if (standalone !== undefined) {
		if (standalone.routeId !== routeId || standalone.directionId !== directionId) {
			return {
				message: `La modification ${alertNumber} porte sur ${standalone.routeId}, sens ${standalone.directionId}.`,
			};
		}
	} else if (!deps.serviceAlerts.alerts.some((alert) => alert.alertNumber === alertNumber)) {
		return { message: `Aucune info trafic ${alertNumber} au flux courant.` };
	}

	return { key: detourKey(alertNumber, routeId, directionId), alertNumber, routeId, directionId };
}

/**
 * Par ligne, dans l'ordre du réseau, puis par sens ; en vigueur d'abord au sein d'un même sens. La
 * liste groupée par info trafic remonte elle-même les perturbations en vigueur.
 */
function compareScopes(a: AlertScope, b: AlertScope, gtfs: StaticGtfs): number {
	if (a.routeId !== b.routeId) return compareLines(gtfs, a.routeId, b.routeId);
	if (a.directionId !== b.directionId) return a.directionId - b.directionId;
	if (a.active !== b.active) return a.active ? -1 : 1;
	return a.alertNumber.localeCompare(b.alertNumber);
}

/** Le nom commercial d'une ligne (« F7 », « Métro »), ou à défaut le bout de son identifiant. */
function lineName(gtfs: StaticGtfs, routeId: string): string {
	return gtfs.routeNames.get(routeId) ?? lineCode(routeId);
}

/** Le bout de l'identifiant de ligne (« TCAR:07 » → « 07 ») : c'est lui qui nomme les cartouches. */
function lineCode(routeId: string): string {
	return routeId.split(":").at(-1) ?? routeId;
}

/** Le métro, puis les lignes T, puis les lignes F, puis tout le reste. */
function lineRank(name: string): number {
	if (/^m[ée]tro$/i.test(name)) return 0;
	if (/^T\d+$/.test(name)) return 1;
	if (/^F\d+$/.test(name)) return 2;
	return 3;
}

/** L'ordre du réseau : par rang, puis par nom, les nombres comparés comme tels (F2 avant F10). */
function compareLines(gtfs: StaticGtfs, a: string, b: string): number {
	const nameA = lineName(gtfs, a);
	const nameB = lineName(gtfs, b);
	return lineRank(nameA) - lineRank(nameB) || nameA.localeCompare(nameB, "fr", { numeric: true });
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
		line: lineName(gtfs, scope.routeId),
		lineCode: lineCode(scope.routeId),
		directionId: scope.directionId,
		headsigns:
			gtfs.routeDirections.get(scope.routeId)?.find((d) => d.directionId === scope.directionId)?.headsigns ?? [],
		headerText: scope.headerText,
		periods: scope.periods,
		active: scope.active,
		ended: hasEnded(scope.periods, Temporal.Now.instant()),
		standalone: scope.standalone,
		disabled: scope.disabled,
		removedStopCount: scope.removedStopIds.size,
		manualScope: deps.store.scopeOverrides.has(scope.key),
		declared: record !== undefined,
		segmentCount: segments.length,
		publishableSegments: segments.filter((segment) => isSegmentPublishable(segment, scope, deps)).length,
		stopCount: segments.reduce((total, segment) => total + segment.stops.length, 0),
		pathPointCount: segments.reduce((total, segment) => total + segment.path.length, 0),
		updatedAt: record?.updatedAt ?? null,
		publishable: segments.some((segment) => isSegmentPublishable(segment, scope, deps)),
	};
}

/**
 * Un tronçon n'entre dans le feed qu'avec ses deux bornes — ce sont elles qui désignent les courses —
 * et de quoi dire quelque chose.
 *
 * Quand sa plage supprime des arrêts, ce quelque chose est des arrêts de substitution, un tracé, ou
 * les deux : le tracé seul suffit, le segment est alors supprimé sans report, et l'itinéraire porte
 * toute l'information. Quand elle n'en supprime aucun, c'est le tracé et rien d'autre — il n'y a
 * rien à remplacer (cf. `removesStops`).
 */
function isSegmentPublishable(segment: DetourSegment, scope: AlertScope, deps: AdminDependencies): boolean {
	if (segment.startStopId === null || segment.endStopId === null) return false;
	if (!removesStops(deps.gtfs.data, scope.routeId, scope.directionId, scope.removedStopIds, segment)) {
		return segment.path.length >= 2;
	}
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

	// Les tracés empruntés du sens, services partiels compris : un tronçon peut n'en viser que certains,
	// et c'est sur leurs arrêts que se choisissent ses bornes.
	const routePatterns = gtfs.routePatterns.get(scope.routeId)?.get(scope.directionId) ?? [];
	const labels = patternLabels(routePatterns, gtfs);
	const patterns = routePatterns.map((pattern, index) => ({
		patternId: pattern.patternId,
		shapeId: pattern.shapeId,
		label: labels[index],
		tripCount: pattern.tripCount,
		sequence: pattern.stops.map((stop) => ({
			stopId: stop.stopId,
			name: gtfs.stopNames.get(stop.stopId) ?? stop.name,
			...(gtfs.stopCoordinates.get(stop.stopId) ?? { latitude: null, longitude: null }),
			removed: scope.removedStopIds.has(stop.stopId),
		})),
	}));

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
	// Rien de supprimé, donc rien à borner : il ne reste qu'à choisir entre quels arrêts la course
	// passe ailleurs, et c'est un tronçon vierge qu'on propose. C'est très exactement le cas d'une
	// ligne déviée dans un sens où elle ne perd aucun arrêt.
	const fallback: DetourSegment[] =
		scope.removedStopIds.size === 0
			? [{ patternIds: [], startStopId: null, endStopId: null, propagatedDelay: 0, stops: [], waypoints: [], path: [] }]
			: proposed.map((bounds) => ({
					patternIds: [],
					startStopId: bounds.startStopId,
					endStopId: bounds.endStopId,
					propagatedDelay: 0,
					stops: [],
					waypoints: [],
					path: [],
				}));

	const segments = record !== undefined && record.segments.length > 0 ? record.segments : fallback;

	// La période d'une modification sans info trafic, découpée comme le formulaire la saisit.
	const standalone = deps.store.standaloneModifications.get(scope.alertNumber);
	const period =
		standalone === undefined
			? null
			: {
					label: standalone.label,
					start: splitBound(standalone.period.start),
					end: standalone.period.end === null ? null : splitBound(standalone.period.end),
				};

	return {
		...summarize(scope, deps),
		period,
		// Le texte d'une info trafic est du HTML : le flux amont reprend ce que le CMS de l'exploitant a
		// saisi, listes et plans de déviation compris. Il part nettoyé plutôt qu'échappé — la page
		// l'affiche tel quel, et n'a pas à savoir d'où il vient (cf. `sanitizeHtml`).
		descriptionHtml: sanitizeHtml(scope.descriptionText),
		// L'éditeur ne propose l'accrochage aux rues que si le graphe est là. Le drapeau voyage avec le
		// détail plutôt que dans un appel à lui — la carte n'existe que sur cette vue.
		roadRouting: deps.roadGraph.available,
		removedStopIds: [...scope.removedStopIds],
		// Le périmètre vient-il de l'analyse, ou a-t-il été saisi ? L'interface le dit, et propose de
		// rendre la main à l'analyse — c'est la seule façon de revenir en arrière.
		manualScope: deps.store.scopeOverrides.has(scope.key),
		patterns,
		shapes,
		boundsCandidates,
		// Un arrêt n'est plus décrit dans la déclaration, seulement désigné : son libellé et sa position
		// se relisent à l'affichage, du GTFS ou de la base provisoire. Un arrêt provisoire déplacé depuis
		// une autre déviation se voit donc tout de suite, sans rien avoir à recopier.
		//
		// `matchingTrips` dit combien de courses ces bornes-là modifieraient sur les tracés visés. Zéro
		// veut dire que le tronçon ne sortira pas du tout dans le feed, et c'est exactement ce qu'il faut
		// voir AVANT d'enregistrer : des bornes prises sur une autre branche, des quais renumérotés ou
		// un tracé disparu d'un GTFS plus récent ne sélectionnent rien.
		segments: segments.map((segment) => {
			const counts = countTripsByPattern(segment, scope, deps);
			return {
				patternIds: segment.patternIds,
				startStopId: segment.startStopId,
				endStopId: segment.endStopId,
				propagatedDelay: segment.propagatedDelay,
				stops: segment.stops.map((stop) => ({ ...stop, ...describeStop(stop.stopId, deps) })),
				waypoints: segment.waypoints,
				path: segment.path,
				publishable: isSegmentPublishable(segment, scope, deps),
				tripsByPattern: Object.fromEntries(counts),
				matchingTrips: sumTargeted(counts, segment),
			};
		}),
	};
}

/**
 * Le libellé d'un tracé : « premier arrêt → dernier arrêt ». Deux tracés qui partent et arrivent au
 * même endroit se départagent par le premier arrêt que l'un dessert et pas l'autre.
 */
function patternLabels(patterns: readonly RoutePattern[], gtfs: StaticGtfs): string[] {
	const nameOf = (stopId: string | undefined) => (stopId === undefined ? "?" : (gtfs.stopNames.get(stopId) ?? stopId));
	const base = patterns.map(
		(pattern) => `${nameOf(pattern.stops[0]?.stopId)} → ${nameOf(pattern.stops.at(-1)?.stopId)}`,
	);

	return patterns.map((pattern, index) => {
		const twins = patterns.filter((_, other) => other !== index && base[other] === base[index]);
		if (twins.length === 0) return base[index] as string;

		const elsewhere = new Set(twins.flatMap((twin) => twin.stops.map((stop) => stop.stopId)));
		const own = pattern.stops.find((stop) => !elsewhere.has(stop.stopId));
		return own === undefined
			? `${base[index]} (${pattern.stops.length} arrêts)`
			: `${base[index]} via ${nameOf(own.stopId)}`;
	});
}

/** Le nombre de courses touchées sur les seuls tracés visés, d'après {@link countTripsByPattern}. */
function sumTargeted(counts: ReadonlyMap<string, number>, segment: { patternIds: readonly string[] }): number {
	let total = 0;
	for (const [patternId, count] of counts) if (targets(segment, patternId)) total += count;
	return total;
}

/**
 * Combien de courses les bornes d'un tronçon désignent sur chaque tracé, qu'il le vise ou non. Rien
 * tant qu'elles ne sont pas arrêtées.
 */
function countTripsByPattern(
	segment: { startStopId: string | null; endStopId: string | null },
	scope: AlertScope,
	deps: AdminDependencies,
): Map<string, number> {
	if (segment.startStopId === null || segment.endStopId === null) return new Map();

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

	const patterns = gtfs.routePatterns.get(scope.routeId)?.get(scope.directionId) ?? [];

	for (const [index, raw] of payload.segments.entries()) {
		const parsed = parseSegment(raw, `Tronçon ${index + 1}`, designated, patterns, gtfs, store);
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
	patterns: readonly RoutePattern[],
	gtfs: StaticGtfs,
	store: DetourStore,
): { segment: DetourSegment } | { message: string } {
	if (typeof raw !== "object" || raw === null) return { message: `${label} : illisible.` };
	const payload = raw as Record<string, unknown>;

	// Les tracés visés sont facultatifs : sans eux, le tronçon les vise tous, comme avant qu'on puisse
	// les distinguer. Un tracé inconnu est refusé plutôt qu'écarté — l'écarter élargirait en silence
	// le tronçon à des courses qu'on n'a pas choisies.
	const patternIds: string[] = [];
	if (payload.patternIds !== undefined) {
		if (!Array.isArray(payload.patternIds)) return { message: `${label} : tracés visés attendus, une liste.` };

		for (const patternId of payload.patternIds) {
			if (typeof patternId !== "string" || !patterns.some((pattern) => pattern.patternId === patternId)) {
				return { message: `${label} : tracé « ${String(patternId)} » inconnu du GTFS pour cette ligne et ce sens.` };
			}
			if (!patternIds.includes(patternId)) patternIds.push(patternId);
		}

		// Les nommer tous revient à n'en nommer aucun, et cette forme-là survit à un tracé que le GTFS
		// ajouterait demain.
		if (patternIds.length === patterns.length) patternIds.length = 0;
	}

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
	// Rien n'est refusé ici à un tronçon dont la plage ne supprime aucun arrêt : le périmètre peut
	// changer APRÈS l'enregistrement, et cet état-là est de toute façon à traverser. Ses arrêts de
	// substitution sont alors laissés de côté à la publication, qui le dit (cf. `collectCandidates`).
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

	// Les points de passage sont facultatifs : sans eux, le tracé EST sa propre suite de points de
	// passage, tirés droit — c'est le dessin libre d'avant, et un PUT écrit à la main reste valable.
	const waypoints: DetourSegment["waypoints"] = [];
	if (payload.waypoints === undefined) {
		waypoints.push(...path.map((point) => ({ ...point, mode: "free" as const })));
	} else {
		if (!Array.isArray(payload.waypoints)) return { message: `${label} : points de passage attendus, une liste.` };

		for (const [index, entry] of payload.waypoints.entries()) {
			if (typeof entry !== "object" || entry === null) {
				return { message: `${label}, point de passage ${index + 1} : illisible.` };
			}
			const waypoint = entry as Record<string, unknown>;

			const point = Array.isArray(waypoint.point) ? readCoordinates(waypoint.point[0], waypoint.point[1]) : undefined;
			if (point === undefined) {
				return { message: `${label}, point de passage ${index + 1} : coordonnées hors du réseau.` };
			}
			if (waypoint.mode !== "route" && waypoint.mode !== "free") {
				return { message: `${label}, point de passage ${index + 1} : mode attendu, « route » ou « free ».` };
			}

			waypoints.push({ ...point, mode: waypoint.mode });
		}
	}

	// Le seul lien qu'on impose entre les deux : ils vont de pair. On ne vérifie PAS que le tracé
	// redérive des points de passage — ce serait rejouer le routage ici, et le tracé, déjà contrôlé
	// point par point, fait foi de toute façon.
	if (waypoints.length === 1) return { message: `${label} : un tracé doit compter au moins deux points de passage.` };
	if ((path.length === 0) !== (waypoints.length === 0)) {
		return { message: `${label} : tracé et points de passage doivent être tous deux vides, ou tous deux remplis.` };
	}

	return {
		segment: {
			patternIds,
			startStopId: startStopId as string | null,
			endStopId: endStopId as string | null,
			propagatedDelay: propagatedDelay as number,
			stops,
			waypoints,
			path,
		},
	};
}

/**
 * Une déviation qui désigne un arrêt provisoire, telle que la liste des arrêts la cite. Sa
 * perturbation peut avoir quitté le flux : la déclaration reste en base, mais n'a plus de détail à
 * ouvrir — `open` le dit.
 */
function describeUsage(alertNumber: string, routeId: string, directionId: number, deps: AdminDependencies) {
	const key = detourKey(alertNumber, routeId, directionId);
	const scope = deps.serviceAlerts.alertScopes.get(key);

	return {
		key,
		alertNumber,
		standalone: scope?.standalone ?? false,
		line: lineName(deps.gtfs.data, routeId),
		lineCode: lineCode(routeId),
		directionId,
		headsigns:
			deps.gtfs.data.routeDirections.get(routeId)?.find((direction) => direction.directionId === directionId)
				?.headsigns ?? [],
		headerText: scope?.headerText ?? null,
		open: scope !== undefined,
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

/**
 * Relit l'intitulé et la période d'une modification sans info trafic. Chaque borne est un objet
 * `{ date, time }` : la date est obligatoire, l'heure facultative. La fin peut manquer — la période
 * est alors ouverte — et doit sinon venir après le début.
 */
function parseModification(
	payload: Record<string, unknown>,
): { label: string | null; period: StandalonePeriod } | { message: string } {
	if (payload.label !== undefined && payload.label !== null && typeof payload.label !== "string") {
		return { message: "Intitulé attendu : un texte." };
	}
	const label = typeof payload.label === "string" && payload.label.trim().length > 0 ? payload.label.trim() : null;

	const start = readBound(payload.start, "début");
	if ("message" in start) return start;
	if (start.bound === null) return { message: "La date de début est obligatoire." };

	const end = readBound(payload.end, "fin");
	if ("message" in end) return end;

	// La fin se compare comme elle se jauge : exclusive, et à la journée entière quand elle est sans
	// heure (cf. `periodEnd`). « Du 24 au 24 » couvre donc bien la journée.
	if (end.bound !== null) {
		const from = start.time === null ? start.date.toPlainDateTime() : start.date.toPlainDateTime(start.time);
		const until = end.time === null ? end.date.add({ days: 1 }).toPlainDateTime() : end.date.toPlainDateTime(end.time);
		if (Temporal.PlainDateTime.compare(until, from) <= 0) return { message: "La fin doit venir après le début." };
	}

	return { label, period: { start: start.bound, end: end.bound } };
}

/** Une borne `{ date, time }` telle que le formulaire l'envoie, ou `null` pour une borne absente. */
function readBound(
	raw: unknown,
	which: string,
):
	| { bound: string; date: Temporal.PlainDate; time: Temporal.PlainTime | null }
	| { bound: null }
	| { message: string } {
	if (raw === undefined || raw === null) return { bound: null };
	if (typeof raw !== "object") return { message: `Borne de ${which} illisible.` };

	const payload = raw as Record<string, unknown>;
	const date = typeof payload.date === "string" ? payload.date.trim() : "";
	const time = typeof payload.time === "string" ? payload.time.trim() : "";

	if (date.length === 0) {
		return time.length === 0 ? { bound: null } : { message: `Heure de ${which} sans date.` };
	}
	if (!DATE_PATTERN.test(date)) return { message: `Date de ${which} attendue au format AAAA-MM-JJ.` };
	if (time.length > 0 && !TIME_PATTERN.test(time)) return { message: `Heure de ${which} attendue au format HH:MM.` };

	let plainDate: Temporal.PlainDate;
	try {
		plainDate = Temporal.PlainDate.from(date, { overflow: "reject" });
	} catch {
		return { message: `Date de ${which} invalide.` };
	}

	return time.length === 0
		? { bound: date, date: plainDate, time: null }
		: { bound: `${date}T${time}`, date: plainDate, time: Temporal.PlainTime.from(time) };
}

/** « 2026-09-24T08:30 » donne `{ date: "2026-09-24", time: "08:30" }` ; sans heure, `time` est null. */
function splitBound(bound: string) {
	const [date, time] = bound.split("T");
	return { date: date as string, time: time ?? null };
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

/** Un point tel que l'interface l'envoie : une paire [latitude, longitude]. */
function readPoint(raw: unknown) {
	return Array.isArray(raw) ? readCoordinates(raw[0], raw[1]) : undefined;
}

function readCoordinates(latitude: unknown, longitude: unknown) {
	if (typeof latitude !== "number" || typeof longitude !== "number") return undefined;
	if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return undefined;
	if (latitude < LATITUDE_RANGE[0] || latitude > LATITUDE_RANGE[1]) return undefined;
	if (longitude < LONGITUDE_RANGE[0] || longitude > LONGITUDE_RANGE[1]) return undefined;
	return { latitude, longitude };
}
