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
 *
 * Sauf pour un véhicule qui attend son départ : celui-là reste suivi et publié aussi longtemps qu'il
 * patiente (cf. {@link DEPARTURE_GRACE}).
 */
export const IMMOBILITY_LIMIT = Temporal.Duration.from({ minutes: 30 }).total("seconds");

/**
 * Délai accordé à une course après son heure de départ avant de tenir son véhicule pour mort.
 *
 * Un véhicule qui attend son départ à son terminus ne bouge pas, et les durées ci-dessus le
 * sortiraient du feed au bout de dix minutes puis cesseraient de le suivre au bout de trente : il
 * faudrait alors qu'il démarre pour y revenir, quand c'est justement en tête de course qu'il
 * intéresse le voyageur. Aucune d'elles ne joue donc contre lui tant que sa course n'a pas dépassé
 * son départ de ce délai — ni {@link VEHICLE_STALENESS}, ni {@link IMMOBILITY_LIMIT}, ni
 * {@link VEHICLE_MEMORY_DURATION}. Un véhicule mis à quai une heure et demie avant son service
 * reste ainsi publié une heure et demie durant (cf. `awaitsDeparture`).
 *
 * Ce délai-ci ne mesure donc pas une attente, qui n'a pas de limite, mais le retard au départ
 * au-delà duquel un véhicule qui n'a toujours pas bougé n'attend visiblement plus rien.
 *
 * Le départ retenu est celui du flux temps réel quand il l'annonce — le retard pris avant même de
 * partir s'y lit — et à défaut celui du GTFS statique.
 */
export const DEPARTURE_GRACE = Temporal.Duration.from({ minutes: 10 }).total("seconds");

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
 * Écart latéral maximal, en kilomètres, entre la position d'un véhicule et la shape de sa course.
 * Au-delà, la position ne le situe plus sur son itinéraire — déviation, relevé GPS aberrant, shape
 * qui ne lui correspond pas — et le prochain arrêt qu'on en déduirait ne voudrait rien dire. On
 * garde alors le dernier qu'on savait juste (cf. `useVehicleLocator`).
 */
export const MAX_SHAPE_OFFSET = 0.15;

/**
 * Rayon du « à quai », en kilomètres. Il joue des deux côtés du point d'arrêt : en deçà le véhicule
 * y arrive, au-delà il n'en est pas encore reparti. La dérive GPS le pousse volontiers quelques
 * mètres trop loin, et sans cette marge il annoncerait l'arrêt suivant portes encore ouvertes.
 */
export const STOPPED_AT_RADIUS = 0.03;

/** Distance restante, en kilomètres, en deçà de laquelle le véhicule est annoncé en approche. */
export const INCOMING_AT_RADIUS = 0.1;

/**
 * Vitesse plafond retenue pour borner l'avance plausible d'un véhicule entre deux relevés, en
 * kilomètres par seconde (90 km/h). Elle restreint la projection sur la shape autour de la dernière
 * abscisse connue : une shape qui repasse au même endroit — boucle, tronçon emprunté dans les deux
 * sens — offre sinon plusieurs projetés également plausibles.
 */
export const MAX_VEHICLE_SPEED = 0.025;

/**
 * Recul toléré sur la shape d'un relevé à l'autre, en kilomètres. Un véhicule n'avance pas toujours :
 * le bruit GPS le fait osciller, et il manœuvre pour de bon aux terminus.
 */
export const PROJECTION_BACKTRACK = 0.2;

/**
 * Portée minimale de la fenêtre de projection, en kilomètres. Elle absorbe les longues absences — un
 * véhicule perdu puis retrouvé plus loin — sans pour autant rouvrir la shape entière.
 */
export const MIN_PROJECTION_REACH = 2;

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

/**
 * Fichier où le producteur relit et réécrit tout ce qu'il retient d'un relevé à l'autre. Un
 * redémarrage n'a rien d'exceptionnel — déploiement, mise à jour, incident — et sans cette mémoire
 * il se verrait dans le feed pendant de longues minutes (cf. `loadState`).
 */
export const STATE_CACHE_PATH = ".state.json";

/**
 * Âge au-delà duquel l'état relu au démarrage est jeté. Il décrit alors un réseau qui n'existe plus
 * : véhicules rentrés au dépôt, courses terminées, journée de service changée. Mieux vaut repartir
 * vierge et laisser le feed se repeupler au premier mouvement constaté.
 */
export const STATE_MAX_AGE = Temporal.Duration.from({ hours: 1 }).total("seconds");
