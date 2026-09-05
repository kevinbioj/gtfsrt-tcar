/**
 * Lignes dont le temps réel de la source est authentique. Ailleurs, la source rebadge l'horaire
 * théorique en temps réel : ses véhicules ne sont jamais publiés — tout au plus rafraîchit-on la
 * position d'un véhicule déjà connu — et ses trip updates sont réduits aux seules suppressions
 * d'arrêt (cf. `keepOnlySkippedStops`).
 */
export const REALTIME_LINES = new Set([
	"90",
	"91",
	"92",
	"93",
	"94",
	"95",
	"01",
	"02",
	"03",
	"04",
	"05",
	"07",
	"08",
	"10",
	"11",
	"15",
	"20",
	"22",
	"41",
	"43",
	"98",
]);

export const PORT = 3000;
export const POLL_INTERVAL = 20_000;
/** Source des positions et des courses : le GTFS-RT du SAE, compact et gzippé (~7 Ko). */
export const VEHICLE_POSITIONS_URL =
	"https://api.mrn.cityway.fr/dataflow/vehicle-tc-tr/download?provider=TCAR&dataFormat=GTFS-RT";
/**
 * La même donnée SAE, en JSON non compressé (~190 Ko) mais complète : elle seule porte la girouette
 * du véhicule. On ne s'en sert que pour vérifier la ligne du flux source, en confrontant cette
 * girouette aux destinations déclarées de la ligne ({@link LINE_DESTINATIONS}) — d'où un
 * rafraîchissement espacé, une girouette ne changeant qu'aux terminus.
 */
export const VEHICLE_MONITORING_URL =
	"https://api.mrn.cityway.fr/dataflow/realtime/vehicle-monitoring?provider=TCAR&dataFormat=SIRI-LITE";
export const VEHICLE_MONITORING_INTERVAL = Temporal.Duration.from({ minutes: 5 }).total("milliseconds");
export const TRIP_UPDATES_URL =
	"https://api.mrn.cityway.fr/dataflow/horaire-tc-tr/download?provider=TCAR&dataFormat=GTFS-RT";
export const VERIFICATION_FEED_URL = "https://reseau-astuce.fr/ftp/gtfsrt/Astuce.VehiclePosition.pb";
/** Rafraîchissement du flux de vérification : il republie ses relevés à la minute. */
export const VERIFICATION_FEED_INTERVAL = Temporal.Duration.from({ minutes: 1 }).total("milliseconds");
export const VEHICLE_OCCUPANCY_STALENESS = Temporal.Duration.from({ minutes: 3 }).total("milliseconds");
export const VEHICLE_OCCUPANCY_STATUS_URL = atob("aHR0cHM6Ly90Y2FyLmZsb3dseS5yZS9Qb3J0YWwvTWFwRGV2aWNlcy5hc3B4");

/**
 * Âge au-delà duquel une position n'est plus diffusée. Il joue à deux endroits :
 *
 *  - sur la date brute de la source, pour écarter un relevé d'emblée. Qu'elle cesse elle-même de
 *    réhorodater un véhicule est un aveu : elle l'a bel et bien perdu ;
 *  - sur la date du dernier mouvement, pour sortir du feed un véhicule à l'arrêt — ce qu'elle
 *    réhorodate n'est pas fiable pour autant (cf. `useMovementTracker`).
 */
export const VEHICLE_STALENESS = Temporal.Duration.from({ minutes: 10 }).total("seconds");

/**
 * Durée d'immobilité au-delà de laquelle un véhicule cesse d'être mis à jour, quoi qu'en dise la
 * source. Celle-ci réhorodate « maintenant » des véhicules déconnectés depuis des heures : seul le
 * mouvement constaté prouve qu'elle les a encore au bout du fil (cf. `useMovementTracker`).
 *
 * Le véhicule a déjà quitté le feed bien avant, passé {@link VEHICLE_STALENESS} d'immobilité. Ce
 * délai-ci gouverne l'entretien de ce qui ne s'y voit plus : entre les deux, la course, le quai et
 * le rang continuent de suivre la source, de sorte que le véhicule reparte juste au premier
 * mouvement. Au-delà, plus rien n'est touché.
 */
export const IMMOBILITY_LIMIT = Temporal.Duration.from({ minutes: 30 }).total("seconds");

/**
 * Durée pendant laquelle un véhicule reste mémorisé après son dernier mouvement. Il n'est plus émis
 * passé {@link VEHICLE_STALENESS}, mais la course qu'on lui connaissait l'attend : un véhicule qui
 * repart sans être vérifiable retrouve ainsi sa course au lieu de repartir de rien.
 *
 * Seul le publié périme ainsi ; l'empreinte de position qui date les mouvements, elle, ne périme
 * jamais (cf. `useMovementTracker`).
 */
export const VEHICLE_MEMORY_DURATION = Temporal.Duration.from({ minutes: 90 }).total("seconds");

/**
 * Âge au-delà duquel un relevé de vérification — flux Astuce comme instantané SAE — ne confirme plus
 * rien. Une source muette et une source périmée reviennent au même : elles ne valident pas.
 */
export const VERIFICATION_STALENESS = Temporal.Duration.from({ minutes: 15 }).total("seconds");

/**
 * Girouettes qui signalent un retour au dépôt : un véhicule qui les affiche est haut-le-pied, il
 * roule mais n'assure plus rien. Sa position est publiée avec cette destination-là, mais jamais la
 * course que le SAE continue de lui prêter.
 *
 * Rapprochées comme les destinations de {@link LINE_DESTINATIONS} : casse, accents et ponctuation
 * n'ont pas d'importance, le reste doit correspondre.
 */
export const DEPOT_DESTINATIONS = ["Dépôt 2 Rivières", "Dépôt St-Julien"];

/**
 * Destinations affichées par les véhicules, ligne par ligne, écrites **comme le SAE les écrit** —
 * abréviations comprises (« CHU Ch. Nicolle », « V. Schoelcher », « Boulingrin C ») : la comparaison
 * se fait sur ces chaînes-là, pas sur les libellés du GTFS.
 *
 * La table ne sert qu'aux véhicules que le flux de vérification ignore — il tranche seul dès qu'il en
 * connaît un (cf. `verifyVehicle`). Deux cas, donc :
 *
 *  1. girouette déclarée pour la ligne → le véhicule passe ;
 *  2. girouette étrangère à la ligne, ou ligne absente de la table → le véhicule est écarté.
 *
 * Une ligne déclarée doit donc porter **toutes** ses destinations, pas seulement celles qui posent
 * question, faute de quoi ses véhicules légitimes tombent dans le second cas.
 *
 * ⚠ Table de départ récoltée sur un échantillon de sept minutes un samedi matin : elle est
 * incomplète. Le journal signale chaque girouette non déclarée avec la ligne et le terminus attendu —
 * de quoi la compléter au fil de l'eau.
 */
export const LINE_DESTINATIONS = new Map<string, string[]>([
	["01", ["Stade Diochon", "Pl. de la Ronce"]],
	["02", ["La Vatine-C.Cial", "Hôtel de Ville", "Tamarelle"]],
	["03", ["Pôle Multimodal", "C. Commercial", "HDV Sotteville"]],
	["04", ["Hameau Frévaux", "Mont-Riboudet"]],
	["05", ["Lycée Galilée", "Théâtre des Arts"]],
	["07", ["La Pléiade", "HDV Sotteville"]],
	["08", ["Lycée du Cailly", "Tamarelle"]],
	["10", ["Portes de l'Ouest", "Lycée Flaubert", "La Maine"]],
	["11", ["Ile Lacroix", "Coll. L.de Vinci"]],
	["15", ["Collège J. Verne", "Grand Val", "Hôtel de Ville"]],
	["20", ["Le Chapître", "Mairie St Aubin", "Rue de l'Eglise", "Hôtel de Ville"]],
	["22", ["Barr.de Darnétal", "P. de la Vatine"]],
	["41", ["Ancienne Mare", "La Bastille"]],
	["43", ["Longs Vallons", "Place du Vivier"]],
	[
		"90",
		[
			"Boulingrin A",
			"Boulingrin B",
			"Boulingrin C",
			"Boulingrin D",
			"Théâtre des Arts",
			"Joffre-Mutualité",
			"Avenue de Caen",
			"Place du 8-Mai",
			"Saint-Julien",
			"J.F. Kennedy",
			"Georges Braque",
			"Honoré de Balzac",
			"HDV Sotteville",
			"Toit Familial",
			"Ernest Renan",
			"Technopôle",
		],
	],
	["91", ["CHU Ch. Nicolle", "Mont aux Malades"]],
	["92", ["V. Schoelcher", "Tamarelle"]],
	["93", ["Durécu-Lavoisier", "Monet"]],
	["94", ["ESIGELEC", "Marie Curie-MTC"]],
	["95", ["Champlain", "Mont aux Malades"]],
	["98", ["Hôtel de Ville", "La Pléiade", "Cateliers"]],
]);

export const SERVICE_ALERTS_URL = "https://hexatransit.fr/datasets/services_rt/astuce/service_alerts.pb";
export const STATIC_GTFS_URL = "https://gtfs.bus-tracker.fr/astuce-tcar.zip";
export const ALERTS_POLL_INTERVAL = Temporal.Duration.from({ minutes: 5 }).total("milliseconds");
/**
 * Intervalle de vérification de fraîcheur du GTFS statique : une simple requête HEAD compare la
 * signature (ETag/Last-Modified) et ne déclenche un retéléchargement que si le fichier a changé.
 * Fréquent à dessein — un GTFS périmé fait échouer la correspondance des identifiants d'arrêt.
 */
export const GTFS_CHECK_INTERVAL = Temporal.Duration.from({ minutes: 5 }).total("milliseconds");
export const ANTHROPIC_MODEL = "claude-haiku-4-5";
export const ALERT_CACHE_PATH = ".cache/alert-analysis.json";
