import { VERIFIED_ROUTE_DESTINATIONS } from "../config.js";

import type { VerifiedVehicle } from "../gtfs-rt/use-verification-feed.js";

export function isVehicleVerified(
	verifiedVehicle: VerifiedVehicle | undefined,
	routeId: string,
	directionId: number,
	destination: string,
) {
	if (verifiedVehicle !== undefined) {
		if (verifiedVehicle.routeId === routeId) {
			return;
		}

		return { type: "ROUTE_MISMATCH", verifiedRouteId: verifiedVehicle.routeId } as const;
	}

	const verifiedDestinations = VERIFIED_ROUTE_DESTINATIONS[routeId]?.[directionId];
	if (verifiedDestinations === undefined) {
		return { type: "MISSING_ROUTE_DESTINATIONS" } as const;
	}

	if (!verifiedDestinations.includes(destination)) {
		return { type: "UNKNOWN_DESTINATION" } as const;
	}
}
