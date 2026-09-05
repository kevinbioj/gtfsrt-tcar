import { readFileSync, writeFileSync } from "node:fs";

import { STATE_MAX_AGE } from "./config.js";
import type { TrackedVehicle } from "./gtfs-rt/use-movement-tracker.js";
import type { LocatedVehicle } from "./gtfs-rt/use-vehicle-locator.js";
import type { RegisteredVehicle } from "./gtfs-rt/use-vehicle-registry.js";

/**
 * Tout ce que le producteur sait et que personne d'autre ne saurait lui redire : le mouvement qu'il
 * a constaté, ce qu'il a publié, où il a situé chaque véhicule. Les instantanés qu'il tient des
 * sources amont (vérification, girouettes, charge, trip updates) n'en sont pas : ceux-là se
 * rechargent d'eux-mêmes dès le démarrage, et les relire ne ferait que ressortir du périmé.
 */
export type ProducerState = {
	/** L'empreinte de position qui date les mouvements (cf. `useMovementTracker`). */
	movements: [string, TrackedVehicle][];
	/** Les entrées du feed, publiées ou en sursis (cf. `useVehicleRegistry`). */
	vehicles: [string, RegisteredVehicle][];
	/** Le dernier projeté de chaque véhicule sur sa course (cf. `useVehicleLocator`). */
	locations: [string, LocatedVehicle][];
};

/**
 * Relit l'état laissé par le dernier arrêt du producteur, ou `undefined` pour repartir de rien.
 *
 * Un redémarrage ne doit pas se voir dans le feed : sans cette relecture, tout le parc repasserait
 * par l'attente d'un premier mouvement (cf. `useMovementTracker`) et le feed mettrait de longues
 * minutes à se repeupler — quand il ne ferait pas réapparaître, à l'inverse, des véhicules éteints.
 *
 * L'état ne vaut toutefois que frais : passé {@link STATE_MAX_AGE}, il ne décrit plus le réseau tel
 * qu'il est mais tel qu'il était, et le producteur repart vierge. Un fichier absent, vide, tronqué
 * ou d'un autre format revient au même — il n'y a rien à en tirer, ce n'est pas une erreur.
 */
export function loadState(path: string, nowSeconds: number): ProducerState | undefined {
	let raw: string;

	try {
		raw = readFileSync(path, "utf8");
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
			console.warn("✘ Failed to read state cache — starting fresh.", cause);
		}
		return undefined;
	}

	// Fichier vierge : c'est le gabarit que le montage Docker met en place, pas un état.
	if (raw.trim().length === 0) return undefined;

	let parsed: { savedAt?: unknown; movements?: unknown; vehicles?: unknown; locations?: unknown };
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		console.warn("✘ Malformed state cache — starting fresh.", cause);
		return undefined;
	}

	const savedAt = typeof parsed?.savedAt === "number" ? parsed.savedAt : 0;
	const age = nowSeconds - savedAt;
	if (!savedAt || age > STATE_MAX_AGE) {
		console.log(`✘ State cache is ${Math.round(age / 60)} min old — starting fresh.`);
		return undefined;
	}

	const state: ProducerState = {
		movements: entriesOf(parsed.movements, isTrackedVehicle),
		vehicles: entriesOf(parsed.vehicles, isRegisteredVehicle),
		locations: entriesOf(parsed.locations, isLocatedVehicle),
	};

	console.log(
		`✓ Restored state saved ${Math.round(age / 60)} min ago (${state.vehicles.length} vehicles, ${state.movements.length} tracked, ${state.locations.length} located).`,
	);

	return state;
}

/**
 * Réécrit l'état sur disque, horodaté de l'instant de l'écriture.
 *
 * L'écriture se fait en place, sans fichier temporaire : le cache est monté fichier par fichier dans
 * le conteneur, où un renommage ne passerait pas. Un arrêt en plein milieu laisse donc un JSON
 * tronqué — {@link loadState} le jette et repart vierge, ce qui coûte un feed à repeupler et rien de
 * plus.
 */
export function saveState(path: string, state: ProducerState, nowSeconds: number): void {
	try {
		writeFileSync(path, JSON.stringify({ savedAt: nowSeconds, ...state }));
	} catch (cause) {
		console.error("✘ Failed to persist state cache:", cause);
	}
}

// ---

/** Les paires d'un `Map` sérialisé, celles qui ne tiennent pas la route en moins. */
function entriesOf<T>(value: unknown, isValid: (payload: unknown) => payload is T): [string, T][] {
	if (!Array.isArray(value)) return [];

	const entries: [string, T][] = [];

	for (const entry of value) {
		if (!Array.isArray(entry) || entry.length !== 2) continue;
		const [key, payload] = entry;
		if (typeof key !== "string" || !isValid(payload)) continue;
		entries.push([key, payload]);
	}

	return entries;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isTrackedVehicle(payload: unknown): payload is TrackedVehicle {
	if (!isObject(payload)) return false;
	// `movedAt` manque tant qu'aucun mouvement n'a été constaté : JSON n'écrit pas `undefined`.
	if (payload.movedAt !== undefined && typeof payload.movedAt !== "number") return false;
	return typeof payload.signature === "string" && isObject(payload.position);
}

function isRegisteredVehicle(payload: unknown): payload is RegisteredVehicle {
	return isObject(payload) && isObject(payload.entity) && typeof payload.movedAt === "number";
}

function isLocatedVehicle(payload: unknown): payload is LocatedVehicle {
	if (!isObject(payload)) return false;
	if (typeof payload.tripId !== "string" || typeof payload.distance !== "number") return false;
	if (typeof payload.at !== "number" || !isObject(payload.location)) return false;

	const { currentStopSequence, stopId, currentStatus } = payload.location;
	return typeof currentStopSequence === "number" && typeof stopId === "string" && typeof currentStatus === "number";
}
