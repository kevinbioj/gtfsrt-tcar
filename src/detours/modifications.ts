import type { AlertPeriod } from "../ai/analyze-alert.js";
import {
	type AnalyzedAlert,
	type CancelEntry,
	type CancelIndex,
	type CancelWindow,
	emptyCancelIndex,
	isActive,
	lastPeriodEnd,
	type SkipBucket,
	type SkipIndex,
} from "../gtfs-rt/use-service-alerts.js";
import { courseKey, type RoutePattern, type StaticGtfs } from "../gtfs-rt/use-static-gtfs.js";
import { rangeOn } from "./bounds.js";
import { type AlertOverrides, type DetourStore, type Modification, scopeKey, type TripSet } from "./store.js";

/**
 * Une info trafic telle que l'activation la voit : ce que le flux en dit, ce qu'on en a réglé, ce que
 * l'IA y lit, et les modifications qui lui sont associées.
 */
export type ResolvedAlert = {
	/** L'identifiant d'entité du flux amont, que porte `serviceAlertId` ; `null` faute de dernier relevé. */
	alertId: string | null;
	alertNumber: string;
	headerText: string;
	/** Le texte de l'info trafic, en HTML brut. */
	descriptionText: string;
	routeIds: string[];
	/** Au flux en ce moment. Sinon, elle n'est là que parce que des modifications lui restent associées. */
	inFeed: boolean;
	/** Masquée : sans aucun effet, et plus republiée. */
	hidden: boolean;
	/** Au flux et visible : ses périodes, et elles seules, décident de ce qu'elle active. */
	effective: boolean;
	/** Les périodes saisies, sinon celles de l'analyse. */
	periods: AlertPeriod[];
	/** Celles de l'analyse, saisies ou non. */
	analysisPeriods: AlertPeriod[];
	periodsOverridden: boolean;
	/** Effective, et l'une de ses périodes couvre l'instant de l'indexation. */
	active: boolean;
	/** Les suppressions d'arrêts que l'IA lit, ligne par ligne et sens par sens, et ce qu'on en a corrigé. */
	aiSkips: AiSkip[];
	/** Les modifications qui lui sont associées. */
	modificationUids: number[];
	/** Les ensembles de courses qu'elle annule, chaque jour où elle vaut. */
	tripSets: readonly TripSet[];
	/** Ce qui se réécrit de l'alerte republiée. */
	overrides: AlertOverrides;
	/** Première apparition : l'ordre chronologique. */
	firstSeenAt: number;
};

/**
 * Des quais supprimés sur une ligne et dans un sens : ceux que lit l'IA — sauf si le sens est ignoré —,
 * corrigés arrêt par arrêt. Ils sautent tant que l'info trafic vaut, sauf remplacés par une déviation
 * associée sur cette ligne et dans ce sens : c'est alors elle qui dit quels arrêts sont supprimés.
 */
export type AiSkip = {
	routeId: string;
	directionId: number;
	/** Ce que lit l'analyse. */
	aiStopIds: string[];
	/** Les corrections : quai → supprimé (vrai) ou desservi (faux). */
	overrides: Map<string, boolean>;
	/** Ce qui saute, corrections faites. */
	stopIds: string[];
	ignored: boolean;
	/** Les déviations associées qui portent la même ligne et le même sens. */
	replacedBy: number[];
};

/** Une info trafic associée, telle qu'une modification la cite. */
export type AlertLink = Pick<ResolvedAlert, "alertNumber" | "headerText" | "inFeed" | "hidden" | "active">;

/**
 * Une modification telle que tout le reste la voit : ce qui a été saisi, et ce que ses infos trafic
 * associées — ou son activation à la main — en font.
 */
export type ResolvedModification = {
	uid: number;
	description: string | null;
	routeId: string;
	directionId: number;
	/** Les tracés visés, ou aucun pour tous. */
	patternIds: string[];
	/** Activée à la main : elle vaut, quoi que deviennent ses infos trafic. */
	manual: boolean;
	/** Ses infos trafic associées, au flux ou non. */
	alerts: AlertLink[];
	/**
	 * L'info trafic que cite son `serviceAlertId` : la première associée qui est en vigueur, à défaut
	 * la première effective ; `null` s'il n'y en a aucune.
	 */
	alertId: string | null;
	/**
	 * Aucune, donc sans fin, pour une modification activée à la main ; sinon la réunion des périodes de
	 * ses infos trafic effectives — sans fin dès que l'une n'en a pas.
	 */
	periods: AlertPeriod[];
	/** Vrai lorsqu'elle vaut à l'instant de l'indexation. */
	active: boolean;
	/**
	 * Ne publie rien — ni tronçon, ni arrêt sauté, ni course annulée : ni activée à la main, ni associée à
	 * une info trafic effective.
	 */
	silent: boolean;
	/**
	 * La période de communication de ses trip modifications, en secondes epoch : de son dernier
	 * enregistrement à la fin de sa dernière période, exclue — `null` si rien ne la borne. Ce n'est
	 * que pendant celle-ci qu'elles sortent dans le feed, pour les courses qui passent pendant l'une
	 * des périodes (cf. `buildDetourEntities`).
	 */
	communication: { start: number; end: number | null };
	/**
	 * Ses tronçons écrasés à l'instant de l'indexation : rang du tronçon → tracés sur lesquels un
	 * tronçon plus prioritaire, actif, en recouvre la plage (cf. `resolveOverrides`).
	 */
	overridden: Map<number, Set<string>>;
	/** Les quais supprimés. */
	removedStopIds: Set<string>;
	/** Ce qui a été saisi, tel quel. */
	record: Modification;
};

export type ModificationIndex = ReturnType<typeof useModificationIndex>;

/**
 * Les modifications et les infos trafic résolues, les arrêts à sauter et les courses à annuler —
 * rebâtis d'un bloc.
 *
 * `reindex` est purement local : il relit la dernière analyse et la base, sans toucher au réseau ni
 * rappeler l'IA. Il se rejoue donc à chaque relevé d'infos trafic comme après chaque saisie.
 */
export function useModificationIndex(
	store: DetourStore,
	gtfs: { data: StaticGtfs },
	alerts: () => readonly AnalyzedAlert[],
) {
	const resource = {
		/** Les modifications, par uid. */
		modifications: new Map<number, ResolvedModification>(),
		/** Les infos trafic du flux, et celles qui l'ont quitté en gardant des modifications associées, par numéro. */
		alerts: new Map<string, ResolvedAlert>(),
		/** Les quais à sauter dans les trip updates, chacun avec ses périodes (cf. `SkipBucket`). */
		skipIndex: new Map() as SkipIndex,
		/** Les courses à annuler, par clé de course ou par tranche horaire. */
		cancelIndex: emptyCancelIndex(),
		reindex() {
			const now = Temporal.Now.instant();
			const current = alerts();

			store.recordAlerts(current, Math.floor(now.epochMilliseconds / 1000));

			const indexed = indexModifications(current, store, gtfs.data, now);
			resource.modifications = indexed.modifications;
			resource.alerts = indexed.alerts;
			resource.skipIndex = indexed.skipIndex;
			resource.cancelIndex = indexed.cancelIndex;
		},
	};

	resource.reindex();
	return resource;
}

// ---

/**
 * Résout les infos trafic, puis les modifications, et en tire les arrêts à sauter et les courses à
 * annuler.
 *
 * Une info trafic sortie du flux n'active plus rien : ses associations restent en base, et elle reste
 * listée d'après son dernier relevé tant qu'il lui en reste — le réseau remplace souvent une info
 * trafic par une autre, sous un autre numéro, avant la fin de la perturbation, et il n'y a alors qu'à
 * associer la nouvelle.
 *
 * La priorité départage les tronçons qui se recouvrent (cf. `resolveOverrides`) : une déviation qui
 * en recouvre une autre le temps d'un chantier l'emporte, sans que les deux se replient l'une dans
 * l'autre. Le reste de la modification écrasée — ses autres tronçons, ses arrêts supprimés ailleurs, ses
 * courses annulées — continue de s'appliquer.
 */
function indexModifications(
	current: readonly AnalyzedAlert[],
	store: DetourStore,
	gtfs: StaticGtfs,
	now: Temporal.Instant,
) {
	const nowSeconds = Math.floor(now.epochMilliseconds / 1000);
	const records = [...store.modifications.values()];
	const live = new Set(current.map((alert) => alert.alertNumber));

	// Celles du flux, puis celles qui l'ont quitté et que des modifications citent encore.
	const sources: { alert: AnalyzedAlert; inFeed: boolean }[] = current.map((alert) => ({ alert, inFeed: true }));
	const withdrawn = new Set(records.flatMap((record) => record.alertNumbers).filter((number) => !live.has(number)));
	for (const alertNumber of withdrawn) {
		const alert = store.alertSnapshots.get(alertNumber) ?? {
			alertId: null,
			alertNumber,
			headerText: store.alertHeaders.get(alertNumber) ?? "",
			descriptionText: "",
			periods: [],
			routeIds: [],
			contributions: [],
		};
		sources.push({ alert, inFeed: false });
	}

	const alerts = new Map<string, ResolvedAlert>();
	for (const { alert, inFeed } of sources) {
		const settings = store.alertSettings(alert.alertNumber);
		const periods = settings.periods ?? alert.periods;
		const effective = inFeed && !settings.hidden;
		const associated = records.filter((record) => record.alertNumbers.includes(alert.alertNumber));

		alerts.set(alert.alertNumber, {
			alertId: alert.alertId,
			alertNumber: alert.alertNumber,
			headerText: alert.headerText,
			descriptionText: alert.descriptionText,
			// Un impact réécrit dit à lui seul quelles lignes l'info trafic touche.
			routeIds:
				settings.impact === null
					? alert.routeIds
					: [
							...new Set(
								settings.impact.entities.flatMap(({ routeId }) =>
									routeId !== null && gtfs.routeDirections.has(routeId) ? [routeId] : [],
								),
							),
						],
			inFeed,
			hidden: settings.hidden,
			effective,
			periods,
			analysisPeriods: alert.periods,
			periodsOverridden: settings.periods !== null,
			active: effective && isActive(periods, now),
			aiSkips: aiSkipsOf(alert, associated, store),
			modificationUids: associated.map((record) => record.uid),
			tripSets: store.alertTripSets(alert.alertNumber),
			overrides: settings.overrides,
			firstSeenAt: store.alertFirstSeen.get(alert.alertNumber) ?? nowSeconds,
		});
	}

	const modifications = new Map<number, ResolvedModification>();
	for (const record of records) {
		const linked = record.alertNumbers.flatMap((alertNumber) => {
			const alert = alerts.get(alertNumber);
			return alert === undefined ? [] : [alert];
		});
		const effective = linked.filter((alert) => alert.effective);
		const silent = !record.manual && effective.length === 0;
		// Une info trafic sans période vaut tant qu'elle est au flux : la réunion n'a alors plus de borne.
		const periods =
			record.manual || effective.some((alert) => alert.periods.length === 0)
				? []
				: effective.flatMap((alert) => alert.periods);
		const end = lastPeriodEnd(periods);

		modifications.set(record.uid, {
			uid: record.uid,
			description: record.description,
			routeId: record.routeId,
			directionId: record.directionId,
			patternIds: record.patternIds,
			manual: record.manual,
			alerts: linked.map(({ alertNumber, headerText, inFeed, hidden, active }) => ({
				alertNumber,
				headerText,
				inFeed,
				hidden,
				active,
			})),
			alertId: (effective.find((alert) => alert.active) ?? effective[0])?.alertId ?? null,
			periods,
			active: !silent && isActive(periods, now),
			silent,
			communication: {
				start: record.updatedAt,
				end: end === null ? null : Math.floor(end.epochMilliseconds / 1000),
			},
			overridden: new Map(),
			removedStopIds: new Set(record.removedStopIds),
			record,
		});
	}

	const skipIndex: SkipIndex = new Map();
	const cancelIndex: CancelIndex = emptyCancelIndex();
	const pushSkip = (routeId: string, bucket: SkipBucket) => {
		const buckets = skipIndex.get(routeId) ?? [];
		buckets.push(bucket);
		skipIndex.set(routeId, buckets);
	};

	// Ce que l'info trafic porte elle-même — les suppressions de l'IA, ni ignorées ni remplacées, et les
	// courses annulées —, tant qu'elle est effective. Les annulations ne se jaugent pas maintenant mais
	// course par course, à son départ (cf. `isCancelled`).
	for (const alert of alerts.values()) {
		if (!alert.effective) continue;
		for (const set of alert.tripSets) {
			pushCancellations(cancelIndex, set.routeId, set.directionId, [set], { patternIds: null, periods: alert.periods });
		}
		for (const skip of alert.aiSkips) {
			if (skip.replacedBy.length > 0 || skip.stopIds.length === 0) continue;
			pushSkip(skip.routeId, {
				directionId: skip.directionId,
				patternIds: null,
				periods: alert.periods,
				stopIds: new Set(skip.stopIds),
			});
		}
	}

	const contenders = [...modifications.values()].filter((modification) => modification.active);
	const yielded = resolveOverrides(contenders, gtfs);

	for (const modification of modifications.values()) {
		const { record, periods, removedStopIds, silent } = modification;
		// Muette, elle ne fait rien sauter ni n'annule rien. Hors période, si : ses arrêts ne sautent que
		// sur les courses qui passent à leurs bornes pendant l'une de ses périodes, et le feed porte les
		// vingt-quatre heures à venir.
		if (silent) continue;
		const patternIds = record.patternIds.length === 0 ? null : new Set(record.patternIds);

		// Ses annulations se jaugent course par course, comme celles des infos trafic, sur ses seuls tracés.
		// Aucun tronçon ne les écrase : une priorité départage des tracés, pas des services.
		pushCancellations(cancelIndex, record.routeId, record.directionId, record.tripSets, { patternIds, periods });

		if (removedStopIds.size > 0) {
			const ceded = yielded.get(record.uid);
			if (ceded === undefined) {
				pushSkip(record.routeId, { directionId: record.directionId, patternIds, periods, stopIds: removedStopIds });
			} else {
				// Là où l'un de ses tronçons est écrasé, c'est la modification prioritaire qui dit quels
				// arrêts sont desservis : tracé par tracé, ses arrêts supprimés s'arrêtent à cette plage.
				for (const pattern of patternsOf(gtfs, modification)) {
					const zone = ceded.get(pattern.patternId);
					const stopIds =
						zone === undefined ? removedStopIds : new Set([...removedStopIds].filter((stopId) => !zone.has(stopId)));
					if (stopIds.size === 0) continue;
					pushSkip(record.routeId, {
						directionId: record.directionId,
						patternIds: new Set([pattern.patternId]),
						periods,
						stopIds,
					});
				}
			}
		}
	}

	console.log(
		`✓ ${modifications.size} modifications and ${alerts.size} alerts indexed (${skipIndex.size} routes with skipped stops, ${cancelIndex.courses.size} cancelled departures, ${cancelIndex.windows.size} routes with cancelled ranges).`,
	);

	return { modifications, alerts, skipIndex, cancelIndex };
}

/** Verse dans l'index les ensembles cochés d'une ligne et d'un sens, chacun valant `entry`. */
function pushCancellations(
	index: CancelIndex,
	routeId: string,
	directionId: number,
	sets: readonly Pick<TripSet, "enabled" | "selection">[],
	entry: CancelEntry,
) {
	for (const { enabled, selection } of sets) {
		if (!enabled) continue;
		if (selection.kind === "range") {
			const key = `${routeId}|${directionId}`;
			const window: CancelWindow = { ...entry, from: selection.from, to: selection.to };
			index.windows.set(key, [...(index.windows.get(key) ?? []), window]);
			continue;
		}
		for (const { stopId, departure } of selection.departures) {
			const key = courseKey(routeId, directionId, stopId, departure);
			index.courses.set(key, [...(index.courses.get(key) ?? []), entry]);
		}
	}
}

/**
 * Les suppressions d'arrêts d'une info trafic, par ligne et par sens : ce que lit l'analyse, et ce
 * qu'on en a corrigé. Une contribution « les deux sens » se dédouble : la maille d'une déviation, qui
 * peut la remplacer, est le sens. Un sens que l'analyse ne cite pas, mais où l'on a supprimé des
 * arrêts à la main, en est un aussi.
 */
function aiSkipsOf(alert: AnalyzedAlert, associated: readonly Modification[], store: DetourStore): AiSkip[] {
	const byScope = new Map<string, AiSkip>();
	const scope = (routeId: string, directionId: number) => {
		const key = scopeKey(alert.alertNumber, routeId, directionId);
		const existing = byScope.get(key);
		if (existing !== undefined) return existing;
		const skip: AiSkip = {
			routeId,
			directionId,
			aiStopIds: [],
			overrides: new Map(),
			stopIds: [],
			ignored: store.ignoredScopes.has(key),
			replacedBy: associated
				.filter((record) => record.routeId === routeId && record.directionId === directionId)
				.map((record) => record.uid),
		};
		byScope.set(key, skip);
		return skip;
	};

	for (const { routeId, directionId, stopIds } of alert.contributions) {
		for (const direction of directionId === null ? [0, 1] : [directionId]) {
			const skip = scope(routeId, direction);
			for (const stopId of stopIds) if (!skip.aiStopIds.includes(stopId)) skip.aiStopIds.push(stopId);
		}
	}
	for (const { routeId, directionId, stopId, removed } of store.alertSkipStops(alert.alertNumber)) {
		scope(routeId, directionId).overrides.set(stopId, removed);
	}

	for (const skip of byScope.values()) {
		const removed = new Set(skip.ignored ? [] : skip.aiStopIds);
		for (const [stopId, verdict] of skip.overrides) {
			if (verdict) removed.add(stopId);
			else removed.delete(stopId);
		}
		skip.stopIds = [...removed];
	}
	return [...byScope.values()];
}

/** La plage d'un tronçon sur un tracé : les rangs de ses deux bornes dans la suite de ses arrêts. */
type Placement = { uid: number; rank: number; priority: number; start: number; end: number };

/**
 * Tranche, tracé par tracé, entre les tronçons en vigueur qui se recouvrent — qui ont au moins un
 * arrêt de leur plage en commun sur un tracé qu'ils visent tous deux. Le plus prioritaire reste,
 * l'autre est écrasé sur ce tracé ; à priorité égale, ils restent tous deux, et la publication les
 * fusionne comme avant (cf. `mergeOverlaps`). Un tronçon qui ne recouvre rien de plus prioritaire
 * n'est jamais touché, fût-il d'une modification dont un autre tronçon l'est.
 *
 * On tranche du plus prioritaire au moins prioritaire, et seul un tronçon qui reste peut en écraser
 * un autre : un tronçon écrasé n'emporte pas avec lui ceux qu'il aurait recouverts.
 *
 * Marque les tronçons écrasés sur leur modification (`overridden`), et rend, pour chaque modification
 * qui en a, les arrêts qu'elle cède sur chaque tracé : la plage de son tronçon écrasé et celle du
 * tronçon qui l'écrase, bout à bout.
 */
function resolveOverrides(
	contenders: readonly ResolvedModification[],
	gtfs: StaticGtfs,
): Map<number, Map<string, Set<string>>> {
	const yielded = new Map<number, Map<string, Set<string>>>();
	const byRouteDirection = new Map<string, ResolvedModification[]>();
	for (const modification of contenders) {
		const key = `${modification.routeId}|${modification.directionId}`;
		byRouteDirection.set(key, [...(byRouteDirection.get(key) ?? []), modification]);
	}

	for (const group of byRouteDirection.values()) {
		const { routeId, directionId } = group[0] as ResolvedModification;
		const byUid = new Map(group.map((modification) => [modification.uid, modification]));

		for (const pattern of gtfs.routePatterns.get(routeId)?.get(directionId) ?? []) {
			const placements = group
				.flatMap((modification) => placementsOn(modification, pattern))
				.sort((a, b) => b.priority - a.priority);

			const kept: Placement[] = [];
			for (const placement of placements) {
				const winner = kept.find((other) => other.priority > placement.priority && overlaps(other, placement));
				if (winner === undefined) {
					kept.push(placement);
					continue;
				}

				const modification = byUid.get(placement.uid) as ResolvedModification;
				const patterns = modification.overridden.get(placement.rank) ?? new Set<string>();
				patterns.add(pattern.patternId);
				modification.overridden.set(placement.rank, patterns);

				const ceded = yielded.get(placement.uid) ?? new Map<string, Set<string>>();
				const zone = ceded.get(pattern.patternId) ?? new Set<string>();
				const from = Math.min(placement.start, winner.start);
				const to = Math.max(placement.end, winner.end);
				for (const stop of pattern.stops.slice(from, to + 1)) zone.add(stop.stopId);
				ceded.set(pattern.patternId, zone);
				yielded.set(placement.uid, ceded);
			}
		}
	}

	return yielded;
}

/**
 * Deux modifications ont-elles des tronçons qui se recouvrent, sur un tracé qu'elles visent toutes
 * deux ? C'est là, et là seulement, que leur priorité départage — quelles que soient leurs périodes.
 */
export function collides(a: ResolvedModification, b: ResolvedModification, gtfs: StaticGtfs): boolean {
	if (a.routeId !== b.routeId || a.directionId !== b.directionId) return false;
	return patternsOf(gtfs, a).some((pattern) => {
		const theirs = placementsOn(b, pattern);
		return placementsOn(a, pattern).some((mine) => theirs.some((other) => overlaps(mine, other)));
	});
}

/** Les tracés du sens que vise une modification — aucun tracé nommé les vise tous. */
function patternsOf(gtfs: StaticGtfs, modification: ResolvedModification): RoutePattern[] {
	const patterns = gtfs.routePatterns.get(modification.routeId)?.get(modification.directionId) ?? [];
	if (modification.patternIds.length === 0) return patterns;
	return patterns.filter((pattern) => modification.patternIds.includes(pattern.patternId));
}

/**
 * Les plages des tronçons d'une modification sur un tracé : aucune s'il n'est pas visé, ni pour un
 * tronçon dont le tracé ne porte pas les deux bornes dans l'ordre — il ne s'y applique pas. Sans
 * borne aval, la plage va jusqu'au bout du tracé (cf. `rangeOn`).
 */
function placementsOn(modification: ResolvedModification, pattern: RoutePattern): Placement[] {
	if (modification.patternIds.length > 0 && !modification.patternIds.includes(pattern.patternId)) return [];

	const placements: Placement[] = [];
	modification.record.segments.forEach((segment, rank) => {
		const range = rangeOn(pattern.stops, segment);
		if (range === undefined) return;
		placements.push({ uid: modification.uid, rank, priority: modification.record.priority, ...range });
	});
	return placements;
}

/** Deux plages ont-elles au moins un arrêt en commun ? */
function overlaps(a: Placement, b: Placement): boolean {
	return a.start <= b.end && b.start <= a.end;
}
