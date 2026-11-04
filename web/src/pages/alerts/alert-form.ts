import type { AlertDto, AlertInputDto, DirectionDto, ImpactEntityDto, RouteDto, StopGroupDto } from "@dto";

import { type PeriodForm, periodForm, periodInput } from "@/components/period-editor";
import { type TripSetForm, tripSetKey } from "@/components/trip-sets";

/** Ce qui se saisit d'une alerte, tel que le formulaire le tient jusqu'à l'enregistrement. */
export type AlertForm = {
	headerText: string;
	descriptionText: string;
	cause: string | null;
	effect: string | null;
	/** Le lien, l'image et son texte alternatif publiés ; `""` : aucun. */
	url: string;
	imageUrl: string;
	imageAlternativeText: string;
	/** `null` : les périodes de l'analyse. */
	periods: PeriodForm[] | null;
	/** « routeId|directionId|stopId » → supprimé (vrai) ou desservi (faux), contre l'avis de l'analyse. */
	overrides: Record<string, boolean>;
	/** « routeId|directionId » des sens dont on ignore l'analyse. */
	ignored: string[];
	tripSets: TripSetForm[];
	modifications: number[];
	/** Les périodes propres des modifications associées, par uid ; sans entrée, celles de l'alerte. */
	modificationPeriods: Record<number, PeriodForm[]>;
	/** `null` : l'impact reçu. */
	impact: ImpactEntityDto[] | null;
};

export const scopeOf = (group: { routeId: string; directionId: number }) => `${group.routeId}|${group.directionId}`;
export const stopKey = (group: { routeId: string; directionId: number }, stopId: string) =>
	`${scopeOf(group)}|${stopId}`;

/**
 * L'alerte qu'ouvre « Nouvelle alerte », avant tout enregistrement : créée à la main, vide, en
 * brouillon. Son numéro vide dit qu'elle n'existe pas encore — le premier enregistrement la crée.
 */
export function blankAlert(): AlertDto {
	const empty = {
		headerText: "",
		descriptionText: "",
		cause: null,
		effect: null,
		url: null,
		imageUrl: null,
		imageAlternativeText: null,
	};
	return {
		alertNumber: "",
		inFeed: false,
		custom: true,
		publishedAt: null,
		hidden: true,
		active: false,
		publication: "draft",
		phase: "current",
		phaseDetail: "",
		received: { ...empty, descriptionHtml: "" },
		published: empty,
		overrides: empty,
		periods: [],
		analysisPeriods: [],
		periodsOverridden: true,
		feedPeriods: { received: [], communication: [], impact: [] },
		lines: [],
		stopGroups: [],
		tripSets: [],
		modifications: [],
		modificationPeriods: {},
		warnings: [],
		firstSeenAt: 0,
		checkedAt: null,
		impact: { received: [], published: [], overridden: false },
	};
}

/** L'alerte n'est-elle pas encore créée (cf. {@link blankAlert}) ? */
export const isUnsaved = (alert: AlertDto) => alert.alertNumber === "";

export function formOf(alert: AlertDto): AlertForm {
	const overrides: Record<string, boolean> = {};
	for (const group of alert.stopGroups) {
		for (const stop of group.stops) if (stop.overridden) overrides[stopKey(group, stop.stopId)] = stop.removed;
	}
	return {
		headerText: alert.published.headerText,
		descriptionText: alert.published.descriptionText,
		cause: alert.published.cause,
		effect: alert.published.effect,
		url: alert.published.url ?? "",
		imageUrl: alert.published.imageUrl ?? "",
		imageAlternativeText: alert.published.imageAlternativeText ?? "",
		// Créée à la main, elle n'a d'autres périodes que les siennes, fût-ce aucune.
		periods: alert.custom || alert.periodsOverridden ? alert.periods.map(periodForm) : null,
		overrides,
		ignored: alert.stopGroups.filter((group) => group.ignored).map(scopeOf),
		tripSets: alert.tripSets.map((set) => ({ ...set, key: tripSetKey() })),
		modifications: [...alert.modifications],
		modificationPeriods: Object.fromEntries(
			Object.entries(alert.modificationPeriods).map(([uid, periods]) => [uid, periods.map(periodForm)]),
		),
		impact: alert.impact.overridden ? alert.impact.published.map((entity) => ({ ...entity })) : null,
	};
}

/**
 * Ce que l'API reçoit : une réécriture identique au texte reçu n'en est pas une. Un lien, une image
 * ou un texte alternatif vidés alors que le flux en porte partent à vide : ils le retirent.
 */
export function inputOf(form: AlertForm, alert: AlertDto): AlertInputDto {
	const differs = <T>(value: T, received: T) => (value === received ? null : value);
	return {
		overrides: {
			headerText: differs(form.headerText.trim(), alert.received.headerText.trim()),
			descriptionText: differs(form.descriptionText.trim(), alert.received.descriptionText.trim()),
			cause: differs(form.cause, alert.received.cause),
			effect: differs(form.effect, alert.received.effect),
			url: differs(form.url.trim(), alert.received.url ?? ""),
			imageUrl: differs(form.imageUrl.trim(), alert.received.imageUrl ?? ""),
			imageAlternativeText: differs(form.imageAlternativeText.trim(), alert.received.imageAlternativeText ?? ""),
		},
		periods: form.periods === null ? null : form.periods.map(periodInput),
		skipStops: Object.entries(form.overrides).map(([key, removed]) => {
			const [routeId, directionId, ...rest] = key.split("|");
			return { routeId: routeId ?? "", directionId: Number(directionId), stopId: rest.join("|"), removed };
		}),
		ignoredScopes: form.ignored.map((scope) => {
			const [routeId, directionId] = scope.split("|");
			return { routeId: routeId ?? "", directionId: Number(directionId) };
		}),
		tripSets: form.tripSets.map(({ routeId, directionId, enabled, selection }) => ({
			routeId,
			directionId,
			enabled,
			selection,
		})),
		modificationUids: form.modifications,
		// Celles d'une modification dissociée ne partent pas.
		modificationPeriods: Object.fromEntries(
			form.modifications.flatMap((uid) => {
				const periods = form.modificationPeriods[uid];
				return periods === undefined ? [] : [[uid, periods.map(periodInput)]];
			}),
		),
		impact: form.impact,
	};
}

/** L'arrêt est-il supprimé, corrections faites ? */
export function isRemoved(form: AlertForm, group: StopGroupDto, stop: { stopId: string; ai: boolean }): boolean {
	const override = form.overrides[stopKey(group, stop.stopId)];
	if (override !== undefined) return override;
	return form.ignored.includes(scopeOf(group)) ? false : stop.ai;
}

/** Bascule un arrêt : une correction qui ramène à l'avis de l'analyse s'efface. */
export function toggleStop(form: AlertForm, group: StopGroupDto, stopId: string): AlertForm {
	const stop = group.stops.find((entry) => entry.stopId === stopId);
	if (stop === undefined) return form;
	const key = stopKey(group, stopId);
	const next = !isRemoved(form, group, stop);
	const base = form.ignored.includes(scopeOf(group)) ? false : stop.ai;
	const overrides = { ...form.overrides };
	if (next === base) delete overrides[key];
	else overrides[key] = next;
	return { ...form, overrides };
}

/** Oublie les corrections d'un sens : il revient à l'analyse, ou à rien s'il est ignoré. */
export function clearGroup(form: AlertForm, group: StopGroupDto, ignore: boolean): AlertForm {
	const prefix = `${scopeOf(group)}|`;
	const overrides = Object.fromEntries(Object.entries(form.overrides).filter(([key]) => !key.startsWith(prefix)));
	const ignored = form.ignored.filter((scope) => scope !== scopeOf(group));
	return { ...form, overrides, ignored: ignore ? [...ignored, scopeOf(group)] : ignored };
}

/**
 * Les sens où suggérer une modification : ceux que l'impact cite — tous ceux d'une ligne citée sans
 * sens —, une fois chacun. Les lignes dans l'ordre du réseau (`routes` le suit déjà), les sens par
 * `direction_id`.
 */
export function suggestionsOf(
	impact: ImpactEntityDto[],
	routes: RouteDto[],
): { route: RouteDto; direction: DirectionDto }[] {
	const cited = (routeId: string, directionId: number) =>
		impact.some((entity) => entity.routeId === routeId && (entity.directionId ?? directionId) === directionId);
	return routes.flatMap((route) =>
		route.directions
			.filter((direction) => cited(route.routeId, direction.directionId))
			.sort((a, b) => a.directionId - b.directionId)
			.map((direction) => ({ route, direction })),
	);
}
