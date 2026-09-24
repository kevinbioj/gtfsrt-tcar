/**
 * L'interface de déclaration des déviations, d'un seul tenant.
 *
 * Elle est portée par une chaîne et non par un fichier `.html` : `tsc` ne copie que les `.ts` vers
 * `dist`, et le `Dockerfile` ne prend que `src/` puis `dist/`. Un fichier à part imposerait une étape
 * de copie au build, un chemin à résoudre au démarrage — différent entre `tsx src/` et `node dist/` —
 * et un lot d'occasions de livrer une image sans sa page. Ici il n'y a rien à copier ni à ouvrir.
 *
 * Aucun backtick ni `${` ne doit apparaître dans ce qui suit : la page est un littéral brut, et l'un
 * comme l'autre y mettraient fin. Le script s'en passe — concaténations plutôt que gabarits.
 */
export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Déviations — GTFS-RT TCAR</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
	:root {
		--bg: #f6f7f9; --panel: #fff; --ink: #14181f; --muted: #67707d; --line: #dfe3e9;
		--accent: #1f6feb; --danger: #d1242f; --warn: #9a6700; --ok: #1a7f37;
	}
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		background: var(--bg); color: var(--ink); }
	header { display: flex; align-items: center; gap: 12px; padding: 12px 20px;
		background: var(--panel); border-bottom: 1px solid var(--line); }
	header h1 { font-size: 16px; margin: 0; font-weight: 600; }
	header .spacer { flex: 1; }
	button, a.button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 6px;
		background: var(--panel); color: var(--ink); cursor: pointer; }
	button:hover, a.button:hover { border-color: var(--muted); }
	/*
	 * Ce qui mène ailleurs est un lien, même habillé en bouton : Ctrl+clic ou clic du milieu l'ouvrent
	 * dans un autre onglet, et l'adresse se copie. Un bouton, lui, ne fait qu'agir.
	 */
	a.button { display: inline-block; text-decoration: none; }
	a.button.hidden { display: none; }
	button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
	button.danger { color: var(--danger); }
	button.active { background: var(--accent); border-color: var(--accent); color: #fff; }
	button:disabled { opacity: .5; cursor: not-allowed; }
	input, select { font: inherit; padding: 5px 8px; border: 1px solid var(--line);
		border-radius: 6px; background: var(--panel); color: var(--ink); width: 100%; }
	.wrap { padding: 20px; }
	/*
	 * Une ligne par déviation, et qui tient sur une ligne : les colonnes sont fixes et ce qui déborde
	 * s'abrège. Le texte entier reste lisible en survol (title), et le détail est à un clic.
	 */
	table { width: 100%; border-collapse: collapse; background: var(--panel);
		border: 1px solid var(--line); border-radius: 8px; overflow: hidden; table-layout: fixed; }
	th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid var(--line);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	th { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted);
		font-weight: 600; background: #fbfcfd; }
	tbody tr { cursor: pointer; }
	tbody tr:hover { background: #eef2f7; }
	tbody tr:last-child td { border-bottom: none; }
	/*
	 * Chaque cellule est un lien vers la déviation, étendu à toute la cellule : la ligne entière se
	 * clique, et s'ouvre aussi bien dans un autre onglet. L'abréviation passe de la cellule au lien.
	 */
	td > a.cell { display: block; margin: -5px -10px; padding: 5px 10px; color: inherit;
		text-decoration: none; overflow: hidden; text-overflow: ellipsis; }
	td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
	/*
	 * Le cartouche de la ligne, tel que le réseau le dessine : c'est par lui qu'on cherche dans la
	 * liste, et il se reconnaît plus vite qu'un numéro. Toutes les lignes n'en ont pas — le numéro en
	 * clair prend alors le relais (cf. adoptPictos).
	 */
	.line { display: inline-flex; align-items: center; vertical-align: middle; }
	.line img { width: 22px; height: 22px; flex: none; }
	.line .code { display: none; min-width: 28px; padding: 0 6px; border-radius: 5px;
		background: var(--ink); color: #fff; font-weight: 600; font-size: 12px; text-align: center; }
	.line.plain .code { display: inline-block; }
	.toward { color: var(--muted); margin-left: 8px; }
	.ref { font-variant-numeric: tabular-nums; color: var(--muted); margin-right: 8px; }
	/* Les regroupements : un bandeau par ligne ou par info trafic, et ses déviations dessous. */
	tr.group { cursor: default; }
	tr.group td { background: #eef2f7; padding: 4px 10px; }
	tr.group:hover td { background: #eef2f7; }
	tr.group .bar { display: flex; align-items: center; gap: 8px; }
	tr.group .bar .grow { flex: 1; }
	tr.group .title { font-weight: 600; min-width: 0; overflow: hidden;
		text-overflow: ellipsis; white-space: nowrap; }
	.badge { display: inline-block; padding: 1px 7px; border-radius: 99px; font-size: 12px;
		border: 1px solid var(--line); color: var(--muted); }
	.badge.ok { color: var(--ok); border-color: #b4ddc0; background: #eaf7ee; }
	.badge.warn { color: var(--warn); border-color: #e6d39a; background: #fdf6e3; }
	.badge.off { color: var(--muted); }
	.detail { display: flex; height: calc(100vh - 53px); }
	#map { flex: 1; }
	.panel { width: 400px; overflow-y: auto; background: var(--panel);
		border-left: 1px solid var(--line); padding: 16px; }
	.panel h2 { font-size: 14px; margin: 20px 0 8px; text-transform: uppercase;
		letter-spacing: .04em; color: var(--muted); }
	.panel h2:first-child { margin-top: 0; }
	.note { color: var(--muted); font-size: 13px; }
	/*
	 * Le texte de l'info trafic, tel que l'exploitant l'a écrit : listes, mises en gras, tableaux et
	 * plans de déviation. Il arrive nettoyé du serveur (cf. sanitizeHtml) ; il reste à lui rendre des
	 * marges qui tiennent dans un panneau de quatre cents pixels, et à défaire ce que les règles du
	 * tableau de la liste imposent à toutes les cellules.
	 */
	.richtext { font-size: 13px; }
	.richtext p, .richtext ul, .richtext ol, .richtext table { margin: 0 0 6px; }
	.richtext ul, .richtext ol { padding-left: 18px; }
	.richtext li { margin: 1px 0; }
	.richtext strong { font-weight: 600; }
	.richtext img { display: block; max-width: 100%; height: auto; margin: 8px 0;
		border: 1px solid var(--line); border-radius: 6px; }
	.richtext table { table-layout: auto; font-size: 12px; }
	.richtext th, .richtext td { padding: 3px 6px; white-space: normal; overflow: visible; }
	.richtext > :last-child { margin-bottom: 0; }
	.alertbox { background: #fdf6e3; border: 1px solid #e6d39a; color: var(--warn);
		padding: 8px 10px; border-radius: 6px; font-size: 13px; margin-bottom: 10px; }
	.row { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
	button.grow { flex: 1; }
	/*
	 * Deux choix qui s'excluent, dessinés comme un seul objet plutôt que comme deux boutons côte à
	 * côte : on voit alors qu'on règle une chose, et non qu'on en déclenche deux. Les bordures se
	 * chevauchent d'un pixel pour n'en former qu'une entre les deux moitiés.
	 */
	.segmented { display: flex; flex: 1; }
	.segmented button { flex: 1; border-radius: 0; margin-left: -1px; }
	.segmented button:first-child { border-radius: 6px 0 0 6px; margin-left: 0; }
	.segmented button:last-child { border-radius: 0 6px 6px 0; }
	.segmented button.active { position: relative; z-index: 1; }
	/* Les gestes de la carte : une liste serrée, à lire une fois et à retrouver du coin de l'œil. */
	.hints { margin: 0 0 8px; padding-left: 16px; color: var(--muted); font-size: 13px; }
	.hints li { margin: 2px 0; }
	.stop { border: 1px solid var(--line); border-radius: 8px; padding: 8px; margin-bottom: 8px; }
	.stop .head { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
	.stop .num { width: 22px; height: 22px; flex: none; border-radius: 50%; background: var(--accent);
		color: #fff; font-size: 12px; display: grid; place-items: center; }
	.stop .coords { font-size: 12px; color: var(--muted); margin-top: 4px; }
	.field { display: flex; gap: 6px; align-items: center; }
	.field label { flex: none; font-size: 12px; color: var(--muted); width: 74px; }
	.actions { display: flex; gap: 8px; margin-top: 16px; }
	/*
	 * Un filet là où l'on passe des réglages — ce que le prochain clic fera — aux actions — ce qui se
	 * produit tout de suite. Les deux vivent dans la même section et se ressemblaient trop.
	 */
	.actions.divided { border-top: 1px solid var(--line); padding-top: 12px; }
	.status { margin-top: 10px; font-size: 13px; }
	.hidden { display: none; }
	.results { max-height: 220px; overflow-y: auto; border: 1px solid var(--line);
		border-radius: 6px; margin-top: 6px; }
	.results div { padding: 6px 9px; cursor: pointer; border-bottom: 1px solid var(--line); }
	.results div:last-child { border-bottom: none; }
	.results div:hover { background: #eef2f7; }
	/*
	 * Le périmètre d'un sens : tous les arrêts de la ligne, à cocher. C'est long — quarante arrêts —
	 * mais c'est la liste où se trouve la réponse, et la faire défiler dans son cadre évite de
	 * repousser le reste du panneau hors de l'écran.
	 */
	.picker { max-height: 260px; overflow-y: auto; border: 1px solid var(--line); border-radius: 6px; }
	.picker label { display: flex; gap: 8px; align-items: center; padding: 4px 9px;
		border-bottom: 1px solid var(--line); cursor: pointer; }
	.picker label:last-child { border-bottom: none; }
	.picker label:hover { background: #eef2f7; }
	.picker input { width: auto; flex: none; }
	/* Les lignes et sens d'une info trafic, à ouvrir ou à déclarer concernés. */
	.scopes { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
		padding: 12px 14px; margin-bottom: 12px; }
	.scopes .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
	.scopes .head .title { font-weight: 600; }
	.scopes .head .grow { flex: 1; }
	.scopes .dir { display: flex; align-items: center; gap: 8px; padding: 5px 0;
		border-top: 1px solid var(--line); }
	.scopes .dir .grow { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;
		white-space: nowrap; }
	/*
	 * Le bouton d'une ligne de sens tient dans la hauteur du cartouche : la liste se parcourt à
	 * l'œil, et un bouton pleine taille en ferait une suite de pavés.
	 */
	.scopes .dir button, .scopes .dir a.button { padding: 2px 9px; font-size: 12px; line-height: 18px; }
	/* Deux classes, parce que .hidden est déclarée plus haut et ne l'emporterait pas sur ce display. */
	.tools { display: flex; align-items: center; gap: 12px; }
	.tools.hidden { display: none; }
	.results .id { color: var(--muted); font-size: 12px; }
	.results .empty { color: var(--muted); cursor: default; }
	.gtfsname { font-weight: 600; flex: 1; }
	/* Les champs d'un formulaire s'empilent : une ligne chacun, un peu d'air entre eux. */
	.form .field { margin-bottom: 8px; }
	.form { max-width: 560px; }
</style>
</head>
<body>
<header>
	<h1 id="title">Déviations en vigueur</h1>
	<span class="spacer"></span>
	<span id="listTools" class="tools">
		<label class="note">grouper <select id="groupBy" style="width:auto">
			<option value="line">par ligne</option>
			<option value="alert">par info trafic</option>
		</select></label>
		<label class="note"><input type="checkbox" id="showUpcoming" style="width:auto"> afficher aussi les déviations à venir ou terminées</label>
		<a id="openScopes" class="button" href="#/scopes">Ajouter une ligne concernée</a>
		<a id="openNew" class="button" href="#/new">Nouvelle modification</a>
	</span>
	<a id="back" class="button hidden" href="#/">Retour à la liste</a>
</header>

<div id="listView" class="wrap">
	<table>
		<colgroup id="listCols"></colgroup>
		<thead id="listHead"></thead>
		<tbody id="listBody"></tbody>
	</table>
	<p id="listEmpty" class="note hidden">Aucune déviation à afficher.</p>
</div>

<div id="scopeView" class="wrap hidden">
	<p class="note">Une info trafic n'ouvre à la déclaration que les lignes et les sens où l'analyse a
		lu des arrêts supprimés. Déclarer un sens concerné le fait apparaître dans la liste, avec un
		périmètre vide : il accepte alors un tracé de déviation sans qu'aucun arrêt n'y soit supprimé.</p>
	<div id="scopeList"></div>
	<p id="scopeEmpty" class="note hidden">Aucune info trafic au flux courant.</p>
</div>

<div id="newView" class="wrap hidden">
	<div class="scopes form">
		<p class="note">Une modification sans info trafic : on choisit la ligne, le sens et la période
			d'application, puis on la saisit comme les autres — arrêts supprimés, tronçons, tracé.</p>
		<div class="field"><label>Ligne</label><select id="newRoute"></select></div>
		<div class="field"><label>Sens</label><select id="newDirection"></select></div>
		<div id="newPeriod"></div>
		<div class="actions"><button id="create" class="primary">Créer</button></div>
		<p class="status" id="newStatus"></p>
	</div>
</div>

<div id="detailView" class="detail hidden">
	<div id="map"></div>
	<aside class="panel">
		<div id="summary"></div>

		<h2>Périmètre du sens</h2>
		<p class="note" id="scopeSummary"></p>
		<div id="scopePicker"></div>
		<div class="row" id="scopeActions" style="margin:8px 0 0"></div>

		<h2>Tronçons déviés</h2>
		<div class="row" id="segmentBar"></div>
		<p class="note" id="segmentNote"></p>

		<h2>Bornes du tronçon</h2>
		<p class="note" id="boundsNote"></p>
		<div id="boundsWarnings"></div>
		<div class="field" style="margin-bottom:8px"><label>Premier</label><select id="startStop"></select></div>
		<div class="field"><label>Dernier</label><select id="endStop"></select></div>
		<p class="note" id="referenceNote"></p>
		<div class="field" style="margin-top:8px"><label>Délai propagé</label><input id="propagatedDelay" type="number" step="1" value="0"></div>
		<p class="note">Secondes ajoutées aux horaires qui suivent le tronçon. 0 si le détour ne rallonge rien.</p>
		<p class="note" id="tripCount"></p>

		<div id="stopSection">
			<h2>Arrêts de substitution</h2>
			<p class="note" id="travelTimeNote"></p>
			<div id="stopList"></div>
			<p class="note" id="stopNote"></p>
			<button id="addStop">Ajouter un arrêt</button>
			<div id="stopSearch" class="hidden">
				<input id="stopQuery" placeholder="Nom de l'arrêt…" autocomplete="off">
				<div class="results" id="stopResults"></div>
				<p class="note" id="searchHint"></p>
			</div>
		</div>

		<h2>Tracé du tronçon</h2>
		<p class="note">Partir d'où la course quitte son itinéraire, et y revenir plus loin — ou
			s'arrêter à l'écart si la ligne est coupée.</p>

		<ul class="hints">
			<li>Clic : poser un point de passage. Glisser : le déplacer. Alt+clic : le retirer.</li>
			<li>Clic sur une jambe : y insérer un point. Sa pastille centrale la bascule entre rue et
				ligne droite.</li>
			<li>En « suivre les rues », le point posé se recale sur la chaussée : c'est lui qui sera
				publié, pas le clic.</li>
			<li>Sens interdits et accès réservés ne sont pas opposés au tracé : l'itinéraire remonte une
				rue à sens unique si c'est le plus court.</li>
			<li>La course ne reprend sa ligne que si le tracé l'y ramène. Le finir à l'écart, c'est
				l'arrêter là : terminus provisoire, ligne coupée.</li>
		</ul>

		<div class="row"><button id="draw" class="grow">Dessiner</button></div>
		<div class="field"><label>Trait</label>
			<div class="segmented">
				<button id="penRoute">Suivre les rues</button>
				<button id="penFree">Ligne droite</button>
			</div>
		</div>
		<p class="note" id="penNote"></p>

		<div class="actions divided">
			<button id="undo">Annuler le dernier point</button>
			<button id="clearPath" class="danger">Effacer</button>
		</div>
		<p class="note" id="pathNote"></p>

		<h2>Publication</h2>
		<p class="note" id="disabledNote"></p>
		<div class="actions">
			<button id="save" class="primary">Enregistrer</button>
			<button id="toggleDisabled"></button>
			<button id="remove" class="danger">Supprimer la déclaration</button>
		</div>
		<p class="status" id="status"></p>
	</aside>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
	"use strict";

	var state = {
		detail: null, rows: [], alerts: [], routes: [], segments: [], active: 0, mode: "idle",
		// Le périmètre en cours de saisie : la liste des arrêts cochés, ou null tant qu'on le lit.
		scopeSelection: null,
		map: null, base: null, routeLayer: null, otherLayer: null, drawLayer: null, previewLine: null,
		stopMarkers: [], waypointMarkers: [], legLines: [], legToggles: [], pen: "free",
		shapes: [], searchTimer: null, countTimer: null,
		// Les lecteurs des champs de période : celui de la création, et celui du détail.
		readNewPeriod: null, readPeriod: null
	};

	/** Le tronçon en cours d'édition. Il y en a toujours au moins un dès qu'un détail est ouvert. */
	function seg() { return state.segments[state.active]; }

	// --- utilitaires ---

	/**
	 * La racine de l'API, déduite de l'adresse de la page plutôt qu'écrite en dur.
	 *
	 * Le service tourne derrière un proxy qui le publie sous un préfixe — « /gtfs-rt/tcar » — et le lui
	 * retire avant de le lui passer. La page arrive donc à « /gtfs-rt/tcar/admin » quand le serveur, lui,
	 * ne connaît que « /admin » : un chemin absolu « /admin/api/… » sortirait du préfixe et retomberait à
	 * la racine du domaine, qui répond du HTML. C'est l'adresse de la page qui porte le bon préfixe, et
	 * elle seule.
	 *
	 * La barre finale est ôtée pour que « /admin » et « /admin/ » donnent la même racine.
	 */
	var API = window.location.pathname.replace(/\/+$/, "");

	/** Écart au-delà duquel le point de divergence est signalé — cf. MAX_DETOUR_JUNCTION_OFFSET. */
	var MAX_JUNCTION_METRES = 200;

	/** En deçà, le tracé a ramené la course sur l'itinéraire — cf. DETOUR_REJOIN_OFFSET. */
	var REJOIN_METRES = 50;

	function el(id) { return document.getElementById(id); }

	function decodePolyline(str) {
		var points = [], index = 0, lat = 0, lng = 0, b, result, shift;
		while (index < str.length) {
			result = 0; shift = 0;
			do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
			lat += (result & 1) ? ~(result >> 1) : (result >> 1);
			result = 0; shift = 0;
			do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
			lng += (result & 1) ? ~(result >> 1) : (result >> 1);
			points.push([lat / 1e5, lng / 1e5]);
		}
		return points;
	}

	/**
	 * Une durée saisie, en secondes. Deux formes : un nombre de secondes, ou « mm:ss ». Le signe porte
	 * sur la durée entière — « -1:30 » vaut -90 s, et non -1 min +30 s : un arrêt peut être atteint
	 * AVANT l'arrêt de référence, et c'est alors tout l'écart qui est négatif.
	 */
	function parseDuration(text) {
		var value = String(text).trim();
		if (/^-?\d+$/.test(value)) return parseInt(value, 10);

		var match = /^(-?)(\d+):([0-5]\d)$/.exec(value);
		if (match === null) return null;

		var seconds = parseInt(match[2], 10) * 60 + parseInt(match[3], 10);
		return match[1] === "-" ? -seconds : seconds;
	}

	function formatDuration(seconds) {
		var sign = seconds < 0 ? "-" : "", total = Math.abs(seconds);
		var rest = total % 60;
		return sign + Math.floor(total / 60) + ":" + (rest < 10 ? "0" : "") + rest;
	}

	function describePeriods(periods) {
		if (!periods || periods.length === 0) return "sans borne";
		return periods.map(function (period) {
			var text = (period.start || "?") + " → " + (period.end || "?");
			if (period.dailyWindow) text += " (" + period.dailyWindow.from + "–" + period.dailyWindow.to + ")";
			return text;
		}).join(" ; ");
	}

	/** La période en compact, pour la liste : « 01/09 → 30/09 · 8h–17h ». Le détail la donne en entier. */
	function describePeriodsShort(periods) {
		if (!periods || periods.length === 0) return "sans borne";

		var first = periods[0];
		var sameDay = first.start && first.end && first.start.slice(0, 10) === first.end.slice(0, 10);
		var text = sameDay ? shortDate(first.start) : shortDate(first.start) + " → " + shortDate(first.end);

		// Les heures que portent les bornes valent tranche horaire : une perturbation d'un après-midi se
		// lit « 19/09 · 14h–20h », et non « 19/09 → 19/09 », qui ne dit rien de plus que la date.
		var slot = first.dailyWindow
			? shortTime(first.dailyWindow.from) + "–" + shortTime(first.dailyWindow.to)
			: sameDay && timeOf(first.start) && timeOf(first.end)
				? timeOf(first.start) + "–" + timeOf(first.end)
				: null;
		if (slot) text += " · " + slot;

		// Les plages disjointes ne tiennent pas dans une colonne : on dit combien il en reste.
		if (periods.length > 1) text += " +" + (periods.length - 1);
		return text;
	}

	/** L'heure qu'une borne « AAAA-MM-JJTHH:MM » porte, ou rien si elle désigne la journée entière. */
	function timeOf(value) {
		var match = /T(\d{2}:\d{2})$/.exec(String(value));
		return match === null ? null : shortTime(match[1]);
	}

	/** « 2026-09-01 » ou « 2026-09-01T08:30 » donnent « 01/09 ». L'année ne distingue rien ici. */
	function shortDate(value) {
		if (!value) return "?";
		var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
		return match === null ? value : match[3] + "/" + match[2];
	}

	/** « 08:30 » donne « 8h30 », « 17:00 » donne « 17h ». */
	function shortTime(value) {
		var parts = String(value).split(":");
		return parts[1] === "00" ? parseInt(parts[0], 10) + "h" : parseInt(parts[0], 10) + "h" + parts[1];
	}

	function request(url, options) {
		return fetch(url, options).then(function (response) {
			return response.text().then(function (text) {
				var body = null;
				try { body = JSON.parse(text); } catch (error) { body = null; }

				// Du HTML là où l'on attend du JSON : la requête n'a pas atteint l'API mais autre chose —
				// une page d'erreur du proxy, ou la racine du domaine si le préfixe s'est perdu. Le dire
				// vaut mieux que de laisser remonter l'erreur d'analyse, qui ne nomme pas le problème.
				if (body === null) {
					throw new Error("Réponse inattendue de " + url + " (HTTP " + response.status
						+ ") : du contenu non-JSON. L'API n'est pas joignable à cette adresse.");
				}

				if (!response.ok) throw new Error(body.message ? body.message : "Erreur " + response.status);
				return body;
			});
		});
	}

	// --- vues et adresses ---

	/**
	 * Une vue à la fois, et le bandeau qui va avec : chaque vue n'offre que ce qu'elle permet — on ne
	 * groupe pas une liste qu'on ne regarde pas, et on n'ajoute pas une ligne concernée depuis l'écran
	 * qui sert à ça.
	 */
	function showView(name) {
		el("listView").className = name === "list" ? "wrap" : "wrap hidden";
		el("scopeView").className = name === "scopes" ? "wrap" : "wrap hidden";
		el("newView").className = name === "new" ? "wrap" : "wrap hidden";
		el("detailView").className = name === "detail" ? "detail" : "detail hidden";
		el("listTools").className = name === "list" ? "tools" : "tools hidden";
		el("back").className = name === "list" ? "button hidden" : "button";
		el("title").textContent = name === "scopes" ? "Ajouter une ligne concernée"
			: name === "new" ? "Nouvelle modification"
			: name === "detail" ? "Déviation" : "Déviations en vigueur";
	}

	/**
	 * La vue courante vit dans l'adresse : « #/ », « #/scopes », « #/new », « #/detour/<clé> », et
	 * « #/declare/<clé> », qui déclare le sens concerné avant d'ouvrir sa déviation. Le retour du
	 * navigateur revient alors à l'écran précédent, et non au site d'où l'on venait — c'est le geste
	 * qu'on fait sans y penser, et il ne doit pas faire perdre la page.
	 */
	function go(route) {
		var next = "#/" + route;
		if (window.location.hash === next) applyRoute();
		else window.location.hash = next;
	}

	function applyRoute() {
		var route = window.location.hash.replace(/^#\/?/, "");

		if (route.indexOf("detour/") === 0) {
			openDetail(decodeURIComponent(route.slice("detour/".length)));
			return;
		}
		if (route.indexOf("declare/") === 0) {
			declareDirection(decodeURIComponent(route.slice("declare/".length)));
			return;
		}
		if (route === "scopes") {
			openScopes();
			return;
		}
		if (route === "new") {
			openNew();
			return;
		}

		state.detail = null;
		showView("list");
		loadList();
	}

	// --- liste ---

	/** L'adresse des cartouches de ligne du réseau. */
	var LINE_CARTRIDGE = "https://storage.googleapis.com/bus-tracker-assets/line-cartridges/astuce/";

	/**
	 * Les colonnes que la liste sait rendre. Chaque groupement choisit les siennes : ce qui est commun
	 * à tout un groupe se dit une fois dans son bandeau, et n'a plus à se répéter à chaque ligne.
	 */
	var COLUMNS = {
		lineAndSens: { label: "Ligne et sens", cell: function (row) {
			return lineChip(row.line) + "<span class='toward'>" + escapeHtml(towardOf(row)) + "</span>";
		} },
		sens: { label: "Sens", cell: function (row) {
			return "<span class='toward' style='margin-left:0'>" + escapeHtml(towardOf(row)) + "</span>";
		} },
		alert: { label: "Info trafic", cell: function (row) {
			return perturbationRef(row) + escapeHtml(row.headerText);
		} },
		stops: { label: "Arrêts", className: "num", cell: function (row) { return String(row.removedStopCount); } },
		period: { label: "Période", className: "note", cell: function (row) {
			return escapeHtml(describePeriodsShort(row.periods));
		} },
		state: { label: "État", cell: stateBadge },
		declaration: { label: "Déclaration", cell: declarationBadge }
	};

	/**
	 * Les deux façons de lire la liste. Par ligne, pour préparer une ligne entière — c'est la question
	 * de l'exploitant. Par info trafic, pour traiter une perturbation de bout en bout — c'est celle de
	 * l'agent qui saisit. Le choix se retient d'une visite à l'autre.
	 */
	var GROUPINGS = {
		line: {
			columns: [["sens", "24%"], ["alert", "32%"], ["stops", "7%"], ["period", "16%"], ["state", "9%"], ["declaration", "12%"]],
			keyOf: function (row) { return row.routeId; },
			heading: function (rows) {
				return lineChip(rows[0].line) + "<span class='title' style='margin-left:8px'>Ligne "
					+ escapeHtml(rows[0].line) + "</span><span class='grow'></span>"
					+ "<span class='note'>" + countLabel(rows) + "</span>";
			}
		},
		alert: {
			// La période et l'état appartiennent à l'info trafic, pas au sens : ils montent dans le
			// bandeau, et les lignes n'ont plus à porter six fois la même date.
			columns: [["lineAndSens", "52%"], ["stops", "16%"], ["declaration", "32%"]],
			keyOf: function (row) { return row.alertNumber; },
			heading: function (rows) {
				var row = rows[0];
				return perturbationRef(row)
					+ "<span class='title'>" + escapeHtml(row.headerText) + "</span><span class='grow'></span>"
					+ "<span class='note'>" + countLabel(rows) + "</span>"
					+ "<span class='note'>" + escapeHtml(describePeriodsShort(row.periods)) + "</span>"
					+ stateBadge(row);
			}
		}
	};

	/**
	 * Ce que fait une image de cartouche absente : laisser le numéro en clair. Le réseau n'en publie pas
	 * pour toutes ses lignes, et un cadre vide se verrait autant qu'une image manquante.
	 *
	 * Posé en attribut plutôt que branché après coup : l'image commence à charger dès que le navigateur
	 * la rencontre, et un 404 déjà en cache signalerait son échec avant qu'on ait eu le temps d'écouter.
	 * Les apostrophes sont écrites en entités pour ne pas fermer l'attribut.
	 */
	var PICTO_FALLBACK = "this.parentNode.className=&#39;line plain&#39;;this.parentNode.removeChild(this)";

	/** Le cartouche de la ligne, le numéro en clair derrière lui si l'image ne vient pas. */
	function lineChip(line) {
		return "<span class='line'><img alt='' onerror='" + PICTO_FALLBACK + "' src='"
			+ LINE_CARTRIDGE + encodeURIComponent(line) + ".svg'>"
			+ "<span class='code'>" + escapeHtml(line) + "</span></span>";
	}

	function towardOf(row) {
		return row.headsigns.length ? "→ " + row.headsigns.join(" / ") : "sens " + row.directionId;
	}

	/**
	 * Ce qui rattache la déviation à sa perturbation : le numéro de l'info trafic, ou le constat qu'il
	 * n'y en a pas. Une modification sans info trafic a bien un numéro, mais il ne dit rien à personne.
	 */
	function perturbationRef(row) {
		return row.standalone
			? '<span class="badge warn" style="margin-right:8px">sans info trafic</span>'
			: "<span class='ref'>" + escapeHtml(row.alertNumber) + "</span>";
	}

	/**
	 * La désactivation passe avant tout : elle dit qu'on a choisi de ne rien publier, quelle que soit la
	 * période. Ensuite seulement vient ce que la période en dit.
	 */
	function stateBadge(row) {
		if (row.disabled) return '<span class="badge warn">désactivée</span>';
		if (row.active) return '<span class="badge ok">en vigueur</span>';
		if (row.ended) return '<span class="badge off">terminée</span>';
		return '<span class="badge off">à venir</span>';
	}

	function declarationBadge(row) {
		if (!row.declared) return '<span class="badge off">non déclarée</span>';
		if (!row.publishable) return '<span class="badge warn">incomplète</span>';

		// Ce qu'il y a de plus parlant, et rien de plus : le nombre de tronçons quand il y en a
		// plusieurs, sinon ce que le tronçon annonce. Un tracé sans arrêt de substitution est une
		// déclaration complète — le segment est supprimé, et l'itinéraire dit par où l'on passe.
		var what = row.segmentCount > 1
			? row.segmentCount + " tronçons"
			: row.stopCount === 0 ? "tracé seul" : row.stopCount + " arrêts";
		return '<span class="badge ok">' + what + "</span>";
	}

	function countLabel(rows) {
		var declared = rows.filter(function (row) { return row.declared; }).length;
		return rows.length + (rows.length > 1 ? " déviations" : " déviation")
			+ " · " + declared + " déclarée" + (declared > 1 ? "s" : "");
	}

	function loadList() {
		request(API + "/api/detours").then(function (rows) {
			state.rows = rows;
			renderList();
		}).catch(function (error) { alert(error.message); });
	}

	/**
	 * La liste, groupée. L'ordre des groupes est celui de leur première déviation, que le serveur rend
	 * déjà classée — les perturbations en vigueur d'abord : une Map retient l'ordre d'insertion, il
	 * n'y a rien à trier de plus.
	 */
	function renderList() {
		var grouping = GROUPINGS[el("groupBy").value] || GROUPINGS.line;
		var showUpcoming = el("showUpcoming").checked;
		var visible = state.rows.filter(function (row) { return showUpcoming || row.active; });

		var cols = el("listCols");
		cols.innerHTML = grouping.columns.map(function (column) {
			return "<col style='width:" + column[1] + "'>";
		}).join("");

		el("listHead").innerHTML = "<tr>" + grouping.columns.map(function (column) {
			var definition = COLUMNS[column[0]];
			return "<th" + (definition.className === "num" ? " class='num'" : "") + ">" + definition.label + "</th>";
		}).join("") + "</tr>";

		var groups = new Map();
		visible.forEach(function (row) {
			var key = grouping.keyOf(row);
			var group = groups.get(key);
			if (group === undefined) groups.set(key, [row]);
			else group.push(row);
		});

		var body = el("listBody");
		body.innerHTML = "";

		groups.forEach(function (rows) {
			var head = document.createElement("tr");
			head.className = "group";
			head.innerHTML = "<td colspan='" + grouping.columns.length + "'><div class='bar'>"
				+ grouping.heading(rows) + "</div></td>";
			body.appendChild(head);

			rows.forEach(function (row) {
				var tr = document.createElement("tr");
				var href = "#/detour/" + encodeURIComponent(row.key);

				// Ce que la ligne abrège se relit en entier au survol : la destination comme le texte de
				// l'info trafic dépassent volontiers la largeur d'une colonne.
				tr.title = row.line + " " + towardOf(row) + "\n"
					+ (row.standalone ? "Sans info trafic" : row.alertNumber) + " — " + row.headerText + "\n"
					+ describePeriods(row.periods);

				tr.innerHTML = grouping.columns.map(function (column) {
					var definition = COLUMNS[column[0]];
					return "<td" + (definition.className ? " class='" + definition.className + "'" : "") + ">"
						+ "<a class='cell' href='" + href + "'>" + definition.cell(row) + "</a></td>";
				}).join("");
				body.appendChild(tr);
			});
		});

		el("listEmpty").className = visible.length === 0 ? "note" : "note hidden";
	}

	function escapeHtml(text) {
		return String(text == null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	// --- périmètre : déclarer une ligne et un sens concernés ---

	/**
	 * Les infos trafic du flux, avec les lignes qu'elles citent et l'état de chaque sens. C'est la
	 * seule vue qui montre un sens dont l'analyse n'a rien tiré — et c'est précisément celui qu'on
	 * vient y déclarer concerné.
	 */
	function openScopes() {
		request(API + "/api/alerts").then(function (alerts) {
			state.alerts = alerts;
			state.detail = null;
			showView("scopes");
			renderScopes();
		}).catch(function (error) { alert(error.message); go(""); });
	}

	function renderScopes() {
		var list = el("scopeList");
		list.innerHTML = "";

		state.alerts.forEach(function (alert) {
			var block = document.createElement("div");
			block.className = "scopes";

			var head = document.createElement("div");
			head.className = "head";
			head.innerHTML = "<span class='ref'>" + escapeHtml(alert.alertNumber) + "</span>"
				+ "<span class='title'>" + escapeHtml(alert.headerText) + "</span><span class='grow'></span>"
				+ "<span class='note'>" + escapeHtml(describePeriodsShort(alert.periods)) + "</span>"
				+ stateBadge(alert);
			block.appendChild(head);

			alert.routes.forEach(function (route) {
				route.directions.forEach(function (direction) {
					block.appendChild(directionRow(route, direction));
				});
			});

			list.appendChild(block);
		});

		el("scopeEmpty").className = state.alerts.length === 0 ? "note" : "note hidden";
	}

	/** Un sens d'une ligne citée par l'info trafic : ce qu'on en sait, et ce qu'on peut en faire. */
	function directionRow(route, direction) {
		var row = document.createElement("div");
		row.className = "dir";

		var what = direction.manual
			? '<span class="badge warn">périmètre saisi</span>'
			: direction.scoped
				? '<span class="badge ok">' + direction.removedStopCount + " supprimés</span>"
				: '<span class="badge off">hors périmètre</span>';

		row.innerHTML = lineChip(route.line) + "<span class='grow'><span class='toward'>"
			+ escapeHtml(direction.headsigns.length ? "→ " + direction.headsigns.join(" / ") : "sens " + direction.directionId)
			+ "</span></span>" + what
			+ (direction.declared ? ' <span class="badge ok">déclarée</span>' : "");

		var action = document.createElement("a");
		action.className = "button";
		action.href = "#/" + (direction.scoped ? "detour/" : "declare/") + encodeURIComponent(direction.key);
		action.textContent = direction.scoped ? "Ouvrir" : "Déclarer concernée";
		row.appendChild(action);

		return row;
	}

	/**
	 * Déclare un sens concerné : un périmètre saisi, sans aucun arrêt supprimé. La déviation devient
	 * déclarable sur-le-champ — c'est là qu'on lui donne son tracé.
	 *
	 * C'est une adresse, pour s'ouvrir dans un autre onglet comme n'importe quel lien — et une adresse
	 * se rouvre : onglet rechargé, lien recopié. Un sens déjà concerné n'est donc pas redéclaré, ce qui
	 * viderait le périmètre qu'on lui a saisi depuis ; on ouvre simplement sa déviation.
	 *
	 * L'adresse de la déclaration est REMPLACÉE par celle de la déviation : le retour du navigateur
	 * ramène à la liste des infos trafic, et non à une déclaration qu'il rejouerait.
	 */
	function declareDirection(key) {
		var detour = "#/detour/" + encodeURIComponent(key);

		request(API + "/api/detours/" + encodeURIComponent(key)).then(function () {
			window.location.replace(detour);
		}, function () {
			return request(API + "/api/scopes/" + encodeURIComponent(key), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ removedStopIds: [] })
			}).then(function () { window.location.replace(detour); });
		}).catch(function (error) {
			alert(error.message);
			window.location.replace("#/scopes");
		});
	}

	// --- modification sans info trafic ---

	/**
	 * Les champs d'une période d'application, et l'intitulé qui l'accompagne : la création et le détail
	 * les partagent. Renvoie de quoi les relire, dans la forme que le serveur attend.
	 *
	 * Le début a sa date obligatoire, la fin non — sans elle, la période reste ouverte. L'heure est
	 * toujours facultative : sans elle, le début vaut minuit et la fin couvre la journée entière. Une
	 * heure de fin sans date de fin ne voudrait rien dire, et son champ reste grisé tant qu'il en manque.
	 */
	function periodFields(container, period) {
		container.innerHTML =
			'<div class="field"><label>Intitulé</label><input class="label" placeholder="facultatif"></div>' +
			'<div class="field"><label>Début</label><input type="date" class="startDate" required>' +
				'<input type="time" class="startTime"></div>' +
			'<div class="field"><label>Fin</label><input type="date" class="endDate">' +
				'<input type="time" class="endTime"></div>' +
			'<p class="note">Heures facultatives. Sans fin, la modification reste en vigueur jusqu\'à ce ' +
				"qu'on la désactive ou la supprime.</p>";

		function field(name) { return container.querySelector("." + name); }

		field("label").value = period && period.label ? period.label : "";
		field("startDate").value = period ? period.start.date : "";
		field("startTime").value = period && period.start.time ? period.start.time : "";
		field("endDate").value = period && period.end ? period.end.date : "";
		field("endTime").value = period && period.end && period.end.time ? period.end.time : "";

		function syncEnd() {
			field("endTime").disabled = field("endDate").value === "";
			if (field("endTime").disabled) field("endTime").value = "";
		}
		field("endDate").oninput = syncEnd;
		syncEnd();

		return function () {
			return {
				label: field("label").value,
				start: { date: field("startDate").value, time: field("startTime").value },
				end: field("endDate").value === "" ? null : { date: field("endDate").value, time: field("endTime").value }
			};
		};
	}

	/** Le formulaire de création : la ligne, le sens, la période. Le reste se saisit dans le détail. */
	function openNew() {
		request(API + "/api/routes").then(function (routes) {
			state.routes = routes;
			state.detail = null;
			showView("new");

			var select = el("newRoute");
			select.innerHTML = "";
			routes.forEach(function (route, index) {
				var option = document.createElement("option");
				option.value = String(index);
				option.textContent = "Ligne " + route.line;
				select.appendChild(option);
			});
			select.onchange = renderNewDirections;
			renderNewDirections();

			state.readNewPeriod = periodFields(el("newPeriod"), null);
			el("newStatus").textContent = "";
		}).catch(function (error) { alert(error.message); go(""); });
	}

	function renderNewDirections() {
		var route = state.routes[parseInt(el("newRoute").value, 10)];
		var select = el("newDirection");
		select.innerHTML = "";
		(route ? route.directions : []).forEach(function (direction) {
			var option = document.createElement("option");
			option.value = String(direction.directionId);
			option.textContent = towardOf(direction);
			select.appendChild(option);
		});
	}

	/**
	 * Crée la modification, puis ouvre sa déviation. L'adresse de création est REMPLACÉE : le retour du
	 * navigateur ramène à la liste, et non à un formulaire qui en créerait une seconde.
	 */
	function createModification() {
		var route = state.routes[parseInt(el("newRoute").value, 10)];
		if (!route) return;

		var status = el("newStatus");
		status.textContent = "Création…";
		status.style.color = "var(--muted)";

		var body = state.readNewPeriod();
		body.routeId = route.routeId;
		body.directionId = parseInt(el("newDirection").value, 10);

		request(API + "/api/modifications", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body)
		}).then(function (created) {
			window.location.replace("#/detour/" + encodeURIComponent(created.key));
		}).catch(function (error) {
			status.textContent = error.message;
			status.style.color = "var(--danger)";
		});
	}

	// --- détail ---

	/** Un arrêt tel que le serveur le rend, ramené à ce que l'éditeur manipule. */
	function adoptStop(stop) {
		return {
			stopId: stop.stopId, provisional: stop.provisional, name: stop.name,
			latitude: stop.latitude, longitude: stop.longitude, travelTime: stop.travelTime
		};
	}

	/**
	 * Un tronçon tel que le serveur le rend, ramené à ce que l'éditeur manipule. Le serveur en propose
	 * toujours au moins un : à défaut de déclaration, les suites d'arrêts supprimés en dessinent autant
	 * qu'il y a d'interruptions sur l'itinéraire.
	 */
	function adoptSegment(segment) {
		var adopted = {
			startStopId: segment.startStopId, endStopId: segment.endStopId,
			propagatedDelay: segment.propagatedDelay,
			stops: segment.stops.map(adoptStop),
			path: segment.path.map(asPair),
			waypoints: [], legs: [],
			publishable: segment.publishable,
			matchingTrips: segment.matchingTrips
		};

		adoptDrawing(adopted, (segment.waypoints || []).map(function (waypoint) {
			return { point: asPair(waypoint), mode: waypoint.mode === "route" ? "route" : "free" };
		}));

		return adopted;
	}

	function asPair(point) { return [point.latitude, point.longitude]; }

	function samePoint(a, b) { return a[0] === b[0] && a[1] === b[1]; }

	function newLeg(points) { return { points: points || [], status: "ok", token: 0, message: "" }; }

	/**
	 * Redécoupe en jambes le tracé enregistré.
	 *
	 * Seuls les points de passage et le tracé aplati traversent l'enregistrement : les frontières des
	 * jambes se retrouvent en suivant le tracé et en y reconnaissant, dans l'ordre, chaque point de
	 * passage — ce sont très exactement les endroits où les jambes ont été recousues.
	 *
	 * Si la lecture ne retombe pas sur ses pieds — tracé repris à la main, enregistrement d'une autre
	 * version — on garde le tracé TEL QUEL et l'on revient au dessin libre : chaque point devient un
	 * point de passage, et le trajet publié n'est pas touché d'un pouce. C'est ce qui compte : le
	 * découpage en jambes n'est qu'un plan de montage.
	 */
	function adoptDrawing(segment, waypoints) {
		var path = segment.path;

		if (path.length >= 2 && waypoints.length >= 2 && samePoint(path[0], waypoints[0].point)) {
			var legs = [];
			var points = [path[0]];
			var next = 1;

			for (var index = 1; index < path.length; index += 1) {
				points.push(path[index]);
				if (next < waypoints.length && samePoint(path[index], waypoints[next].point)) {
					legs.push(newLeg(points));
					points = [path[index]];
					next += 1;
				}
			}

			if (next === waypoints.length && legs.length === waypoints.length - 1) {
				segment.waypoints = waypoints;
				segment.legs = legs;
				return;
			}
		}

		segment.waypoints = path.length >= 2
			? path.map(function (point) { return { point: point, mode: "free" }; })
			: [];
		straightenLegs(segment);
	}

	/** Une jambe droite entre chaque point de passage : le dessin libre, tel qu'il a toujours été. */
	function straightenLegs(segment) {
		segment.legs = [];
		for (var index = 0; index + 1 < segment.waypoints.length; index += 1) {
			segment.legs.push(newLeg([segment.waypoints[index].point, segment.waypoints[index + 1].point]));
		}
	}

	function openDetail(key) {
		request(API + "/api/detours/" + encodeURIComponent(key)).then(function (detail) {
			state.active = 0;
			// L'accrochage aux rues est ce qu'on veut presque toujours ; le dessin libre reste à un clic.
			state.pen = detail.roadRouting ? "route" : "free";

			showView("detail");
			adoptDetail(detail);
			setStatus("");
		}).catch(function (error) {
			// Une adresse qui ne désigne plus rien — déviation effacée, périmètre rendu à l'analyse,
			// lien d'hier : on le dit, et on repart de la liste plutôt que de laisser un écran vide.
			// L'adresse fautive est REMPLACÉE, sans quoi le retour du navigateur y ramènerait aussitôt.
			alert(error.message);
			window.location.replace("#/");
		});
	}

	/**
	 * Prend pour état courant le détail que le serveur rend. Tout ce qui s'affiche en dépend — le
	 * périmètre comme les tronçons —, et un périmètre ressaisi change les deux : les arrêts marqués
	 * supprimés sur l'itinéraire, et les bornes que l'on propose.
	 */
	function adoptDetail(detail) {
		state.detail = detail;
		state.segments = detail.segments.map(adoptSegment);
		if (state.segments.length === 0) state.segments = [emptySegment()];
		state.active = Math.max(0, Math.min(state.active, state.segments.length - 1));
		state.scopeSelection = null;

		renderSummary();
		renderScope();
		renderPublication();
		// La carte est refaite à chaque adoption, et pas seulement à l'ouverture : un périmètre
		// ressaisi change les arrêts marqués supprimés, qu'elle dessine en rouge.
		setupMap();
		renderSegment();
	}

	function emptySegment() {
		return {
			startStopId: null, endStopId: null, propagatedDelay: 0, stops: [],
			waypoints: [], legs: [], path: [], matchingTrips: 0
		};
	}

	// --- tronçons ---

	/** Tout ce qui dépend du tronçon actif, d'un bloc : on ne repeint jamais l'un sans les autres. */
	function renderSegment() {
		renderPen();
		renderSegments();
		renderBounds();
		renderStops();
		renderPath();
		renderTripCount();
	}

	/**
	 * Ce tronçon supprime-t-il des arrêts ? La question ne se règle pas, elle se lit : sa plage —
	 * bornes comprises — porte-t-elle un arrêt que le périmètre déclare supprimé ? Sinon le véhicule
	 * passe ailleurs entre deux arrêts qu'il dessert toujours, et seul le tracé sera publié.
	 *
	 * Même règle que le serveur (cf. removesStops), sur les itinéraires que le détail porte.
	 */
	function removesStops(segment) {
		if (segment.startStopId === null || segment.endStopId === null) return false;
		if (state.detail.removedStopIds.length === 0) return false;

		var removed = false;
		state.detail.sequences.forEach(function (sequence) {
			var start = -1, end = -1;
			sequence.forEach(function (stop, index) {
				if (stop.stopId === segment.startStopId && start === -1) start = index;
				if (stop.stopId === segment.endStopId && end === -1) end = index;
			});
			if (start === -1 || end === -1 || start > end) return;
			for (var index = start; index <= end; index += 1) {
				if (sequence[index].removed) removed = true;
			}
		});
		return removed;
	}

	function renderSegments() {
		var bar = el("segmentBar");
		bar.innerHTML = "";

		state.segments.forEach(function (segment, index) {
			var button = document.createElement("button");
			var what = segment.stops.length > 0 ? segment.stops.length + " arrêts"
				: segment.path.length >= 2 ? (removesStops(segment) ? "tracé seul" : "chemin")
				: "vide";
			button.textContent = "Tronçon " + (index + 1) + " · " + what;
			button.className = index === state.active ? "active" : "";
			button.onclick = function () { selectSegment(index); };
			bar.appendChild(button);
		});

		var add = document.createElement("button");
		add.textContent = "Ajouter un tronçon";
		add.onclick = function () {
			state.segments.push(emptySegment());
			selectSegment(state.segments.length - 1);
		};
		bar.appendChild(add);

		if (state.segments.length > 1) {
			var remove = document.createElement("button");
			remove.className = "danger";
			remove.textContent = "Supprimer ce tronçon";
			remove.onclick = function () {
				state.segments.splice(state.active, 1);
				selectSegment(Math.min(state.active, state.segments.length - 1));
			};
			bar.appendChild(remove);
		}

		// À un seul tronçon il n'y a rien à dire : la barre le montre déjà.
		el("segmentNote").textContent = state.segments.length === 1
			? ""
			: state.segments.length + " tronçons, publiés ensemble sur chaque course.";
	}

	function selectSegment(index) {
		state.active = index;
		setMode("idle");
		renderSegment();
	}

	function backToList() {
		go("");
	}

	/**
	 * Le nombre de courses que les bornes retenues modifieraient. À zéro, rien ne sortira dans le feed
	 * — pas même les arrêts de substitution : c'est le signe que les bornes ne figurent sur l'horaire
	 * théorique d'aucune course de la ligne.
	 */
	function renderTripCount() {
		var count = seg().matchingTrips;
		var note = el("tripCount");
		note.textContent = count === 0
			? "Aucune course ne dessert ces bornes : ce tronçon ne sera pas publié."
			: count + " courses concernées d'ici la fin du service.";
		note.style.color = count === 0 ? "var(--danger)" : "var(--muted)";
	}

	/**
	 * Recompte les courses auprès du serveur après un changement de borne. Le compte du chargement ne
	 * vaut que pour les bornes d'alors, et c'est lui qui dit si le tronçon sortira du feed.
	 */
	function refreshTripCount() {
		var segment = seg();
		if (segment.startStopId === null || segment.endStopId === null) {
			segment.matchingTrips = 0;
			renderTripCount();
			return;
		}

		clearTimeout(state.countTimer);
		state.countTimer = setTimeout(function () {
			var url = API + "/api/detours/" + encodeURIComponent(state.detail.key) + "/trip-count"
				+ "?start=" + encodeURIComponent(segment.startStopId) + "&end=" + encodeURIComponent(segment.endStopId);
			request(url).then(function (answer) {
				segment.matchingTrips = answer.matchingTrips;
				if (seg() === segment) renderTripCount();
			}).catch(function (error) { setStatus(error.message, "error"); });
		}, 150);
	}

	// --- périmètre du sens ---

	/** Le libellé d'un arrêt de la ligne, d'après les itinéraires que le détail porte. */
	function stopNameOf(stopId) {
		var found = stopId;
		state.detail.sequences.forEach(function (sequence) {
			sequence.forEach(function (stop) { if (stop.stopId === stopId) found = stop.name; });
		});
		return found;
	}

	/**
	 * Ce que l'info trafic supprime dans ce sens — et d'où on le tient. L'analyse ne lit que le texte,
	 * et le texte ne dit pas tout : la liste se reprend à la main, et c'est elle qui fait foi ensuite,
	 * y compris vide — « concernée, mais sans suppression ».
	 */
	function renderScope() {
		var detail = state.detail;
		var summary = el("scopeSummary");
		var picker = el("scopePicker");
		var actions = el("scopeActions");
		picker.innerHTML = "";
		actions.innerHTML = "";

		if (state.scopeSelection === null) {
			var names = detail.removedStopIds.map(stopNameOf);
			// Sans info trafic, il n'y a pas d'analyse : le périmètre est toujours saisi, et le dire
			// n'apprendrait rien.
			summary.innerHTML = (detail.standalone ? ""
				: detail.manualScope ? '<span class="badge warn">saisi à la main</span> '
				: '<span class="badge ok">analyse du texte</span> ')
				+ (names.length === 0
					? "Aucun arrêt supprimé dans ce sens : seul le chemin peut changer."
					: names.length + (names.length > 1 ? " arrêts supprimés : " : " arrêt supprimé : ")
						+ escapeHtml(names.join(", ")) + ".");

			var edit = document.createElement("button");
			edit.textContent = detail.manualScope ? "Reprendre la saisie" : "Saisir le périmètre";
			edit.onclick = function () {
				state.scopeSelection = detail.removedStopIds.slice();
				renderScope();
			};
			actions.appendChild(edit);

			if (detail.manualScope && !detail.standalone) {
				var revert = document.createElement("button");
				revert.className = "danger";
				revert.textContent = "Rendre à l'analyse";
				revert.onclick = revertScope;
				actions.appendChild(revert);
			}
			return;
		}

		summary.innerHTML = detail.standalone
			? "Cocher les arrêts que la modification supprime dans ce sens — aucun arrêt coché veut dire "
				+ "que seul le chemin change."
			: "Cocher les arrêts que l'info trafic supprime dans ce sens. La liste "
				+ "remplacera ce que l'analyse en dit — aucun arrêt coché veut dire que la ligne est "
				+ "concernée sans perdre d'arrêt.";

		var box = document.createElement("div");
		box.className = "picker";
		routeStops().forEach(function (stop) {
			var label = document.createElement("label");
			var input = document.createElement("input");
			input.type = "checkbox";
			input.checked = state.scopeSelection.indexOf(stop.stopId) !== -1;
			input.onchange = function () {
				var index = state.scopeSelection.indexOf(stop.stopId);
				if (input.checked && index === -1) state.scopeSelection.push(stop.stopId);
				if (!input.checked && index !== -1) state.scopeSelection.splice(index, 1);
			};
			label.appendChild(input);
			label.appendChild(document.createTextNode(stop.name));
			box.appendChild(label);
		});
		picker.appendChild(box);

		var save = document.createElement("button");
		save.className = "primary";
		save.textContent = "Enregistrer le périmètre";
		save.onclick = saveScope;
		actions.appendChild(save);

		var cancel = document.createElement("button");
		cancel.textContent = "Annuler";
		cancel.onclick = function () { state.scopeSelection = null; renderScope(); };
		actions.appendChild(cancel);
	}

	function saveScope() {
		// Le périmètre s'enregistre à part, et le serveur rend le détail entier : ce qui n'a pas été
		// enregistré des tronçons repartirait avec. Mieux vaut le dire que le faire disparaître.
		var drawn = state.segments.some(function (segment) { return segment.path.length >= 2; });
		if (drawn && !confirm("Les tronçons non enregistrés seront perdus. Enregistrer le périmètre ?")) return;

		setStatus("Enregistrement du périmètre…");
		request(API + "/api/scopes/" + encodeURIComponent(state.detail.key), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ removedStopIds: state.scopeSelection })
		}).then(function (detail) {
			adoptDetail(detail);
			setStatus("Périmètre enregistré.", "ok");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	function revertScope() {
		if (!confirm("Rendre le périmètre à l'analyse du texte ?")) return;
		request(API + "/api/scopes/" + encodeURIComponent(state.detail.key), { method: "DELETE" })
			.then(function () {
				// Le périmètre rendu à l'analyse peut ne plus rien porter du tout : la déviation disparaît
				// alors de la liste, et il n'y a plus de détail à relire.
				return request(API + "/api/detours/" + encodeURIComponent(state.detail.key))
					.then(adoptDetail)
					.catch(backToList);
			})
			.catch(function (error) { setStatus(error.message, "error"); });
	}

	function renderSummary() {
		var detail = state.detail;
		var heading = "<h2 style='display:flex;align-items:center;gap:8px'>" + lineChip(detail.line)
			+ "<span>" + escapeHtml(detail.line + " " + towardOf(detail)) + "</span>" + stateBadge(detail) + "</h2>";

		if (!detail.standalone) {
			el("summary").innerHTML = heading +
				"<p><strong>" + escapeHtml(detail.headerText) + "</strong></p>" +
				"<div class='richtext'>" + detail.descriptionHtml + "</div>" +
				"<p class='note'>Info trafic " + detail.alertNumber + " · " + escapeHtml(describePeriods(detail.periods)) + "</p>";
			state.readPeriod = null;
			return;
		}

		// Sans info trafic, c'est ici que vivent l'intitulé et la période : ils se reprennent sur place.
		el("summary").innerHTML = heading +
			"<p>" + perturbationRef(detail) + "<strong>" + escapeHtml(detail.headerText) + "</strong></p>" +
			"<h2>Période d'application</h2><div class='form' id='periodEditor'></div>" +
			"<div class='row'><button id='savePeriod'>Enregistrer la période</button></div>";

		state.readPeriod = periodFields(el("periodEditor"), detail.period);
		el("savePeriod").onclick = savePeriod;
	}

	/**
	 * La période s'enregistre à part, comme le périmètre. Elle ne touche pas aux tronçons : on n'en
	 * reprend que ce qu'elle change — l'intitulé, les dates, l'état —, et ce qui est en cours de
	 * saisie sur la carte reste où il est.
	 */
	function savePeriod() {
		setStatus("Enregistrement de la période…");
		request(API + "/api/modifications/" + encodeURIComponent(state.detail.alertNumber), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(state.readPeriod())
		}).then(function (detail) {
			adoptState(detail);
			renderSummary();
			setStatus("Période enregistrée.", "ok");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	/** Reprend du détail rendu ce qui ne tient pas aux tronçons : la période, l'intitulé, l'état. */
	function adoptState(detail) {
		["headerText", "period", "periods", "active", "ended", "disabled"].forEach(function (name) {
			state.detail[name] = detail[name];
		});
	}

	/**
	 * La désactivation, et ce qu'elle fait. Elle vaut pour toute modification : désactivée, rien ne
	 * sort — ni la modification, ni les arrêts que son périmètre supprime.
	 */
	function renderPublication() {
		var detail = state.detail;
		el("toggleDisabled").textContent = detail.disabled ? "Réactiver" : "Désactiver";
		el("remove").textContent = detail.standalone ? "Supprimer la modification" : "Supprimer la déclaration";

		var note = el("disabledNote");
		note.textContent = detail.disabled
			? "Désactivée : rien n'est publié, ni la modification ni ses arrêts supprimés."
			: "";
		note.style.color = "var(--warn)";
	}

	function toggleDisabled() {
		var disabled = !state.detail.disabled;
		request(API + "/api/detours/" + encodeURIComponent(state.detail.key) + "/disabled", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ disabled: disabled })
		}).then(function (detail) {
			adoptState(detail);
			renderSummary();
			renderPublication();
			setStatus(disabled ? "Désactivée." : "Réactivée.", "ok");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	/** Tous les arrêts de la ligne/sens, dédoublonnés, dans l'ordre du premier itinéraire qui les voit. */
	function routeStops() {
		var seen = {}, stops = [];
		state.detail.sequences.forEach(function (sequence) {
			sequence.forEach(function (stop) {
				if (seen[stop.stopId]) return;
				seen[stop.stopId] = true;
				stops.push(stop);
			});
		});
		return stops;
	}

	/**
	 * L'arrêt d'où se comptent les temps de parcours : celui qui précède la borne amont sur le premier
	 * itinéraire qui la dessert. Rien lorsque la borne ouvre l'itinéraire — la référence est alors
	 * cette borne même, et les temps peuvent être négatifs.
	 */
	function referenceOf(startStopId) {
		var found = null;
		state.detail.sequences.forEach(function (sequence) {
			if (found !== null) return;
			for (var index = 0; index < sequence.length; index += 1) {
				if (sequence[index].stopId !== startStopId) continue;
				found = index === 0 ? null : sequence[index - 1];
				return;
			}
		});
		return found;
	}

	function renderBounds() {
		var segment = seg();
		var stops = routeStops();

		// Les bornes désignent les courses dans tous les cas — celles dont l'horaire porte les deux, dans
		// l'ordre. Ce qu'elles disent de plus dépend du périmètre : des arrêts supprimés, ou les deux
		// extrémités d'un passage ailleurs, qui restent desservies et ne sont alors pas publiées.
		var removes = removesStops(segment);
		el("boundsNote").innerHTML = removes
			? "Premier et dernier arrêt <strong>supprimé</strong>, bornes comprises."
			: "Entre quels arrêts le chemin change. Aucun arrêt supprimé dans cette plage : les deux "
				+ "bornes restent <strong>desservies</strong> et ne servent qu'à désigner les courses.";

		[["startStop", "startStopId"], ["endStop", "endStopId"]].forEach(function (pair) {
			var select = el(pair[0]);
			select.innerHTML = "";

			// Un tronçon qu'on vient d'ajouter n'a pas de bornes : sans cette entrée vide, le premier arrêt
			// de la ligne s'imposerait en silence.
			var empty = document.createElement("option");
			empty.value = "";
			empty.textContent = "— choisir —";
			select.appendChild(empty);

			stops.forEach(function (stop) {
				var option = document.createElement("option");
				option.value = stop.stopId;
				option.textContent = (stop.removed ? "✗ " : "") + stop.name;
				select.appendChild(option);
			});

			select.value = segment[pair[1]] || "";
			select.onchange = function (event) {
				segment[pair[1]] = event.target.value || null;
				renderBounds();
				renderStops();
				refreshTripCount();
			};
		});

		el("propagatedDelay").value = segment.propagatedDelay;
		el("propagatedDelay").onchange = function (event) {
			segment.propagatedDelay = parseInt(event.target.value, 10) || 0;
		};

		var candidates = state.detail.boundsCandidates;
		var itineraries = {};
		candidates.forEach(function (candidate) { itineraries[candidate.itinerary] = true; });

		var warnings = [];
		// Sans arrêt supprimé, il n'y a rien à déduire et rien à signaler : les bornes se choisissent
		// toujours à la main, et l'on sait pourquoi.
		if (candidates.length === 0 && state.detail.removedStopIds.length > 0) {
			warnings.push("Aucun itinéraire ne dessert les arrêts supprimés : bornes à choisir à la main.");
		}
		if (Object.keys(itineraries).length > 1) warnings.push("Plusieurs branches : les bornes pré-remplies sont celles de la mieux couverte.");

		el("boundsWarnings").innerHTML = warnings.map(function (text) {
			return '<div class="alertbox">' + escapeHtml(text) + "</div>";
		}).join("");

		el("referenceNote").innerHTML = referenceNote(segment);
	}

	/**
	 * D'où partent les temps de parcours de ce tronçon, nommément. C'est la question que se pose celui
	 * qui saisit un temps, et la réponse change à chaque fois que la borne amont change.
	 */
	function referenceNote(segment) {
		if (segment.startStopId === null) return "Choisir la borne amont pour connaître l'arrêt de référence.";

		var reference = referenceOf(segment.startStopId);
		if (!reference) return "Temps comptés depuis <strong>le premier arrêt de la course</strong> : ils peuvent être négatifs.";

		var note = "Temps comptés depuis l'arrivée à <strong>" + escapeHtml(reference.name) + "</strong>.";

		// Un tronçon dont la référence est supprimée par un autre lui sera fusionné à la publication, et
		// ses temps recomptés depuis la référence de celui-là — le consommateur n'a plus d'arrêt où
		// rattacher les siens. Autant le dire ici : les temps saisis ne sont pas ceux qui sortiront.
		var upstream = mergedInto(segment);
		if (upstream === null) return note;

		var root = referenceOf(state.segments[upstream].startStopId);
		return note + " Il suit le tronçon " + (upstream + 1) + " : à la publication les deux n'en feront qu'un, "
			+ "et ces temps seront recomptés depuis <strong>" + escapeHtml(root ? root.name : "le premier arrêt de la course")
			+ "</strong>.";
	}

	/**
	 * Le rang du tronçon qui supprime l'arrêt de référence de celui-ci, de proche en proche, ou null
	 * s'il n'y en a pas. C'est la même règle que le serveur applique course par course, en plus simple :
	 * ici on ne dispose que des itinéraires de la ligne, pas de l'horaire de chaque course.
	 */
	function mergedInto(segment) {
		var found = null;
		var current = segment;

		for (var guard = 0; guard < state.segments.length; guard += 1) {
			if (current.startStopId === null) return found;
			var reference = referenceOf(current.startStopId);
			if (!reference) return found;

			var index = -1;
			state.segments.forEach(function (other, rank) {
				if (other !== current && other.endStopId === reference.stopId) index = rank;
			});
			if (index === -1) return found;

			found = index;
			current = state.segments[index];
		}

		return found;
	}

	// --- carte ---

	function setupMap() {
		if (state.map === null) {
			state.map = L.map("map");
			L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
				maxZoom: 19, attribution: "© OpenStreetMap"
			}).addTo(state.map);
			state.base = L.layerGroup().addTo(state.map);
			state.routeLayer = L.layerGroup().addTo(state.map);
			// Les autres tronçons passent sous celui qu'on édite : ils se voient, ils ne gênent pas.
			state.otherLayer = L.layerGroup().addTo(state.map);
			state.drawLayer = L.layerGroup().addTo(state.map);
			state.map.on("click", onMapClick);
		}

		state.base.clearLayers();
		state.routeLayer.clearLayers();
		state.shapes = [];

		var bounds = [];

		// Une ligne a plusieurs itinéraires par sens — variantes, services partiels — et le tracé devra
		// se recoudre dans CHACUN de ceux que desservent les courses visées. Ils sont donc tous gardés,
		// pas seulement le premier : c'est contre eux que la prévisualisation se juge.
		state.detail.shapes.forEach(function (shape) {
			var points = decodePolyline(shape.encodedPolyline);
			state.shapes.push({ shapeId: shape.shapeId, points: points });
			L.polyline(points, { color: "#8b949e", weight: 4, opacity: .7 }).addTo(state.base);
			bounds = bounds.concat(points);
		});

		routeStops().forEach(function (stop) {
			if (stop.latitude === null || stop.longitude === null) return;
			var marker = L.circleMarker([stop.latitude, stop.longitude], {
				radius: stop.removed ? 6 : 4,
				color: stop.removed ? "#d1242f" : "#57606a",
				fillColor: stop.removed ? "#d1242f" : "#fff",
				fillOpacity: 1, weight: 2
			}).bindTooltip(stop.name).addTo(state.routeLayer);

			// En mode « arrêt existant », les arrêts de la ligne se réemploient d'un clic. Le clic ne doit
			// pas remonter à la carte, qui y verrait la pose d'un point.
			marker.on("click", function (event) {
				if (state.mode !== "search") return;
				L.DomEvent.stopPropagation(event);
				addStop({ stopId: stop.stopId, provisional: false, name: stop.name,
					latitude: stop.latitude, longitude: stop.longitude });
			});
			bounds.push([stop.latitude, stop.longitude]);
		});

		if (bounds.length > 0) state.map.fitBounds(L.latLngBounds(bounds).pad(.05));
		else state.map.setView([49.443, 1.099], 12);

		// La carte est révélée après coup : Leaflet a mesuré un conteneur encore caché.
		setTimeout(function () { state.map.invalidateSize(); }, 0);
	}

	function setMode(mode) {
		state.mode = mode;
		var searching = mode === "search" || mode === "place";
		el("addStop").className = searching ? "active" : "";
		el("draw").className = mode === "draw" ? "grow active" : "grow";
		el("draw").textContent = mode === "draw" ? "Terminer le tracé" : "Dessiner";
		el("stopSearch").className = searching ? "" : "hidden";
		// Seuls la pose d'un arrêt et le tracé se prennent sur la carte ; la recherche, au clavier.
		state.map.getContainer().style.cursor = mode === "place" || mode === "draw" ? "crosshair" : "";
		if (mode === "search") el("stopQuery").focus();
		if (mode === "place") setStatus("Cliquer sa position sur la carte.");
	}

	function onMapClick(event) {
		if (state.mode === "place") {
			placeProvisionalStop(event.latlng);
		} else if (state.mode === "draw") {
			addWaypoint(event.latlng);
		}
	}

	/** Une minute après le dernier arrêt posé : une valeur de départ plausible, à corriger. */
	function nextTravelTime() {
		var stops = seg().stops;
		if (stops.length === 0) return 60;
		return stops[stops.length - 1].travelTime + 60;
	}

	// --- recherche d'arrêts ---

	/**
	 * Désigne un arrêt, du GTFS ou de la base provisoire. La déviation ne retient que son identifiant
	 * et le temps pour l'atteindre : ce qu'il est se lit ailleurs, et suit ses propres modifications.
	 */
	function addStop(stop) {
		// Tous tronçons confondus : ils se suivent sur la même course, et deux mentions du même arrêt y
		// feraient arrêter le véhicule deux fois.
		var already = state.segments.some(function (segment) {
			return segment.stops.some(function (existing) { return existing.stopId === stop.stopId; });
		});
		if (already) { setStatus("Cet arrêt figure déjà dans la déclaration.", "error"); return; }

		seg().stops.push({
			stopId: stop.stopId, provisional: stop.provisional, name: stop.name,
			latitude: stop.latitude, longitude: stop.longitude, travelTime: nextTravelTime()
		});
		setStatus("");
		setMode("idle");
		renderStops();
		renderSegments();
	}

	function searchStops() {
		var query = el("stopQuery").value.trim();
		var results = el("stopResults");
		var hint = el("searchHint");

		if (query.length < 2) {
			results.innerHTML = "";
			hint.textContent = "Saisir au moins deux caractères.";
			return;
		}

		request(API + "/api/stops?q=" + encodeURIComponent(query)).then(function (stops) {
			results.innerHTML = "";

			stops.forEach(function (stop) {
				var row = document.createElement("div");
				var tag = stop.provisional ? '<span class="badge warn">provisoire</span> ' : "";
				row.innerHTML = tag + escapeHtml(stop.name) + ' <span class="id">' + escapeHtml(stop.stopId) + "</span>";
				row.onclick = function () {
					addStop(stop);
					state.map.panTo([stop.latitude, stop.longitude]);
				};
				results.appendChild(row);
			});

			// Aucun arrêt existant ne convient : le nom saisi devient celui d'un nouvel arrêt provisoire,
			// qu'il ne reste qu'à poser. C'est la seule façon d'en créer un, et elle part de la recherche —
			// on ne crée un arrêt qu'après avoir constaté qu'il n'existe pas.
			var row = document.createElement("div");
			row.innerHTML = "Créer « <strong>" + escapeHtml(query) + "</strong> » — cliquer sa position sur la carte";
			row.onclick = function () { setMode("place"); };
			results.appendChild(row);

			hint.textContent = stops.length === 0 ? "Aucun arrêt de ce nom." : "";
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	/** Crée l'arrêt provisoire en cours de saisie à l'endroit cliqué, puis l'ajoute à la déviation. */
	function placeProvisionalStop(latlng) {
		var name = el("stopQuery").value.trim();
		if (name.length === 0) { setStatus("Saisir d'abord le nom de l'arrêt.", "error"); return; }

		request(API + "/api/provisional-stops", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: name, latitude: latlng.lat, longitude: latlng.lng })
		}).then(function (stop) {
			el("stopQuery").value = "";
			el("stopResults").innerHTML = "";
			addStop({ stopId: stop.stopId, provisional: true, name: stop.name,
				latitude: stop.latitude, longitude: stop.longitude });
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	/** Renomme ou déplace un arrêt provisoire dans la base — le changement vaut pour toutes les déviations. */
	function saveProvisionalStop(stop) {
		request(API + "/api/provisional-stops/" + encodeURIComponent(stop.stopId), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: stop.name, latitude: stop.latitude, longitude: stop.longitude })
		}).then(function () {
			setStatus("Arrêt mis à jour, pour toutes les déviations qui le désignent.", "ok");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	// --- arrêts de substitution ---

	function renderStops() {
		var list = el("stopList");
		list.innerHTML = "";

		// Sans suppression, il n'y a rien à remplacer : la section disparaît, sauf si des arrêts y
		// subsistent d'un périmètre précédent — il faut alors pouvoir les retirer.
		el("stopSection").className = removesStops(seg()) || seg().stops.length > 0 ? "" : "hidden";

		var reference = seg().startStopId === null ? null : referenceOf(seg().startStopId);
		var from = "Secondes depuis l'arrivée à " + (reference ? reference.name : "l'arrêt de départ de la course");
		el("travelTimeNote").innerHTML = referenceNote(seg()) + " En <code>mm:ss</code> ou en secondes, croissants.";

		seg().stops.forEach(function (stop, index) {
			var box = document.createElement("div");
			box.className = "stop";

			// Un arrêt du GTFS ne se renomme pas : son libellé est celui du GTFS. Un arrêt provisoire, si —
			// mais il vit dans sa propre base, et le renommer vaut pour toutes les déviations qui le
			// désignent. D'où l'enregistrement à part, qui ne passe pas par la déviation.
			var nameField = stop.provisional
				? '<input class="name" placeholder="Nom de l\'arrêt" value="' + escapeHtml(stop.name) + '">'
				: '<span class="gtfsname">' + escapeHtml(stop.name) + "</span>";

			var origin = '<div class="coords"><span class="badge ' + (stop.provisional ? "warn" : "ok") + '">'
				+ (stop.provisional ? "PROVISOIRE" : "GTFS") + "</span> " + escapeHtml(stop.stopId) + "</div>";

			box.innerHTML =
				'<div class="head"><span class="num">' + (index + 1) + "</span>" + nameField + "</div>" + origin +
				'<div class="field"><label>Depuis</label><input class="time" title="' + escapeHtml(from)
					+ '" value="' + formatDuration(stop.travelTime) + '"></div>' +
				'<div class="coords">' + stop.latitude.toFixed(5) + ", " + stop.longitude.toFixed(5) + "</div>" +
				'<div class="row" style="margin:8px 0 0"><button class="up">↑</button><button class="down">↓</button>' +
				'<span style="flex:1"></span><button class="del danger">Retirer</button></div>';

			var nameInput = box.querySelector(".name");
			if (nameInput) {
				nameInput.oninput = function (event) { stop.name = event.target.value; };
				nameInput.onchange = function () { saveProvisionalStop(stop); };
			}
			box.querySelector(".time").onchange = function (event) {
				var seconds = parseDuration(event.target.value);
				if (seconds === null) { event.target.value = formatDuration(stop.travelTime); return; }
				stop.travelTime = seconds;
				event.target.value = formatDuration(seconds);
			};
			box.querySelector(".up").onclick = function () { move(index, -1); };
			box.querySelector(".down").onclick = function () { move(index, 1); };
			box.querySelector(".del").onclick = function () {
				seg().stops.splice(index, 1);
				renderStops();
				renderSegments();
			};

			list.appendChild(box);
		});

		var segment = seg();
		var negatives = segment.stops.some(function (stop) { return stop.travelTime < 0; });
		var note = el("stopNote");

		if (negatives && reference !== null) {
			// La spécification ne sanctionne les temps négatifs que lorsque la modification commence au
			// premier arrêt de la course — la référence est alors cet arrêt même. Ailleurs, ils restent
			// publiés : c'est l'exploitant qui sait par où passe son bus. Mais il faut le lui dire.
			note.textContent = "Temps négatifs alors que la course passe d'abord par " + reference.name
				+ " : publiés tels quels, mais un consommateur strict peut les écarter.";
			note.style.color = "var(--warn)";
		} else if (!removesStops(segment)) {
			note.textContent = segment.stops.length === 0
				? "Aucun arrêt supprimé dans cette plage : seul le tracé sera publié."
				: "Aucun arrêt supprimé dans cette plage : ces arrêts de substitution ne seront pas publiés.";
			note.style.color = segment.stops.length === 0 ? "var(--muted)" : "var(--warn)";
		} else if (segment.stops.length === 0) {
			note.textContent = "Aucun report : le tronçon est simplement supprimé, et le tracé dit par où passe le véhicule.";
			note.style.color = "var(--muted)";
		} else {
			note.textContent = "";
		}

		drawStopMarkers();
	}

	function move(index, step) {
		var stops = seg().stops;
		var target = index + step;
		if (target < 0 || target >= stops.length) return;
		var moved = stops.splice(index, 1)[0];
		stops.splice(target, 0, moved);
		renderStops();
	}

	function drawStopMarkers() {
		state.stopMarkers.forEach(function (marker) { state.drawLayer.removeLayer(marker); });
		state.stopMarkers = [];

		seg().stops.forEach(function (stop, index) {
			var label = String(index + 1) + ". " + (stop.name || "sans nom");

			// Un arrêt du GTFS ne se déplace pas : sa position est celle du quai. Un arrêt provisoire, si,
			// et le déplacement va droit dans sa base — il vaut pour toutes les déviations.
			if (!stop.provisional) {
				var pin = L.circleMarker([stop.latitude, stop.longitude], {
					radius: 8, color: "#1a7f37", fillColor: "#1a7f37", fillOpacity: .85, weight: 2
				}).bindTooltip(label + " (GTFS)").addTo(state.drawLayer);
				state.stopMarkers.push(pin);
				return;
			}

			var marker = L.marker([stop.latitude, stop.longitude], { draggable: true })
				.bindTooltip(label)
				.addTo(state.drawLayer);
			marker.on("dragend", function () {
				var position = marker.getLatLng();
				stop.latitude = position.lat;
				stop.longitude = position.lng;
				saveProvisionalStop(stop);
				renderStops();
			});
			state.stopMarkers.push(marker);
		});
	}

	// --- tracé ---

	/**
	 * Le tracé se tient en POINTS DE PASSAGE — ceux que l'on clique — et en JAMBES — ce qui les relie.
	 * Une jambe suit les rues d'OpenStreetMap ou file tout droit, et c'est le point de passage qui
	 * l'ouvre qui porte ce choix. Le trajet publié, lui, reste la simple suite des points : il se
	 * recompose à chaque rendu, et rien en aval ne sait qu'il y a eu des jambes.
	 */
	function rebuildPath() {
		var segment = seg();
		var path = [];

		segment.legs.forEach(function (leg, index) {
			// Le premier point d'une jambe est le dernier de la précédente : il ne compte qu'une fois.
			for (var point = index === 0 ? 0 : 1; point < leg.points.length; point += 1) {
				path.push(leg.points[point]);
			}
		});

		// Un point de passage seul ne décrit aucun trajet, et le serveur le refuserait.
		segment.path = segment.waypoints.length >= 2 ? path : [];
	}

	/** Pose un point de passage au bout du tracé, et résout la jambe qu'il ferme. */
	function addWaypoint(latlng) {
		var segment = seg();

		// Le mode vit sur le point qui OUVRE la jambe : c'est donc le dernier posé qui prend le trait
		// courant, et non celui qu'on ajoute. Sans quoi changer de trait puis cliquer laisserait la
		// jambe qu'on vient de tirer au trait d'avant, et n'agirait que sur la suivante.
		if (segment.waypoints.length > 0) segment.waypoints[segment.waypoints.length - 1].mode = state.pen;
		segment.waypoints.push({ point: [latlng.lat, latlng.lng], mode: state.pen });

		if (segment.waypoints.length < 2) {
			renderPath();
			renderSegments();
			return;
		}

		segment.legs.push(newLeg());
		resolveLeg(segment.legs.length - 1);
	}

	/** Insère un point de passage au milieu d'une jambe, qui se scinde en deux du même mode. */
	function insertWaypoint(index, latlng) {
		var segment = seg();
		segment.waypoints.splice(index + 1, 0, { point: [latlng.lat, latlng.lng], mode: segment.waypoints[index].mode });
		segment.legs.splice(index + 1, 0, newLeg());
		resolveLeg(index);
		resolveLeg(index + 1);
	}

	/** Retire un point de passage : ses deux jambes n'en font plus qu'une. */
	function removeWaypoint(index) {
		var segment = seg();
		if (index < 0 || index >= segment.waypoints.length) return;
		segment.waypoints.splice(index, 1);

		if (segment.waypoints.length < 2) {
			segment.legs = [];
		} else if (index === 0) {
			segment.legs.shift();
		} else if (index === segment.waypoints.length) {
			segment.legs.pop();
		} else {
			segment.legs.splice(index, 1);
			resolveLeg(index - 1);
			return;
		}

		renderPath();
		renderSegments();
	}

	/**
	 * Recalcule une jambe.
	 *
	 * Le routage part au serveur, seul à tenir le graphe : la réponse peut donc revenir après qu'on a
	 * redéplacé le point de passage. Chaque jambe porte un jeton, incrémenté à chaque demande, et une
	 * réponse dont le jeton n'est plus le bon décrit un tracé qui n'existe plus — on la laisse tomber.
	 *
	 * Un routage qui échoue ne bascule PAS la jambe en ligne droite et n'empêche pas d'enregistrer :
	 * elle se dessine en rouge, reste déclarée comme suivant les rues, et c'est au dessinateur de
	 * trancher — poser un point intermédiaire, ou la passer en ligne droite. Deviner à sa place
	 * publierait un raccourci qu'il n'a pas vu.
	 */
	function resolveLeg(index) {
		var segment = seg();
		var leg = segment.legs[index];
		var from = segment.waypoints[index];
		var to = segment.waypoints[index + 1];
		if (!leg || !from || !to) return;

		leg.token += 1;
		leg.message = "";
		leg.points = [from.point, to.point];
		var token = leg.token;

		if (from.mode !== "route") {
			leg.status = "ok";
			renderPath();
			renderSegments();
			return;
		}

		leg.status = "pending";
		renderPath();

		request(API + "/api/route", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ from: from.point, to: to.point })
		}).then(function (result) {
			if (leg.token !== token) return;
			leg.points = result.path;
			leg.status = "ok";
			adoptSnapped(index);
			renderPath();
			renderSegments();
		}).catch(function (error) {
			if (leg.token !== token) return;
			leg.status = "failed";
			leg.message = error.message;
			renderPath();
			renderSegments();
			setStatus("Jambe " + (index + 1) + " : " + error.message, "error");
		});
	}

	/**
	 * Les deux points de passage d'une jambe accrochée rejoignent la chaussée.
	 *
	 * Le serveur n'a pas routé depuis le clic mais depuis son PROJETÉ sur la rue la plus proche, et
	 * c'est ce projeté qui sera publié. Laisser la pastille là où la souris est tombée montrerait un
	 * tracé qui n'existe pas : on la ramène où elle a effectivement accroché, quitte à ce qu'elle
	 * saute de quelques dizaines de mètres sous le curseur — c'est très exactement ce que le mode
	 * fait, et le voir vaut mieux que de le deviner à l'enregistrement.
	 *
	 * Une jambe droite voisine se retend d'autant, sans rien redemander : ses bouts ont bougé.
	 */
	function adoptSnapped(index) {
		var segment = seg();
		var leg = segment.legs[index];
		if (!leg || leg.points.length < 2) return;

		segment.waypoints[index].point = leg.points[0];
		segment.waypoints[index + 1].point = leg.points[leg.points.length - 1];

		if (index > 0 && segment.waypoints[index - 1].mode !== "route") stretchLeg(index - 1);
		if (segment.waypoints[index + 1].mode !== "route") stretchLeg(index + 1);
	}

	/** Les deux jambes que touche un point de passage. */
	function resolveAround(index) {
		if (index > 0) resolveLeg(index - 1);
		if (index < seg().legs.length) resolveLeg(index);
	}

	/** L'état des deux boutons de trait : ce que suivra la PROCHAINE jambe. */
	function renderPen() {
		var routing = state.detail && state.detail.roadRouting;
		if (!routing) state.pen = "free";

		el("penRoute").className = state.pen === "route" ? "active" : "";
		el("penFree").className = state.pen === "free" ? "active" : "";
		el("penRoute").disabled = !routing;
		el("penNote").textContent = routing
			? ""
			: "Graphe routier absent : le construire avec pnpm build:graph pour accrocher aux rues.";
	}

	function renderPath() {
		rebuildPath();

		state.legLines.concat(state.legToggles, state.waypointMarkers).forEach(function (layer) {
			if (layer) state.drawLayer.removeLayer(layer);
		});
		state.legLines = [];
		state.legToggles = [];
		state.waypointMarkers = [];
		if (state.previewLine) { state.base.removeLayer(state.previewLine); state.previewLine = null; }

		drawOtherSegments();

		var segment = seg();
		var failed = 0;

		// Une action qui ne ferait rien ne s'offre pas : c'est ce qui distingue, d'un coup d'œil, les
		// deux boutons d'action des réglages au-dessus, qui eux sont toujours actifs.
		el("undo").disabled = segment.waypoints.length === 0;
		el("clearPath").disabled = segment.waypoints.length === 0;

		segment.legs.forEach(function (leg, index) {
			state.legLines[index] = null;
			state.legToggles[index] = null;
			if (leg.points.length < 2) return;
			if (leg.status === "failed") failed += 1;

			var routed = segment.waypoints[index].mode === "route";
			var color = leg.status === "failed" ? "#d1242f" : "#fb8500";
			// Le pointillé dit la ligne droite : ce qui ne suit aucune rue, qu'on l'ait voulu ou que le
			// routage ait échoué.
			var line = L.polyline(leg.points, {
				color: color, weight: 5, opacity: leg.status === "pending" ? .45 : 1,
				dashArray: routed && leg.status === "ok" ? null : "6 4"
			}).addTo(state.drawLayer);

			line.on("click", function (event) {
				L.DomEvent.stopPropagation(event);
				insertWaypoint(index, event.latlng);
			});
			state.legLines[index] = line;

			// La pastille du milieu bascule la jambe entre rue et ligne droite : un geste visible plutôt
			// qu'une combinaison de touches, car c'est le réglage qu'on reprend le plus souvent.
			var toggle = L.circleMarker(leg.points[Math.floor(leg.points.length / 2)], {
				radius: 5, color: color, fillColor: routed ? color : "#fff", fillOpacity: 1, weight: 2
			}).addTo(state.drawLayer);

			toggle.bindTooltip("Jambe " + (index + 1) + " · " + (routed ? "suit les rues" : "ligne droite"));
			toggle.on("click", function (event) {
				L.DomEvent.stopPropagation(event);
				segment.waypoints[index].mode = routed ? "free" : "route";
				resolveLeg(index);
			});
			state.legToggles[index] = toggle;
		});

		// Seuls les points de passage se matérialisent. Les centaines de points qu'une jambe accrochée
		// rapporte sont de la géométrie, pas des prises : les montrer rendrait le tracé illisible et
		// laisserait croire qu'on peut les saisir.
		segment.waypoints.forEach(function (waypoint, index) {
			var marker = L.circleMarker(waypoint.point, {
				radius: 6, color: "#fb8500", fillColor: "#fb8500", fillOpacity: 1, weight: 2
			}).addTo(state.drawLayer);

			marker.on("mousedown", function (event) {
				if (!event.originalEvent.altKey) startDragWaypoint(index, marker);
			});
			marker.on("click", function (event) {
				L.DomEvent.stopPropagation(event);
				if (event.originalEvent.altKey) removeWaypoint(index);
			});

			state.waypointMarkers.push(marker);
		});

		// La prévisualisation vaut pour la course entière, et non pour le seul tronçon actif : c'est un
		// unique trajet qui sera publié, cousu de tous les tracés déclarés.
		var preview = drawPreview();
		var note = el("pathNote");
		var counted = segment.waypoints.length + " points de passage, " + segment.path.length + " points publiés";

		if (preview === null) {
			note.textContent = segment.waypoints.length === 0 ? "Aucun tracé." : counted + ", rien à prévisualiser.";
			note.style.color = "var(--muted)";
			return;
		}

		var text = (segment.waypoints.length === 0 ? "Aucun tracé ici. En bleu" : counted + ". En bleu")
			+ ", le trajet publié — ";
		text += preview.rejoined
			? "il revient sur l'itinéraire."
			: "il s'achève au dernier tracé, en terminus provisoire.";
		if (preview.unreachable > 0) text += " " + preview.unreachable + " tracé(s) hors d'atteinte.";
		if (preview.offset > MAX_JUNCTION_METRES) {
			text += " Départ à " + Math.round(preview.offset) + " m de la ligne grise : la coupe se fera là.";
		}
		if (failed > 0) {
			text += " " + failed + " jambe(s) sans itinéraire, tracées droit : les basculer en ligne droite,"
				+ " ou poser un point de passage intermédiaire.";
		}

		note.textContent = text;
		note.style.color = failed > 0 || preview.offset > MAX_JUNCTION_METRES || preview.unreachable > 0
			? "var(--warn)" : "var(--muted)";
	}

	/**
	 * Les autres tronçons, en retrait : leur tracé en orange pâle et leurs arrêts en petits cercles
	 * gris. Ils ne s'éditent pas d'ici — un clic les active, et tout revient au premier plan.
	 */
	function drawOtherSegments() {
		state.otherLayer.clearLayers();

		state.segments.forEach(function (segment, index) {
			if (index === state.active) return;

			if (segment.path.length >= 2) {
				var line = L.polyline(segment.path, { color: "#fb8500", weight: 3, opacity: .35 }).addTo(state.otherLayer);
				line.bindTooltip("Tronçon " + (index + 1));
				line.on("click", function (event) {
					L.DomEvent.stopPropagation(event);
					selectSegment(index);
				});
			}

			segment.stops.forEach(function (stop) {
				if (stop.latitude === null || stop.longitude === null) return;
				L.circleMarker([stop.latitude, stop.longitude], {
					radius: 5, color: "#8b949e", fillColor: "#8b949e", fillOpacity: .5, weight: 1
				}).bindTooltip("Tronçon " + (index + 1) + " — " + (stop.name || "sans nom")).addTo(state.otherLayer);
			});
		});
	}

	/** Déplacement : Leaflet ne rend pas les cercles déplaçables, on suit la souris nous-mêmes. */
	function startDragWaypoint(index, marker) {
		var segment = seg();
		state.map.dragging.disable();

		function onMove(event) {
			segment.waypoints[index].point = [event.latlng.lat, event.latlng.lng];
			marker.setLatLng(event.latlng);
			// Pendant le geste, les deux jambes voisines se tendent en droites : router à chaque pixel
			// ferait une requête par mouvement de souris, pour un tracé qu'on n'a pas fini de choisir.
			stretchLeg(index - 1);
			stretchLeg(index);
		}

		function onUp() {
			state.map.off("mousemove", onMove);
			state.map.off("mouseup", onUp);
			state.map.dragging.enable();
			resolveAround(index);
		}

		state.map.on("mousemove", onMove);
		state.map.on("mouseup", onUp);
	}

	/** La jambe tendue entre ses deux points de passage, le temps du geste. */
	function stretchLeg(index) {
		var segment = seg();
		var leg = segment.legs[index];
		if (!leg) return;

		leg.points = [segment.waypoints[index].point, segment.waypoints[index + 1].point];
		if (state.legLines[index]) state.legLines[index].setLatLngs(leg.points);
	}

	/**
	 * Le trajet tel qu'il sera publié : l'itinéraire d'origine jusqu'au premier point de divergence, le
	 * dessin, l'itinéraire jusqu'à la divergence suivante, et ainsi de suite. Un tracé qui ne revient
	 * pas termine la course : c'est un terminus provisoire, et le trajet s'arrête là — les tracés qui
	 * suivaient ne sont alors pas atteints.
	 *
	 * TOUS les tronçons y entrent, dans l'ordre où la course les rencontre et non dans celui où ils ont
	 * été saisis : c'est un seul trajet qui sera publié pour la course.
	 *
	 * Le premier itinéraire du sens sert de référence pour l'affichage ; le serveur, lui, recoud dans
	 * chacun de ceux qu'empruntent les courses visées. La prévisualisation se contente des sommets —
	 * le serveur projette sur les segments — mais elle suffit à juger des raccords.
	 *
	 * Renvoie l'écart maximal aux points de divergence, en mètres, et de quoi rédiger la note ; ou null
	 * s'il n'y avait rien à prévisualiser.
	 */
	function drawPreview() {
		var shape = state.shapes[0];
		if (!shape || shape.points.length < 2) return null;

		var drawn = [];
		state.segments.forEach(function (segment) {
			if (segment.path.length < 2) return;
			var from = nearestIndex(shape.points, segment.path[0]);
			var to = nearestIndex(shape.points, segment.path[segment.path.length - 1]);
			// Reprend-on l'itinéraire ? Seulement si le tracé y ramène : cf. spliceShape, côté serveur.
			drawn.push({
				path: segment.path, from: from.index, to: to.index, offset: from.offset,
				rejoins: to.offset <= REJOIN_METRES && to.index > from.index
			});
		});
		if (drawn.length === 0) return null;
		drawn.sort(function (a, b) { return a.from - b.from; });

		var preview = [], cursor = -1, open = true, unreachable = 0, offset = 0;
		drawn.forEach(function (item) {
			// Un tracé qui diverge avant le point où le précédent a rejoint l'itinéraire ferait remonter la
			// course : on le laisse de côté, comme le serveur.
			if (!open || item.from < cursor) { unreachable += 1; return; }
			preview = preview.concat(shape.points.slice(Math.max(cursor, 0), item.from)).concat(item.path);
			offset = Math.max(offset, item.offset);
			if (item.rejoins) cursor = item.to + 1;
			else open = false;
		});
		if (open) preview = preview.concat(shape.points.slice(cursor));

		state.previewLine = L.polyline(preview, { color: "#1f6feb", weight: 3, opacity: .9, dashArray: "6 4" })
			.addTo(state.base);

		return { offset: offset, rejoined: open, unreachable: unreachable };
	}

	/** Le sommet le plus proche d'un point, et son écart approché en mètres. */
	function nearestIndex(points, point) {
		var best = 0, bestDistance = Infinity;
		points.forEach(function (candidate, index) {
			var dx = candidate[0] - point[0], dy = (candidate[1] - point[1]) * .66;
			var distance = dx * dx + dy * dy;
			if (distance < bestDistance) { bestDistance = distance; best = index; }
		});
		return { index: best, offset: Math.sqrt(bestDistance) * 111000 };
	}

	// --- enregistrement ---

	function setStatus(text, kind) {
		var status = el("status");
		status.textContent = text;
		status.style.color = kind === "error" ? "var(--danger)" : kind === "ok" ? "var(--ok)" : "var(--muted)";
	}

	function save() {
		var payload = {
			segments: state.segments.map(function (segment) {
				return {
					startStopId: segment.startStopId,
					endStopId: segment.endStopId,
					propagatedDelay: segment.propagatedDelay,
					stops: segment.stops.map(function (stop) {
						return { stopId: stop.stopId, travelTime: stop.travelTime };
					}),
					path: segment.path,
					// Le plan de montage, pour pouvoir reprendre le tracé plus tard. Un point de passage
					// esseulé ne décrit rien : il ne part pas, comme le tracé lui-même.
					waypoints: segment.waypoints.length >= 2 ? segment.waypoints : []
				};
			})
		};

		setStatus("Enregistrement…");
		request(API + "/api/detours/" + encodeURIComponent(state.detail.key), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		}).then(function (detail) {
			state.detail = detail;
			state.segments = detail.segments.map(adoptSegment);
			state.active = Math.min(state.active, state.segments.length - 1);
			renderSegment();
			renderPublication();

			// Le compte rendu porte sur le premier tronçon qui coince : c'est celui-là qu'il faut reprendre,
			// et le nommer évite de les passer tous en revue.
			var blocking = -1;
			state.segments.forEach(function (segment, index) {
				if (blocking === -1 && (!segment.publishable || segment.matchingTrips === 0)) blocking = index;
			});

			var message;
			if (blocking === -1) {
				message = "Enregistré et publié.";
			} else {
				var segment = state.segments[blocking];
				var why = segment.startStopId === null || segment.endStopId === null
					? "bornes manquantes."
					: segment.matchingTrips === 0 ? "aucune course ne dessert ses bornes."
					: removesStops(segment) ? "ni arrêt ni tracé."
					: "tracé manquant.";
				message = "Enregistré. Tronçon " + (blocking + 1) + " : " + why;
			}
			setStatus(message, blocking === -1 ? "ok" : "error");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	function remove() {
		if (!confirm(state.detail.standalone
			? "Supprimer cette modification, sa période et son périmètre ?"
			: "Effacer cette déclaration ?")) return;
		request(API + "/api/detours/" + encodeURIComponent(state.detail.key), { method: "DELETE" })
			.then(backToList)
			.catch(function (error) { setStatus(error.message, "error"); });
	}

	// --- branchements ---

	// Le groupement ne tient qu'à l'affichage : rien à redemander au serveur. Il se retient d'une visite
	// à l'autre — c'est une façon de travailler, pas un réglage qu'on repose chaque matin.
	el("groupBy").value = window.localStorage.getItem("detours.groupBy") === "alert" ? "alert" : "line";
	el("groupBy").onchange = function (event) {
		window.localStorage.setItem("detours.groupBy", event.target.value);
		renderList();
	};
	el("showUpcoming").onchange = renderList;
	el("addStop").onclick = function () {
		setMode(state.mode === "search" || state.mode === "place" ? "idle" : "search");
	};
	el("stopQuery").oninput = function () {
		if (state.mode === "place") setMode("search");
		// Un caractère de plus ne relance pas la recherche : on attend que la frappe se calme.
		clearTimeout(state.searchTimer);
		state.searchTimer = setTimeout(searchStops, 200);
	};
	el("draw").onclick = function () { setMode(state.mode === "draw" ? "idle" : "draw"); };
	el("penRoute").onclick = function () { state.pen = "route"; renderPen(); };
	el("penFree").onclick = function () { state.pen = "free"; renderPen(); };
	el("undo").onclick = function () { removeWaypoint(seg().waypoints.length - 1); };
	el("clearPath").onclick = function () {
		seg().waypoints = [];
		seg().legs = [];
		renderPath();
		renderSegments();
	};
	el("save").onclick = save;
	el("toggleDisabled").onclick = toggleDisabled;
	el("remove").onclick = remove;
	el("create").onclick = createModification;

	document.addEventListener("keydown", function (event) {
		if ((event.ctrlKey || event.metaKey) && event.key === "z" && state.detail) {
			event.preventDefault();
			removeWaypoint(seg().waypoints.length - 1);
		}
	});

	window.addEventListener("hashchange", applyRoute);
	applyRoute();
})();
</script>
</body>
</html>`;
