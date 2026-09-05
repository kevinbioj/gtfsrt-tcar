import GtfsRealtime from "gtfs-realtime-bindings";

import { VERIFICATION_FEED_INTERVAL, VERIFICATION_STALENESS } from "../config.js";

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Tient à jour un instantané du flux de vérification, un relevé par véhicule. Il ne sert pas à
 * publier mais à trancher : c'est la seule source qui porte la ligne et le sens réels du véhicule.
 */
export async function useVerificationFeed(vehicleUrl: string) {
	const resource = {
		verifiedVehicles: (await loadResource(vehicleUrl)) ?? new Map<string, VerifiedVehicle>(),
		importedAt: Temporal.Now.instant(),
	};

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		const verifiedVehicles = await loadResource(vehicleUrl);
		if (verifiedVehicles === undefined) return; // échec ponctuel : on garde l'instantané précédent

		resource.verifiedVehicles = verifiedVehicles;
		resource.importedAt = Temporal.Now.instant();
	}, VERIFICATION_FEED_INTERVAL);

	return resource;
}

// ---

export type VerifiedVehicle = {
	position: {
		latitude: number;
		longitude: number;
		bearing: number;
	};
	/** Instant du relevé, en secondes epoch. */
	recordedAt: number;
	/** Ligne préfixée comme le GTFS publié (« TCAR:92 »), pour se comparer au flux source. */
	routeId: string;
	directionId: number;
};

async function loadResource(vehicleUrl: string): Promise<Map<string, VerifiedVehicle> | undefined> {
	console.log("➔ Fetching verification feed.");

	try {
		const verifiedVehicles = new Map<string, VerifiedVehicle>();

		const vehicleResponse = await fetch(vehicleUrl);
		if (!vehicleResponse.ok || vehicleResponse.status === 204) {
			console.error(`✘ Failed to fetch verification feed (HTTP ${vehicleResponse.status}).`);
			return undefined;
		}

		const vehicleBuffer = Buffer.from(await vehicleResponse.arrayBuffer());
		const vehicleFeed = GtfsRealtime.transit_realtime.FeedMessage.decode(vehicleBuffer);

		const nowSeconds = Math.floor(Date.now() / 1000);
		// La source date ses relevés en heure locale encodée en epoch : sans correction, ils paraissent
		// vieux de deux heures l'été. L'en-tête du feed, lui, est bel et bien en UTC.
		const offsetSeconds = Math.floor(
			Temporal.Now.instant().toZonedDateTimeISO("Europe/Paris").offsetNanoseconds / 1_000_000_000,
		);

		// Feed entier périmé : la source ne republie plus, rien de ce qu'elle dit ne vérifie plus rien.
		if (nowSeconds - Number(vehicleFeed.header.timestamp ?? 0) > VERIFICATION_STALENESS) {
			console.warn("✘ Verification feed is stale, ignoring it.");
			return verifiedVehicles;
		}

		for (const entity of vehicleFeed.entity) {
			const vehicle = entity.vehicle;
			if (!vehicle?.vehicle?.id || !vehicle.trip?.routeId || !vehicle.position) continue;

			const recordedAt = Number(vehicle.timestamp ?? 0) + offsetSeconds;
			if (!recordedAt || nowSeconds - recordedAt > VERIFICATION_STALENESS) continue;

			verifiedVehicles.set(vehicle.vehicle.id, {
				position: {
					latitude: vehicle.position.latitude,
					longitude: vehicle.position.longitude,
					bearing: vehicle.position.bearing ?? 0,
				},
				recordedAt,
				routeId: `TCAR:${vehicle.trip.routeId}`,
				directionId: vehicle.trip.directionId ?? 0,
			});
		}

		console.log(`✓ Loaded ${verifiedVehicles.size} verified vehicles.`);
		return verifiedVehicles;
	} catch (cause) {
		console.error("✘ Failed to update verification feed!", cause);
		return undefined;
	}
}
