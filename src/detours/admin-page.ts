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
<title>Modifications — GTFS-RT TCAR</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
	:root {
		--bg: #f6f7f9; --panel: #fff; --ink: #14181f; --muted: #67707d; --line: #dfe3e9;
		--accent: #1f6feb; --danger: #d1242f; --warn: #9a6700; --ok: #1a7f37;
	}
	* { box-sizing: border-box; }
	body { margin: 0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		background: var(--bg); color: var(--ink); }
	/*
	 * L'en-tête a une hauteur fixe : les vues carte prennent exactement le reste de l'écran (cf.
	 * .detail), et une hauteur déduite du contenu ne se retrancherait pas au pixel près.
	 */
	header { display: flex; align-items: center; gap: 12px; height: 56px; padding: 0 20px;
		background: var(--panel); border-bottom: 1px solid var(--line); }
	header h1 { font-size: 16px; margin: 0 12px 0 0; font-weight: 600; }
	/* Les deux menus de l'en-tête : l'actif se souligne, sans autre décor. */
	.nav { display: flex; gap: 4px; }
	.nav a { padding: 6px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; }
	.nav a:hover { color: var(--ink); }
	.nav a.active { color: var(--ink); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent); border-radius: 0; }
	/* Au-dessus du tableau : créer à gauche, ranger à droite. */
	.toolbar { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
	.toolbar .grow { flex: 1; }
	.toolbar select { width: auto; }
	a.button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
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
	.detail { display: flex; height: calc(100vh - 56px); }
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
	.results .id { color: var(--muted); font-size: 12px; }
	.results .empty { color: var(--muted); cursor: default; }
	.gtfsname { font-weight: 600; flex: 1; }
	/* Les champs d'un formulaire s'empilent : une ligne chacun, un peu d'air entre eux. */
	.form .field { margin-bottom: 8px; }
	.form { max-width: 560px; }
	/*
	 * La base des arrêts provisoires : la carte d'un côté, le tableau de l'autre, comme le détail d'une
	 * déviation. Le panneau s'élargit — un nom, les déviations qui s'en servent, une action.
	 */
	#stopsMap { flex: 1; }
	.panel.wide { width: 560px; }
	.panel table { table-layout: auto; }
	.panel table td { white-space: normal; vertical-align: top; }
	.panel table tbody tr { cursor: default; }
	.usage { display: flex; align-items: center; gap: 4px; margin: 2px 0; font-size: 12px; color: inherit;
		text-decoration: none; }
	a.usage:hover { text-decoration: underline; }
	.usage .toward { margin-left: 2px; }
	/* Un arrêt provisoire se choisit d'un clic, au tableau ou sur la carte : sa ligne et son marqueur ressortent. */
	#stopsBody tr { cursor: pointer; }
	#stopsBody tr.selected td { background: #fdecee; }
	.stopPin { background: none; border: none; }
	/* Les boîtes de dialogue des arrêts provisoires : un titre, un contenu, les actions en bas à droite. */
	dialog { width: 440px; max-width: calc(100vw - 32px); padding: 16px; border: 1px solid var(--line);
		border-radius: 8px; background: var(--panel); color: var(--ink); }
	dialog::backdrop { background: rgba(20, 24, 31, .35); }
	dialog h2 { font-size: 15px; margin: 0 0 12px; }
	dialog .actions { justify-content: flex-end; }
	dialog .status:empty { display: none; }
	/*
	 * Le panneau d'une déviation : ce qui défile au-dessus, la barre d'enregistrement en dessous, qui
	 * reste en vue quelle que soit la longueur du reste. Le fond gris fait ressortir les cartes — une
	 * par chose qu'on règle : la modification, les arrêts supprimés du sens, les tronçons.
	 */
	.panel.editor { width: 440px; padding: 0; display: flex; flex-direction: column; overflow: hidden; }
	.editor .scroll { flex: 1; overflow-y: auto; padding: 12px; background: var(--bg); }
	.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px;
		padding: 12px; margin-bottom: 12px; }
	.card:last-child { margin-bottom: 0; }
	.panel .card h2 { margin: 0 0 8px; }
	/* Ce que couvre une section, dit à côté de son titre : le sens entier, ou le seul tronçon actif. */
	.card h2 .scopeof { text-transform: none; letter-spacing: 0; font-weight: 400; margin-left: 6px; }
	.card h3 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; padding-top: 10px;
		border-top: 1px solid var(--line); }
	.card h3.first { border-top: none; padding-top: 0; margin-top: 0; }
	/*
	 * Le cartouche et le sens à gauche, les badges empilés à droite, le tout centré sur une même
	 * hauteur : le statut en haut, l'origine en dessous. Un sens trop long passe à la ligne sans
	 * repousser les badges.
	 */
	.heading { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600;
		margin-bottom: 6px; }
	.heading .toward { flex: 1; min-width: 0; margin-left: 0; color: var(--ink); }
	.heading .badges { display: flex; flex-direction: column; align-items: flex-end; gap: 3px;
		flex: none; font-weight: 400; }
	.heading .badges > div { display: flex; gap: 4px; }
	.heading .badges .badge.tag { margin-left: 0; }
	/* La raison et la période, un champ par ligne, un peu d'air entre eux. */
	.fields .field { margin-bottom: 8px; }
	details > summary { cursor: pointer; color: var(--muted); font-size: 13px; margin: 4px 0; }
	details[open] > summary { margin-bottom: 6px; }
	/*
	 * Les tronçons en onglets, collés au cadre du tronçon actif : tout ce qui est dans le cadre vaut
	 * pour lui seul. L'onglet actif se fond dans le cadre plutôt que de prendre la couleur d'accent,
	 * qui reste aux boutons qui agissent.
	 */
	.tabs { display: flex; flex-wrap: wrap; gap: 4px; }
	.tabs button { border-radius: 6px 6px 0 0; margin-bottom: -1px; background: var(--bg); }
	.tabs button.active { background: var(--panel); color: var(--ink); border-color: var(--line);
		border-bottom-color: var(--panel); font-weight: 600; position: relative; z-index: 1; }
	.segment { border: 1px solid var(--line); border-radius: 0 6px 6px 6px; padding: 10px; }
	/* Les onglets de phase, collés au tableau comme ceux des tronçons à leur cadre. */
	.phases button { background: var(--bg); }
	table.list { border-top-left-radius: 0; }
	/* Une ligne invisible ou une suggestion se lit en retrait : elle ne publie rien. */
	tr.muted td, tr.suggestion td { color: var(--muted); }
	tr.suggestion td { background: #fbfcfd; }
	tr.suggestion { cursor: default; }
	/* La cellule d'action n'est pas un lien : elle agit sur la ligne au lieu de l'ouvrir. */
	td.act { text-align: right; }
	td.act button, td.act a.button { padding: 1px 8px; font-size: 12px; margin-left: 4px; }
	.badge.tag { margin-left: 6px; }
	/* La case de sélection : une colonne étroite, qui coche au lieu d'ouvrir. */
	td.pick, th.pick { text-align: center; padding-left: 0; padding-right: 0; }
	td.pick { cursor: default; }
	.pick input, tr.group .bar input { width: auto; margin: 0; vertical-align: middle; }
	/* Ce que l'on fait aux lignes cochées, dans la barre d'outils, tant qu'il y en a. */
	.bulk { display: flex; align-items: center; gap: 8px; }
	.bulk.hidden { display: none; }
	.card h2 { font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
	.field.top { align-items: flex-start; }
	.field .grow { flex: 1; }
	/* Les tracés du sens, à cocher ; le nom se clique pour montrer le tracé sur la carte. */
	.patterns { border: 1px solid var(--line); border-radius: 6px; }
	.patterns div { display: flex; gap: 8px; align-items: center; padding: 4px 9px;
		border-bottom: 1px solid var(--line); }
	.patterns div:last-child { border-bottom: none; }
	.patterns input { width: auto; flex: none; }
	.patterns .name { flex: 1; cursor: pointer; }
	.patterns .name.focused { font-weight: 600; }
	.patterns .count { color: var(--muted); font-size: 12px; white-space: nowrap; }
	.savebar { border-top: 1px solid var(--line); padding: 10px 12px; background: var(--panel); }
	.savebar .actions { margin-top: 0; }
	.savebar .grow { flex: 1; }
	.savebar .status { margin: 6px 0 0; }
	.savebar .status:empty, .savebar .note:empty { display: none; }
</style>
</head>
<body>
<header>
	<h1>GTFS-RT TCAR</h1>
	<nav class="nav">
		<a id="navList" href="#/">Modifications</a>
		<a id="navStops" href="#/stops">Base d'arrêts</a>
	</nav>
	<span class="spacer"></span>
	<a id="back" class="button hidden" href="#/">Retour à la liste</a>
</header>

<div id="listView" class="wrap">
	<div class="toolbar">
		<a class="button primary" href="#/new">Nouvelle modification</a>
		<span id="bulkBar" class="bulk hidden">
			<span class="note" id="bulkCount"></span>
			<button id="bulkHide">Masquer</button>
			<button id="bulkShow">Afficher</button>
			<button id="bulkDiscard" class="danger"></button>
		</span>
		<span class="grow"></span>
		<label class="note">grouper <select id="groupBy">
			<option value="line">par ligne</option>
			<option value="alert">par info trafic</option>
		</select></label>
		<label class="note">trier par <select id="sortBy">
			<option value="number">n° d'info trafic</option>
			<option value="name">nom</option>
			<option value="chrono">chronologie</option>
		</select></label>
	</div>
	<div class="tabs phases" id="phaseTabs"></div>
	<table class="list">
		<colgroup id="listCols"></colgroup>
		<thead id="listHead"></thead>
		<tbody id="listBody"></tbody>
	</table>
	<p id="listEmpty" class="note hidden">Rien à afficher.</p>
</div>

<div id="newView" class="wrap hidden">
	<div class="card form">
		<h2>Nouvelle modification</h2>
		<div class="field"><label>Info trafic</label><select id="newAlert"></select></div>
		<div class="field"><label>Ligne</label><select id="newRoute"></select></div>
		<div class="field"><label>Sens</label><select id="newDirection"></select></div>
		<div class="field top"><label>Tracés</label><div class="patterns grow" id="newPatterns"></div></div>
		<div class="field"><label>Raison</label><input id="newLabel"></div>
		<div id="newPeriod"></div>
		<div class="actions"><button id="create" class="primary">Créer</button></div>
		<p class="status" id="newStatus"></p>
	</div>
</div>

<div id="stopsView" class="detail hidden">
	<div id="stopsMap"></div>
	<aside class="panel wide">
		<div class="row">
			<input id="newStopName" placeholder="Nom du nouvel arrêt" autocomplete="off">
			<button id="placeNewStop" style="flex:none">Poser sur la carte</button>
		</div>
		<div class="row">
			<input id="stopsQuery" placeholder="Rechercher un arrêt" autocomplete="off">
			<label class="note" style="flex:none">trier par <select id="stopsSort" style="width:auto">
				<option value="name">nom</option>
				<option value="recent">création, récents d'abord</option>
				<option value="usages">nombre de modifications</option>
			</select></label>
		</div>
		<table>
			<thead><tr><th>Arrêt</th><th style="width:180px"></th></tr></thead>
			<tbody id="stopsBody"></tbody>
		</table>
		<p id="stopsEmpty" class="note hidden"></p>
		<p class="status" id="stopsStatus"></p>
	</aside>
</div>

<dialog id="dialog">
	<form id="dialogForm">
		<h2 id="dialogTitle"></h2>
		<div id="dialogBody"></div>
		<p class="status" id="dialogStatus"></p>
		<div class="actions">
			<button type="button" id="dialogCancel">Annuler</button>
			<button type="submit" id="dialogConfirm"></button>
		</div>
	</form>
</dialog>

<div id="detailView" class="detail hidden">
	<div id="map"></div>
	<aside class="panel editor">
		<div class="scroll">
			<section class="card">
				<div id="summary"></div>
				<div class="fields">
					<div class="field"><label>Raison</label><input id="label"></div>
					<div id="period"></div>
				</div>
				<h3>Tracés concernés</h3>
				<div class="patterns" id="patternList"></div>
				<p class="note" id="patternNote"></p>
			</section>

			<section class="card">
				<h2>Arrêts supprimés</h2>
				<p class="note" id="removedSummary"></p>
				<div id="removedPicker"></div>
				<div class="row" id="removedActions" style="margin:8px 0 0"></div>
			</section>

			<section class="card">
				<h2>Courses annulées</h2>
				<p class="note" id="cancelSummary"></p>
				<div id="cancelPicker"></div>
				<div class="row" id="cancelActions" style="margin:8px 0 0"></div>
			</section>

			<section class="card">
				<h2>Tronçons</h2>
				<div class="tabs" id="segmentBar"></div>
				<div class="segment">
					<p class="note" id="segmentNote" style="margin-top:0"></p>

					<h3 class="first">Bornes</h3>
					<p class="note" id="boundsNote"></p>
					<div id="boundsWarnings"></div>
					<div class="field" style="margin-bottom:8px"><label>Premier</label><select id="startStop"></select></div>
					<div class="field"><label>Dernier</label><select id="endStop"></select></div>
					<p class="note" id="referenceNote"></p>
					<div class="field" style="margin-top:8px"><label>Délai propagé</label><input id="propagatedDelay" type="number" step="1" value="0"></div>
					<p class="note">Secondes ajoutées aux horaires qui suivent le tronçon. 0 si le détour ne rallonge rien.</p>
					<p class="note" id="tripCount"></p>

					<div id="stopSection">
						<h3>Arrêts de substitution</h3>
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

					<h3>Tracé</h3>
					<p class="note">Partir d'où la course quitte son itinéraire, et y revenir plus loin — ou
						s'arrêter à l'écart si la ligne est coupée.</p>

					<details>
						<summary>Gestes sur la carte</summary>
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
					</details>

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

					<div class="actions divided" id="segmentFoot">
						<button id="removeSegment" class="danger">Supprimer ce tronçon</button>
					</div>
				</div>
			</section>
		</div>

		<footer class="savebar">
			<div class="actions">
				<button id="save" class="primary">Enregistrer</button>
				<button id="toggleVisible"></button>
				<span class="grow"></span>
				<button id="remove" class="danger"></button>
			</div>
			<p class="status" id="status"></p>
		</footer>
	</aside>
</div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
(function () {
	"use strict";

	var state = {
		detail: null, rows: [], alerts: [], routes: [], segments: [], active: 0, mode: "idle",
		// L'onglet du tableau : « current », « upcoming » ou « ended ».
		phase: "current",
		// Les lignes cochées du tableau, par identifiant (cf. rowId).
		selected: new Set(),
		// La base des arrêts provisoires : sa carte, ses marqueurs par identifiant, et la pose en cours.
		stopsMap: null, stopsLayer: null, provisionalStops: [], stopMarkersById: {}, placingStop: false,
		// L'arrêt provisoire choisi au tableau ou sur la carte, par identifiant publié.
		selectedStop: null,
		// Tous les arrêts désignables, GTFS et provisoires, chargés au premier « Ajouter un arrêt » ;
		// null tant qu'ils ne le sont pas, ou qu'un arrêt provisoire a changé depuis.
		allStops: null, pickLayer: null,
		// La mise en lumière d'un arrêt survolé : un seul à la fois, sur l'une ou l'autre carte.
		highlight: null,
		// La vue d'avant le survol, où la carte revient quand il cesse ; et ce retour, s'il est en attente.
		returnView: null, returnTimer: null,
		// Les tracés cochés de la modification, et combien de ceux qu'elle nommait ont disparu du GTFS.
		patterns: [], stalePatterns: 0,
		// Les arrêts supprimés saisis, ou null pour suivre l'analyse ; et si leur liste est dépliée.
		removed: null, removedEditing: false,
		// Les départs annulés, { stopId, departure } : quai et horaire du premier arrêt.
		cancelled: [],
		map: null, base: null, routeLayer: null, otherLayer: null, drawLayer: null, previewLine: null,
		stopMarkers: [], waypointMarkers: [], legLines: [], legToggles: [], pen: "free",
		shapes: [], shapeLayers: {}, searchTimer: null, countTimer: null,
		// Le tracé mis en avant sur la carte, et sur lequel porte l'aperçu : null, c'est le premier que
		// vise la modification.
		focusPattern: null,
		// Les lecteurs des champs de période : celui de la création, et celui de l'édition.
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
	 * Une vue à la fois. L'en-tête ne porte que les deux menus — les modifications, la base d'arrêts —,
	 * et le retour à la liste quand on en est sorti.
	 */
	function showView(name) {
		clearHighlight();
		el("listView").className = name === "list" ? "wrap" : "wrap hidden";
		el("newView").className = name === "new" ? "wrap" : "wrap hidden";
		el("detailView").className = name === "detail" ? "detail" : "detail hidden";
		el("stopsView").className = name === "stops" ? "detail" : "detail hidden";
		el("navList").className = name === "list" ? "active" : "";
		el("navStops").className = name === "stops" ? "active" : "";
		el("back").className = name === "new" || name === "detail" ? "button" : "button hidden";
	}

	/**
	 * La vue courante vit dans l'adresse : « #/ », « #/new », « #/stops » et « #/modification/<uid> ».
	 * Le retour du navigateur revient alors à l'écran précédent, et non au site d'où l'on venait —
	 * c'est le geste qu'on fait sans y penser, et il ne doit pas faire perdre la page.
	 */
	function go(route) {
		var next = "#/" + route;
		if (window.location.hash === next) applyRoute();
		else window.location.hash = next;
	}

	function applyRoute() {
		var route = window.location.hash.replace(/^#\/?/, "");

		if (route.indexOf("modification/") === 0) {
			openDetail(decodeURIComponent(route.slice("modification/".length)));
			return;
		}
		if (route === "new") {
			openNew();
			return;
		}
		if (route === "stops") {
			openStops();
			return;
		}

		state.detail = null;
		showView("list");
		loadList();
	}

	// --- liste ---

	/** L'adresse des cartouches de ligne du réseau. */
	var LINE_CARTRIDGE = "https://storage.googleapis.com/bus-tracker-assets/line-cartridges/astuce/";

	/** Les trois onglets du tableau : ce qui court, ce qui vient, ce qui est fini. */
	var PHASES = [["current", "En cours"], ["upcoming", "À venir"], ["ended", "Terminées"]];

	/**
	 * Les colonnes que le tableau sait rendre. Chaque groupement choisit les siennes : ce qui est commun
	 * à tout un groupe se dit une fois dans son bandeau, et n'a plus à se répéter à chaque ligne.
	 */
	var COLUMNS = {
		lineAndSens: { label: "Ligne et sens", cell: function (row) {
			return lineChip(row.lineCode, row.line) + "<span class='toward'>" + escapeHtml(towardOf(row)) + "</span>";
		} },
		sens: { label: "Sens", cell: function (row) {
			return "<span class='toward' style='margin-left:0'>" + escapeHtml(towardOf(row)) + "</span>";
		} },
		what: { label: "Modification", cell: function (row) {
			return perturbationRef(row) + escapeHtml(row.label) + originBadge(row);
		} },
		origin: { label: "Origine", cell: function (row) {
			// La raison ne se répète que si elle diffère du titre de l'info trafic, déjà dans le bandeau.
			return (row.alertNumber !== null && row.label !== row.alertHeader ? escapeHtml(row.label) : "") + originBadge(row);
		} },
		stops: { label: "Arrêts", className: "num", cell: function (row) { return String(row.removedStopCount); } },
		period: { label: "Période", className: "note", cell: function (row) {
			return escapeHtml(describePeriodsShort(row.periods));
		} },
		status: { label: "Déclaration", cell: statusBadges },
		actions: { label: "", action: true },
		select: { label: "", pick: true }
	};

	/**
	 * Les deux façons de lire le tableau. Par ligne, pour préparer une ligne entière — c'est la question
	 * de l'exploitant. Par info trafic, pour traiter une perturbation de bout en bout — c'est celle de
	 * l'agent qui saisit. Les modifications sans info trafic s'y groupent par raison.
	 */
	var GROUPINGS = {
		line: {
			columns: [["select", "32px"], ["sens", "18%"], ["what", "32%"], ["stops", "6%"], ["period", "14%"], ["status", "14%"], ["actions", "16%"]],
			keyOf: function (row) { return row.routeId; },
			heading: function (rows) {
				return lineChip(rows[0].lineCode, rows[0].line) + "<span class='title' style='margin-left:8px'>Ligne "
					+ escapeHtml(rows[0].line) + "</span><span class='grow'></span>"
					+ "<span class='note'>" + countLabel(rows) + "</span>";
			}
		},
		alert: {
			columns: [["select", "32px"], ["lineAndSens", "34%"], ["origin", "20%"], ["stops", "8%"], ["status", "18%"], ["actions", "20%"]],
			keyOf: function (row) { return row.alertNumber !== null ? "A" + row.alertNumber : "R" + row.label; },
			heading: function (rows) {
				var row = rows[0];
				return perturbationRef(row)
					+ "<span class='title'>" + escapeHtml(row.alertNumber !== null ? row.alertHeader : row.label) + "</span>"
					+ "<span class='grow'></span>"
					+ "<span class='note'>" + countLabel(rows) + "</span>"
					+ "<span class='note'>" + escapeHtml(describePeriodsShort(row.periods)) + "</span>";
			}
		}
	};

	/**
	 * Les tris : par numéro d'info trafic (les modifications sans info trafic en dernier), par nom, ou
	 * par ordre d'arrivée — la plus récente d'abord. Ils ordonnent les groupes par info trafic, et les
	 * lignes au sein d'un groupe par ligne.
	 */
	var SORTS = {
		number: function (a, b) {
			if ((a.alertNumber === null) !== (b.alertNumber === null)) return a.alertNumber === null ? 1 : -1;
			if (a.alertNumber === null) return a.label.localeCompare(b.label, "fr");
			return a.alertNumber.localeCompare(b.alertNumber, "fr", { numeric: true });
		},
		name: function (a, b) { return groupTitle(a).localeCompare(groupTitle(b), "fr"); },
		chrono: function (a, b) { return b.firstSeenAt - a.firstSeenAt; }
	};

	function groupTitle(row) { return row.alertNumber !== null ? row.alertHeader : row.label; }

	/**
	 * Ce que fait une image de cartouche absente : laisser le nom en clair. Le réseau n'en publie pas
	 * pour toutes ses lignes, et un cadre vide se verrait autant qu'une image manquante.
	 *
	 * Posé en attribut plutôt que branché après coup : l'image commence à charger dès que le navigateur
	 * la rencontre, et un 404 déjà en cache signalerait son échec avant qu'on ait eu le temps d'écouter.
	 * Les apostrophes sont écrites en entités pour ne pas fermer l'attribut.
	 */
	var PICTO_FALLBACK = "this.parentNode.className=&#39;line plain&#39;;this.parentNode.removeChild(this)";

	/**
	 * Le cartouche de la ligne, son nom commercial en clair derrière lui si l'image ne vient pas. Les
	 * images portent le bout de l'identifiant (« 07 »), le texte le nom qu'on lit sur le bus (« F7 »).
	 */
	function lineChip(code, name) {
		return "<span class='line'><img alt='' onerror='" + PICTO_FALLBACK + "' src='"
			+ LINE_CARTRIDGE + encodeURIComponent(code) + ".svg'>"
			+ "<span class='code'>" + escapeHtml(name) + "</span></span>";
	}

	function towardOf(row) {
		return row.headsigns.length ? "→ " + row.headsigns.join(" / ") : "sens " + row.directionId;
	}

	/** Le numéro de l'info trafic, s'il y en a une. */
	function perturbationRef(row) {
		return row.alertNumber !== null ? "<span class='ref'>" + escapeHtml(row.alertNumber) + "</span>" : "";
	}

	/** D'où vient la ligne : l'analyse, une saisie, ou une suggestion à trancher. Il suit ce qu'il qualifie. */
	function originBadge(row) {
		if (row.kind === "suggestion") return '<span class="badge off tag">suggestion</span>';
		return row.origin === "ai" ? '<span class="badge tag">auto</span>' : '<span class="badge tag">manuelle</span>';
	}

	/**
	 * Ce que la modification déclare, en un coup d'œil : ses tronçons, ses tracés si elle n'en vise
	 * qu'une partie, et qu'elle est invisible. Une suggestion ne déclare rien encore.
	 */
	function statusBadges(row) {
		if (row.kind === "suggestion") return "";

		var badges = [];
		if (row.disabled) badges.push('<span class="badge warn">invisible</span>');

		if (row.cancelledCount > 0) {
			badges.push('<span class="badge warn">' + row.cancelledCount
				+ (row.cancelledCount > 1 ? " départs annulés" : " départ annulé") + "</span>");
		}

		if (row.segmentCount === 0) {
			// Une modification qui ne fait qu'annuler des courses n'a pas de tronçon à déclarer.
			if (row.cancelledCount === 0) badges.push('<span class="badge off">sans tronçon</span>');
		} else if (row.publishableSegments < row.segmentCount) {
			badges.push('<span class="badge warn">incomplète</span>');
		} else {
			// Ce qu'il y a de plus parlant, et rien de plus : le nombre de tronçons quand il y en a
			// plusieurs, sinon ce que le tronçon annonce.
			var what = row.segmentCount > 1 ? row.segmentCount + " tronçons"
				: row.stopCount === 0 ? "tracé seul" : row.stopCount + " arrêts";
			badges.push('<span class="badge ok">' + what + "</span>");
		}

		if (row.patternCount > 0) badges.push('<span class="badge">' + row.patternCount + "/" + row.patternTotal + " tracés</span>");
		return badges.join(" ");
	}

	function countLabel(rows) {
		var suggestions = rows.filter(function (row) { return row.kind === "suggestion"; }).length;
		var modifications = rows.length - suggestions;
		var parts = [];
		if (modifications > 0) parts.push(modifications + (modifications > 1 ? " modifications" : " modification"));
		if (suggestions > 0) parts.push(suggestions + (suggestions > 1 ? " suggestions" : " suggestion"));
		return parts.join(" · ");
	}

	function loadList() {
		request(API + "/api/modifications").then(function (answer) {
			state.rows = answer.modifications.concat(answer.suggestions);
			renderList();
		}).catch(function (error) { alert(error.message); });
	}

	/** Les onglets de phase, chacun avec ce qu'il contient. */
	function renderPhases() {
		var tabs = el("phaseTabs");
		tabs.innerHTML = "";
		PHASES.forEach(function (phase) {
			var count = state.rows.filter(function (row) { return row.phase === phase[0]; }).length;
			var button = document.createElement("button");
			button.textContent = phase[1] + " (" + count + ")";
			button.className = state.phase === phase[0] ? "active" : "";
			button.onclick = function () {
				state.phase = phase[0];
				remember("modifications.phase", phase[0]);
				renderList();
			};
			tabs.appendChild(button);
		});
	}

	/**
	 * Le tableau, groupé et trié. Le serveur rend les lignes dans l'ordre du réseau ; les tris sont
	 * stables, et cet ordre tient donc partout où le tri choisi ne départage pas.
	 */
	function renderList() {
		renderPhases();

		var grouping = GROUPINGS[el("groupBy").value] || GROUPINGS.line;
		var sort = SORTS[el("sortBy").value] || SORTS.number;
		var visible = state.rows.filter(function (row) { return row.phase === state.phase; });

		// On n'agit que sur ce qu'on voit : ce qui a quitté l'onglet, ou la liste, se décoche.
		var shown = new Set(visible.map(rowId));
		Array.from(state.selected).forEach(function (id) { if (!shown.has(id)) state.selected.delete(id); });

		el("listCols").innerHTML = grouping.columns.map(function (column) {
			return "<col style='width:" + column[1] + "'>";
		}).join("");

		el("listHead").innerHTML = "<tr>" + grouping.columns.map(function (column) {
			var definition = COLUMNS[column[0]];
			if (definition.pick) return "<th class='pick'></th>";
			return "<th" + (definition.className === "num" ? " class='num'" : "") + ">" + definition.label + "</th>";
		}).join("") + "</tr>";
		var all = el("listHead").querySelector("th.pick");
		if (visible.length > 0) all.appendChild(pickBox(visible));

		var groups = new Map();
		visible.forEach(function (row) {
			var key = grouping.keyOf(row);
			var group = groups.get(key);
			if (group === undefined) groups.set(key, [row]);
			else group.push(row);
		});

		var ordered = Array.from(groups.values());
		if (grouping === GROUPINGS.alert) ordered.sort(function (a, b) { return sort(a[0], b[0]); });
		else ordered.forEach(function (rows) { rows.sort(sort); });

		var body = el("listBody");
		body.innerHTML = "";

		ordered.forEach(function (rows) {
			var head = document.createElement("tr");
			head.className = "group";
			head.innerHTML = "<td colspan='" + grouping.columns.length + "'><div class='bar'>"
				+ grouping.heading(rows) + "</div></td>";
			var bar = head.querySelector(".bar");
			bar.insertBefore(pickBox(rows), bar.firstChild);
			body.appendChild(head);

			rows.forEach(function (row) { body.appendChild(listRow(row, grouping)); });
		});

		el("listEmpty").className = visible.length === 0 ? "note" : "note hidden";
		renderBulk();
	}

	/** L'identifiant d'une ligne du tableau, pour la sélection. */
	function rowId(row) {
		return row.kind === "suggestion" ? "s:" + row.key : "m:" + row.uid;
	}

	/**
	 * Une case qui coche ou décoche d'un coup toutes ces lignes : une seule, un groupe, ou l'onglet
	 * entier. Cochée si toutes le sont, à moitié si quelques-unes.
	 */
	function pickBox(rows) {
		var ids = rows.map(rowId);
		var count = ids.filter(function (id) { return state.selected.has(id); }).length;
		var box = document.createElement("input");
		box.type = "checkbox";
		box.checked = count === ids.length;
		box.indeterminate = count > 0 && count < ids.length;
		box.onclick = function (event) {
			event.stopPropagation();
			ids.forEach(function (id) {
				if (box.checked) state.selected.add(id);
				else state.selected.delete(id);
			});
			renderList();
		};
		return box;
	}

	/** Les lignes cochées, telles que le tableau les connaît. */
	function selectedRows() {
		return state.rows.filter(function (row) { return state.selected.has(rowId(row)); });
	}

	/**
	 * La barre des actions de masse. Chaque bouton dit ce qu'il fera à la sélection : masquer ce qui est
	 * visible, afficher ce qui est masqué, supprimer les modifications — de l'IA ou saisies — et
	 * ignorer les suggestions.
	 */
	function renderBulk() {
		var rows = selectedRows();
		el("bulkBar").className = rows.length > 0 ? "bulk" : "bulk hidden";
		if (rows.length === 0) return;

		var modifications = rows.filter(function (row) { return row.kind === "modification"; });
		var hidden = modifications.filter(function (row) { return row.disabled; }).length;

		el("bulkCount").textContent = rows.length + (rows.length > 1 ? " cochées" : " cochée");
		el("bulkHide").disabled = modifications.length - hidden === 0;
		el("bulkShow").disabled = hidden === 0;
		el("bulkDiscard").textContent = modifications.length === 0 ? "Ignorer"
			: modifications.length === rows.length ? "Supprimer" : "Ignorer / supprimer";
	}

	/** Applique une action de masse aux lignes cochées, puis relit le tableau. */
	function bulk(action) {
		var rows = selectedRows();
		var modifications = rows.filter(function (row) { return row.kind === "modification"; });

		if (action === "discard") {
			var removed = modifications.length;
			var ignored = rows.length - removed;
			var parts = [];
			if (removed > 0) parts.push("supprimer " + removed + (removed > 1 ? " modifications" : " modification"));
			if (ignored > 0) parts.push("ignorer " + ignored + (ignored > 1 ? " suggestions" : " suggestion"));
			var fromAi = ignored + modifications.filter(function (row) { return row.origin === "ai"; }).length;
			var question = parts.join(" et ") + " ?";
			question = question.charAt(0).toUpperCase() + question.slice(1);
			if (fromAi > 0) question += "\n\nC'est définitif : l'IA ne recréera ni ne proposera ce qui vient d'elle.";
			if (!confirm(question)) return;
		}

		request(API + "/api/bulk", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				action: action,
				uids: modifications.map(function (row) { return row.uid; }),
				suggestions: rows.filter(function (row) { return row.kind === "suggestion"; }).map(function (row) { return row.key; })
			})
		}).then(function () {
			state.selected.clear();
			loadList();
		}).catch(function (error) { alert(error.message); });
	}

	/**
	 * Une ligne du tableau. Une modification s'ouvre d'un clic n'importe où sur la ligne — chaque
	 * cellule est un lien, qui s'ouvre aussi bien dans un autre onglet. Une suggestion n'a rien à
	 * ouvrir : elle s'accepte ou s'ignore. La première cellule coche la ligne, pour les actions de masse.
	 */
	function listRow(row, grouping) {
		var tr = document.createElement("tr");
		var href = row.kind === "modification" ? "#/modification/" + row.uid : null;
		tr.className = row.kind === "suggestion" ? "suggestion" : row.disabled ? "muted" : "";

		tr.innerHTML = grouping.columns.map(function (column) {
			var definition = COLUMNS[column[0]];
			if (definition.action) return "<td class='act'></td>";
			if (definition.pick) return "<td class='pick'></td>";
			var content = definition.cell(row);
			return "<td" + (definition.className ? " class='" + definition.className + "'" : "") + ">"
				+ (href === null ? content : "<a class='cell' href='" + href + "'>" + content + "</a>") + "</td>";
		}).join("");

		// Toute la cellule coche : la case seule est une cible bien petite.
		var pick = tr.querySelector("td.pick");
		var box = pickBox([row]);
		pick.appendChild(box);
		pick.onclick = function (event) { if (event.target !== box) box.click(); };

		var cell = tr.querySelector("td.act");
		if (row.kind === "suggestion") {
			cell.appendChild(actionButton("Accepter", "", function () { acceptSuggestion(row); }));
			cell.appendChild(actionButton("Ignorer", "danger", function () { dismissSuggestion(row); }));
		} else {
			var edit = document.createElement("a");
			edit.className = "button";
			edit.href = href;
			edit.textContent = "Éditer";
			cell.appendChild(edit);
			cell.appendChild(actionButton(row.disabled ? "Afficher" : "Masquer", "", function () {
				setVisible(row.uid, row.disabled).then(loadList).catch(function (error) { alert(error.message); });
			}));
			cell.appendChild(actionButton("Supprimer", "danger", function () {
				removeModification(row).then(function (done) { if (done) loadList(); });
			}));
		}

		return tr;
	}

	function actionButton(text, className, onclick) {
		var button = document.createElement("button");
		button.textContent = text;
		button.className = className;
		button.onclick = onclick;
		return button;
	}

	/** Accepte une suggestion, et ouvre la modification qu'elle devient. */
	function acceptSuggestion(row) {
		request(API + "/api/suggestions/" + encodeURIComponent(row.key) + "/accept", { method: "POST" })
			.then(function (created) { go("modification/" + created.uid); })
			.catch(function (error) { alert(error.message); });
	}

	function dismissSuggestion(row) {
		if (!confirm("Ignorer la suggestion " + row.line + " " + towardOf(row) + " de l'info trafic "
			+ row.alertNumber + " ?\n\nC'est définitif : l'IA ne la proposera plus.")) return;
		request(API + "/api/suggestions/" + encodeURIComponent(row.key) + "/dismiss", { method: "POST" })
			.then(loadList)
			.catch(function (error) { alert(error.message); });
	}

	/** Rend une modification visible ou invisible. */
	function setVisible(uid, visible) {
		return request(API + "/api/modifications/" + uid + "/visible", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ visible: visible })
		});
	}

	/**
	 * Supprime une modification, et tout ce qui y a été saisi. Celle de l'IA ne sera pas recréée.
	 * Résout à vrai si c'est fait.
	 */
	function removeModification(row) {
		var what = row.line + " " + towardOf(row);
		var question = "Supprimer la modification " + what + " et tout ce qui y a été saisi ?"
			+ (row.origin === "ai" ? "\n\nC'est définitif : l'IA ne la recréera pas." : "");
		if (!confirm(question)) return Promise.resolve(false);

		return request(API + "/api/modifications/" + row.uid, { method: "DELETE" })
			.then(function () { return true; })
			.catch(function (error) { alert(error.message); return false; });
	}

	function escapeHtml(text) {
		return String(text == null ? "" : text)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}

	/** Retient un réglage d'affichage d'une visite à l'autre — sans en dépendre : le stockage peut manquer. */
	function remember(key, value) {
		try { window.localStorage.setItem(key, value); } catch (error) { /* rien à retenir */ }
	}

	function recall(key) {
		try { return window.localStorage.getItem(key); } catch (error) { return null; }
	}

	// --- arrêts provisoires ---

	/**
	 * La base des arrêts provisoires, à part de toute déviation : c'est là qu'on en crée un d'avance,
	 * qu'on corrige un nom ou une position pour toutes les déviations qui le désignent, et qu'on retire
	 * ceux que plus rien ne désigne.
	 */
	function openStops() {
		request(API + "/api/provisional-stops").then(function (stops) {
			state.detail = null;
			state.provisionalStops = stops;
			showView("stops");

			if (state.stopsMap === null) {
				state.stopsMap = createMap("stopsMap");
				state.stopsLayer = L.layerGroup().addTo(state.stopsMap);
				state.stopsMap.on("click", onStopsMapClick);
			}

			setPlacing(false);
			renderStopsTable();
			drawProvisionalStops(true);
			setStopsStatus("");
			// Même raison que pour la carte du détail : Leaflet a mesuré un conteneur encore caché.
			setTimeout(function () { state.stopsMap.invalidateSize(); }, 0);
		}).catch(function (error) { alert(error.message); go(""); });
	}

	/** Relit la base après une écriture : un autre onglet a pu y toucher, et les usages avec. */
	function reloadStops(message) {
		return request(API + "/api/provisional-stops").then(function (stops) {
			state.provisionalStops = stops;
			renderStopsTable();
			drawProvisionalStops(false);
			if (message) setStopsStatus(message, "ok");
		});
	}

	function setStopsStatus(text, kind) {
		var status = el("stopsStatus");
		status.textContent = text;
		status.style.color = kind === "error" ? "var(--danger)" : kind === "ok" ? "var(--ok)" : "var(--muted)";
	}

	/** Les déviations qui désignent l'arrêt, chacune ouvrable quand sa perturbation est encore au flux. */
	function describeUsages(stop) {
		if (stop.usages.length === 0) return "<span class='note'>aucune</span>";

		return stop.usages.map(function (usage) {
			// La raison suit la ligne en clair : rien ne se lit au survol.
			var what = lineChip(usage.lineCode, usage.line) + "<span class='toward'>" + escapeHtml(towardOf(usage)) + "</span>"
				+ (usage.label ? "<span class='note' style='margin-left:6px'>" + escapeHtml(usage.label) + "</span>" : "");
			return usage.open
				? '<a class="usage" href="#/modification/' + usage.uid + '">' + what + "</a>"
				: '<span class="usage">' + what + "<span class='note' style='margin-left:6px'>(info trafic retombée)</span></span>";
		}).join("");
	}

	/** Minuscules et sans accents : « champ de mars » trouve « Champ-de-Mars (provisoire) ». */
	function searchable(text) {
		return String(text).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
	}

	/** Les tris du tableau des arrêts. Le numéro d'un arrêt provisoire suit l'ordre de création. */
	var STOP_SORTS = {
		name: function (a, b) { return a.name.localeCompare(b.name, "fr"); },
		recent: function (a, b) { return stopNumber(b) - stopNumber(a); },
		usages: function (a, b) { return b.usages.length - a.usages.length || a.name.localeCompare(b.name, "fr"); }
	};

	function stopNumber(stop) { return parseInt(stop.stopId.split(":").pop(), 10) || 0; }

	/** Le tableau des arrêts : ceux que la recherche retient, dans l'ordre choisi. */
	function renderStopsTable() {
		var body = el("stopsBody");
		body.innerHTML = "";

		var query = searchable(el("stopsQuery").value.trim());
		var stops = state.provisionalStops.filter(function (stop) {
			return query === "" || searchable(stop.name).indexOf(query) !== -1 || searchable(stop.stopId).indexOf(query) !== -1;
		}).sort(STOP_SORTS[el("stopsSort").value] || STOP_SORTS.name);

		stops.forEach(function (stop) {
			var tr = document.createElement("tr");
			tr.className = stop.stopId === state.selectedStop ? "selected" : "";
			tr.innerHTML =
				"<td>" + escapeHtml(stop.name)
					+ "<div class='note' style='font-size:12px'>" + escapeHtml(stop.stopId) + "</div></td>" +
				"<td class='act'></td>";

			var cell = tr.querySelector("td.act");
			cell.appendChild(actionButton("Modifier", "", function () { editProvisional(stop); }));
			cell.appendChild(actionButton("Supprimer", "danger", function () { deleteProvisional(stop); }));

			// Cliquer la ligne choisit l'arrêt : son marqueur passe au rouge, et la carte s'y centre.
			tr.onclick = function (event) {
				if (event.target.tagName === "BUTTON") return;
				selectStop(stop);
				state.stopsMap.setView([stop.latitude, stop.longitude], Math.max(state.stopsMap.getZoom(), 17));
			};

			body.appendChild(tr);
		});

		var empty = el("stopsEmpty");
		empty.textContent = state.provisionalStops.length === 0 ? "Aucun arrêt provisoire." : "Aucun arrêt ne correspond.";
		empty.className = stops.length === 0 ? "note" : "note hidden";
	}

	/** Le marqueur d'un arrêt provisoire : une épingle bleue, rouge pour l'arrêt choisi. */
	function stopPin(selected) {
		var color = selected ? "#d1242f" : "#1f6feb";
		return L.divIcon({
			className: "stopPin",
			html: '<svg width="24" height="36" viewBox="0 0 24 36"><path d="M12 1C5.9 1 1 5.9 1 12c0 8.3 11 23 11 23s11-14.7 11-23C23 5.9 18.1 1 12 1z" fill="'
				+ color + '" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" fill="#fff"/></svg>',
			iconSize: [24, 36],
			iconAnchor: [12, 35],
			tooltipAnchor: [12, -22]
		});
	}

	/** Choisit un arrêt : sa ligne ressort au tableau, son marqueur passe au rouge et au premier plan. */
	function selectStop(stop) {
		state.selectedStop = stop.stopId;
		Object.keys(state.stopMarkersById).forEach(function (stopId) {
			var marker = state.stopMarkersById[stopId];
			marker.setIcon(stopPin(stopId === stop.stopId));
			marker.setZIndexOffset(stopId === stop.stopId ? 1000 : 0);
		});
		renderStopsTable();
	}

	/**
	 * Un marqueur par arrêt, à glisser pour le déplacer. Le déplacement s'enregistre au lâcher : il
	 * vaut pour toutes les déviations qui désignent l'arrêt, et le tableau dit lesquelles.
	 */
	function drawProvisionalStops(fit) {
		state.stopsLayer.clearLayers();
		state.stopMarkersById = {};

		var bounds = [];
		state.provisionalStops.forEach(function (stop) {
			var selected = stop.stopId === state.selectedStop;
			var marker = L.marker([stop.latitude, stop.longitude], {
				draggable: true, icon: stopPin(selected), zIndexOffset: selected ? 1000 : 0
			})
				.bindTooltip(stop.name)
				.addTo(state.stopsLayer);

			marker.on("click", function () { selectStop(stop); });
			marker.on("dragend", function () {
				var position = marker.getLatLng();
				updateProvisional(stop, { name: stop.name, latitude: position.lat, longitude: position.lng })
					.catch(function (error) { setStopsStatus(error.message, "error"); });
			});

			state.stopMarkersById[stop.stopId] = marker;
			bounds.push([stop.latitude, stop.longitude]);
		});

		if (!fit) return;
		if (bounds.length > 0) state.stopsMap.fitBounds(L.latLngBounds(bounds).pad(.2), { maxZoom: 16 });
		else state.stopsMap.setView([49.443, 1.099], 12);
	}

	/**
	 * Enregistre le nom ou la position d'un arrêt. En cas d'échec, la carte revient à ce que la base
	 * retient, et l'erreur remonte à qui l'a demandé.
	 */
	function updateProvisional(stop, change) {
		return request(API + "/api/provisional-stops/" + encodeURIComponent(stop.stopId), {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(change)
		}).then(function () {
			var count = stop.usages.length;
			return reloadStops(count === 0
				? "Arrêt mis à jour."
				: "Arrêt mis à jour, pour " + count + (count > 1 ? " déviations." : " déviation."));
		}).catch(function (error) {
			// Le marqueur a déjà bougé : on le ramène à ce que la base retient.
			reloadStops();
			throw error;
		});
	}

	/**
	 * La boîte de dialogue, remplie pour l'occasion. Son « confirm » agit et renvoie une promesse : la boîte
	 * se ferme quand elle aboutit, et affiche l'erreur sinon — ce qui a été saisi reste là.
	 */
	function openDialog(options) {
		var dialog = el("dialog");
		el("dialogTitle").textContent = options.title;
		el("dialogBody").innerHTML = options.body;
		el("dialogStatus").textContent = "";
		el("dialogConfirm").textContent = options.confirmText;
		el("dialogConfirm").className = options.danger ? "danger" : "primary";
		el("dialogConfirm").disabled = false;

		el("dialogForm").onsubmit = function (event) {
			event.preventDefault();
			el("dialogConfirm").disabled = true;
			options.confirm().then(function () {
				dialog.close();
			}).catch(function (error) {
				el("dialogConfirm").disabled = false;
				el("dialogStatus").textContent = error.message;
				el("dialogStatus").style.color = "var(--danger)";
			});
		};

		dialog.showModal();
		var first = el("dialogBody").querySelector("input");
		if (first) first.select();
	}

	/** Les modifications qui désignent l'arrêt, telles que les dialogues les listent. */
	function usagesBlock(stop, intro) {
		if (stop.usages.length === 0) return "<p class='note'>Aucune modification ne le désigne.</p>";
		return "<p class='note' style='margin-bottom:4px'>" + intro + "</p>" + describeUsages(stop);
	}

	/**
	 * Renomme l'arrêt. Le nouveau nom vaut pour toutes les modifications qui le désignent ; la position
	 * se change en glissant le marqueur.
	 */
	function editProvisional(stop) {
		openDialog({
			title: "Modifier l'arrêt provisoire",
			body: "<div class='field'><label>Nom</label><input id='dialogName' autocomplete='off' value='"
				+ escapeHtml(stop.name).replace(/'/g, "&#39;") + "'></div>"
				+ usagesBlock(stop, "Le nouveau nom vaudra pour :"),
			confirmText: "Enregistrer",
			confirm: function () {
				var name = el("dialogName").value.trim();
				if (name.length === 0) return Promise.reject(new Error("Le nom de l'arrêt est obligatoire."));
				return updateProvisional(stop, { name: name, latitude: stop.latitude, longitude: stop.longitude });
			}
		});
	}

	/**
	 * Supprime l'arrêt, et le retire de toutes les déviations qui le désignent. Le dialogue les
	 * nomme : c'est le moment de voir qu'on s'apprête à toucher à une déviation publiée.
	 */
	function deleteProvisional(stop) {
		openDialog({
			title: "Supprimer « " + stop.name + " » ?",
			body: usagesBlock(stop, "Il sera retiré de :"),
			confirmText: "Supprimer",
			danger: true,
			confirm: function () {
				return request(API + "/api/provisional-stops/" + encodeURIComponent(stop.stopId), { method: "DELETE" })
					.then(function (answer) {
						return reloadStops(answer.withdrawn > 0
							? "Arrêt supprimé, et retiré de " + answer.withdrawn
								+ (answer.withdrawn > 1 ? " déviations." : " déviation.")
							: "Arrêt supprimé.");
					});
			}
		});
	}

	/** La pose d'un nouvel arrêt : le nom d'abord, puis un clic sur la carte pour sa position. */
	function setPlacing(placing) {
		state.placingStop = placing;
		el("placeNewStop").className = placing ? "active" : "";
		el("placeNewStop").textContent = placing ? "Annuler la pose" : "Poser sur la carte";
		if (state.stopsMap) state.stopsMap.getContainer().style.cursor = placing ? "crosshair" : "";
	}

	function onStopsMapClick(event) {
		if (!state.placingStop) return;

		var name = el("newStopName").value.trim();
		request(API + "/api/provisional-stops", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ name: name, latitude: event.latlng.lat, longitude: event.latlng.lng })
		}).then(function () {
			el("newStopName").value = "";
			setPlacing(false);
			return reloadStops("Arrêt « " + name + " » créé.");
		}).catch(function (error) { setStopsStatus(error.message, "error"); });
	}

	// --- création ---

	/**
	 * Les champs d'une période : une date de début, une date de fin, et leurs heures, toutes
	 * facultatives dans la saisie — c'est le serveur qui exige le début quand il n'y a pas d'info
	 * trafic à suivre. Une heure de fin sans date de fin ne voudrait rien dire, et son champ reste
	 * grisé tant qu'il en manque. Renvoie de quoi les relire, dans la forme que le serveur attend.
	 */
	function periodFields(container, period, hint, inherited) {
		container.innerHTML =
			'<div class="field"><label>Début</label><input type="date" class="startDate">' +
				'<input type="time" class="startTime"></div>' +
			'<div class="field"><label>Fin</label><input type="date" class="endDate">' +
				'<input type="time" class="endTime"></div>' +
			'<p class="note hint"></p>';

		function field(name) { return container.querySelector("." + name); }

		field("startDate").value = period ? period.start.date : "";
		field("startTime").value = period && period.start.time ? period.start.time : "";
		field("endDate").value = period && period.end ? period.end.date : "";
		field("endTime").value = period && period.end && period.end.time ? period.end.time : "";
		field("hint").textContent = hint;

		// Ce que la période suit quand on la laisse vide, en indication dans les champs — jamais en valeur.
		// Un champ de date n'affiche pas d'indication : vide, il se fait champ de texte, et redevient
		// champ de date dès qu'on y entre.
		if (inherited) {
			[["startDate", inherited.start.date], ["startTime", inherited.start.time],
				["endDate", inherited.end.date], ["endTime", inherited.end.time]].forEach(function (entry) {
				var input = field(entry[0]);
				var type = input.type;
				if (!entry[1]) return;
				input.placeholder = entry[1];
				var sync = function () { input.type = input.value === "" && document.activeElement !== input ? "text" : type; };
				input.addEventListener("focus", sync);
				input.addEventListener("blur", sync);
				sync();
			});
		}

		function syncEnd() {
			field("endTime").disabled = field("endDate").value === "";
			if (field("endTime").disabled) field("endTime").value = "";
		}
		field("endDate").oninput = syncEnd;
		syncEnd();

		return function () {
			return {
				start: field("startDate").value === "" ? null : { date: field("startDate").value, time: field("startTime").value },
				end: field("endDate").value === "" ? null : { date: field("endDate").value, time: field("endTime").value }
			};
		};
	}

	/**
	 * Les bornes que suit une période laissée vide, telles que les champs les affichent : le début de
	 * la première période de l'info trafic, la fin de la dernière.
	 */
	function inheritedBounds(periods) {
		function split(value) {
			var match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(value || "");
			return match === null ? { date: null, time: null }
				: { date: match[3] + "/" + match[2] + "/" + match[1], time: match[4] || null };
		}
		var first = periods[0], last = periods[periods.length - 1];
		return { start: split(first && first.start), end: split(last && last.end) };
	}

	/** Ce que la période devient quand on ne la saisit pas. */
	function periodHint(attached) {
		return attached
			? "Laisser vide pour suivre les dates de l'info trafic. Heures facultatives."
			: "Date de début obligatoire. Heures facultatives ; sans fin, la période reste ouverte.";
	}

	/**
	 * Le formulaire de création : l'info trafic de rattachement s'il y en a une, la ligne, le sens, les
	 * tracés, la raison et la période. Les arrêts supprimés et les tronçons se saisissent ensuite.
	 */
	function openNew() {
		Promise.all([request(API + "/api/routes"), request(API + "/api/alerts")]).then(function (answers) {
			state.routes = answers[0];
			state.alerts = answers[1];
			state.detail = null;
			showView("new");

			var alerts = el("newAlert");
			alerts.innerHTML = "<option value=''>— aucune —</option>" + state.alerts.map(function (alert) {
				return "<option value='" + escapeHtml(alert.alertNumber) + "'>" + escapeHtml(alert.alertNumber + " — " + alert.headerText) + "</option>";
			}).join("");
			alerts.onchange = renderNewAlert;

			var routes = el("newRoute");
			routes.innerHTML = state.routes.map(function (route, index) {
				return "<option value='" + index + "'>Ligne " + escapeHtml(route.line) + "</option>";
			}).join("");
			routes.onchange = renderNewDirections;

			el("newLabel").value = "";
			state.readNewPeriod = periodFields(el("newPeriod"), null, periodHint(false));
			renderNewAlert();
			renderNewDirections();
			el("newStatus").textContent = "";
		}).catch(function (error) { alert(error.message); go(""); });
	}

	/** Rattachée à une info trafic, la raison et la période s'en héritent : les champs le disent. */
	function renderNewAlert() {
		var number = el("newAlert").value;
		var attached = state.alerts.filter(function (alert) { return alert.alertNumber === number; })[0];
		el("newLabel").placeholder = attached ? attached.headerText : "obligatoire";
		el("newPeriod").querySelector(".hint").textContent = periodHint(attached !== undefined)
			+ (attached ? " Info trafic : " + describePeriods(attached.periods) + "." : "");
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
		select.onchange = renderNewPatterns;
		renderNewPatterns();
	}

	/** Les tracés du sens choisi, tous cochés : c'est le cas courant, et le seul qui survit à un GTFS neuf. */
	function renderNewPatterns() {
		var direction = newDirection();
		el("newPatterns").innerHTML = (direction ? direction.patterns : []).map(function (pattern) {
			return "<div><input type='checkbox' checked value='" + escapeHtml(pattern.patternId) + "'>"
				+ "<span class='name'>" + escapeHtml(pattern.label) + "</span></div>";
		}).join("");
	}

	function newDirection() {
		var route = state.routes[parseInt(el("newRoute").value, 10)];
		var directionId = parseInt(el("newDirection").value, 10);
		return route ? route.directions.filter(function (direction) { return direction.directionId === directionId; })[0] : undefined;
	}

	/**
	 * Crée la modification, puis ouvre son édition. L'adresse de création est REMPLACÉE : le retour du
	 * navigateur ramène à la liste, et non à un formulaire qui en créerait une seconde.
	 */
	function createModification() {
		var route = state.routes[parseInt(el("newRoute").value, 10)];
		var direction = newDirection();
		if (!route || !direction) return;

		var checked = Array.prototype.map.call(el("newPatterns").querySelectorAll("input:checked"), function (input) {
			return input.value;
		});
		var status = el("newStatus");
		if (checked.length === 0) {
			status.textContent = "Cocher au moins un tracé.";
			status.style.color = "var(--danger)";
			return;
		}

		var period = state.readNewPeriod();
		var body = {
			alertNumber: el("newAlert").value || null,
			routeId: route.routeId,
			directionId: direction.directionId,
			patternIds: checked.length === direction.patterns.length ? [] : checked,
			label: el("newLabel").value,
			start: period.start,
			end: period.end
		};

		status.textContent = "Création…";
		status.style.color = "var(--muted)";
		request(API + "/api/modifications", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body)
		}).then(function (created) {
			window.location.replace("#/modification/" + created.uid);
		}).catch(function (error) {
			status.textContent = error.message;
			status.style.color = "var(--danger)";
		});
	}

	// --- édition ---

	/** Un arrêt tel que le serveur le rend, ramené à ce que l'éditeur manipule. */
	function adoptStop(stop) {
		return {
			stopId: stop.stopId, provisional: stop.provisional, name: stop.name,
			latitude: stop.latitude, longitude: stop.longitude, travelTime: stop.travelTime
		};
	}

	/**
	 * Un tronçon tel que le serveur le rend, ramené à ce que l'éditeur manipule. Le serveur en propose
	 * toujours au moins un : à défaut de tronçon enregistré, les suites d'arrêts supprimés en dessinent
	 * autant qu'il y a d'interruptions sur l'itinéraire.
	 */
	function adoptSegment(segment) {
		var adopted = {
			startStopId: segment.startStopId, endStopId: segment.endStopId,
			propagatedDelay: segment.propagatedDelay,
			stops: segment.stops.map(adoptStop),
			path: segment.path.map(asPair),
			waypoints: [], legs: [],
			publishable: segment.publishable,
			tripsByPattern: segment.tripsByPattern || {}
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

	function openDetail(uid) {
		request(API + "/api/modifications/" + encodeURIComponent(uid)).then(function (detail) {
			state.active = 0;
			// La base provisoire a pu changer ailleurs depuis : elle se relira au prochain ajout.
			state.allStops = null;
			state.focusPattern = null;
			// L'accrochage aux rues est ce qu'on veut presque toujours ; le dessin libre reste à un clic.
			state.pen = detail.roadRouting ? "route" : "free";

			showView("detail");
			adoptDetail(detail, true);
			setStatus("");
		}).catch(function (error) {
			// Une adresse qui ne désigne plus rien — modification supprimée, info trafic retombée, lien
			// d'hier : on le dit, et on repart de la liste plutôt que de laisser un écran vide.
			// L'adresse fautive est REMPLACÉE, sans quoi le retour du navigateur y ramènerait aussitôt.
			alert(error.message);
			window.location.replace("#/");
		});
	}

	/**
	 * Prend pour état courant le détail que le serveur rend. Tout ce qui s'affiche en dépend. La carte
	 * ne se recadre qu'à l'ouverture : après un enregistrement, on reste où l'on regardait.
	 */
	function adoptDetail(detail, fit) {
		state.detail = detail;
		state.patterns = checkedPatterns(detail.patternIds);
		// Des tracés nommés que le GTFS ne connaît plus : on le dit, et on ne les coche pas.
		state.stalePatterns = detail.patternIds.length === 0 ? 0 : detail.patternIds.length - state.patterns.length;
		state.removed = detail.removedFromAnalysis ? null : detail.removedStopIds.slice();
		state.removedEditing = false;
		state.cancelled = detail.cancelledDepartures.map(function (entry) {
			return { stopId: entry.stopId, departure: entry.departure };
		});
		state.segments = detail.segments.map(adoptSegment);
		if (state.segments.length === 0) state.segments = [emptySegment()];
		state.active = Math.max(0, Math.min(state.active, state.segments.length - 1));

		applyRemoved();
		renderHeading();
		renderHeader();
		renderRemoved();
		renderCancelled();
		renderPublication();
		setupMap(fit);
		renderSegment();
	}

	function emptySegment() {
		return {
			startStopId: null, endStopId: null, propagatedDelay: 0, stops: [],
			waypoints: [], legs: [], path: [], tripsByPattern: {}
		};
	}

	// --- tracés empruntés ---

	/**
	 * Les tracés cochés, d'après ce que le serveur en retient : aucun tracé nommé veut dire tous.
	 * L'éditeur, lui, tient toujours la liste explicite — c'est ce que montrent les cases.
	 */
	function checkedPatterns(patternIds) {
		var known = state.detail.patterns.map(function (pattern) { return pattern.patternId; });
		if (!patternIds || patternIds.length === 0) return known;
		return patternIds.filter(function (patternId) { return known.indexOf(patternId) !== -1; });
	}

	/** Les tracés que vise la modification, dans l'ordre du serveur — les plus longs d'abord. */
	function modPatterns() {
		return state.detail.patterns.filter(function (pattern) {
			return state.patterns.indexOf(pattern.patternId) !== -1;
		});
	}

	/** Les courses que le tronçon modifierait : celles des tracés cochés qui desservent ses bornes. */
	function matchingTrips(segment) {
		return state.patterns.reduce(function (total, patternId) {
			return total + (segment.tripsByPattern[patternId] || 0);
		}, 0);
	}

	/** Le tracé mis en avant : celui qu'on a cliqué, sinon le premier que vise la modification. */
	function focusedPattern() {
		var patterns = state.detail.patterns;
		var clicked = patterns.filter(function (pattern) { return pattern.patternId === state.focusPattern; })[0];
		return clicked || modPatterns()[0] || patterns[0] || null;
	}

	/**
	 * Les tracés du sens, à cocher. Le nom se clique pour mettre le tracé en avant sur la carte ; le
	 * compte dit combien de courses de chacun les bornes du tronçon actif désignent.
	 */
	function renderPatterns() {
		var segment = seg();
		var list = el("patternList");
		var focused = focusedPattern();
		var bounded = segment.startStopId !== null && segment.endStopId !== null;
		list.innerHTML = "";

		state.detail.patterns.forEach(function (pattern) {
			var row = document.createElement("div");

			var input = document.createElement("input");
			input.type = "checkbox";
			input.checked = state.patterns.indexOf(pattern.patternId) !== -1;
			input.onchange = function () {
				var chosen = state.patterns.filter(function (patternId) { return patternId !== pattern.patternId; });
				if (input.checked) chosen.push(pattern.patternId);
				// L'ordre des cases, pas celui des clics : c'est lui qui départage les tracés ensuite.
				state.patterns = state.detail.patterns
					.map(function (candidate) { return candidate.patternId; })
					.filter(function (patternId) { return chosen.indexOf(patternId) !== -1; });
				state.stalePatterns = 0;
				renderRemoved();
				renderCancelled();
				renderSegment();
			};

			var name = document.createElement("span");
			name.className = focused && focused.patternId === pattern.patternId ? "name focused" : "name";
			name.textContent = pattern.label;
			name.onclick = function () {
				state.focusPattern = pattern.patternId;
				renderPatterns();
				styleShapes();
				renderPath();
			};

			var count = document.createElement("span");
			count.className = "count";
			var trips = segment.tripsByPattern[pattern.patternId] || 0;
			count.textContent = !bounded ? "" : trips > 0 ? trips + " courses" : "ne dessert pas ces bornes";

			row.appendChild(input);
			row.appendChild(name);
			row.appendChild(count);
			list.appendChild(row);
		});

		var note = el("patternNote");
		if (state.stalePatterns > 0) {
			note.textContent = state.stalePatterns + " tracé(s) visé(s) ont disparu du GTFS : cocher ceux que la modification vise.";
			note.style.color = "var(--warn)";
		} else if (state.patterns.length === 0) {
			note.textContent = "Aucun tracé coché : la modification ne vise aucune course.";
			note.style.color = "var(--danger)";
		} else {
			note.textContent = bounded ? "Courses d'ici la fin du service entre les bornes du tronçon " + (state.active + 1) + "." : "";
			note.style.color = "var(--muted)";
		}
	}

	/**
	 * Les itinéraires d'origine sur la carte : ceux que vise la modification en avant, les autres en
	 * retrait, et le tracé mis en avant plus épais — c'est sur lui que porte l'aperçu.
	 */
	function styleShapes() {
		var targeted = {};
		modPatterns().forEach(function (pattern) { targeted[pattern.shapeId] = true; });
		var focused = focusedPattern();

		Object.keys(state.shapeLayers).forEach(function (shapeId) {
			var main = focused !== null && focused.shapeId === shapeId;
			state.shapeLayers[shapeId].setStyle({
				color: main ? "#57606a" : "#8b949e",
				weight: main ? 6 : 4,
				opacity: targeted[shapeId] || main ? .7 : .2
			});
		});
	}

	// --- tronçons ---

	/** Tout ce qui dépend du tronçon actif, d'un bloc : on ne repeint jamais l'un sans les autres. */
	function renderSegment() {
		renderPen();
		renderSegments();
		renderPatterns();
		styleShapes();
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
	 * Même règle que le serveur (cf. removesStops), sur les tracés que le tronçon vise.
	 */
	function removesStops(segment) {
		if (segment.startStopId === null || segment.endStopId === null) return false;
		if (state.detail.removedStopIds.length === 0) return false;

		var removed = false;
		modPatterns().forEach(function (pattern) {
			var sequence = pattern.sequence;
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
		add.textContent = "+ Ajouter";
		add.onclick = function () {
			state.segments.push(emptySegment());
			selectSegment(state.segments.length - 1);
		};
		bar.appendChild(add);

		el("segmentFoot").className = state.segments.length > 1 ? "actions divided" : "actions divided hidden";

		// À un seul tronçon il n'y a rien à dire : la barre le montre déjà.
		el("segmentNote").textContent = state.segments.length === 1
			? ""
			: state.segments.length + " tronçons, publiés ensemble sur chaque course.";
	}

	function selectSegment(index) {
		state.active = index;
		state.focusPattern = null;
		setMode("idle");
		renderSegment();
	}

	/**
	 * Le nombre de courses que les bornes retenues modifieraient. À zéro, rien ne sortira dans le feed
	 * — pas même les arrêts de substitution : c'est le signe que les bornes ne figurent sur l'horaire
	 * théorique d'aucune course de la ligne.
	 */
	function renderTripCount() {
		var count = matchingTrips(seg());
		var note = el("tripCount");
		note.textContent = count > 0
			? count + " courses concernées d'ici la fin du service."
			: state.patterns.length === 0
				? "Aucun tracé coché : ce tronçon ne sera pas publié."
				: "Aucune course des tracés cochés ne dessert ces bornes : ce tronçon ne sera pas publié.";
		note.style.color = count === 0 ? "var(--danger)" : "var(--muted)";
	}

	/**
	 * Recompte les courses auprès du serveur après un changement de borne. Le compte du chargement ne
	 * vaut que pour les bornes d'alors, et c'est lui qui dit si le tronçon sortira du feed.
	 */
	function refreshTripCount() {
		var segment = seg();
		if (segment.startStopId === null || segment.endStopId === null) {
			segment.tripsByPattern = {};
			renderTripCount();
			renderPatterns();
			return;
		}

		clearTimeout(state.countTimer);
		state.countTimer = setTimeout(function () {
			var url = API + "/api/modifications/" + state.detail.uid + "/trip-count"
				+ "?start=" + encodeURIComponent(segment.startStopId) + "&end=" + encodeURIComponent(segment.endStopId);
			// Le compte revient par tracé, qu'il soit coché ou non : cocher ou décocher n'a alors plus
			// rien à redemander, et chaque case dit si son tracé dessert ces bornes.
			request(url).then(function (answer) {
				segment.tripsByPattern = answer.tripsByPattern;
				if (seg() !== segment) return;
				renderTripCount();
				renderPatterns();
			}).catch(function (error) { setStatus(error.message, "error"); });
		}, 150);
	}

	// --- arrêts supprimés ---

	/** Le libellé d'un arrêt de la ligne, d'après les tracés que le détail porte. */
	function stopNameOf(stopId) {
		var found = stopId;
		state.detail.patterns.forEach(function (pattern) {
			pattern.sequence.forEach(function (stop) { if (stop.stopId === stopId) found = stop.name; });
		});
		return found;
	}

	/** Les arrêts supprimés tels que l'éditeur les tient : saisis, ou, à défaut, ceux de l'analyse. */
	function currentRemoved() {
		return state.removed !== null ? state.removed : state.detail.analysisStopIds;
	}

	/**
	 * Reporte les arrêts supprimés sur les tracés du détail : la carte les dessine en rouge, les listes
	 * de bornes les marquent, et c'est d'eux que se lit ce que supprime un tronçon.
	 */
	function applyRemoved() {
		var removed = {};
		currentRemoved().forEach(function (stopId) { removed[stopId] = true; });
		state.detail.patterns.forEach(function (pattern) {
			pattern.sequence.forEach(function (stop) { stop.removed = removed[stop.stopId] === true; });
		});
		state.detail.removedStopIds = currentRemoved().slice();
	}

	/**
	 * Les arrêts que la modification supprime. Rattachée à une info trafic, elle suit l'analyse tant
	 * qu'on ne les saisit pas ; la saisie fait foi ensuite, y compris vide — et se rend à l'analyse
	 * d'un clic. Sans info trafic, ils sont toujours saisis.
	 */
	function renderRemoved() {
		var detail = state.detail;
		var attached = detail.alertNumber !== null;
		var summary = el("removedSummary");
		var picker = el("removedPicker");
		var actions = el("removedActions");
		picker.innerHTML = "";
		actions.innerHTML = "";

		// Seuls comptent les arrêts que desservent les tracés visés : l'analyse porte tous les quais d'un
		// nom, y compris ceux d'autres lignes ou de l'autre sens, qui ne suppriment rien ici.
		var onCourse = {};
		routeStops(modPatterns()).forEach(function (stop) { onCourse[stop.stopId] = true; });
		var names = currentRemoved()
			.filter(function (stopId) { return onCourse[stopId] === true; })
			.map(stopNameOf);
		summary.innerHTML = (!attached ? ""
			: state.removed === null ? '<span class="badge ok">selon l\'analyse</span> '
			: '<span class="badge warn">saisis</span> ')
			+ (names.length === 0
				? "Aucun arrêt supprimé : seul le chemin peut changer."
				: names.length + (names.length > 1 ? " arrêts supprimés : " : " arrêt supprimé : ")
					+ escapeHtml(names.join(", ")) + ".");

		if (attached && !state.removedEditing) {
			actions.appendChild(actionButton("Modifier", "", function () {
				if (state.removed === null) state.removed = detail.analysisStopIds.slice();
				state.removedEditing = true;
				onRemovedChanged();
			}));
		} else {
			var box = document.createElement("div");
			box.className = "picker";
			routeStops().forEach(function (stop) {
				var label = document.createElement("label");
				var input = document.createElement("input");
				input.type = "checkbox";
				input.checked = state.removed.indexOf(stop.stopId) !== -1;
				input.onchange = function () {
					state.removed = state.removed.filter(function (stopId) { return stopId !== stop.stopId; });
					if (input.checked) state.removed.push(stop.stopId);
					onRemovedChanged();
				};
				label.appendChild(input);
				label.appendChild(document.createTextNode(stop.name));
				box.appendChild(label);
			});
			picker.appendChild(box);
		}

		if (attached && state.removed !== null) {
			actions.appendChild(actionButton("Suivre l'analyse", "", function () {
				state.removed = null;
				state.removedEditing = false;
				onRemovedChanged();
			}));
		}
	}

	/** Un horaire GTFS en secondes depuis minuit : « 17:05 », et « 01:10 +1 » passé minuit. */
	function formatDeparture(seconds) {
		var minutes = Math.floor(seconds / 60);
		var hours = Math.floor(minutes / 60);
		var text = String(hours % 24).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
		return hours >= 24 ? text + " +1" : text;
	}

	function departureKey(entry) { return entry.stopId + "|" + entry.departure; }

	/**
	 * Les départs à annuler, chaque jour de la période où ils circulent : ceux des tracés cochés, et
	 * ceux déjà annulés que la liste ne montrerait plus — un tracé décoché, une période qui a changé.
	 */
	function renderCancelled() {
		var detail = state.detail;
		var picker = el("cancelPicker");
		var actions = el("cancelActions");
		picker.innerHTML = "";
		actions.innerHTML = "";

		var cancelled = {};
		state.cancelled.forEach(function (entry) { cancelled[departureKey(entry)] = true; });

		var listed = {};
		var rows = detail.departures.filter(function (entry) {
			var shown = entry.patternIds.some(function (patternId) { return state.patterns.indexOf(patternId) !== -1; });
			if (shown) listed[departureKey(entry)] = true;
			return shown;
		});
		state.cancelled.forEach(function (entry) {
			if (listed[departureKey(entry)]) return;
			rows.push({ stopId: entry.stopId, departure: entry.departure, name: stopNameOf(entry.stopId), headsign: "" });
		});
		rows.sort(function (a, b) { return a.departure - b.departure; });

		var count = state.cancelled.length;
		el("cancelSummary").textContent = count === 0 ? "Aucune course annulée."
			: count + (count > 1 ? " départs annulés" : " départ annulé") + ", chaque jour de la période.";

		if (rows.length === 0) {
			el("cancelSummary").textContent += " Aucun départ sur la période.";
			return;
		}

		var box = document.createElement("div");
		box.className = "picker";
		rows.forEach(function (entry) {
			var label = document.createElement("label");
			var input = document.createElement("input");
			input.type = "checkbox";
			input.checked = cancelled[departureKey(entry)] === true;
			input.onchange = function () {
				setCancelled([entry], input.checked);
			};
			label.appendChild(input);
			label.appendChild(document.createTextNode(formatDeparture(entry.departure) + "  " + entry.name
				+ (entry.headsign ? " → " + entry.headsign : "")));
			box.appendChild(label);
		});
		picker.appendChild(box);

		actions.appendChild(actionButton("Tout cocher", "", function () { setCancelled(rows, true); }));
		actions.appendChild(actionButton("Tout décocher", "", function () { setCancelled(rows, false); }));
	}

	/** Annule ou rétablit ces départs. */
	function setCancelled(entries, cancel) {
		var keys = {};
		entries.forEach(function (entry) { keys[departureKey(entry)] = true; });
		state.cancelled = state.cancelled.filter(function (entry) { return !keys[departureKey(entry)]; });
		if (cancel) {
			entries.forEach(function (entry) { state.cancelled.push({ stopId: entry.stopId, departure: entry.departure }); });
		}
		renderCancelled();
	}

	/** Un arrêt coché ou décoché : la carte et le tronçon actif se relisent aussitôt. */
	function onRemovedChanged() {
		applyRemoved();
		renderRemoved();
		drawRouteStops();
		renderSegment();
	}

	// --- en-tête et publication ---

	/** Où en est la période : ce qui court, ce qui vient, ce qui est fini. */
	function phaseBadge(row) {
		if (row.phase === "current") return '<span class="badge ok">en cours</span>';
		if (row.phase === "ended") return '<span class="badge off">terminée</span>';
		return '<span class="badge off">à venir</span>';
	}

	/** La ligne, le sens, l'origine, l'état — et l'info trafic de rattachement, son texte replié. */
	function renderHeading() {
		var detail = state.detail;
		var heading = "<div class='heading'>" + lineChip(detail.lineCode, detail.line)
			+ "<span class='toward'>" + escapeHtml(towardOf(detail)) + "</span>"
			+ "<span class='badges'><div>" + (detail.disabled ? '<span class="badge warn">invisible</span>' : "")
			+ phaseBadge(detail) + "</div><div>" + originBadge(detail) + "</div></span></div>";

		// Le texte de l'info trafic est long, plans compris : il se déplie à la demande.
		el("summary").innerHTML = heading + (detail.alertNumber === null
			? "<p class='note' style='margin:0 0 8px'>Sans info trafic.</p>"
			: "<p style='margin:0 0 4px'>" + perturbationRef(detail) + "<strong>" + escapeHtml(detail.alertHeader) + "</strong></p>"
				+ "<details><summary>Texte de l'info trafic</summary><div class='richtext'>" + detail.alertDescriptionHtml + "</div></details>");
	}

	/** La raison et la période : saisies, ou héritées de l'info trafic — ce que disent les champs vides. */
	function renderHeader() {
		var detail = state.detail;
		var attached = detail.alertNumber !== null;
		el("label").value = detail.labelInput || "";
		el("label").placeholder = attached ? detail.alertHeader : "obligatoire";
		state.readPeriod = periodFields(el("period"), detail.periodInput, periodHint(attached)
			+ (attached ? " Info trafic : " + describePeriods(detail.alertPeriods) + "." : ""),
			attached ? inheritedBounds(detail.alertPeriods) : null);
		renderPatterns();
	}

	/** Les deux actions qui ne passent pas par l'enregistrement : la visibilité, et la suppression. */
	function renderPublication() {
		var detail = state.detail;
		el("toggleVisible").textContent = detail.disabled ? "Afficher" : "Masquer";
		el("remove").textContent = "Supprimer";
	}

	/**
	 * La visibilité s'applique tout de suite, sans enregistrer le reste : ce qui est en cours de saisie
	 * reste où il est.
	 */
	function toggleVisible() {
		var visible = state.detail.disabled;
		setVisible(state.detail.uid, visible).then(function () {
			state.detail.disabled = !visible;
			renderHeading();
			renderPublication();
			setStatus(visible ? "Visible : publiée pendant sa période." : "Invisible : plus rien n'est publié.", "ok");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	function remove() {
		removeModification(state.detail).then(function (done) { if (done) go(""); });
	}

	/**
	 * Les arrêts de ces tracés — de tous ceux du sens, à défaut —, dédoublonnés, dans l'ordre du premier
	 * tracé qui les voit.
	 */
	function routeStops(patterns) {
		var seen = {}, stops = [];
		(patterns || state.detail.patterns).forEach(function (pattern) {
			pattern.sequence.forEach(function (stop) {
				if (seen[stop.stopId]) return;
				seen[stop.stopId] = true;
				stops.push(stop);
			});
		});
		return stops;
	}

	/**
	 * L'arrêt d'où se comptent les temps de parcours : celui qui précède la borne amont sur le premier
	 * des tracés visés qui la dessert. Rien lorsque la borne ouvre l'itinéraire — la référence est
	 * alors cette borne même, et les temps peuvent être négatifs.
	 */
	function referenceOf(segment) {
		var startStopId = segment.startStopId;
		var found = null;
		modPatterns().forEach(function (pattern) {
			var sequence = pattern.sequence;
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
		var stops = routeStops(modPatterns());

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

			// Une borne qu'aucun tracé coché ne dessert reste affichée : elle est toujours enregistrée, et
			// la laisser disparaître de la liste ferait croire qu'elle a été vidée.
			var current = segment[pair[1]];
			if (current && !stops.some(function (stop) { return stop.stopId === current; })) {
				var stray = document.createElement("option");
				stray.value = current;
				stray.textContent = "⚠ " + stopNameOf(current) + " (hors des tracés cochés)";
				select.appendChild(stray);
			}

			select.value = segment[pair[1]] || "";
			select.onchange = function (event) {
				segment[pair[1]] = event.target.value || null;
				renderBounds();
				renderStops();
				renderSegments();
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

		var reference = referenceOf(segment);
		if (!reference) return "Temps comptés depuis <strong>le premier arrêt de la course</strong> : ils peuvent être négatifs.";

		var note = "Temps comptés depuis l'arrivée à <strong>" + escapeHtml(reference.name) + "</strong>.";

		// Un tronçon dont la référence est supprimée par un autre lui sera fusionné à la publication, et
		// ses temps recomptés depuis la référence de celui-là — le consommateur n'a plus d'arrêt où
		// rattacher les siens. Autant le dire ici : les temps saisis ne sont pas ceux qui sortiront.
		var upstream = mergedInto(segment);
		if (upstream === null) return note;

		var root = referenceOf(state.segments[upstream]);
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
			var reference = referenceOf(current);
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

	/** Une carte du réseau, fond OpenStreetMap. Il y en a deux : celle du détail, celle des arrêts. */
	function createMap(id) {
		var map = L.map(id);
		L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
			maxZoom: 19, attribution: "© OpenStreetMap"
		}).addTo(map);
		return map;
	}

	/**
	 * Met un arrêt en lumière : un large anneau autour de lui, et son nom, au centre de la carte. Le
	 * zoom ne bouge pas : on voit l'arrêt au milieu de ce qu'on regardait, et non en bordure.
	 *
	 * La vue d'avant est retenue, pour y revenir quand le survol cesse (cf. endHighlight). D'un arrêt
	 * survolé au suivant, c'est toujours celle d'avant le premier.
	 */
	function highlightStop(map, stop) {
		clearTimeout(state.returnTimer);
		if (state.returnView === null || state.returnView.map !== map) {
			state.returnView = { map: map, center: map.getCenter(), zoom: map.getZoom() };
		}
		clearHighlight();
		if (stop.latitude === null || stop.longitude === null) return;

		var at = L.latLng(stop.latitude, stop.longitude);
		var marker = L.circleMarker(at, {
			radius: 16, color: "#1f6feb", weight: 3, fillColor: "#1f6feb", fillOpacity: .2, interactive: false
		}).bindTooltip(stop.name, { permanent: true, direction: "top", offset: [0, -14] }).addTo(map);

		state.highlight = { map: map, marker: marker };
		map.panTo(at);
	}

	function clearHighlight() {
		if (state.highlight === null) return;
		state.highlight.map.removeLayer(state.highlight.marker);
		state.highlight = null;
	}

	/**
	 * Le survol cesse : l'arrêt s'éteint, et la carte revient où elle était. Un instant après seulement,
	 * pour ne pas faire l'aller-retour en passant d'un arrêt survolé au suivant.
	 */
	function endHighlight() {
		clearHighlight();
		clearTimeout(state.returnTimer);
		state.returnTimer = setTimeout(function () {
			var view = state.returnView;
			state.returnView = null;
			if (view !== null) view.map.setView(view.center, view.zoom);
		}, 150);
	}

	/** L'arrêt survolé est choisi : la carte reste où le survol l'a menée. */
	function keepView() {
		clearTimeout(state.returnTimer);
		state.returnView = null;
	}

	/**
	 * La carte d'une modification : les itinéraires d'origine et les arrêts de la ligne. Elle ne se
	 * recadre que sur demande — à l'ouverture, pas après un enregistrement.
	 */
	function setupMap(fit) {
		if (state.map === null) {
			state.map = createMap("map");
			state.base = L.layerGroup().addTo(state.map);
			state.pickLayer = L.layerGroup().addTo(state.map);
			state.routeLayer = L.layerGroup().addTo(state.map);
			// Les autres tronçons passent sous celui qu'on édite : ils se voient, ils ne gênent pas.
			state.otherLayer = L.layerGroup().addTo(state.map);
			state.drawLayer = L.layerGroup().addTo(state.map);
			state.map.on("click", onMapClick);
		}

		state.base.clearLayers();
		state.shapes = [];
		state.shapeLayers = {};

		var bounds = [];

		// Une ligne a plusieurs itinéraires par sens — variantes, services partiels — et le tracé devra
		// se recoudre dans CHACUN de ceux que desservent les courses visées. Ils sont donc tous gardés,
		// pas seulement le premier : c'est contre eux que la prévisualisation se juge.
		state.detail.shapes.forEach(function (shape) {
			var points = decodePolyline(shape.encodedPolyline);
			state.shapes.push({ shapeId: shape.shapeId, points: points });
			state.shapeLayers[shape.shapeId] = L.polyline(points, { color: "#8b949e", weight: 4, opacity: .7 }).addTo(state.base);
			bounds = bounds.concat(points);
		});

		drawRouteStops();

		if (fit) {
			routeStops().forEach(function (stop) {
				if (stop.latitude !== null && stop.longitude !== null) bounds.push([stop.latitude, stop.longitude]);
			});
			if (bounds.length > 0) state.map.fitBounds(L.latLngBounds(bounds).pad(.05));
			else state.map.setView([49.443, 1.099], 12);
		}

		// La carte est révélée après coup : Leaflet a mesuré un conteneur encore caché.
		setTimeout(function () { state.map.invalidateSize(); }, 0);
	}

	/** Les arrêts de la ligne, les supprimés en rouge. Redessinés dès qu'on coche ou décoche. */
	function drawRouteStops() {
		state.routeLayer.clearLayers();

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
		});
	}

	function setMode(mode) {
		state.mode = mode;
		clearHighlight();
		var searching = mode === "search" || mode === "place";
		el("addStop").className = searching ? "active" : "";
		el("draw").className = mode === "draw" ? "grow active" : "grow";
		el("draw").textContent = mode === "draw" ? "Terminer le tracé" : "Dessiner";
		el("stopSearch").className = searching ? "" : "hidden";
		showPickableStops(searching);
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
	 * Les arrêts désignables sur la carte, le temps d'ajouter un arrêt : ceux du GTFS en bleu, les
	 * provisoires en ocre, chacun ajouté d'un clic. Les arrêts de la ligne, déjà dessinés et déjà
	 * cliquables, n'y sont pas repris. Ils passent sous tout le reste de la carte.
	 */
	function showPickableStops(show) {
		state.pickLayer.clearLayers();
		if (!show) return;

		if (state.allStops === null) {
			request(API + "/api/stops/all").then(function (stops) {
				state.allStops = stops;
				if (state.mode === "search" || state.mode === "place") showPickableStops(true);
			}).catch(function (error) { setStatus(error.message, "error"); });
			return;
		}

		var onRoute = {};
		routeStops().forEach(function (stop) { onRoute[stop.stopId] = true; });

		state.allStops.forEach(function (entry) {
			var stop = { stopId: entry[0], name: entry[1], latitude: entry[2], longitude: entry[3], provisional: entry[4] };
			if (onRoute[stop.stopId]) return;

			var color = stop.provisional ? "#9a6700" : "#1f6feb";
			var marker = L.circleMarker([stop.latitude, stop.longitude], {
				radius: 4, color: color, weight: 2, fillColor: "#fff", fillOpacity: 1
			}).bindTooltip(stop.name).addTo(state.pickLayer);
			marker.bringToBack();

			// En pose d'un nouvel arrêt, le clic revient à la carte : c'est une position qu'on donne.
			marker.on("click", function (event) {
				if (state.mode !== "search") return;
				L.DomEvent.stopPropagation(event);
				addStop(stop);
			});
		});
	}

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
		// Les résultats vont être refaits : celui qu'on survolait n'existera plus pour signaler qu'on le
		// quitte. C'en est la fin, et la carte revient où elle était.
		if (state.highlight !== null) endHighlight();
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
				// Plusieurs arrêts portent souvent le même nom — deux quais, deux communes : c'est la carte
				// qui les départage, et le survol les y montre avant qu'on choisisse.
				row.onmouseenter = function () { highlightStop(state.map, stop); };
				row.onmouseleave = endHighlight;
				row.onclick = function () {
					keepView();
					clearHighlight();
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
			state.allStops = null;
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
			state.allStops = null;
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

		var reference = seg().startStopId === null ? null : referenceOf(seg());
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
			+ ", le trajet publié"
			+ (preview.pattern !== null && state.detail.patterns.length > 1 ? " sur « " + preview.pattern.label + " »" : "")
			+ " — ";
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
	 * L'aperçu porte sur le tracé mis en avant, et n'y coud que les tronçons qui le visent ; le
	 * serveur, lui, recoud dans chacun de ceux qu'empruntent les courses visées. La prévisualisation se
	 * contente des sommets — le serveur projette sur les segments — mais elle suffit à juger des
	 * raccords.
	 *
	 * Renvoie l'écart maximal aux points de divergence, en mètres, et de quoi rédiger la note ; ou null
	 * s'il n'y avait rien à prévisualiser.
	 */
	function drawPreview() {
		var pattern = focusedPattern();
		var shape = pattern === null ? state.shapes[0] : state.shapes.filter(function (candidate) {
			return candidate.shapeId === pattern.shapeId;
		})[0];
		if (!shape || shape.points.length < 2) return null;

		var drawn = [];
		state.segments.forEach(function (segment) {
			if (segment.path.length < 2) return;
			if (pattern !== null && state.patterns.indexOf(pattern.patternId) === -1) return;
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

		return { offset: offset, rejoined: open, unreachable: unreachable, pattern: pattern };
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

	/** Un tronçon sans arrêt de substitution ni tracé n'annonce rien : il n'est pas enregistré. */
	function hasContent(segment) {
		return segment.stops.length > 0 || segment.path.length >= 2;
	}

	/** Tout part d'un bloc : raison, période, tracés, arrêts supprimés, tronçons. */
	function save() {
		// Aucun tracé coché s'enverrait comme une liste vide, que le serveur lit « tous » : c'est le
		// seul cas qu'on refuse avant d'envoyer.
		if (state.patterns.length === 0) {
			setStatus("Cocher au moins un tracé.", "error");
			return;
		}

		var period = state.readPeriod();
		var kept = state.segments.filter(hasContent);
		var dropped = state.segments.length - kept.length;
		var payload = {
			label: el("label").value,
			start: period.start,
			end: period.end,
			patternIds: state.patterns.length === state.detail.patterns.length ? [] : state.patterns,
			removedStopIds: state.removed,
			cancelledDepartures: state.cancelled,
			segments: kept.map(function (segment) {
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
		request(API + "/api/modifications/" + state.detail.uid, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(payload)
		}).then(function (detail) {
			adoptDetail(detail, false);

			// Le compte rendu porte sur le premier tronçon qui coince : c'est celui-là qu'il faut reprendre,
			// et le nommer évite de les passer tous en revue. Seuls comptent les tronçons enregistrés.
			var blocking = -1;
			state.segments.slice(0, detail.segmentCount).forEach(function (segment, index) {
				if (blocking === -1 && (!segment.publishable || matchingTrips(segment) === 0)) blocking = index;
			});

			var message;
			if (blocking === -1) {
				message = detail.segmentCount === 0 ? "Enregistré, sans tronçon." : "Enregistré.";
			} else {
				var segment = state.segments[blocking];
				var why = segment.startStopId === null || segment.endStopId === null
					? "bornes manquantes."
					: matchingTrips(segment) === 0 ? "aucune course des tracés cochés ne dessert ses bornes."
					: removesStops(segment) ? "ni arrêt ni tracé."
					: "tracé manquant.";
				message = "Enregistré. Tronçon " + (blocking + 1) + " : " + why;
			}
			if (dropped > 0) message += " " + dropped + " tronçon(s) sans arrêt ni tracé laissé(s) de côté.";
			setStatus(message, blocking === -1 ? "ok" : "error");
		}).catch(function (error) { setStatus(error.message, "error"); });
	}

	// --- branchements ---

	// Le groupement, le tri et l'onglet ne tiennent qu'à l'affichage : rien à redemander au serveur. Ils
	// se retiennent d'une visite à l'autre — c'est une façon de travailler, pas un réglage qu'on repose
	// chaque matin.
	el("groupBy").value = recall("modifications.groupBy") === "alert" ? "alert" : "line";
	el("sortBy").value = SORTS[recall("modifications.sortBy")] ? recall("modifications.sortBy") : "number";
	state.phase = PHASES.some(function (phase) { return phase[0] === recall("modifications.phase"); })
		? recall("modifications.phase") : "current";
	el("groupBy").onchange = function (event) {
		remember("modifications.groupBy", event.target.value);
		renderList();
	};
	el("sortBy").onchange = function (event) {
		remember("modifications.sortBy", event.target.value);
		renderList();
	};
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
	el("removeSegment").onclick = function () {
		if (state.segments.length < 2) return;
		state.segments.splice(state.active, 1);
		selectSegment(Math.min(state.active, state.segments.length - 1));
	};
	el("toggleVisible").onclick = toggleVisible;
	el("dialogCancel").onclick = function () { el("dialog").close(); };
	el("stopsSort").value = STOP_SORTS[recall("stops.sortBy")] ? recall("stops.sortBy") : "name";
	el("stopsSort").onchange = function (event) {
		remember("stops.sortBy", event.target.value);
		renderStopsTable();
	};
	el("stopsQuery").oninput = renderStopsTable;
	el("bulkHide").onclick = function () { bulk("hide"); };
	el("bulkShow").onclick = function () { bulk("show"); };
	el("bulkDiscard").onclick = function () { bulk("discard"); };
	el("remove").onclick = remove;
	el("create").onclick = createModification;
	el("placeNewStop").onclick = function () {
		if (state.placingStop) { setPlacing(false); setStopsStatus(""); return; }
		if (el("newStopName").value.trim().length === 0) {
			setStopsStatus("Saisir d'abord le nom de l'arrêt.", "error");
			el("newStopName").focus();
			return;
		}
		setPlacing(true);
	};

	document.addEventListener("keydown", function (event) {
		if ((event.ctrlKey || event.metaKey) && event.key === "z" && state.detail) {
			event.preventDefault();
			removeWaypoint(seg().waypoints.length - 1);
		}
	});

	// Un lien suivi depuis un dialogue — une modification qui désigne l'arrêt — change de vue : le
	// dialogue n'a plus rien à y faire.
	window.addEventListener("hashchange", function () { if (el("dialog").open) el("dialog").close(); });
	window.addEventListener("hashchange", applyRoute);
	applyRoute();
})();
</script>
</body>
</html>`;
