import GtfsRealtime from "gtfs-realtime-bindings";

import { TEOR_ROUTES } from "../config.js";

const { WHEELCHAIR_ACCESSIBLE, WHEELCHAIR_INACCESSIBLE } =
	GtfsRealtime.transit_realtime.VehicleDescriptor.WheelchairAccessible;

/** Un véhicule du parc, réduit à ce que la publication en exploite. `null` : la source ne sait pas. */
type FleetVehicle = {
	wheelchairAccessible: boolean | null;
	teorAccessible: boolean | null;
	licensePlate: string | null;
};

/** Une entrée de `vehicles.json`. */
type VehicleRecord = {
	ref?: string;
	wheelchair_accessible?: boolean | null;
	teor_accessible?: boolean | null;
	license_plate?: string | null;
};

let currentInterval: NodeJS.Timeout | undefined;

/**
 * Tient à jour le parc des véhicules et en déduit le `wheelchairAccessible` et la `licensePlate` de
 * chaque position publiée. Un échec ponctuel laisse le parc précédent en place.
 */
export async function useVehicleFleet(url: string, interval: number) {
	let vehicles = (await loadVehicles(url)) ?? new Map<string, FleetVehicle>();

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		vehicles = (await loadVehicles(url)) ?? vehicles;
	}, interval);

	return {
		/**
		 * La position, son véhicule qualifié de son accessibilité et de son immatriculation. Sur une
		 * ligne du TEOR, c'est l'accessibilité aux quais TEOR qui prime ; ailleurs — et là où la
		 * première est inconnue —, l'accessibilité générale. Ce qui n'est pas connu est laissé tel quel.
		 */
		describe(position: GtfsRealtime.transit_realtime.IVehiclePosition): GtfsRealtime.transit_realtime.IVehiclePosition {
			const vehicle = vehicles.get(position.vehicle?.id ?? "");
			if (vehicle === undefined) return position;

			const accessible =
				(TEOR_ROUTES.has(position.trip?.routeId ?? "") ? vehicle.teorAccessible : null) ?? vehicle.wheelchairAccessible;
			if (accessible === null && vehicle.licensePlate === null) return position;

			return {
				...position,
				vehicle: {
					...position.vehicle,
					...(accessible !== null && {
						wheelchairAccessible: accessible ? WHEELCHAIR_ACCESSIBLE : WHEELCHAIR_INACCESSIBLE,
					}),
					...(vehicle.licensePlate !== null && { licensePlate: vehicle.licensePlate }),
				},
			};
		},
	};
}

/**
 * Le parc, indexé comme les véhicules publiés : « TCAR:Vehicle:3101:LOC » → « TCAR:3101 »,
 * « TAE141 » → « TAE:141 ». `undefined` en cas d'échec.
 */
async function loadVehicles(url: string): Promise<Map<string, FleetVehicle> | undefined> {
	console.log("➔ Fetching vehicle fleet.");

	try {
		const response = await fetch(url);
		if (!response.ok) throw new Error(`HTTP ${response.status}`);

		const records = (await response.json()) as VehicleRecord[];
		const vehicles = new Map<string, FleetVehicle>();

		for (const record of records) {
			const match = /^([A-Z]+)(?::Vehicle:+([^:]+):LOC|(\d+))$/.exec(record.ref ?? "");
			if (match === null) continue;

			const [, network, longNumber, shortNumber] = match;
			const number = longNumber ?? shortNumber;
			vehicles.set(`${network}:${number}`, {
				wheelchairAccessible: record.wheelchair_accessible ?? null,
				teorAccessible: record.teor_accessible ?? null,
				licensePlate: record.license_plate || null,
			});
		}

		console.log(`✓ Loaded ${vehicles.size} fleet vehicles.`);
		return vehicles;
	} catch (cause) {
		console.error("✘ Failed to update vehicle fleet!", cause);
		return undefined;
	}
}
