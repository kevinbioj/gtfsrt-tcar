/** Le réseau du producteur : le seul que le feed publie par défaut (cf. `requestedNetworks`). */
export const HOME_NETWORK = "TCAR";

/**
 * Le réseau d'un identifiant du GTFS — course, ligne ou quai —, qui le porte en préfixe (« TAE:F9 »
 * → « TAE »). C'est lui qui range chaque entité publiée sous son réseau.
 */
export function networkOf(id: string): string {
	return id.split(":")[0] ?? id;
}

/**
 * Le réseau d'une entité publiée, qui le porte au second rang de son identifiant : « ET:TAE:… » pour
 * un trip update, « VM:TNI:… » pour une position, « TM:TCAR:… » pour une modification.
 */
export function entityNetwork(entityId: string): string {
	return entityId.split(":")[1] ?? "";
}
