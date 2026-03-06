import { VERIFIED_ROUTE_DESTINATIONS } from "../config.js";

export function isVehicleVerified(
	vehicleRoute: Map<string, string>,
	vehicleId: string,
	routeId: string,
	directionId: number,
	destination: string,
) {
	const verifiedRouteId = vehicleRoute.get(vehicleId);
	if (verifiedRouteId !== undefined) {
		if (verifiedRouteId === routeId) {
			return;
		}

		return { type: "ROUTE_MISMATCH", verifiedRouteId } as const;
	}

	const verifiedDestinations = VERIFIED_ROUTE_DESTINATIONS[routeId]?.[directionId];
	if (verifiedDestinations === undefined) {
		return { type: "MISSING_ROUTE_DESTINATIONS" } as const;
	}

	if (!verifiedDestinations.includes(destination)) {
		return { type: "UNKNOWN_DESTINATION" } as const;
	}
}
