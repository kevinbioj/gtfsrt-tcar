import { createHash } from "node:crypto";

import type GtfsRealtime from "gtfs-realtime-bindings";

import { MAX_DETOUR_JUNCTION_OFFSET } from "../config.js";
import { serviceDays } from "../gtfs-rt/scheduled-trips.js";
import { type CancelIndex, isCancelled, republishedAlertId } from "../gtfs-rt/use-service-alerts.js";
import type { StaticGtfs, TripStop } from "../gtfs-rt/use-static-gtfs.js";
import { encodePolyline } from "../utils/encode-polyline.js";
import type { Coordinates } from "../utils/geometry.js";
import { removesStops } from "./bounds.js";
import type { ResolvedModification } from "./modifications.js";
import { spliceShape } from "./splice-shape.js";
import { type ProvisionalStop, provisionalStopUid } from "./store.js";

/**
 * Les journées de service qu'une déviation couvre. La veille en fait partie pour la même raison que
 * dans `scheduledTripUpdates` : une course partie à « 25:10 » appartient à hier et roule ce matin.
 */
const CANDIDATE_DAYS = [-1, 0] as const;

/**
 * Un tronçon dévié prêt à être appliqué : un segment d'une déclaration, dont l'info trafic est en
 * vigueur et dont tout ce qu'il faut pour publier est là. C'est ce que la suite manipule — la
 * déclaration dont il vient n'a plus d'importance, seule compte la course qu'il modifie.
 */
type Candidate = {
	/** De quoi le nommer au journal et dans les identifiants publiés : « M12#0 ». */
	label: string;
	/**
	 * Sa plage supprime-t-elle des arrêts ? Sinon le véhicule passe ailleurs entre deux arrêts qu'il
	 * dessert toujours : le tronçon ne publie pas de `Modification`, seulement son tracé.
	 */
	removes: boolean;
	/** `null` pour une modification déclarée sans info trafic : il n'y a pas d'alerte à citer. */
	alertId: string | null;
	routeId: string;
	directionId: number;
	/** Les tracés visés, ou `null` pour tous (cf. `DetourSegment.patternIds`). */
	patternIds: ReadonlySet<string> | null;
	startStopId: string;
	endStopId: string;
	propagatedDelay: number;
	stops: { stopId: string; travelTime: number }[];
	path: Coordinates[];
	updatedAt: number;
};

/** Un tronçon rapporté à une course : ses bornes y ont un rang, et c'est lui qui les ordonne. */
type Applicable = { candidate: Candidate; startIndex: number; endIndex: number };

/**
 * Les courses d'une journée qui reçoivent exactement la même chose : les mêmes modifications, les
 * mêmes déroutements, et le même itinéraire d'origine. Elles sortent en une seule entité.
 */
type Group = {
	modifications: Modification[];
	/** Les tronçons sans suppression : ils ne donnent qu'un tracé, à coudre avec les autres. */
	reroutes: Applicable[];
	shapeId: string;
	tripIds: string[];
};

/**
 * Une `Modification` telle qu'elle sera publiée, une fois les chevauchements repliés. Elle vient d'un
 * tronçon, ou de plusieurs qui se recouvraient sur cette course.
 */
type Modification = {
	parts: string[];
	startStopId: string;
	endStopId: string;
	startIndex: number;
	endIndex: number;
	propagatedDelay: number;
	stops: { stopId: string; travelTime: number }[];
	paths: Coordinates[][];
	alertId: string | null;
	lastModifiedTime: number;
};

/**
 * Les entités que les déviations déclarées ajoutent au feed : les arrêts provisoires qu'aucun GTFS ne
 * connaît, les tracés recousus, et les modifications elles-mêmes.
 *
 * Elles sortent dans cet ordre — arrêts, tracés, puis modifications qui les référencent. La spec
 * n'impose rien, mais un consommateur qui lit le feed d'une traite y gagne, et ça ne coûte rien.
 *
 * Le pivot est LA COURSE, et non la déclaration : la spécification veut qu'une course soit couverte
 * par une seule `TripModifications`, dont le champ `modifications` porte autant de `Modification`
 * qu'il y a de tronçons déviés. Deux infos trafic sur la même ligne et le même sens se retrouvent
 * donc dans la même entité, et une info trafic qui dévie la ligne en deux endroits y met deux
 * modifications. On assemble ce qui s'applique à chaque course, puis on réunit les courses qui
 * reçoivent exactement la même chose.
 *
 * Un tronçon qui ne supprime aucun arrêt, lui, ne produit AUCUNE `Modification` : il n'a rien à
 * remplacer, et des sélecteurs qui désigneraient des arrêts encore desservis mentiraient. Ce qu'il
 * change — le chemin — passe tout entier par le `shape_id` de la course, et l'entité sort avec une
 * liste `modifications` vide. C'est la seule façon d'annoncer une déviation qui ne touche pas à la
 * desserte, et c'est le cas d'une ligne déviée dans un sens où elle ne perd pas d'arrêt.
 *
 * Une entité est émise PAR JOURNÉE DE SERVICE, et non une seule portant plusieurs `service_dates`.
 * Sans cela, les courses de toutes les journées se retrouveraient réunies sous chaque date : une
 * course que son service ne fait rouler que le dimanche serait déclarée modifiée le samedi.
 */
export function buildDetourEntities(
	gtfs: StaticGtfs,
	modifications: ReadonlyMap<number, ResolvedModification>,
	cancelIndex: CancelIndex,
	provisional: ReadonlyMap<string, ProvisionalStop>,
	nowSeconds: number,
): GtfsRealtime.transit_realtime.IFeedEntity[] {
	const stops = new Map<string, GtfsRealtime.transit_realtime.IStop>();
	const shapes = new Map<string, GtfsRealtime.transit_realtime.IShape>();
	const entities: GtfsRealtime.transit_realtime.IFeedEntity[] = [];
	/**
	 * Ce qui a empêché une déclaration de sortir, ou de sortir entière. Un ensemble, et non une liste :
	 * les mêmes constats se reposent à l'identique sur des centaines de courses, et le journal n'a
	 * besoin de les lire qu'une fois.
	 */
	const problems = new Set<string>();

	const candidates = collectCandidates(gtfs, modifications, provisional, problems);
	if (candidates.size === 0) {
		report(modifications.size, 0, stops, shapes, entities, problems);
		return [];
	}

	/** Les arrêts provisoires qu'une modification publiée désigne — eux seuls entrent dans le feed. */
	const referenced = new Set<string>();
	/** Les tronçons qui ont fini par s'appliquer à au moins une course. */
	const applied = new Set<string>();
	/** Les tracés recousus, par itinéraire d'origine et combinaison de tronçons. */
	const splicedShapes = new Map<string, string | null>();

	for (const day of serviceDays(gtfs, CANDIDATE_DAYS)) {
		/** Les courses du jour qui reçoivent exactement les mêmes modifications et le même itinéraire. */
		const groups = new Map<string, Group>();

		for (const serviceId of day.services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined) continue;

				const applicable = candidates.get(`${meta.routeId}:${meta.directionId}`);
				if (applicable === undefined) continue;

				// La course a fini de circuler : on publie le reste de la journée d'un bloc, comme pour les
				// trip updates reconstruits.
				const arrival = gtfs.tripArrivals.get(tripId);
				if (arrival === undefined || day.midnight + arrival < nowSeconds) continue;

				// Annulée, la course ne roule pas : elle n'a pas d'itinéraire à modifier.
				if (isCancelled(cancelIndex, gtfs, tripId, day.midnight)) continue;

				const schedule = gtfs.tripStopSequences.get(tripId);
				if (schedule === undefined) continue;

				const matched = matchOnTrip(applicable, schedule, gtfs.tripPatterns.get(tripId));
				if (matched.length === 0) continue;

				// Les deux natures de tronçon se séparent ici, et ne se revoient qu'au tracé. Un tronçon
				// qui ne supprime rien n'a pas de `Modification` à replier avec les autres : il n'en
				// produit aucune, et ce qu'il dessine se coud dans la shape comme le reste.
				const resolved = mergeOverlaps(
					gtfs,
					matched.filter((entry) => entry.candidate.removes),
					schedule,
					problems,
				);
				const reroutes = matched.filter((entry) => !entry.candidate.removes);

				for (const modification of resolved) for (const part of modification.parts) applied.add(part);
				for (const entry of reroutes) applied.add(entry.candidate.label);

				const signature =
					`${meta.shapeId}|${resolved.map(signatureOf).join(";")}` +
					`|${reroutes.map((entry) => entry.candidate.label).join(";")}`;
				const group = groups.get(signature);
				if (group === undefined)
					groups.set(signature, { modifications: resolved, reroutes, shapeId: meta.shapeId, tripIds: [tripId] });
				else group.tripIds.push(tripId);
			}
		}

		for (const [signature, group] of groups) {
			const parts = [
				...group.modifications.map((modification) => modification.parts.join("+")),
				...group.reroutes.map((entry) => entry.candidate.label),
			].join("-");
			// Les mêmes tronçons ne donnent pas forcément la même chose sur deux branches : des horaires
			// différents les replient différemment. L'empreinte de la signature tranche, et reste la même
			// d'un relevé à l'autre tant que la déclaration ne bouge pas.
			const fingerprint = createHash("sha1").update(signature).digest("hex").slice(0, 8);
			const shapeId = resolveShapeId(gtfs, shapes, splicedShapes, problems, parts, fingerprint, group);

			// Une entité qui ne porterait ni modification ni tracé ne dirait rien : c'est le cas d'un
			// tronçon sans suppression dont la shape n'a pas pu être recousue, et le journal l'a dit.
			if (group.modifications.length === 0 && shapeId === null) continue;

			entities.push({
				id: `TM:TCAR:${parts}:${day.date}:${fingerprint}`,
				tripModifications: {
					selectedTrips: [{ tripIds: group.tripIds, shapeId: shapeId ?? undefined }],
					serviceDates: [day.date],
					// `start_times` ne sert qu'à désigner un départ précis d'une course à fréquence. Les
					// courses sont ici énumérées une à une : une liste non vide ne ferait que restreindre à
					// tort ce qui est déjà désigné sans ambiguïté.
					startTimes: [],
					modifications: group.modifications.map((modification) => ({
						// Toujours par identifiant d'arrêt, jamais par rang : une même modification couvre
						// des dizaines de courses dont les `stop_sequence` ne coïncident pas.
						startStopSelector: { stopId: modification.startStopId },
						endStopSelector: { stopId: modification.endStopId },
						propagatedModificationDelay: modification.propagatedDelay,
						replacementStops: modification.stops.map((stop) => ({
							stopId: stop.stopId,
							travelTimeToStop: stop.travelTime,
						})),
						// Facultatif dans la spécification : une modification sans info trafic n'en cite aucune.
						// Celle qu'elle cite est republiée dans le même feed, sous l'identifiant préfixé.
						serviceAlertId: modification.alertId === null ? undefined : republishedAlertId(modification.alertId),
						lastModifiedTime: modification.lastModifiedTime,
					})),
				},
			});

			// Les arrêts du GTFS ne sont jamais republiés : ils y sont déjà, et les redéclarer reviendrait
			// à en proposer une seconde version, avec le risque qu'elle prenne le pas sur la bonne. Ne
			// restent que les arrêts provisoires, publiés parce qu'une modification les désigne — et non
			// parce qu'une déviation les posséderait.
			for (const modification of group.modifications) {
				for (const stop of modification.stops) if (provisional.has(stop.stopId)) referenced.add(stop.stopId);
			}
		}
	}

	// Un tronçon dont aucune course ne relève ne laisse rien dans le feed, pas même ses arrêts. C'est le
	// cas à surveiller — des bornes qui ne figurent pas sur l'horaire théorique des courses, parce
	// qu'elles ont été prises sur une autre branche ou que le GTFS a renuméroté ses quais.
	for (const list of candidates.values()) {
		for (const candidate of list) {
			if (applied.has(candidate.label)) continue;
			problems.add(
				`${candidate.label} — aucune course de ${lineOf(gtfs, candidate.routeId)} sens ${candidate.directionId} ` +
					(candidate.patternIds === null ? "" : `sur ${[...candidate.patternIds].join(", ")} `) +
					`ne dessert ${candidate.startStopId} puis ${candidate.endStopId} d'ici la fin du service : ` +
					(candidate.patternIds === null ? "vérifier les bornes." : "vérifier les bornes et les tracés visés."),
			);
		}
	}

	for (const stopId of referenced) {
		const stop = provisional.get(stopId) as ProvisionalStop;
		stops.set(stopId, {
			stopId,
			stopName: { translation: [{ text: stop.name, language: "fr" }] },
			stopLat: stop.latitude,
			stopLon: stop.longitude,
		});
	}

	report(modifications.size, applied.size, stops, shapes, entities, problems);

	return [
		...stops.entries().map(([stopId, stop]) => ({ id: `ST:${stopId}`, stop })),
		...shapes.entries().map(([shapeId, shape]) => ({ id: `SH:${shapeId}`, shape })),
		...entities,
	];
}

/**
 * Le nombre de courses qu'un tronçon modifierait avec ces bornes, toutes journées de service
 * confondues, par tracé emprunté. L'interface s'en sert pour le dire AVANT l'enregistrement : des
 * bornes que l'horaire théorique ne porte pas ne sélectionnent rien, et le tronçon n'entre alors pas
 * dans le feed. Le détail par tracé dit en plus lesquels desservent ces bornes.
 */
export function countSelectableTrips(
	gtfs: StaticGtfs,
	routeId: string,
	directionId: number,
	startStopId: string,
	endStopId: string,
	nowSeconds: number,
): Map<string, number> {
	const counts = new Map<string, number>();

	for (const day of serviceDays(gtfs, CANDIDATE_DAYS)) {
		for (const serviceId of day.services) {
			for (const tripId of gtfs.serviceTrips.get(serviceId) ?? []) {
				const meta = gtfs.trips.get(tripId);
				if (meta === undefined || meta.routeId !== routeId || meta.directionId !== directionId) continue;

				const arrival = gtfs.tripArrivals.get(tripId);
				if (arrival === undefined || day.midnight + arrival < nowSeconds) continue;

				const schedule = gtfs.tripStopSequences.get(tripId);
				const patternId = gtfs.tripPatterns.get(tripId);
				if (schedule === undefined || patternId === undefined) continue;
				if (boundsOn(schedule, startStopId, endStopId) === undefined) continue;

				counts.set(patternId, (counts.get(patternId) ?? 0) + 1);
			}
		}
	}

	return counts;
}

// ---

/**
 * Les tronçons publiables, indexés par ligne et sens. Tout ce qui empêche un segment de sortir se
 * juge ici, une fois pour toutes : au-delà, on ne raisonne plus que sur des courses.
 */
function collectCandidates(
	gtfs: StaticGtfs,
	modifications: ReadonlyMap<number, ResolvedModification>,
	provisional: ReadonlyMap<string, ProvisionalStop>,
	problems: Set<string>,
): Map<string, Candidate[]> {
	const candidates = new Map<string, Candidate[]>();

	for (const modification of modifications.values()) {
		// Hors période ou invisible, la modification ne s'annonce pas : c'est un choix ou un calendrier,
		// pas un problème, et le journal n'a rien à en dire. Celles dont l'info trafic a quitté le flux
		// ne sont pas même indexées.
		if (!modification.active || modification.disabled) continue;
		const record = modification.record;

		record.segments.forEach((segment, rank) => {
			const label = `M${record.uid}#${rank}`;
			const { startStopId, endStopId } = segment;
			// Les bornes sont requises quelle que soit la nature du tronçon : publiées ou non, ce sont
			// elles qui désignent les courses concernées.
			if (startStopId === null || endStopId === null) {
				problems.add(`${label} — bornes du tronçon manquantes.`);
				return;
			}

			// La nature du tronçon se lit d'ici : une plage sans arrêt supprimé ne supprime rien, et n'a
			// que son tracé à annoncer.
			const removes = removesStops(
				gtfs,
				record.routeId,
				record.directionId,
				record.patternIds,
				modification.removedStopIds,
				segment,
			);

			if (!removes && segment.path.length < 2) {
				problems.add(`${label} — aucun arrêt supprimé dans sa plage, et pas de tracé : rien à annoncer.`);
				return;
			}

			// Un tronçon peut n'avoir aucun arrêt de substitution : le segment est alors simplement
			// supprimé, et c'est le tracé qui dit par où le véhicule passe à la place. `replacement_stops`
			// admet d'être vide — la spec la veut « de longueur inférieure, égale ou supérieure » aux
			// arrêts remplacés. Il faut seulement qu'il annonce QUELQUE CHOSE : sans arrêt ni tracé, il ne
			// dit rien que les `SKIPPED` des trip updates ne disent déjà.
			if (removes && segment.stops.length === 0 && segment.path.length < 2) {
				problems.add(`${label} — ni arrêt de substitution ni tracé : rien à annoncer.`);
				return;
			}

			// Le périmètre a pu changer après coup : des arrêts de substitution saisis quand la plage
			// supprimait encore n'ont plus rien à remplacer. Ils sont laissés de côté, et le journal le
			// dit — les publier reviendrait à ajouter des arrêts à une course qui n'en perd aucun.
			if (!removes && (segment.stops.length > 0 || segment.propagatedDelay !== 0)) {
				problems.add(
					`${label} — aucun arrêt supprimé dans sa plage : ses arrêts de substitution et son délai ` +
						"propagé sont ignorés, seul le tracé est publié.",
				);
			}

			// Un arrêt provisoire disparu de la base ne se rattrape pas : publier la modification laisserait
			// un `stop_id` que rien ne définit, et un consommateur ne saurait qu'en faire.
			const dangling = segment.stops.filter(
				(stop) => provisionalStopUid(stop.stopId) !== undefined && !provisional.has(stop.stopId),
			);
			if (dangling.length > 0) {
				problems.add(
					`${label} — désigne ${dangling.map((stop) => stop.stopId).join(", ")}, absent de la base des arrêts provisoires : arrêt à recréer ou à retirer.`,
				);
				return;
			}

			const routeDirection = `${record.routeId}:${record.directionId}`;
			const list = candidates.get(routeDirection);
			const candidate: Candidate = {
				label,
				removes,
				alertId: modification.alertId,
				routeId: record.routeId,
				directionId: record.directionId,
				patternIds: record.patternIds.length === 0 ? null : new Set(record.patternIds),
				startStopId,
				endStopId,
				propagatedDelay: removes ? segment.propagatedDelay : 0,
				stops: removes ? segment.stops.map((stop) => ({ stopId: stop.stopId, travelTime: stop.travelTime })) : [],
				path: segment.path,
				updatedAt: record.updatedAt,
			};
			if (list === undefined) candidates.set(routeDirection, [candidate]);
			else list.push(candidate);
		});
	}

	return candidates;
}

/**
 * Les tronçons que l'horaire théorique de cette course porte, dans l'ordre où elle les rencontre.
 *
 * Un tronçon n'est retenu que si l'horaire porte ses DEUX bornes, dans l'ordre : c'est ce qui écarte
 * les branches et les services partiels qui ne passent pas par le segment dévié, sans avoir à les
 * deviner. S'il nomme des tracés, la course doit en plus emprunter l'un d'eux.
 */
function matchOnTrip(
	candidates: readonly Candidate[],
	schedule: TripStop[],
	patternId: string | undefined,
): Applicable[] {
	const matched: Applicable[] = [];

	for (const candidate of candidates) {
		if (candidate.patternIds !== null && (patternId === undefined || !candidate.patternIds.has(patternId))) continue;
		const bounds = boundsOn(schedule, candidate.startStopId, candidate.endStopId);
		if (bounds !== undefined) matched.push({ candidate, ...bounds });
	}

	return matched.sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
}

/** Le rang des deux bornes dans un horaire, ou `undefined` s'il ne les porte pas dans l'ordre. */
function boundsOn(
	schedule: TripStop[],
	startStopId: string,
	endStopId: string,
): { startIndex: number; endIndex: number } | undefined {
	const startIndex = schedule.findIndex((stop) => stop.stopId === startStopId);
	const endIndex = schedule.findIndex((stop) => stop.stopId === endStopId);
	if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return undefined;
	return { startIndex, endIndex };
}

/**
 * Replie en une seule `Modification` les tronçons qu'une course ne peut pas porter séparément.
 *
 * Un `ReplacementStop.travel_time_to_stop` se compte depuis l'ARRÊT DE RÉFÉRENCE de sa modification,
 * celui qui précède immédiatement sa borne amont. Deux tronçons doivent donc fusionner dès que la
 * référence du second tombe dans ce que le premier supprime — ce qui arrive dans deux cas :
 *
 *  - ils se RECOUVRENT : les mêmes arrêts seraient supprimés deux fois, et la spécification ne dit
 *    pas ce qu'un consommateur devrait en faire. C'est une erreur de saisie, et le journal le dit ;
 *  - ils se SUIVENT, la borne amont du second venant juste après la borne aval du premier : sa
 *    référence est alors le dernier arrêt supprimé par le premier. Publier deux modifications ferait
 *    compter les horaires du second depuis un arrêt que la course ne dessert plus — le consommateur
 *    retomberait sur la référence du premier, et tout le second tronçon serait décalé d'autant. Rien
 *    n'est fautif ici : c'est la seule façon de l'écrire, et il n'y a rien à signaler.
 *
 * Dans les deux cas, la modification fusionnée prend les bornes au plus large, met les arrêts de
 * substitution bout à bout, additionne les délais propagés, et REBASE les temps du second sur la
 * référence du premier — la seule qui survive.
 */
function mergeOverlaps(
	gtfs: StaticGtfs,
	matched: Applicable[],
	schedule: TripStop[],
	problems: Set<string>,
): Modification[] {
	const merged: Modification[] = [];

	for (const { candidate, startIndex, endIndex } of matched) {
		const previous = merged.at(-1);
		// La référence du tronçon est l'arrêt qui précède sa borne amont : il faut fusionner dès qu'elle
		// tombe dans ce que le précédent supprime, donc dès `startIndex - 1 <= previous.endIndex`.
		if (previous === undefined || startIndex - 1 > previous.endIndex) {
			merged.push({
				parts: [candidate.label],
				startStopId: candidate.startStopId,
				endStopId: candidate.endStopId,
				startIndex,
				endIndex,
				propagatedDelay: candidate.propagatedDelay,
				stops: [...candidate.stops],
				paths: candidate.path.length >= 2 ? [candidate.path] : [],
				alertId: candidate.alertId,
				lastModifiedTime: candidate.updatedAt,
			});
			continue;
		}

		const offset = rebaseOffset(schedule, previous.startIndex, startIndex);

		// Le recouvrement, lui, se signale : deux infos trafic qui suppriment les mêmes arrêts décrivent
		// probablement la même perturbation, et leurs délais propagés se comptent alors deux fois.
		if (startIndex <= previous.endIndex) {
			problems.add(
				`${previous.parts.join("+")} et ${candidate.label} se recouvrent sur ${lineOf(gtfs, candidate.routeId)} sens ` +
					`${candidate.directionId} : fusionnés en une seule modification. À ressaisir en un seul tronçon.`,
			);
		}
		if (offset === undefined) {
			problems.add(
				`${previous.parts.join("+")} et ${candidate.label} : horaire théorique incomplet, les temps de ` +
					"parcours du second n'ont pas pu être rebasés sur la référence du premier.",
			);
		}

		previous.parts.push(candidate.label);
		if (endIndex > previous.endIndex) {
			previous.endIndex = endIndex;
			previous.endStopId = candidate.endStopId;
		}
		previous.propagatedDelay += candidate.propagatedDelay;
		previous.lastModifiedTime = Math.max(previous.lastModifiedTime, candidate.updatedAt);
		if (candidate.path.length >= 2) previous.paths.push(candidate.path);

		for (const stop of candidate.stops) {
			if (previous.stops.some((existing) => existing.stopId === stop.stopId)) continue;
			previous.stops.push({ stopId: stop.stopId, travelTime: stop.travelTime + (offset ?? 0) });
		}

		// La spec veut les temps strictement croissants, et le rebasage n'en donne pas la garantie : deux
		// tronçons qui se recouvrent se recouvrent aussi dans le temps. On les écarte d'une seconde plutôt
		// que de publier une suite que le consommateur refuserait.
		for (const [index, stop] of previous.stops.entries()) {
			const before = previous.stops[index - 1];
			if (before !== undefined && stop.travelTime <= before.travelTime) stop.travelTime = before.travelTime + 1;
		}
	}

	return merged;
}

/**
 * Le temps qui sépare les arrêts de référence de deux tronçons sur cette course — celui qui précède
 * chacune de leurs bornes amont —, d'après l'horaire théorique.
 *
 * C'est de quoi décaler les temps de parcours du second pour les rapporter à la référence du premier,
 * et c'est exact : `stop_times.txt` donne l'arrivée à chaque arrêt, il n'y a rien à estimer.
 *
 * `undefined` lorsque l'horaire ne donne pas l'une des deux arrivées — mieux vaut ne rien décaler que
 * décaler n'importe comment, et le journal le dit.
 */
function rebaseOffset(schedule: TripStop[], fromStartIndex: number, toStartIndex: number): number | undefined {
	// Une borne amont qui ouvre la course n'a pas d'arrêt de référence : c'est elle-même, et les temps
	// se comptent alors depuis son arrivée (cf. `DetourStop.travelTime`).
	const from = schedule[Math.max(fromStartIndex - 1, 0)];
	const to = schedule[Math.max(toStartIndex - 1, 0)];
	if (from === undefined || to === undefined) return undefined;
	if (!Number.isFinite(from.arrival) || !Number.isFinite(to.arrival)) return undefined;

	return Math.round(to.arrival - from.arrival);
}

/**
 * Ce qui distingue une modification d'une autre, pour réunir les courses qui reçoivent la même.
 *
 * Les temps de parcours en font partie, et c'est indispensable depuis qu'une fusion les rebase sur
 * l'horaire théorique : deux courses de la même ligne ne mettent pas le même temps entre les deux
 * arrêts de référence — l'heure de pointe n'est pas le dimanche matin —, et les réunir publierait
 * pour l'une les horaires de l'autre.
 */
function signatureOf(modification: Modification): string {
	const stops = modification.stops.map((stop) => `${stop.stopId}@${stop.travelTime}`).join(",");
	return (
		`${modification.parts.join("+")}:${modification.startStopId}>${modification.endStopId}` +
		`/${modification.propagatedDelay}/${stops}`
	);
}

/**
 * L'identifiant du tracé dévié correspondant à l'itinéraire d'origine de ces courses, en l'inscrivant
 * au feed au passage. `null` lorsqu'il n'y a rien à publier — aucun tracé dessiné, itinéraire inconnu,
 * ou recouture impossible : la `SelectedTrips` sort alors sans `shape_id`, le champ étant facultatif.
 *
 * Mémoïsé par itinéraire ET par combinaison de tronçons : le même itinéraire ne se recoud pas de la
 * même façon selon ce qui s'y applique, et la même combinaison revient sur toutes les journées.
 */
function resolveShapeId(
	gtfs: StaticGtfs,
	shapes: Map<string, GtfsRealtime.transit_realtime.IShape>,
	spliced: Map<string, string | null>,
	problems: Set<string>,
	parts: string,
	fingerprint: string,
	group: Group,
): string | null {
	const memo = `${group.shapeId}|${fingerprint}`;
	const known = spliced.get(memo);
	if (known !== undefined) return known;

	const shapeId = buildShape(gtfs, shapes, problems, parts, fingerprint, group);
	spliced.set(memo, shapeId);
	return shapeId;
}

function buildShape(
	gtfs: StaticGtfs,
	shapes: Map<string, GtfsRealtime.transit_realtime.IShape>,
	problems: Set<string>,
	parts: string,
	fingerprint: string,
	group: Group,
): string | null {
	const paths = [
		...group.modifications.flatMap((modification) => modification.paths),
		...group.reroutes.map((entry) => entry.candidate.path),
	];
	if (paths.length === 0) return null;

	const original = gtfs.shapes.get(group.shapeId);
	if (original === undefined) {
		problems.add(`${parts} — ${group.shapeId} absent du GTFS, tracé non publié pour ces courses.`);
		return null;
	}

	const outcome = spliceShape(original, paths);
	if (!outcome.ok) {
		problems.add(`${parts} — ${group.shapeId} : tracé ou itinéraire réduit à moins de deux points.`);
		return null;
	}

	// Les seuls reproches qu'on se permette : un point de divergence loin de l'itinéraire, et un tracé
	// laissé de côté. Le trajet est publié tel quel — il se voit dans l'éditeur, qui en montre le
	// résultat — mais un raccord à plusieurs centaines de mètres vaut d'être signalé.
	for (const offset of outcome.startOffsets) {
		if (offset > MAX_DETOUR_JUNCTION_OFFSET) {
			problems.add(
				`${parts} — ${group.shapeId} : tracé publié, mais un point de départ est à ${Math.round(offset * 1000)} m de l'itinéraire.`,
			);
		}
	}
	if (outcome.unreachable > 0) {
		problems.add(
			`${parts} — ${group.shapeId} : ${outcome.unreachable} tracé(s) laissé(s) de côté, la course ne les atteint pas dans cet ordre.`,
		);
	}

	const shapeId = `TCAR:DEV:${parts}:${suffixOf(group.shapeId)}:${fingerprint}`;
	shapes.set(shapeId, { shapeId, encodedPolyline: encodePolyline(outcome.points) });
	return shapeId;
}

function report(
	declared: number,
	applied: number,
	stops: Map<string, unknown>,
	shapes: Map<string, unknown>,
	modifications: readonly unknown[],
	problems: ReadonlySet<string>,
) {
	if (declared === 0) return;

	console.log(
		`✓ ${applied} detour segments published (${stops.size} stops, ${shapes.size} shapes, ${modifications.length} modifications).`,
	);
	for (const problem of problems) console.warn(`\t✘ ${problem}`);
}

/** Le nom commercial de la ligne (« TCAR:07 » → « F7 »), ou à défaut le bout de son identifiant. */
function lineOf(gtfs: StaticGtfs, routeId: string): string {
	return gtfs.routeNames.get(routeId) ?? routeId.split(":").at(-1) ?? routeId;
}

/** La part distinctive d'un identifiant d'itinéraire, pour en dériver celui du tracé recousu. */
function suffixOf(shapeId: string): string {
	return shapeId.split(":").at(-1) ?? shapeId;
}
