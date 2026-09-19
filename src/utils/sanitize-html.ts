/**
 * Les éléments qu'on laisse passer, et ce qu'ils deviennent. Le reste est DÉBALLÉ — la balise saute,
 * son contenu reste : un `<div>` ou un `<span class="h3">` n'apporte rien qu'on sache rendre ici, mais
 * le texte qu'il entoure, si.
 *
 * `<b>` et `<i>` sont normalisés en `<strong>` et `<em>` : le flux amont mélange les deux écritures
 * pour le même effet, et la feuille de style n'a pas à connaître les deux.
 */
const ALLOWED = new Map([
	["p", "p"],
	["br", "br"],
	["hr", "hr"],
	["ul", "ul"],
	["ol", "ol"],
	["li", "li"],
	["table", "table"],
	["thead", "thead"],
	["tbody", "tbody"],
	["tr", "tr"],
	["td", "td"],
	["th", "th"],
	["strong", "strong"],
	["b", "strong"],
	["em", "em"],
	["i", "em"],
	["img", "img"],
]);

/** Les éléments sans contenu : ils ne s'ouvrent ni ne se ferment, ils sont. */
const VOID = new Set(["br", "hr", "img"]);

/**
 * Les éléments que le HTML dispense de fermeture : l'ouverture du suivant ferme le précédent. Sans
 * cette règle, un `<li>un<li>deux</ul>` — écriture licite, et le CMS amont s'en autorise — donnerait
 * des listes emboîtées les unes dans les autres.
 */
const SIBLING_CLOSES = new Map([
	["p", ["p"]],
	["li", ["li"]],
	["tr", ["tr"]],
	["td", ["td", "th"]],
	["th", ["td", "th"]],
]);

/** Ce dont le contenu n'est pas du texte : il part avec la balise, et non à sa place. */
const OPAQUE = new Set(["script", "style"]);

/** Une balise, ouvrante ou fermante, ses attributs compris — guillemets respectés. */
const TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;

/**
 * Le HTML d'une info trafic, ramené à ce qu'on accepte d'afficher.
 *
 * Le flux amont porte le texte des perturbations tel que le CMS de l'exploitant l'a saisi : des
 * listes, des mises en gras, des tableaux, et les plans de déviation en image. L'échapper le rendrait
 * illisible — on lirait les balises — et l'injecter tel quel reviendrait à laisser un tiers écrire du
 * HTML dans une page d'administration. D'où cette troisième voie : on garde la structure, on jette
 * tout le reste.
 *
 * Aucun attribut ne survit, à deux exceptions près : le `src` d'une image, s'il est en `https:`, et
 * son `alt`. Les dimensions qu'il portait sautent avec les autres — c'est la feuille de style qui
 * décide de la largeur, un plan de sept cents pixels n'ayant rien à faire dans un panneau qui en fait
 * quatre cents.
 *
 * Les balises sont refermées dans l'ordre : une fermeture orpheline est ignorée, et ce qui reste
 * ouvert à la fin est fermé. Le navigateur s'en arrangerait, mais pas forcément comme on l'espère.
 */
export function sanitizeHtml(raw: string): string {
	if (raw.length === 0) return "";

	const out: string[] = [];
	/** Les éléments ouverts, du plus ancien au plus récent. */
	const open: string[] = [];
	/** Non vide tant qu'on traverse le contenu d'un élément opaque, dont rien ne doit sortir. */
	let skipping: string | null = null;
	let cursor = 0;

	TAG.lastIndex = 0;
	for (let match = TAG.exec(raw); match !== null; match = TAG.exec(raw)) {
		const [tag, closing, rawName, attributes] = match as unknown as [string, string, string, string];
		const name = rawName.toLowerCase();

		if (skipping === null) out.push(escapeText(raw.slice(cursor, match.index)));
		cursor = match.index + tag.length;

		if (skipping !== null) {
			if (closing === "/" && name === skipping) skipping = null;
			continue;
		}
		if (OPAQUE.has(name)) {
			if (closing !== "/") skipping = name;
			continue;
		}

		const element = ALLOWED.get(name);
		// Une balise qu'on ne rend pas est simplement retirée : son contenu, lui, a déjà été écrit ou le
		// sera au tour suivant.
		if (element === undefined) continue;

		if (VOID.has(element)) {
			if (closing !== "/") out.push(element === "img" ? image(attributes) : `<${element}>`);
			continue;
		}

		if (closing !== "/") {
			const closes = SIBLING_CLOSES.get(element) ?? [];
			while (open.length > 0 && closes.includes(open.at(-1) as string)) out.push(`</${open.pop() as string}>`);
			open.push(element);
			out.push(`<${element}>`);
			continue;
		}

		// Une fermeture qui n'a rien ouvert ne ferme rien. Sinon on referme tout ce qui traîne au-dessus
		// de son ouverture : c'est ce que le document voulait dire, à son imbrication près.
		const depth = open.lastIndexOf(element);
		if (depth === -1) continue;
		while (open.length > depth) out.push(`</${open.pop() as string}>`);
	}

	if (skipping === null) out.push(escapeText(raw.slice(cursor)));
	while (open.length > 0) out.push(`</${open.pop() as string}>`);

	return out.join("");
}

// ---

/** Une image réduite à ce qu'elle doit dire : où elle est, et ce qu'elle montre. */
function image(attributes: string): string {
	const source = attributeOf(attributes, "src");
	// Rien d'autre que `https:` — ni `data:`, ni `javascript:`, ni une URL relative qui irait chercher
	// dans le service lui-même.
	if (source === undefined || !source.toLowerCase().startsWith("https://")) return "";

	const alt = attributeOf(attributes, "alt") ?? "";
	return `<img src="${escapeAttribute(source)}" alt="${escapeAttribute(alt)}">`;
}

/** La valeur d'un attribut, guillemets simples ou doubles, ou `undefined` s'il n'y est pas. */
function attributeOf(attributes: string, name: string): string | undefined {
	const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(attributes);
	if (match === null) return undefined;
	return decodeEntities(match[1] ?? match[2] ?? "");
}

/**
 * Le texte, rendu inoffensif. L'esperluette n'est échappée que lorsqu'elle n'ouvre pas déjà une
 * entité : le flux en écrit peu, mais doubler celles qu'il écrit se lirait « &amp;amp; ».
 */
function escapeText(text: string): string {
	return text
		.replace(/&(?![a-zA-Z#0-9]{1,8};)/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Les quelques entités qu'une valeur d'attribut peut porter. Elle est relue avant d'être réécrite :
 * sans quoi un `&amp;` du flux, réencodé, deviendrait un `&` de trop dans l'URL.
 */
function decodeEntities(value: string): string {
	return value
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/gi, "&");
}
