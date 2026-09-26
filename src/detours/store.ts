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
	-- Une modification : une ligne, un sens, éventuellement des tracés précis, une période, une raison,
	-- des arrêts supprimés et des tronçons. Elle est créée par l'IA quand l'analyse d'une info trafic
	-- permet de l'appliquer, ou à la main — rattachée à une info trafic ou non.
	--
	-- Un champ laissé NULL d'une modification rattachée suit son info trafic : la raison est son titre,
	-- la période les siennes, les arrêts supprimés ce qu'en lit l'analyse.
	--
	-- L'IA en crée une par LECTURE des arrêts supprimés (cf. readAnalysis) : il peut donc y en
	-- avoir plusieurs par info trafic, ligne et sens, une par groupe de tracés.
	CREATE TABLE modifications (
		uid                INTEGER PRIMARY KEY AUTOINCREMENT,
		-- « ai » : créée par l'analyse. « manual » : saisie. L'une comme l'autre se supprime.
		origin             TEXT    NOT NULL CHECK (origin IN ('ai', 'manual')),
		-- NULL : sans info trafic. La raison et la période sont alors obligatoires.
		alert_number       TEXT,
		route_id           TEXT    NOT NULL,
		direction_id       INTEGER NOT NULL,
		label              TEXT,
		-- AAAA-MM-JJ et HH:MM. NULL au début : la période est celle de l'info trafic.
		start_date         TEXT,
		start_time         TEXT,
		end_date           TEXT,
		end_time           TEXT,
		-- 1 : les arrêts supprimés sont ceux de modification_removed_stops, fût-ce aucun.
		removed_overridden INTEGER NOT NULL DEFAULT 0,
		-- Invisible : ni publiée, ni ses arrêts sautés.
		disabled           INTEGER NOT NULL DEFAULT 0,
		created_at         INTEGER NOT NULL,
		-- Le last_modified_time publié.
		updated_at         INTEGER NOT NULL
	) STRICT;

	-- Les tracés visés, par leur empreinte (cf. RoutePattern). Aucun : tous.
	CREATE TABLE modification_patterns (
		uid        INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		pattern_id TEXT    NOT NULL,
		PRIMARY KEY (uid, pattern_id)
	) STRICT;

	CREATE TABLE modification_removed_stops (
		uid     INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		stop_id TEXT    NOT NULL,
		PRIMARY KEY (uid, stop_id)
	) STRICT;

	-- Les trios info trafic × ligne × sens ignorés : l'IA n'y crée ni n'y suggère plus rien.
	CREATE TABLE dismissed_scopes (
		alert_number TEXT    NOT NULL,
		route_id     TEXT    NOT NULL,
		direction_id INTEGER NOT NULL,
		dismissed_at INTEGER NOT NULL,
		PRIMARY KEY (alert_number, route_id, direction_id)
	) STRICT;

	-- Le premier relevé où chaque info trafic a été vue : c'est l'ordre chronologique de la liste.
	CREATE TABLE alert_first_seen (
		alert_number  TEXT    PRIMARY KEY,
		first_seen_at INTEGER NOT NULL
	) STRICT;

	-- Les tronçons déviés d'une modification. Le rang ne sert qu'à les ordonner : save les réécrit
	-- tous, et rien au dehors ne désigne un tronçon en particulier.
	CREATE TABLE segments (
		uid              INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		segment          INTEGER NOT NULL,
		-- Bornes du tronçon, incluses. NULL tant qu'elles n'ont pas été choisies : il n'est pas publiable.
		start_stop_id    TEXT,
		end_stop_id      TEXT,
		propagated_delay INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (uid, segment)
	) STRICT;

	-- Les arrêts de substitution, dans l'ordre de desserte.
	CREATE TABLE segment_stops (
		uid         INTEGER NOT NULL,
		segment     INTEGER NOT NULL,
		position    INTEGER NOT NULL,
		-- Un quai du GTFS, ou « PROV:<stop_uid> » (« TCAR:DEV:<stop_uid> » avant la migration qui suit) : le
		-- tronçon ne fait que désigner.
		stop_id     TEXT    NOT NULL,
		-- Secondes depuis l'arrivée à l'arrêt de référence (cf. DetourStop.travelTime).
		travel_time INTEGER NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Le tracé publié, point par point.
	CREATE TABLE segment_path (
		uid       INTEGER NOT NULL,
		segment   INTEGER NOT NULL,
		position  INTEGER NOT NULL,
		latitude  REAL    NOT NULL,
		longitude REAL    NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Les points de passage cliqués, de quoi reprendre le tracé.
	CREATE TABLE segment_waypoints (
		uid       INTEGER NOT NULL,
		segment   INTEGER NOT NULL,
		position  INTEGER NOT NULL,
		latitude  REAL    NOT NULL,
		longitude REAL    NOT NULL,
		-- Le mode de la jambe qui SUIT ce point : « route » ou « free ». Sans objet pour le dernier.
		mode      TEXT    NOT NULL,
		PRIMARY KEY (uid, segment, position),
		FOREIGN KEY (uid, segment) REFERENCES segments (uid, segment) ON DELETE CASCADE
	) STRICT;

	-- Les arrêts provisoires : des points de report qui n'existent dans aucun GTFS. Ils n'appartiennent
	-- à aucune modification — un arrêt de report sert souvent à plusieurs : les deux sens d'un
	-- rebroussement, deux infos trafic successives sur le même chantier.
	CREATE TABLE provisional_stops (
		-- AUTOINCREMENT : un identifiant publié ne se réattribue jamais.
		stop_uid   INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT    NOT NULL,
		latitude   REAL    NOT NULL,
		longitude  REAL    NOT NULL,
		created_at INTEGER NOT NULL
	) STRICT;
	`,
	// Une modification peut annuler des courses entières. Elle les désigne par leur départ — le quai
	// et l'horaire du premier arrêt — et non par leur trip_id : le GTFS décrit une même course une fois
	// par service qui l'assure, et « le 17:05 depuis Théâtre des Arts » est une seule chose, en semaine
	// comme le samedi. Avec la ligne et le sens de la modification, c'est la clé de course du GTFS
	// (cf. buildCourses).
	`
	CREATE TABLE modification_cancelled_departures (
		uid       INTEGER NOT NULL REFERENCES modifications (uid) ON DELETE CASCADE,
		stop_id   TEXT    NOT NULL,
		-- Secondes depuis le minuit de la journée de service, au-delà de 86 400 après minuit.
		departure INTEGER NOT NULL,
		PRIMARY KEY (uid, stop_id, departure)
	) STRICT;
	`,
	// Les arrêts provisoires passent de « TCAR:DEV:<n> » à « PROV:<n> » : ils servent désormais aux
	// lignes des trois réseaux, et n'appartiennent à aucun. Le numéro ne bouge pas — seul le préfixe
	// change, partout où un identifiant d'arrêt est rangé. Aucun quai du GTFS ne commence ainsi.
	`
	UPDATE segment_stops
		SET stop_id = 'PROV:' || substr(stop_id, 10) WHERE substr(stop_id, 1, 9) = 'TCAR:DEV:';
	UPDATE segments
		SET start_stop_id = 'PROV:' || substr(start_stop_id, 10) WHERE substr(start_stop_id, 1, 9) = 'TCAR:DEV:';
	UPDATE segments
		SET end_stop_id = 'PROV:' || substr(end_stop_id, 10) WHERE substr(end_stop_id, 1, 9) = 'TCAR:DEV:';
	UPDATE modification_removed_stops
		SET stop_id = 'PROV:' || substr(stop_id, 10) WHERE substr(stop_id, 1, 9) = 'TCAR:DEV:';
	UPDATE modification_cancelled_departures
		SET stop_id = 'PROV:' || substr(stop_id, 10) WHERE substr(stop_id, 1, 9) = 'TCAR:DEV:';
	`,
	// Un tronçon peut déclarer que son tracé ouvre ou ferme la course (cf. DetourSegment.terminus).
	// NULL : le raccord se lit de la géométrie, comme avant.
	`
	ALTER TABLE segments ADD COLUMN terminus TEXT CHECK (terminus IN ('start', 'end'));
	`,
	// Le dernier titre relevé de chaque info trafic. Il la nomme encore une fois sortie du flux : ses
	// modifications restent, et se rattachent à celle qui lui succède (cf. `reattach`).
	`
	ALTER TABLE alert_first_seen ADD COLUMN header_text TEXT;
	`,
	// La priorité d'une modification : en vigueur et visible, elle écrase celles de priorité moindre
	// qui touchent les mêmes courses (cf. `indexModifications`). 0 pour toutes au départ : rien ne
	// change tant qu'on n'en relève pas une.
	`
	ALTER TABLE modifications ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
	`,
];

/** Un arrêt provisoire : un point de report qui n'existe dans aucun GTFS, et que l'on publie. */
export type ProvisionalStop = {
	/** L'identifiant publié, « PROV:<n> ». Il ne se réattribue jamais. */
	stopId: string;
	name: string;
	latitude: number;
	longitude: number;
};

/** Un arrêt que la déviation dessert à la place des arrêts supprimés. */
export type DetourStop = {
	/** Un quai du GTFS, ou un arrêt provisoire (« PROV:<n> ») — la déviation ne fait que désigner. */
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
 * passe. C'est très exactement une `Modification` du GTFS-RT, et une modification en porte autant
 * qu'elle dévie la ligne en d'endroits distincts — deux chantiers sur le même axe ne font pas un
 * seul détour.
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
	/**
	 * Le bout de la course que le tracé remplace, s'il en remplace un : « start », la course part de
	 * son premier point ; « end », elle s'achève à son dernier. Rien de l'itinéraire ne s'y raccorde
	 * alors, quand bien même le tracé y toucherait. `null` : le raccord se lit de la géométrie (cf.
	 * `spliceShape`).
	 */
	terminus: DetourTerminus | null;
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

/** Le bout de la course qu'un tracé remplace : son début, ou sa fin. */
export type DetourTerminus = "start" | "end";

/** Accrochée aux rues d'OpenStreetMap, ou tirée droit d'un point de passage au suivant. */
export type DetourLegMode = "route" | "free";

/** Créée par l'analyse d'une info trafic, ou saisie. */
export type ModificationOrigin = "ai" | "manual";

/**
 * La période saisie d'une modification, bornes au format « AAAA-MM-JJ » ou « AAAA-MM-JJTHH:MM » —
 * celui des périodes d'info trafic, qui se jaugent de la même façon (cf. `isActive`). Sans fin, elle
 * est ouverte.
 */
export type ModificationPeriod = { start: string; end: string | null };

/**
 * Une modification, telle qu'elle a été saisie. Les champs `null` d'une modification rattachée à une
 * info trafic suivent celle-ci ; c'est l'indexation qui les résout (cf. `indexModifications`).
 */
export type Modification = {
	uid: number;
	origin: ModificationOrigin;
	/** L'info trafic à laquelle elle se rattache, ou `null`. */
	alertNumber: string | null;
	routeId: string;
	directionId: number;
	/** `null` : le titre de l'info trafic. */
	label: string | null;
	/** `null` : les périodes de l'info trafic. */
	period: ModificationPeriod | null;
	/**
	 * Les tracés empruntés visés (cf. `RoutePattern`), ou aucun pour les viser tous. La modification
	 * ne touche que les courses de ces tracés — ses tronçons comme ses arrêts supprimés.
	 */
	patternIds: string[];
	/** `null` : ce que l'analyse lit pour sa ligne et son sens. Sinon les quais supprimés, fût-ce aucun. */
	removedStopIds: string[] | null;
	/** Invisible : ni publiée, ni ses arrêts sautés. */
	disabled: boolean;
	/**
	 * Plus elle est élevée, plus la modification l'emporte : en vigueur et visible, elle écrase celles
	 * de priorité moindre qui touchent les mêmes courses. 0 par défaut.
	 */
	priority: number;
	createdAt: number;
	/** Date du dernier enregistrement, en secondes epoch — c'est le `last_modified_time` publié. */
	updatedAt: number;
	/** Les tronçons déviés, dans l'ordre où la course les rencontre. */
	segments: DetourSegment[];
	/** Les départs annulés, chaque jour de la période où ils circulent. */
	cancelledDepartures: CancelledDeparture[];
};

/**
 * Un départ annulé : le quai et l'horaire du premier arrêt de la course, en secondes depuis le
 * minuit de la journée de service. Avec la ligne et le sens de la modification, c'est la clé de
 * course du GTFS : toutes les versions de la course, un par service, en relèvent.
 */
export type CancelledDeparture = { stopId: string; departure: number };

/** Ce qu'un enregistrement porte : tout ce qui se saisit, d'un bloc. */
export type ModificationInput = Pick<
	Modification,
	"label" | "period" | "patternIds" | "removedStopIds" | "segments" | "cancelledDepartures" | "priority"
>;

/** Ce qu'il faut pour créer une modification à la main. Le reste se saisit ensuite. */
export type ManualInput = Pick<
	Modification,
	"alertNumber" | "routeId" | "directionId" | "label" | "period" | "patternIds"
>;

export type DetourStore = ReturnType<typeof useDetourStore>;

/** Un trio info trafic × ligne × sens. */
export type Scope = { alertNumber: string; routeId: string; directionId: number };

/** Une modification que l'IA crée d'elle-même : un trio, et les tracés visés — aucun pour tous. */
export type Proposal = Scope & { patternIds: string[] };

/** La clé d'un trio info trafic × ligne × sens : c'est à cette maille que l'IA crée, suggère, et qu'on ignore. */
export function scopeKey(alertNumber: string, routeId: string, directionId: number): string {
	return `${alertNumber}:${routeId}:${directionId}`;
}

/**
 * Les modifications, telles qu'elles sont retenues d'un démarrage à l'autre, et la base des arrêts
 * provisoires.
 *
 * Tout est relu en mémoire à l'ouverture, puis après chaque écriture : la boucle de publication lit
 * ainsi un instantané, sans toucher à SQLite vingt fois par minute ni avoir de cache à invalider. Le
 * volume s'y prête — quelques dizaines de modifications, quelques centaines de points.
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

	const modifications = new Map<number, Modification>();
	const provisional = new Map<string, ProvisionalStop>();
	const dismissed = new Set<string>();
	const firstSeen = new Map<string, number>();
	const headers = new Map<string, string>();

	const reload = () => {
		modifications.clear();
		provisional.clear();
		dismissed.clear();
		firstSeen.clear();
		headers.clear();

		for (const row of db.prepare("SELECT * FROM provisional_stops ORDER BY stop_uid").all() as ProvisionalRow[]) {
			const stopId = provisionalStopId(row.stop_uid);
			provisional.set(stopId, { stopId, name: row.name, latitude: row.latitude, longitude: row.longitude });
		}

		for (const row of db.prepare("SELECT * FROM dismissed_scopes").all() as DismissedRow[]) {
			dismissed.add(scopeKey(row.alert_number, row.route_id, row.direction_id));
		}

		for (const row of db.prepare("SELECT * FROM alert_first_seen").all() as FirstSeenRow[]) {
			firstSeen.set(row.alert_number, row.first_seen_at);
			if (row.header_text !== null) headers.set(row.alert_number, row.header_text);
		}

		for (const row of db.prepare("SELECT * FROM modifications ORDER BY uid").all() as ModificationRow[]) {
			modifications.set(row.uid, {
				uid: row.uid,
				origin: row.origin === "ai" ? "ai" : "manual",
				alertNumber: row.alert_number,
				routeId: row.route_id,
				directionId: row.direction_id,
				label: row.label,
				period:
					row.start_date === null
						? null
						: {
								start: joinBound(row.start_date, row.start_time),
								end: row.end_date === null ? null : joinBound(row.end_date, row.end_time),
							},
				patternIds: [],
				removedStopIds: row.removed_overridden === 1 ? [] : null,
				disabled: row.disabled === 1,
				priority: row.priority,
				createdAt: row.created_at,
				updatedAt: row.updated_at,
				segments: [],
				cancelledDepartures: [],
			});
		}

		for (const row of db
			.prepare("SELECT * FROM modification_patterns ORDER BY uid, pattern_id")
			.all() as PatternRow[]) {
			modifications.get(row.uid)?.patternIds.push(row.pattern_id);
		}

		for (const row of db
			.prepare("SELECT * FROM modification_removed_stops ORDER BY uid, stop_id")
			.all() as RemovedRow[]) {
			modifications.get(row.uid)?.removedStopIds?.push(row.stop_id);
		}

		// Les segments d'abord, arrêts et points ensuite : les uns se rangent dans les autres par leur
		// rang, que l'écriture garde contigu depuis zéro.
		for (const row of db.prepare("SELECT * FROM segments ORDER BY uid, segment").all() as SegmentRow[]) {
			modifications.get(row.uid)?.segments.push({
				startStopId: row.start_stop_id,
				endStopId: row.end_stop_id,
				propagatedDelay: row.propagated_delay,
				terminus: row.terminus === "start" || row.terminus === "end" ? row.terminus : null,
				stops: [],
				waypoints: [],
				path: [],
			});
		}

		for (const row of db.prepare("SELECT * FROM segment_stops ORDER BY uid, segment, position").all() as StopRow[]) {
			modifications
				.get(row.uid)
				?.segments[row.segment]?.stops.push({ stopId: row.stop_id, travelTime: row.travel_time });
		}

		for (const row of db.prepare("SELECT * FROM segment_path ORDER BY uid, segment, position").all() as PathRow[]) {
			modifications
				.get(row.uid)
				?.segments[row.segment]?.path.push({ latitude: row.latitude, longitude: row.longitude });
		}

		for (const row of db
			.prepare("SELECT * FROM segment_waypoints ORDER BY uid, segment, position")
			.all() as WaypointRow[]) {
			modifications.get(row.uid)?.segments[row.segment]?.waypoints.push({
				latitude: row.latitude,
				longitude: row.longitude,
				mode: row.mode === "route" ? "route" : "free",
			});
		}

		for (const row of db
			.prepare("SELECT * FROM modification_cancelled_departures ORDER BY uid, departure, stop_id")
			.all() as CancelledRow[]) {
			modifications.get(row.uid)?.cancelledDepartures.push({ stopId: row.stop_id, departure: row.departure });
		}
	};

	/** Exécute `work` dans une transaction : tout ou rien, puis relit l'instantané. */
	const transaction = <T>(work: () => T): T => {
		db.exec("BEGIN");
		let result: T;
		try {
			result = work();
			db.exec("COMMIT");
		} catch (cause) {
			db.exec("ROLLBACK");
			throw cause;
		}
		reload();
		return result;
	};

	const writePatterns = (uid: number, patternIds: readonly string[]) => {
		db.prepare("DELETE FROM modification_patterns WHERE uid = ?").run(uid);
		const insert = db.prepare("INSERT INTO modification_patterns (uid, pattern_id) VALUES (?, ?)");
		for (const patternId of new Set(patternIds)) insert.run(uid, patternId);
	};

	/** Les arrêts supprimés saisis, ou `null` pour suivre l'analyse. */
	const writeRemoved = (uid: number, removedStopIds: readonly string[] | null) => {
		db.prepare("UPDATE modifications SET removed_overridden = ? WHERE uid = ?").run(
			removedStopIds === null ? 0 : 1,
			uid,
		);
		db.prepare("DELETE FROM modification_removed_stops WHERE uid = ?").run(uid);
		const insert = db.prepare("INSERT INTO modification_removed_stops (uid, stop_id) VALUES (?, ?)");
		for (const stopId of new Set(removedStopIds ?? [])) insert.run(uid, stopId);
	};

	const writeCancelled = (uid: number, departures: readonly CancelledDeparture[]) => {
		db.prepare("DELETE FROM modification_cancelled_departures WHERE uid = ?").run(uid);
		const insert = db.prepare(
			"INSERT OR IGNORE INTO modification_cancelled_departures (uid, stop_id, departure) VALUES (?, ?, ?)",
		);
		for (const { stopId, departure } of departures) insert.run(uid, stopId, departure);
	};

	/**
	 * Remplace les tronçons en entier plutôt que de les rapprocher un à un — la liste est courte, et
	 * l'interface renvoie de toute façon son état complet. Effacer les segments emporte leurs arrêts
	 * et leurs points, par cascade.
	 */
	const writeSegments = (uid: number, segments: readonly DetourSegment[]) => {
		db.prepare("DELETE FROM segments WHERE uid = ?").run(uid);
		const insertSegment = db.prepare(
			"INSERT INTO segments (uid, segment, start_stop_id, end_stop_id, propagated_delay, terminus) VALUES (?, ?, ?, ?, ?, ?)",
		);
		const insertStop = db.prepare(
			"INSERT INTO segment_stops (uid, segment, position, stop_id, travel_time) VALUES (?, ?, ?, ?, ?)",
		);
		const insertPoint = db.prepare(
			"INSERT INTO segment_path (uid, segment, position, latitude, longitude) VALUES (?, ?, ?, ?, ?)",
		);
		const insertWaypoint = db.prepare(
			"INSERT INTO segment_waypoints (uid, segment, position, latitude, longitude, mode) VALUES (?, ?, ?, ?, ?, ?)",
		);

		segments.forEach((segment, rank) => {
			insertSegment.run(uid, rank, segment.startStopId, segment.endStopId, segment.propagatedDelay, segment.terminus);
			segment.stops.forEach((stop, position) => {
				insertStop.run(uid, rank, position, stop.stopId, stop.travelTime);
			});
			segment.path.forEach((point, position) => {
				insertPoint.run(uid, rank, position, point.latitude, point.longitude);
			});
			segment.waypoints.forEach((waypoint, position) => {
				insertWaypoint.run(uid, rank, position, waypoint.latitude, waypoint.longitude, waypoint.mode);
			});
		});
	};

	reload();
	console.log(`✓ ${modifications.size} modifications restored from ${path}.`);

	return {
		/** L'instantané des modifications, par uid. */
		modifications: modifications as ReadonlyMap<number, Modification>,

		/** La base des arrêts provisoires, par identifiant publié. */
		provisionalStops: provisional as ReadonlyMap<string, ProvisionalStop>,

		/** Les trios info trafic × ligne × sens écartés, par {@link scopeKey} : l'IA n'y revient plus. */
		dismissedScopes: dismissed as ReadonlySet<string>,

		/** Numéro d'info trafic → premier relevé où elle a été vue, en secondes epoch. */
		alertFirstSeen: firstSeen as ReadonlyMap<string, number>,

		/** Numéro d'info trafic → dernier titre relevé, qu'elle soit encore au flux ou non. */
		alertHeaders: headers as ReadonlyMap<string, string>,

		/**
		 * Retient la première apparition des infos trafic du flux, et leur dernier titre. Une info trafic
		 * déjà vue garde sa date : c'est l'ordre dans lequel elles sont arrivées, pas celui de leur
		 * dernier passage.
		 */
		recordAlerts(alerts: Iterable<{ alertNumber: string; headerText: string }>, nowSeconds: number) {
			const upsert = db.prepare(
				`INSERT INTO alert_first_seen (alert_number, first_seen_at, header_text) VALUES (?, ?, ?)
				 ON CONFLICT (alert_number) DO UPDATE SET header_text = excluded.header_text`,
			);
			for (const { alertNumber, headerText } of alerts) {
				if (firstSeen.has(alertNumber) && headers.get(alertNumber) === headerText) continue;
				const seenAt = firstSeen.get(alertNumber) ?? nowSeconds;
				upsert.run(alertNumber, seenAt, headerText);
				firstSeen.set(alertNumber, seenAt);
				headers.set(alertNumber, headerText);
			}
		},

		/**
		 * Crée les modifications que l'IA propose, sauf sur un trio écarté ou qui porte déjà une
		 * modification — de l'IA, ou saisie à la place d'une suggestion : ce qu'une lecture a créé, ou ce
		 * que la main y a mis, n'est jamais complété en douce. Renvoie le nombre de créations.
		 */
		syncAi(proposals: Iterable<Proposal>, nowSeconds: number) {
			const taken = new Set<string>();
			for (const modification of modifications.values()) {
				if (modification.alertNumber === null) continue;
				taken.add(scopeKey(modification.alertNumber, modification.routeId, modification.directionId));
			}

			const fresh = [...proposals].filter((proposal) => {
				const key = scopeKey(proposal.alertNumber, proposal.routeId, proposal.directionId);
				return !taken.has(key) && !dismissed.has(key);
			});
			if (fresh.length === 0) return 0;

			return transaction(() => {
				const insert = db.prepare(
					`INSERT INTO modifications (origin, alert_number, route_id, direction_id, created_at, updated_at)
					 VALUES ('ai', ?, ?, ?, ?, ?)`,
				);
				for (const { alertNumber, routeId, directionId, patternIds } of fresh) {
					const { lastInsertRowid } = insert.run(alertNumber, routeId, directionId, nowSeconds, nowSeconds);
					writePatterns(Number(lastInsertRowid), patternIds);
				}
				return fresh.length;
			});
		},

		/**
		 * Crée une modification à la main, rattachée à une info trafic ou non. Sans info trafic, il n'y
		 * a pas d'analyse à suivre : ses arrêts supprimés sont saisis — aucun, pour commencer.
		 */
		createManual(input: ManualInput, nowSeconds: number): Modification {
			const bounds = periodColumns(input.period);

			const uid = transaction(() => {
				const { lastInsertRowid } = db
					.prepare(
						`INSERT INTO modifications
							(origin, alert_number, route_id, direction_id, label, start_date, start_time, end_date, end_time,
							 created_at, updated_at)
						 VALUES ('manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(input.alertNumber, input.routeId, input.directionId, input.label, ...bounds, nowSeconds, nowSeconds);
				const uid = Number(lastInsertRowid);

				writePatterns(uid, input.patternIds);
				if (input.alertNumber === null) writeRemoved(uid, []);
				return uid;
			});

			return modifications.get(uid) as Modification;
		},

		/**
		 * Enregistre une modification, d'un bloc : la boucle de publication ne peut jamais en lire une
		 * dont les tronçons auraient été effacés mais pas encore réécrits.
		 */
		save(uid: number, input: ModificationInput, nowSeconds: number): Modification | undefined {
			if (!modifications.has(uid)) return undefined;

			transaction(() => {
				db.prepare(
					`UPDATE modifications
					 SET label = ?, start_date = ?, start_time = ?, end_date = ?, end_time = ?, priority = ?, updated_at = ?
					 WHERE uid = ?`,
				).run(input.label, ...periodColumns(input.period), input.priority, nowSeconds, uid);
				writePatterns(uid, input.patternIds);
				writeRemoved(uid, input.removedStopIds);
				writeSegments(uid, input.segments);
				writeCancelled(uid, input.cancelledDepartures);
			});

			return modifications.get(uid);
		},

		/**
		 * Rattache des modifications à une autre info trafic — celle qui succède à la leur, sortie du
		 * flux. Rien de ce qui y a été saisi ne bouge ; ce qui ne l'a pas été suit la nouvelle. Elles
		 * sont réhorodatées : l'info trafic qu'elles citent vient de changer.
		 */
		reattach(uids: Iterable<number>, alertNumber: string, nowSeconds: number): number {
			return transaction(() => {
				const update = db.prepare("UPDATE modifications SET alert_number = ?, updated_at = ? WHERE uid = ?");
				let changes = 0;
				for (const uid of uids) changes += Number(update.run(alertNumber, nowSeconds, uid).changes);
				return changes;
			});
		},

		/** Rend des modifications visibles ou invisibles. Invisible, rien de ce qu'elle déclare ne sort. */
		setDisabled(uids: Iterable<number>, disabled: boolean): number {
			return transaction(() => {
				const update = db.prepare("UPDATE modifications SET disabled = ? WHERE uid = ?");
				let changes = 0;
				for (const uid of uids) changes += Number(update.run(disabled ? 1 : 0, uid).changes);
				return changes;
			});
		},

		/**
		 * Efface des modifications — et tout ce qu'elles portent, par cascade — et écarte des trios pour
		 * de bon : l'IA ne les crée plus ni ne les suggère. D'un bloc, pour qu'une modification de l'IA
		 * ne puisse pas disparaître sans que son trio soit écarté, et renaître au relevé suivant.
		 *
		 * Écarter un trio ne touche pas aux modifications qui le portent encore : les autres lectures
		 * d'une même info trafic, ou ce qui a été saisi à la main.
		 */
		discard(uids: Iterable<number>, scopes: Iterable<Scope>, nowSeconds: number) {
			transaction(() => {
				const remove = db.prepare("DELETE FROM modifications WHERE uid = ?");
				for (const uid of uids) remove.run(uid);

				const dismiss = db.prepare(
					`INSERT INTO dismissed_scopes (alert_number, route_id, direction_id, dismissed_at)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT DO NOTHING`,
				);
				for (const { alertNumber, routeId, directionId } of scopes) {
					dismiss.run(alertNumber, routeId, directionId, nowSeconds);
				}
			});
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
		 * Retire un arrêt provisoire de la base, et de toutes les modifications qui le désignent : le
		 * garder dans l'une d'elles laisserait dans le feed des `replacement_stops` pointant vers un
		 * arrêt que rien ne définit. Les temps de parcours des arrêts restants n'ont pas à être repris —
		 * une suite strictement croissante le reste une fois un terme ôté.
		 *
		 * Les modifications touchées sont réhorodatées : c'est leur `last_modified_time`, et elles
		 * viennent de changer. Renvoie leur nombre, ou `undefined` pour un arrêt inconnu.
		 */
		deleteProvisionalStop(stopId: string, nowSeconds: number): number | undefined {
			const uid = provisionalStopUid(stopId);
			if (uid === undefined || !provisional.has(stopId)) return undefined;

			const designating = [...modifications.values()].filter((modification) =>
				modification.segments.some((segment) => segment.stops.some((stop) => stop.stopId === stopId)),
			);

			return transaction(() => {
				const touch = db.prepare("UPDATE modifications SET updated_at = ? WHERE uid = ?");
				for (const modification of designating) touch.run(nowSeconds, modification.uid);

				// Les rangs des arrêts restants gardent un trou là où il était : ils ne servent qu'à ordonner,
				// et le prochain enregistrement de la modification les réécrit de toute façon.
				db.prepare("DELETE FROM segment_stops WHERE stop_id = ?").run(stopId);
				db.prepare("DELETE FROM provisional_stops WHERE stop_uid = ?").run(uid);
				return designating.length;
			});
		},
	};
}

/**
 * L'identifiant publié d'un arrêt provisoire. Sans réseau : un arrêt de report peut servir aux lignes
 * de plusieurs d'entre eux.
 */
export function provisionalStopId(stopUid: number): string {
	return `PROV:${stopUid}`;
}

/** Le numéro d'un arrêt provisoire d'après son identifiant publié, ou `undefined` si ce n'en est pas un. */
export function provisionalStopUid(stopId: string): number | undefined {
	const match = /^PROV:(\d+)$/.exec(stopId);
	return match === null ? undefined : Number(match[1]);
}

/** « 2026-09-24 » et « 08:30 » donnent « 2026-09-24T08:30 » ; sans heure, la date seule. */
function joinBound(date: string, time: string | null): string {
	return time === null ? date : `${date}T${time}`;
}

function splitBound(bound: string): [string, string | null] {
	const [date, time] = bound.split("T");
	return [date as string, time ?? null];
}

/** Les quatre colonnes d'une période saisie, dans l'ordre de la table ; toutes nulles sans période. */
function periodColumns(
	period: ModificationPeriod | null,
): [string | null, string | null, string | null, string | null] {
	if (period === null) return [null, null, null, null];
	const [startDate, startTime] = splitBound(period.start);
	const [endDate, endTime] = period.end === null ? [null, null] : splitBound(period.end);
	return [startDate, startTime, endDate, endTime];
}

// ---

type ModificationRow = {
	uid: number;
	origin: string;
	alert_number: string | null;
	route_id: string;
	direction_id: number;
	label: string | null;
	start_date: string | null;
	start_time: string | null;
	end_date: string | null;
	end_time: string | null;
	removed_overridden: number;
	disabled: number;
	priority: number;
	created_at: number;
	updated_at: number;
};

type PatternRow = { uid: number; pattern_id: string };

type RemovedRow = { uid: number; stop_id: string };

type DismissedRow = { alert_number: string; route_id: string; direction_id: number; dismissed_at: number };

type FirstSeenRow = { alert_number: string; first_seen_at: number; header_text: string | null };

type ProvisionalRow = { stop_uid: number; name: string; latitude: number; longitude: number; created_at: number };

type SegmentRow = {
	uid: number;
	segment: number;
	start_stop_id: string | null;
	end_stop_id: string | null;
	propagated_delay: number;
	terminus: string | null;
};

type StopRow = { uid: number; segment: number; position: number; stop_id: string; travel_time: number };

type PathRow = { uid: number; segment: number; position: number; latitude: number; longitude: number };

type WaypointRow = PathRow & { mode: string };

type CancelledRow = { uid: number; stop_id: string; departure: number };

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
