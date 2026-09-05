import type GtfsRealtime from "gtfs-realtime-bindings";

import { VEHICLE_MEMORY_DURATION, VEHICLE_STALENESS } from "../config.js";

/** Ce que le registre retient d'un véhicule entre deux relevés. */
type RegisteredVehicle = {
	/** L'entrée telle qu'elle sera émise, position et horodatage compris. */
	entity: GtfsRealtime.transit_realtime.IVehiclePosition;
	/**
	 * Date du dernier mouvement constaté, en secondes epoch — celle que porte `entity.timestamp`.
	 *
	 * C'est elle, et non la date du dernier relevé, qui gouverne la vie de l'entrée : la source
	 * continue d'annoncer un véhicule garé pour la journée, et le dater sur ses relevés le laisserait
	 * dans le feed avec la course de son service du matin.
	 */
	movedAt: number;
};

/**
 * Le registre des véhicules publiés. À la différence du store qu'il remplace, il n'est pas vidé à
 * chaque relevé : une entrée y survit à l'absence du véhicule dans le flux source, et à l'incapacité
 * de vérifier ce que la source en dit.
 *
 * De là les deux écritures, qui traduisent les deux cas du workflow :
 *
 *  - {@link publish} pour un véhicule vérifié, dont on republie tout ce que la source annonce ;
 *  - {@link refresh} pour un véhicule qu'on ne sait pas vérifier, dont on ne bouge que la position
 *    et l'horodatage, la course restant celle du dernier passage vérifié.
 *
 * Et les deux durées : passé {@link VEHICLE_STALENESS} l'entrée cesse d'être émise, passé
 * {@link VEHICLE_MEMORY_DURATION} elle est oubliée.
 */
export function useVehicleRegistry() {
	const vehicles = new Map<string, RegisteredVehicle>();

	return {
		/** Vrai si le véhicule a déjà été vu en circulation, c'est-à-dire publié au moins une fois. */
		has(vehicleId: string): boolean {
			return vehicles.has(vehicleId);
		},

		/** Remplace intégralement l'entrée du véhicule par ce que la source vient d'en dire. */
		publish(vehicleId: string, entity: GtfsRealtime.transit_realtime.IVehiclePosition, movedAt: number): void {
			vehicles.set(vehicleId, { entity, movedAt });
		},

		/**
		 * Ne bouge que la position et sa date pour un véhicule déjà connu ; le reste de l'entrée — la
		 * course, le quai, le rang — reste tel que le dernier relevé vérifié l'avait posé. Renvoie faux
		 * lorsque le véhicule n'a jamais été publié : il n'y a alors rien à rafraîchir.
		 */
		refresh(
			vehicleId: string,
			position: GtfsRealtime.transit_realtime.IPosition,
			movedAt: number,
			occupancyStatus: GtfsRealtime.transit_realtime.VehiclePosition.OccupancyStatus | undefined,
		): boolean {
			const registered = vehicles.get(vehicleId);
			if (registered === undefined) return false;

			registered.entity = { ...registered.entity, position, timestamp: movedAt, occupancyStatus };
			registered.movedAt = movedAt;
			return true;
		},

		/** Oublie les véhicules dont le dernier mouvement remonte à plus de {@link VEHICLE_MEMORY_DURATION}. */
		prune(nowSeconds: number): number {
			let forgotten = 0;

			for (const [vehicleId, registered] of vehicles) {
				if (nowSeconds - registered.movedAt <= VEHICLE_MEMORY_DURATION) continue;
				vehicles.delete(vehicleId);
				forgotten += 1;
			}

			return forgotten;
		},

		/**
		 * Les entrées à émettre : celles dont le dernier mouvement date de moins de
		 * {@link VEHICLE_STALENESS}. Les autres restent en mémoire sans être diffusées — un véhicule
		 * que la source a lâché, comme un véhicule à l'arrêt, sort ainsi du feed de lui-même.
		 */
		publishable(nowSeconds: number): Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> {
			const published = new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>();

			for (const [vehicleId, registered] of vehicles) {
				if (nowSeconds - registered.movedAt > VEHICLE_STALENESS) continue;
				published.set(`VM:TCAR:${vehicleId}`, registered.entity);
			}

			return published;
		},
	};
}
