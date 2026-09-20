import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { Coordinates } from "../utils/geometry.js";

/**
 * Le schéma, dans l'ordre où il s'applique. Chaque entrée fait passer la base de la version qu'elle
 * occupe à la suivante, et `PRAGMA user_version` retient où l'on en est : une base déjà à jour ne
 * rejoue rien. C'est tout ce qu'il faut de migration ici — la base n'a qu'un écrivain, et son
 * contenu se resaisit en quelques minutes s'il fallait la refaire.
 *
 * Les tables sont `STRICT` : SQLite refuse alors d'écrire un texte dans une colonne numérique, là où
 * il l'accepterait et le convertirait en silence. C'est le pendant du `strict` de TypeScript, à la
 * frontière où les types cessent d'exister.
 */
const MIGRATIONS: readonly (string | ((db: DatabaseSync) => void))[] = [
	`
	-- Une déviation déclarée, à la maille de l'info trafic : une ligne, un sens.
	CREATE TABLE detours (
		alert_number     TEXT    NOT NULL,
		route_id         TEXT    NOT NULL,
		direction_id     INTEGER NOT NULL,
		-- Bornes de la modification : le premier et le dernier arrêt SUPPRIMÉ. NULL tant qu'elles
		-- n'ont pas été arrêtées — la déviation n'est alors pas publiable.
		start_stop_id    TEXT,
		end_stop_id      TEXT,
		propagated_delay INTEGER NOT NULL DEFAULT 0,
		-- Prochain identifiant d'arrêt provisoire à attribuer. Jamais décrémenté, jamais réutilisé.
		next_stop_uid    INTEGER NOT NULL DEFAULT 1,
		updated_at       INTEGER NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id)
	) STRICT;

	-- Les arrêts de substitution, dans l'ordre où la déviation les dessert.
	CREATE TABLE detour_stops (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		-- Identité stable de l'arrêt publié, indépendante de son rang (cf. next_stop_uid).
		stop_uid     INTEGER NOT NULL,
		position     INTEGER NOT NULL,
		name         TEXT    NOT NULL,
		latitude     REAL    NOT NULL,
		longitude    REAL    NOT NULL,
		-- Secondes depuis l'arrivée à l'arrêt de référence (cf. DetourStop.travelTime).
		travel_time  INTEGER NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id, stop_uid),
		FOREIGN KEY (alert_number, route_id, direction_id)
			REFERENCES detours (alert_number, route_id, direction_id) ON DELETE CASCADE
	) STRICT;

	-- Le tracé dessiné, point par point.
	CREATE TABLE detour_path (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		position     INTEGER NOT NULL,
		latitude     REAL    NOT NULL,
		longitude    REAL    NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id, position),
		FOREIGN KEY (alert_number, route_id, direction_id)
			REFERENCES detours (alert_number, route_id, direction_id) ON DELETE CASCADE
	) STRICT;
	`,
	`
	-- Un arrêt de substitution peut être un arrêt du GTFS plutôt qu'un point posé sur la carte : le
	-- GTFS-RT admet les deux. La colonne porte alors son identifiant, et le nom comme les coordonnées
	-- ne sont plus qu'un instantané d'affichage — c'est le GTFS qui fait foi.
	ALTER TABLE detour_stops ADD COLUMN gtfs_stop_id TEXT;
	`,
	`
	-- Un arrêt de substitution peut aussi renvoyer à un arrêt provisoire déjà créé par une AUTRE
	-- déviation : un terminus de rebroussement sert aux deux sens, et le dédoubler donnerait deux
	-- arrêts au même endroit, à entretenir séparément. La colonne porte alors son identifiant publié.
	ALTER TABLE detour_stops ADD COLUMN shared_stop_id TEXT;
	`,
	// Les arrêts provisoires deviennent une base à part, et non plus la propriété de la déviation qui
	// les a saisis. C'est ce qu'ils sont : un arrêt de report existe sur le terrain, il sert souvent à
	// plusieurs déviations — les deux sens d'un rebroussement, deux infos trafic successives sur le
	// même chantier — et le rattacher à l'une d'elles obligeait à distinguer celle qui le possède de
	// celles qui l'empruntent. Une déviation ne fait plus que désigner des arrêts, du GTFS ou d'ici.
	(db) => {
		db.exec(`
			CREATE TABLE provisional_stops (
				stop_uid   INTEGER PRIMARY KEY AUTOINCREMENT,
				name       TEXT    NOT NULL,
				latitude   REAL    NOT NULL,
				longitude  REAL    NOT NULL,
				created_at INTEGER NOT NULL
			) STRICT;

			CREATE TABLE detour_stops_next (
				alert_number TEXT    NOT NULL,
				route_id     TEXT    NOT NULL,
				direction_id INTEGER NOT NULL,
				position     INTEGER NOT NULL,
				-- L'identifiant publié : un quai du GTFS, ou « TCAR:DEV:<stop_uid> ».
				stop_id      TEXT    NOT NULL,
				travel_time  INTEGER NOT NULL,
				PRIMARY KEY (alert_number, route_id, direction_id, position),
				FOREIGN KEY (alert_number, route_id, direction_id)
					REFERENCES detours (alert_number, route_id, direction_id) ON DELETE CASCADE
			) STRICT;
		`);

		// Les arrêts que les déviations possédaient passent dans la nouvelle base, et l'ancien
		// identifiant publié — qui portait le numéro d'info trafic — est rattaché au nouveau, pour que
		// les renvois d'une déviation à l'autre continuent de désigner le même arrêt.
		const migrated = new Map<string, string>();
		const createStop = db.prepare(
			"INSERT INTO provisional_stops (name, latitude, longitude, created_at) VALUES (?, ?, ?, ?)",
		);
		const now = Math.floor(Date.now() / 1000);

		const legacy = db
			.prepare("SELECT * FROM detour_stops ORDER BY alert_number, route_id, direction_id, position")
			.all() as LegacyStopRow[];

		for (const row of legacy) {
			if (row.gtfs_stop_id !== null || row.shared_stop_id !== null) continue;
			const { lastInsertRowid } = createStop.run(row.name, row.latitude, row.longitude, now);
			migrated.set(`TCAR:DEV:${row.alert_number}:${row.stop_uid}`, `TCAR:DEV:${lastInsertRowid}`);
		}

		const insert = db.prepare(
			"INSERT INTO detour_stops_next (alert_number, route_id, direction_id, position, stop_id, travel_time) VALUES (?, ?, ?, ?, ?, ?)",
		);
		for (const row of legacy) {
			const legacyId = `TCAR:DEV:${row.alert_number}:${row.stop_uid}`;
			const stopId = row.gtfs_stop_id ?? migrated.get(row.shared_stop_id ?? legacyId);
			// Un renvoi devenu orphelin avant la migration n'a rien à reprendre : l'arrêt est simplement
			// retiré de la déviation, qui se signalera incomplète.
			if (stopId === undefined) continue;
			insert.run(row.alert_number, row.route_id, row.direction_id, row.position, stopId, row.travel_time);
		}

		db.exec(`
			DROP TABLE detour_stops;
			ALTER TABLE detour_stops_next RENAME TO detour_stops;
			ALTER TABLE detours DROP COLUMN next_stop_uid;
		`);
	},
	// Une info trafic peut dévier une ligne en PLUSIEURS endroits disjoints : deux chantiers sur le
	// même axe, ou un détour suivi d'un terminus provisoire. La spécification l'exprime déjà — une
	// `TripModifications` porte autant de `Modification` qu'il y a de tronçons —, et la déclaration
	// s'y range enfin : elle se décompose en segments, chacun avec ses bornes, ses arrêts de
	// substitution, son tracé et son délai propagé. Ce qui était une déclaration devient son
	// premier segment, et ce que `detours` portait de géographie passe à `detour_segments`.
	(db) => {
		db.exec(`
			CREATE TABLE detour_segments (
				alert_number     TEXT    NOT NULL,
				route_id         TEXT    NOT NULL,
				direction_id     INTEGER NOT NULL,
				-- Le rang du segment dans la déclaration, et rien de plus : \`save\` réécrit la
				-- déclaration entière, et rien au dehors ne désigne un segment en particulier.
				segment          INTEGER NOT NULL,
				start_stop_id    TEXT,
				end_stop_id      TEXT,
				propagated_delay INTEGER NOT NULL DEFAULT 0,
				PRIMARY KEY (alert_number, route_id, direction_id, segment),
				FOREIGN KEY (alert_number, route_id, direction_id)
					REFERENCES detours (alert_number, route_id, direction_id) ON DELETE CASCADE
			) STRICT;

			INSERT INTO detour_segments
				(alert_number, route_id, direction_id, segment, start_stop_id, end_stop_id, propagated_delay)
			SELECT alert_number, route_id, direction_id, 0, start_stop_id, end_stop_id, propagated_delay
			FROM detours;

			CREATE TABLE detour_stops_next (
				alert_number TEXT    NOT NULL,
				route_id     TEXT    NOT NULL,
				direction_id INTEGER NOT NULL,
				segment      INTEGER NOT NULL,
				position     INTEGER NOT NULL,
				stop_id      TEXT    NOT NULL,
				travel_time  INTEGER NOT NULL,
				PRIMARY KEY (alert_number, route_id, direction_id, segment, position),
				FOREIGN KEY (alert_number, route_id, direction_id, segment)
					REFERENCES detour_segments (alert_number, route_id, direction_id, segment) ON DELETE CASCADE
			) STRICT;

			INSERT INTO detour_stops_next
			SELECT alert_number, route_id, direction_id, 0, position, stop_id, travel_time FROM detour_stops;
			DROP TABLE detour_stops;
			ALTER TABLE detour_stops_next RENAME TO detour_stops;

			CREATE TABLE detour_path_next (
				alert_number TEXT    NOT NULL,
				route_id     TEXT    NOT NULL,
				direction_id INTEGER NOT NULL,
				segment      INTEGER NOT NULL,
				position     INTEGER NOT NULL,
				latitude     REAL    NOT NULL,
				longitude    REAL    NOT NULL,
				PRIMARY KEY (alert_number, route_id, direction_id, segment, position),
				FOREIGN KEY (alert_number, route_id, direction_id, segment)
					REFERENCES detour_segments (alert_number, route_id, direction_id, segment) ON DELETE CASCADE
			) STRICT;

			INSERT INTO detour_path_next
			SELECT alert_number, route_id, direction_id, 0, position, latitude, longitude FROM detour_path;
			DROP TABLE detour_path;
			ALTER TABLE detour_path_next RENAME TO detour_path;

			ALTER TABLE detours DROP COLUMN start_stop_id;
			ALTER TABLE detours DROP COLUMN end_stop_id;
			ALTER TABLE detours DROP COLUMN propagated_delay;
		`);
	},
	// Un tracé cesse d'être une simple suite de points pour devenir une suite de POINTS DE PASSAGE,
	// chacun disant le mode de la jambe qui le suit : accrochée aux rues d'OpenStreetMap, ou tirée
	// droit comme auparavant. Le tracé lui-même — `detour_path` — ne change pas d'un iota : c'est lui
	// qui est publié, et lui seul que la recouture des shapes regarde.
	`
	CREATE TABLE detour_waypoints (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		segment      INTEGER NOT NULL,
		position     INTEGER NOT NULL,
		latitude     REAL    NOT NULL,
		longitude    REAL    NOT NULL,
		-- Le mode de la jambe qui SUIT ce point : « route » ou « free ». Sans objet pour le dernier.
		mode         TEXT    NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id, segment, position),
		FOREIGN KEY (alert_number, route_id, direction_id, segment)
			REFERENCES detour_segments (alert_number, route_id, direction_id, segment) ON DELETE CASCADE
	) STRICT;

	-- Un tracé dessiné à la main EST une suite de points de passage dont chaque jambe est droite : la
	-- reprise est exacte et non approchée, et rien n'est à deviner au chargement. L'invariant « des
	-- points de passage existent dès qu'il y a un tracé » tient ainsi dans la base elle-même.
	INSERT INTO detour_waypoints
	SELECT alert_number, route_id, direction_id, segment, position, latitude, longitude, 'free'
	FROM detour_path;
	`,
	// Le périmètre d'une info trafic — quelles lignes, quels sens, quels arrêts supprimés — cesse
	// d'être le dernier mot de l'analyse IA. Elle ne voit que ce que le texte dit, et le texte ne dit
	// pas tout : une ligne déviée dans les deux sens n'y perd parfois d'arrêts que dans un seul, et le
	// sens muet n'existait alors nulle part — ni comme déviation à déclarer, ni comme tracé à publier.
	//
	// Une surcharge REMPLACE l'analyse pour ce couple ligne/sens, elle ne la corrige pas : ce qui est
	// saisi ici fait foi, y compris une liste d'arrêts vide — « cette ligne est bien concernée dans ce
	// sens, mais elle n'y perd aucun arrêt ». C'est la seule règle à retenir, et elle vaut pour les
	// suppressions publiées comme pour le périmètre offert à la déclaration.
	`
	CREATE TABLE scope_overrides (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		updated_at   INTEGER NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id)
	) STRICT;

	CREATE TABLE scope_override_stops (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		stop_id      TEXT    NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id, stop_id),
		FOREIGN KEY (alert_number, route_id, direction_id)
			REFERENCES scope_overrides (alert_number, route_id, direction_id) ON DELETE CASCADE
	) STRICT;
	`,
	// Un tronçon a porté un instant la nature de ce qu'il fait — supprimer des arrêts, ou seulement
	// changer le chemin entre eux. Elle n'avait rien à faire là : elle se LIT du périmètre et des
	// bornes, déjà saisis (cf. `removesStops`). Une plage sans aucun arrêt supprimé ne supprime rien,
	// et c'est tout ce qu'il y a à savoir — un réglage de plus n'aurait pu que les contredire.
	`
	ALTER TABLE detour_segments ADD COLUMN kind TEXT NOT NULL DEFAULT 'removal';
	`,
	`
	ALTER TABLE detour_segments DROP COLUMN kind;
	`,
];

/** Un arrêt provisoire : un point de report qui n'existe dans aucun GTFS, et que l'on publie. */
export type ProvisionalStop = {
	/** L'identifiant publié, « TCAR:DEV:<n> ». Il ne se réattribue jamais. */
	stopId: string;
	name: string;
	latitude: number;
	longitude: number;
};

/** Un arrêt que la déviation dessert à la place des arrêts supprimés. */
export type DetourStop = {
	/** Un quai du GTFS, ou un arrêt provisoire (« TCAR:DEV:<n> ») — la déviation ne fait que désigner. */
	stopId: string;
	/**
	 * Secondes écoulées depuis l'arrivée à l'arrêt de référence — l'arrêt desservi juste AVANT la
	 * borne amont, comme le veut `ReplacementStop.travel_time_to_stop`. La suite doit être
	 * strictement croissante ; c'est la seule contrainte contrôlée à la saisie.
	 *
	 * La valeur peut être NÉGATIVE, pour un arrêt que la course atteint avant l'arrêt de référence —
	 * le cas d'une déviation qui quitte l'itinéraire en amont du premier arrêt supprimé. La
	 * spécification ne les prévoit que lorsque la référence est le premier arrêt de la course ;
	 * l'interface le signale sans l'interdire, l'exploitant sachant seul par où passe son véhicule.
	 *
	 * Il appartient à la déviation, et non à l'arrêt : un même arrêt de report n'est pas atteint au
	 * bout du même temps dans les deux sens.
	 *
	 * L'arrêt de référence peut CHANGER à la publication : lorsqu'un autre tronçon le supprime, les
	 * deux sont fusionnés en une seule `Modification` et ces temps sont recomptés depuis la référence
	 * de celle-là, d'après l'horaire théorique de chaque course (cf. `mergeOverlaps`).
	 */
	travelTime: number;
};

/**
 * Un tronçon dévié : les arrêts qu'il supprime, ceux qu'il dessert à la place, et par où le véhicule
 * passe. C'est très exactement une `Modification` du GTFS-RT, et une déclaration en porte autant que
 * l'info trafic dévie la ligne en d'endroits distincts — deux chantiers sur le même axe ne font pas
 * un seul détour.
 */
export type DetourSegment = {
	/**
	 * Premier arrêt de la plage, borne comprise. Publié comme `start_stop_selector` lorsque la plage
	 * supprime des arrêts ; sinon il ne sert qu'à désigner les courses (cf. `removesStops`).
	 */
	startStopId: string | null;
	/** Dernier arrêt de la plage, borne incluse — `end_stop_selector`. */
	endStopId: string | null;
	/** Secondes à répercuter sur tous les horaires suivant la modification. */
	propagatedDelay: number;
	stops: DetourStop[];
	/**
	 * Les points cliqués, et pour chacun le mode de la jambe qui le suit. C'est le PLAN DE MONTAGE du
	 * tracé, conservé pour pouvoir le reprendre ; rien en aval ne le regarde.
	 */
	waypoints: DetourWaypoint[];
	/**
	 * Le tracé publié, aplati. Il est calculé par l'interface — elle seule sait ce que le routage a
	 * rendu — et rangé tel quel : le reconstruire ici demanderait le graphe routier, qui peut être
	 * absent, et reconstruire le graphe déplacerait alors en silence un tracé déjà publié.
	 */
	path: Coordinates[];
};

/** Un point de passage, et le mode de la jambe qui le SUIT. La dernière ne suit rien. */
export type DetourWaypoint = Coordinates & { mode: DetourLegMode };

/** Accrochée aux rues d'OpenStreetMap, ou tirée droit d'un point de passage au suivant. */
export type DetourLegMode = "route" | "free";

/** Tout ce qui a été déclaré pour une déviation. */
export type DetourRecord = {
	alertNumber: string;
	routeId: string;
	directionId: number;
	/** Date du dernier enregistrement, en secondes epoch — c'est le `last_modified_time` publié. */
	updatedAt: number;
	/** Les tronçons déviés, dans l'ordre où la course les rencontre. */
	segments: DetourSegment[];
};

/**
 * Le périmètre d'une info trafic sur une ligne et un sens, tel qu'il a été SAISI À LA MAIN.
 *
 * Il remplace en bloc ce que l'analyse IA donne pour ce couple : ses arrêts sont les arrêts
 * supprimés, point final. Une liste vide dit « concernée, mais sans suppression » — c'est ce qui
 * ouvre la déclaration d'une déviation dont la desserte ne change pas.
 */
export type ScopeOverride = {
	alertNumber: string;
	routeId: string;
	directionId: number;
	/** Les quais supprimés, dans l'ordre où ils ont été saisis. */
	removedStopIds: string[];
	updatedAt: number;
};

/** Ce qu'une déclaration porte de modifiable : le reste — identité, horodatage — est calculé. */
export type DetourInput = {
	segments: DetourSegment[];
};

export type DetourStore = ReturnType<typeof useDetourStore>;

/** La clé d'une déviation : une info trafic, une ligne, un sens. */
export function detourKey(alertNumber: string, routeId: string, directionId: number): string {
	return `${alertNumber}:${routeId}:${directionId}`;
}

/**
 * Les déviations déclarées, telles qu'elles sont retenues d'un démarrage à l'autre.
 *
 * Tout est relu en mémoire à l'ouverture, puis après chaque écriture : la boucle de publication lit
 * ainsi un instantané, sans toucher à SQLite vingt fois par minute ni avoir de cache à invalider. Le
 * volume s'y prête — quelques dizaines de déviations, quelques centaines de points.
 *
 * `DatabaseSync` est synchrone, et c'est ce qui rend la chose sûre : deux requêtes HTTP ne peuvent
 * pas s'entrelacer au milieu d'une transaction, la première tient la boucle d'événements le temps de
 * la sienne — quelques centaines de microsecondes. Le WAL ne sert donc pas à départager des
 * écrivains concurrents, il n'y en a qu'un ; il évite qu'un arrêt brutal laisse la base en plan.
 */
export function useDetourStore(path: string) {
	mkdirSync(dirname(path), { recursive: true });

	const db = new DatabaseSync(path);
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA synchronous = NORMAL");
	// Sans lui, les `ON DELETE CASCADE` ci-dessus sont lettre morte : SQLite les ignore par défaut.
	db.exec("PRAGMA foreign_keys = ON");
	db.exec("PRAGMA busy_timeout = 2000");

	migrate(db);

	const records = new Map<string, DetourRecord>();
	const provisional = new Map<string, ProvisionalStop>();
	const overrides = new Map<string, ScopeOverride>();

	const reload = () => {
		records.clear();
		provisional.clear();
		overrides.clear();

		for (const row of db.prepare("SELECT * FROM provisional_stops ORDER BY stop_uid").all() as ProvisionalRow[]) {
			const stopId = provisionalStopId(row.stop_uid);
			provisional.set(stopId, { stopId, name: row.name, latitude: row.latitude, longitude: row.longitude });
		}

		for (const row of db.prepare("SELECT * FROM detours").all() as DetourRow[]) {
			records.set(detourKey(row.alert_number, row.route_id, row.direction_id), {
				alertNumber: row.alert_number,
				routeId: row.route_id,
				directionId: row.direction_id,
				updatedAt: row.updated_at,
				segments: [],
			});
		}

		// Les segments d'abord, arrêts et points ensuite : les uns se rangent dans les autres par leur
		// rang, que l'écriture garde contigu depuis zéro.
		for (const row of db
			.prepare("SELECT * FROM detour_segments ORDER BY alert_number, route_id, direction_id, segment")
			.all() as SegmentRow[]) {
			records.get(detourKey(row.alert_number, row.route_id, row.direction_id))?.segments.push({
				startStopId: row.start_stop_id,
				endStopId: row.end_stop_id,
				propagatedDelay: row.propagated_delay,
				stops: [],
				waypoints: [],
				path: [],
			});
		}

		for (const row of db
			.prepare("SELECT * FROM detour_stops ORDER BY alert_number, route_id, direction_id, segment, position")
			.all() as StopRow[]) {
			records
				.get(detourKey(row.alert_number, row.route_id, row.direction_id))
				?.segments[row.segment]?.stops.push({ stopId: row.stop_id, travelTime: row.travel_time });
		}

		for (const row of db
			.prepare("SELECT * FROM detour_path ORDER BY alert_number, route_id, direction_id, segment, position")
			.all() as PathRow[]) {
			records
				.get(detourKey(row.alert_number, row.route_id, row.direction_id))
				?.segments[row.segment]?.path.push({ latitude: row.latitude, longitude: row.longitude });
		}

		for (const row of db
			.prepare("SELECT * FROM detour_waypoints ORDER BY alert_number, route_id, direction_id, segment, position")
			.all() as WaypointRow[]) {
			records.get(detourKey(row.alert_number, row.route_id, row.direction_id))?.segments[row.segment]?.waypoints.push({
				latitude: row.latitude,
				longitude: row.longitude,
				mode: row.mode === "route" ? "route" : "free",
			});
		}

		for (const row of db.prepare("SELECT * FROM scope_overrides").all() as OverrideRow[]) {
			overrides.set(detourKey(row.alert_number, row.route_id, row.direction_id), {
				alertNumber: row.alert_number,
				routeId: row.route_id,
				directionId: row.direction_id,
				removedStopIds: [],
				updatedAt: row.updated_at,
			});
		}

		for (const row of db
			.prepare("SELECT * FROM scope_override_stops ORDER BY alert_number, route_id, direction_id, stop_id")
			.all() as OverrideStopRow[]) {
			overrides.get(detourKey(row.alert_number, row.route_id, row.direction_id))?.removedStopIds.push(row.stop_id);
		}
	};

	reload();
	console.log(`✓ ${records.size} declared detours restored from ${path}.`);

	return {
		/** L'instantané des déclarations, par {@link detourKey}. */
		records: records as ReadonlyMap<string, DetourRecord>,

		/** La base des arrêts provisoires, par identifiant publié. */
		provisionalStops: provisional as ReadonlyMap<string, ProvisionalStop>,

		/** Les périmètres saisis à la main, par {@link detourKey}. */
		scopeOverrides: overrides as ReadonlyMap<string, ScopeOverride>,

		/**
		 * Saisit — ou ressaisit — le périmètre d'une info trafic sur une ligne et un sens. La liste
		 * d'arrêts remplace celle de l'analyse : elle peut être vide, et c'est même le cas qui motive
		 * tout ceci — une ligne déviée sans qu'aucun arrêt n'y soit supprimé.
		 */
		saveScopeOverride(
			alertNumber: string,
			routeId: string,
			directionId: number,
			stopIds: readonly string[],
			nowSeconds: number,
		): ScopeOverride {
			db.exec("BEGIN");
			try {
				db.prepare(
					`INSERT INTO scope_overrides (alert_number, route_id, direction_id, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (alert_number, route_id, direction_id) DO UPDATE SET
						 updated_at = excluded.updated_at`,
				).run(alertNumber, routeId, directionId, nowSeconds);

				db.prepare("DELETE FROM scope_override_stops WHERE alert_number = ? AND route_id = ? AND direction_id = ?").run(
					alertNumber,
					routeId,
					directionId,
				);

				const insert = db.prepare(
					`INSERT INTO scope_override_stops (alert_number, route_id, direction_id, stop_id)
					 VALUES (?, ?, ?, ?)`,
				);
				for (const stopId of new Set(stopIds)) insert.run(alertNumber, routeId, directionId, stopId);

				db.exec("COMMIT");
			} catch (cause) {
				db.exec("ROLLBACK");
				throw cause;
			}

			reload();
			return overrides.get(detourKey(alertNumber, routeId, directionId)) as ScopeOverride;
		},

		/**
		 * Rend la main à l'analyse IA pour ce couple. La déclaration de déviation, elle, reste : elle ne
		 * tient pas au périmètre, et l'effacer ferait perdre un tracé pour une reprise de saisie.
		 */
		removeScopeOverride(alertNumber: string, routeId: string, directionId: number): boolean {
			const { changes } = db
				.prepare("DELETE FROM scope_overrides WHERE alert_number = ? AND route_id = ? AND direction_id = ?")
				.run(alertNumber, routeId, directionId);

			reload();
			return changes > 0;
		},

		/**
		 * Enregistre une déclaration, d'un bloc : la boucle de publication ne peut jamais lire une
		 * déviation dont les segments auraient été effacés mais pas encore réécrits.
		 *
		 * Les segments sont remplacés en entier plutôt que rapprochés un à un — la liste est courte, et
		 * l'interface renvoie de toute façon son état complet. Les effacer emporte leurs arrêts et leurs
		 * points, par cascade. Un arrêt de substitution n'est que désigné : ce qu'il est se lit ailleurs,
		 * dans le GTFS ou dans la base des arrêts provisoires.
		 */
		save(alertNumber: string, routeId: string, directionId: number, input: DetourInput, nowSeconds: number) {
			db.exec("BEGIN");
			try {
				db.prepare(
					`INSERT INTO detours (alert_number, route_id, direction_id, updated_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT (alert_number, route_id, direction_id) DO UPDATE SET
						 updated_at = excluded.updated_at`,
				).run(alertNumber, routeId, directionId, nowSeconds);

				db.prepare("DELETE FROM detour_segments WHERE alert_number = ? AND route_id = ? AND direction_id = ?").run(
					alertNumber,
					routeId,
					directionId,
				);

				const insertSegment = db.prepare(
					`INSERT INTO detour_segments
						(alert_number, route_id, direction_id, segment, start_stop_id, end_stop_id, propagated_delay)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const insertStop = db.prepare(
					`INSERT INTO detour_stops (alert_number, route_id, direction_id, segment, position, stop_id, travel_time)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const insertPoint = db.prepare(
					`INSERT INTO detour_path (alert_number, route_id, direction_id, segment, position, latitude, longitude)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				);
				const insertWaypoint = db.prepare(
					`INSERT INTO detour_waypoints
						(alert_number, route_id, direction_id, segment, position, latitude, longitude, mode)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				);

				input.segments.forEach((segment, rank) => {
					insertSegment.run(
						alertNumber,
						routeId,
						directionId,
						rank,
						segment.startStopId,
						segment.endStopId,
						segment.propagatedDelay,
					);
					segment.stops.forEach((stop, position) => {
						insertStop.run(alertNumber, routeId, directionId, rank, position, stop.stopId, stop.travelTime);
					});
					segment.path.forEach((point, position) => {
						insertPoint.run(alertNumber, routeId, directionId, rank, position, point.latitude, point.longitude);
					});
					segment.waypoints.forEach((waypoint, position) => {
						insertWaypoint.run(
							alertNumber,
							routeId,
							directionId,
							rank,
							position,
							waypoint.latitude,
							waypoint.longitude,
							waypoint.mode,
						);
					});
				});

				db.exec("COMMIT");
			} catch (cause) {
				db.exec("ROLLBACK");
				throw cause;
			}

			reload();
			return records.get(detourKey(alertNumber, routeId, directionId));
		},

		/** Efface une déclaration — ses segments, leurs arrêts et leurs tracés partent avec elle, par cascade. */
		remove(alertNumber: string, routeId: string, directionId: number) {
			db.prepare("DELETE FROM detours WHERE alert_number = ? AND route_id = ? AND direction_id = ?").run(
				alertNumber,
				routeId,
				directionId,
			);
			reload();
		},

		/** Verse un arrêt provisoire dans la base. Il est aussitôt désignable par toutes les déviations. */
		createProvisionalStop(name: string, latitude: number, longitude: number, nowSeconds: number): ProvisionalStop {
			const { lastInsertRowid } = db
				.prepare("INSERT INTO provisional_stops (name, latitude, longitude, created_at) VALUES (?, ?, ?, ?)")
				.run(name, latitude, longitude, nowSeconds);

			reload();
			return provisional.get(provisionalStopId(Number(lastInsertRowid))) as ProvisionalStop;
		},

		/**
		 * Renomme ou déplace un arrêt provisoire. Le changement vaut pour TOUTES les déviations qui le
		 * désignent : c'est le même arrêt sur le terrain, il n'a pas à être entretenu deux fois.
		 */
		updateProvisionalStop(stopId: string, name: string, latitude: number, longitude: number): boolean {
			const uid = provisionalStopUid(stopId);
			if (uid === undefined) return false;

			const { changes } = db
				.prepare("UPDATE provisional_stops SET name = ?, latitude = ?, longitude = ? WHERE stop_uid = ?")
				.run(name, latitude, longitude, uid);

			reload();
			return changes > 0;
		},

		/**
		 * Retire un arrêt provisoire de la base. Refusé tant qu'une déviation le désigne : le supprimer
		 * laisserait dans le feed des `replacement_stops` pointant vers un arrêt que rien ne définit.
		 */
		deleteProvisionalStop(stopId: string): boolean {
			const uid = provisionalStopUid(stopId);
			if (uid === undefined) return false;

			for (const record of records.values()) {
				for (const segment of record.segments) {
					if (segment.stops.some((stop) => stop.stopId === stopId)) return false;
				}
			}

			db.prepare("DELETE FROM provisional_stops WHERE stop_uid = ?").run(uid);
			reload();
			return true;
		},
	};
}

/** L'identifiant publié d'un arrêt provisoire. */
export function provisionalStopId(stopUid: number): string {
	return `TCAR:DEV:${stopUid}`;
}

/** Le numéro d'un arrêt provisoire d'après son identifiant publié, ou `undefined` si ce n'en est pas un. */
export function provisionalStopUid(stopId: string): number | undefined {
	const match = /^TCAR:DEV:(\d+)$/.exec(stopId);
	return match === null ? undefined : Number(match[1]);
}

// ---

type DetourRow = {
	alert_number: string;
	route_id: string;
	direction_id: number;
	updated_at: number;
};

type SegmentRow = {
	alert_number: string;
	route_id: string;
	direction_id: number;
	segment: number;
	start_stop_id: string | null;
	end_stop_id: string | null;
	propagated_delay: number;
};

type OverrideRow = { alert_number: string; route_id: string; direction_id: number; updated_at: number };

type OverrideStopRow = { alert_number: string; route_id: string; direction_id: number; stop_id: string };

type ProvisionalRow = { stop_uid: number; name: string; latitude: number; longitude: number; created_at: number };

type StopRow = {
	alert_number: string;
	route_id: string;
	direction_id: number;
	segment: number;
	position: number;
	stop_id: string;
	travel_time: number;
};

/** L'ancienne forme des arrêts de déviation, telle que la migration vers la base d'arrêts la relit. */
type LegacyStopRow = {
	alert_number: string;
	route_id: string;
	direction_id: number;
	stop_uid: number;
	position: number;
	name: string;
	latitude: number;
	longitude: number;
	travel_time: number;
	gtfs_stop_id: string | null;
	shared_stop_id: string | null;
};

type PathRow = {
	alert_number: string;
	route_id: string;
	direction_id: number;
	segment: number;
	position: number;
	latitude: number;
	longitude: number;
};

type WaypointRow = PathRow & { mode: string };

/**
 * Applique les migrations qui manquent. Chacune passe dans sa propre transaction, `user_version`
 * comprise : une migration interrompue ne laisse pas la base à mi-chemin d'un schéma.
 *
 * `PRAGMA user_version = ?` n'accepte pas de paramètre lié — d'où l'interpolation, sur un index de
 * boucle qui ne vient de nulle part ailleurs.
 */
function migrate(db: DatabaseSync) {
	const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };

	for (let index = version; index < MIGRATIONS.length; index += 1) {
		const migration = MIGRATIONS[index] as string | ((db: DatabaseSync) => void);
		db.exec("BEGIN");
		try {
			if (typeof migration === "string") db.exec(migration);
			else migration(db);
			db.exec(`PRAGMA user_version = ${index + 1}`);
			db.exec("COMMIT");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
	}
}
