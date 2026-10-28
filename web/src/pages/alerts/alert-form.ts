import type { AlertDto, AlertInputDto, DirectionDto, ImpactEntityDto, RouteDto, StopGroupDto } from "@dto";

import { type PeriodForm, periodForm, periodInput } from "@/components/period-editor";
import { type TripSetForm, tripSetKey } from "@/components/trip-sets";

/** Ce qui se saisit d'une alerte, tel que le formulaire le tient jusqu'à l'enregistrement. */
export type AlertForm = {
	headerText: string;
	descriptionText: string;
	cause: string | null;
	effect: string | null;
	/** `null` : les périodes de l'analyse. */
	periods: PeriodForm[] | null;
	/** « routeId|directionId|stopId » → supprimé (vrai) ou desservi (faux), contre l'avis de l'analyse. */
	overrides: Record<string, boolean>;
	/** « routeId|directionId » des sens dont on ignore l'analyse. */
	ignored: string[];
	tripSets: TripSetForm[];
	modifications: number[];
	/** `null` : l'impact reçu. */
	impact: ImpactEntityDto[] | null;
};

export const scopeOf = (group: { routeId: string; directionId: number }) => `${group.routeId}|${group.directionId}`;
export const stopKey = (group: { routeId: string; directionId: number }, stopId: string) =>
	`${scopeOf(group)}|${stopId}`;

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
		periods: alert.periodsOverridden ? alert.periods.map(periodForm) : null,
		overrides,
		ignored: alert.stopGroups.filter((group) => group.ignored).map(scopeOf),
		tripSets: alert.tripSets.map((set) => ({ ...set, key: tripSetKey() })),
		modifications: [...alert.modifications],
		impact: alert.impact.overridden ? alert.impact.published.map((entity) => ({ ...entity })) : null,
	};
}

/** Ce que l'API reçoit : une réécriture identique au texte reçu n'en est pas une. */
export function inputOf(form: AlertForm, alert: AlertDto): AlertInputDto {
	const differs = <T>(value: T, received: T) => (value === received ? null : value);
	return {
		overrides: {
			headerText: differs(form.headerText.trim(), alert.received.headerText.trim()),
			descriptionText: differs(form.descriptionText.trim(), alert.received.descriptionText.trim()),
			cause: differs(form.cause, alert.received.cause),
			effect: differs(form.effect, alert.received.effect),
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
