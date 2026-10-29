import type { AlertDto, ModificationSummaryDto, StopGroupDto } from "@dto";
import { Link, useBlocker, useNavigate, useSearch } from "@tanstack/react-router";
import { cn } from "cn";
import {
	CircleCheckIcon,
	ClockIcon,
	EyeIcon,
	EyeOffIcon,
	PlusIcon,
	Trash2Icon,
	TriangleAlertIcon,
	XIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { LineBadge } from "@/components/line-badge";
import { PeriodEditor, periodForm } from "@/components/period-editor";
import { SectionCard, SpecName } from "@/components/section-card";
import {
	ALERT_PHASES,
	ALERT_PUBLICATIONS,
	MODIFICATION_STATES,
	STATE_BANNERS,
	StatusPill,
} from "@/components/status-pill";
import { StopStrip } from "@/components/stop-strip";
import { TripSetDialog, TripSetList } from "@/components/trip-sets";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { describePeriods, formatInstant, modificationId, plural } from "@/lib/format";
import { CAUSES, EFFECTS } from "@/lib/labels";
import {
	useCreateModification,
	useDeleteAlert,
	useRoutes,
	useSaveAlert,
	useSetAlertChecked,
	useSetAlertHidden,
} from "@/lib/queries";

import {
	type AlertForm,
	clearGroup,
	formOf,
	inputOf,
	isRemoved,
	scopeOf,
	suggestionsOf,
	toggleStop,
} from "./alert-form";
import { ImpactEditor } from "./impact-editor";
import { ModificationPicker } from "./modification-picker";

/** Ce qu'on s'apprête à créer : la modification d'un sens suggéré, ou une page blanche. */
type Creation = { routeId: string; directionId: number } | "blank";

/**
 * Le détail d'une alerte : son texte, sa cause et son effet republiés, ses périodes, ce qu'elle
 * supprime — arrêts et courses — et les modifications qu'elle active. Tout se saisit dans un même
 * formulaire, enregistré d'un bloc ; le masquage, lui, vaut tout de suite. Une modification ne se
 * crée que depuis une alerte enregistrée : elle s'y associe côté serveur.
 */
export function AlertDetail({ alert, modifications }: { alert: AlertDto; modifications: ModificationSummaryDto[] }) {
	const [form, setForm] = useState<AlertForm>(() => formOf(alert));
	const search = useSearch({ from: "/alerts" });
	const showAll = search.all === true;
	const save = useSaveAlert(alert.alertNumber);
	const setHidden = useSetAlertHidden(alert.alertNumber);
	const setChecked = useSetAlertChecked(alert.alertNumber);
	const remove = useDeleteAlert(alert.alertNumber);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const create = useCreateModification();
	const routes = useRoutes();
	const navigate = useNavigate();
	const [confirming, setConfirming] = useState<Creation | null>(null);

	const baseline = useMemo(() => JSON.stringify(inputOf(formOf(alert), alert)), [alert]);
	const current = JSON.stringify(inputOf(form, alert));
	const dirty = current !== baseline;

	// L'alerte se relit toutes les minutes. Tant qu'on n'y a rien touché, le formulaire la suit ; dès
	// qu'on l'a modifié, il garde la saisie.
	const previous = useRef(baseline);
	useEffect(() => {
		if (previous.current === baseline) return;
		if (current === previous.current) setForm(formOf(alert));
		previous.current = baseline;
	}, [baseline, current, alert]);
	// Une alerte qu'on modifie devient celle de l'URL : changer de filtre ne la quitte plus. Seul ce
	// qui en ouvre une autre, ou quitte la page, demande alors confirmation.
	useEffect(() => {
		if (dirty && search.alert !== alert.alertNumber)
			navigate({ to: "/alerts", search: (current) => ({ ...current, alert: alert.alertNumber }), replace: true });
	}, [dirty, search.alert, alert.alertNumber, navigate]);
	useBlocker({
		shouldBlockFn: ({ next }) =>
			dirty &&
			!(next.routeId === "/alerts" && next.search.alert === alert.alertNumber) &&
			!window.confirm("Des changements de cette alerte ne sont pas enregistrés. Les abandonner ?"),
		enableBeforeUnload: () => dirty,
	});

	const patch = (change: Partial<AlertForm>) => setForm((current) => ({ ...current, ...change }));
	const publication = ALERT_PUBLICATIONS[alert.publication];
	const phase = ALERT_PHASES[alert.phase];
	const byUid = new Map(modifications.map((entry) => [entry.uid, entry]));
	const lineIds = new Set(alert.lines.map((line) => line.routeId));
	const rewritten =
		form.headerText.trim() !== alert.received.headerText.trim() ||
		form.descriptionText.trim() !== alert.received.descriptionText.trim();

	const submit = (then?: () => void) =>
		save.mutate(inputOf(form, alert), {
			onSuccess: (saved) => {
				setForm(formOf(saved));
				toast.success(`Alerte ${alert.alertNumber} enregistrée.`);
				then?.();
			},
		});

	// Les suggestions suivent l'impact tel qu'il est saisi, enregistré ou non.
	const suggestions = suggestionsOf(form.impact ?? alert.impact.received, routes.data ?? []);

	// Crée la modification d'un sens, tous tracés cochés, ou ouvre la page blanche. Juste après
	// l'enregistrement, l'alerte ne s'est pas encore relue : le garde-fou croirait la saisie perdue.
	const startCreation = (creation: Creation) => {
		if (creation === "blank") {
			navigate({ to: "/modifications/new", search: { alert: alert.alertNumber }, ignoreBlocker: true });
			return;
		}
		create.mutate(
			{ ...creation, description: null, patternIds: [], alertNumbers: [alert.alertNumber] },
			{
				onSuccess: ({ uid }) =>
					navigate({
						to: "/modifications/$uid",
						params: { uid: String(uid) },
						search: { alert: alert.alertNumber },
						ignoreBlocker: true,
					}),
			},
		);
	};
	const requestCreation = (creation: Creation) => (dirty ? setConfirming(creation) : startCreation(creation));

	// Les sens qui disent quelque chose d'abord ; les autres se déplient à la demande.
	const relevant = (group: StopGroupDto) =>
		group.analyzed ||
		group.replacedBy.length > 0 ||
		group.ignored ||
		group.stops.some((stop) => isRemoved(form, group, stop) || stop.overridden);
	const shown = alert.stopGroups.filter((group) => showAll || relevant(group));
	const hiddenCount = alert.stopGroups.length - alert.stopGroups.filter(relevant).length;

	return (
		<div className="flex min-w-0 flex-col gap-4">
			<div className="flex flex-col gap-4 rounded-lg border bg-card px-5 py-4">
				<div className="flex flex-wrap items-center gap-2.5">
					<span className="font-mono text-xs text-muted-foreground">
						N° {alert.alertNumber} · reçue le {formatInstant(alert.firstSeenAt)}
					</span>
					<StatusPill tone={phase.tone}>{phase.label}</StatusPill>
					<StatusPill tone={publication.tone}>{publication.label}</StatusPill>
					{dirty ? <Badge variant="outline">Modifications non enregistrées</Badge> : null}
					<span className="flex-1" />
					<Button
						variant="outline"
						size="lg"
						aria-pressed={alert.checkedAt !== null}
						className={cn(alert.checkedAt !== null && "border-success text-success hover:text-success")}
						disabled={setChecked.isPending}
						onClick={() => setChecked.mutate(alert.checkedAt === null)}
					>
						<CircleCheckIcon data-icon="inline-start" />
						{alert.checkedAt === null ? "Marquer traitée" : `Traitée le ${formatInstant(alert.checkedAt)}`}
					</Button>
					<Button
						variant="outline"
						size="lg"
						aria-pressed={alert.hidden}
						className={cn(
							alert.hidden && "border-inverse bg-inverse text-inverse-foreground hover:bg-strong hover:text-white",
						)}
						disabled={setHidden.isPending || !alert.inFeed}
						onClick={() => setHidden.mutate(!alert.hidden)}
					>
						{alert.hidden ? <EyeIcon data-icon="inline-start" /> : <EyeOffIcon data-icon="inline-start" />}
						{alert.hidden ? "Afficher" : "Masquer"}
					</Button>
					{alert.inFeed ? (
						// Un bouton désactivé ne reçoit pas le survol : c'est son enveloppe qui porte l'infobulle.
						<Tooltip>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button variant="outline" size="lg" disabled aria-label="Supprimer l'alerte">
										<Trash2Icon />
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent>Encore au flux, elle reviendrait au prochain relevé : la masquer plutôt.</TooltipContent>
						</Tooltip>
					) : (
						<Button
							variant="outline"
							size="lg"
							aria-label="Supprimer l'alerte"
							className="text-destructive hover:text-destructive"
							disabled={remove.isPending}
							onClick={() => setConfirmDelete(true)}
						>
							<Trash2Icon />
						</Button>
					)}
					<Button variant="outline" size="lg" disabled={!dirty} onClick={() => setForm(formOf(alert))}>
						Annuler
					</Button>
					<Button size="lg" disabled={!dirty || save.isPending} onClick={() => submit()}>
						Enregistrer
					</Button>
				</div>
				<h2 className="m-0 text-[22px] font-semibold tracking-tight">{form.headerText || alert.received.headerText}</h2>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(240px,100%),1fr))] gap-x-4 gap-y-3">
					<Field className="gap-1.5">
						<FieldLabel htmlFor="alert-cause">
							Cause <SpecName>cause</SpecName>
						</FieldLabel>
						<Select value={form.cause ?? "UNKNOWN_CAUSE"} onValueChange={(value) => patch({ cause: value })}>
							<SelectTrigger id="alert-cause" className="h-10 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{Object.entries(CAUSES).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label} — {value}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
					<Field className="gap-1.5">
						<FieldLabel htmlFor="alert-effect">
							Effet <SpecName>effect</SpecName>
						</FieldLabel>
						<Select value={form.effect ?? "UNKNOWN_EFFECT"} onValueChange={(value) => patch({ effect: value })}>
							<SelectTrigger id="alert-effect" className="h-10 w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectGroup>
									{Object.entries(EFFECTS).map(([value, label]) => (
										<SelectItem key={value} value={value}>
											{label} — {value}
										</SelectItem>
									))}
								</SelectGroup>
							</SelectContent>
						</Select>
					</Field>
				</div>
				{alert.phaseDetail ? (
					<p
						className={cn(
							"m-0 flex items-center gap-2.5 rounded-md px-3 py-2.5 text-[13px]",
							STATE_BANNERS[phase.tone],
						)}
					>
						<ClockIcon aria-hidden="true" className="size-4 flex-none" />
						{alert.phaseDetail}
					</p>
				) : null}
			</div>

			{alert.warnings.length > 0 ? (
				<div className="flex items-start gap-3 rounded-lg border border-warning-border bg-warning px-4 py-3.5 text-[#6E3500]">
					<TriangleAlertIcon aria-hidden="true" className="mt-px size-[18px] flex-none" />
					<span className="flex flex-col gap-0.5">
						<strong className="font-semibold">Analyse à vérifier</strong>
						{alert.warnings.map((warning) => (
							<span key={warning} className="text-[13px]">
								{warning}
							</span>
						))}
					</span>
				</div>
			) : null}

			<ImpactEditor value={form.impact} received={alert.impact.received} onChange={(impact) => patch({ impact })} />

			<SectionCard
				title="Texte de l'alerte"
				actions={
					<>
						<span
							className={cn(
								"rounded-sm px-2 py-0.5 text-xs font-medium",
								rewritten ? "bg-warning text-warning-foreground" : "bg-neutral text-neutral-foreground",
							)}
						>
							{rewritten ? "Réécrit" : "Texte reçu"}
						</span>
						<Button
							variant="outline"
							disabled={!rewritten}
							onClick={() =>
								patch({ headerText: alert.received.headerText, descriptionText: alert.received.descriptionText })
							}
						>
							Reprendre le texte reçu
						</Button>
					</>
				}
			>
				<div className="grid grid-cols-[repeat(auto-fit,minmax(min(300px,100%),1fr))] gap-4">
					<div className="flex flex-col gap-2.5">
						<div className="flex flex-col gap-1.5">
							<span className="text-[13px] font-medium text-strong">Titre reçu</span>
							<p className="m-0 flex min-h-10 items-center rounded-md border border-[#E2E5E1] bg-muted px-3.5 py-2 text-[13px] text-strong">
								{alert.received.headerText}
							</p>
						</div>
						<div className="flex flex-1 flex-col gap-1.5">
							<span className="text-[13px] font-medium text-strong">Description reçue</span>
							<div
								className="flex-1 rounded-md border border-[#E2E5E1] bg-muted px-3.5 py-3 text-[13px] leading-relaxed text-strong [&_a]:underline [&_img]:max-w-full [&_li]:ml-4 [&_li]:list-disc [&_p]:my-1"
								// Nettoyé côté serveur (cf. `sanitizeHtml`) : listes, liens et plans, rien qui s'exécute.
								// biome-ignore lint/security/noDangerouslySetInnerHtml: le HTML est nettoyé par le serveur.
								dangerouslySetInnerHTML={{ __html: alert.received.descriptionHtml }}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-2.5">
						<Field className="gap-1.5">
							<FieldLabel htmlFor="alert-header">
								Titre publié <SpecName>header_text</SpecName>
							</FieldLabel>
							<Input
								id="alert-header"
								className="h-10"
								value={form.headerText}
								onChange={(event) => patch({ headerText: event.target.value })}
							/>
						</Field>
						<Field className="gap-1.5">
							<FieldLabel htmlFor="alert-description">
								Description publiée <SpecName>description_text</SpecName>
							</FieldLabel>
							<Textarea
								id="alert-description"
								rows={7}
								value={form.descriptionText}
								onChange={(event) => patch({ descriptionText: event.target.value })}
							/>
						</Field>
					</div>
				</div>
			</SectionCard>

			<SectionCard
				title="Périodes d'application"
				hint={<SpecName>active_period</SpecName>}
				actions={
					<>
						<span
							className={cn(
								"rounded-sm px-2 py-0.5 text-xs font-medium",
								form.periods === null ? "bg-neutral text-neutral-foreground" : "bg-warning text-warning-foreground",
							)}
						>
							{form.periods === null ? "D'après l'analyse" : "Saisies"}
						</span>
						{form.periods !== null ? (
							<Button variant="outline" onClick={() => patch({ periods: null })}>
								Revenir à l'analyse
							</Button>
						) : null}
					</>
				}
			>
				{form.periods === null ? (
					<div className="flex flex-wrap items-center gap-3 border-t border-divider pt-3.5">
						<p className="m-0 flex-1 text-[13px] text-strong">
							L'analyse lit : {describePeriods(alert.analysisPeriods)}.
						</p>
						<Button variant="outline" onClick={() => patch({ periods: alert.analysisPeriods.map(periodForm) })}>
							Corriger les périodes
						</Button>
					</div>
				) : (
					<PeriodEditor periods={form.periods} onChange={(periods) => patch({ periods })} />
				)}
			</SectionCard>

			<SectionCard title="Arrêts supprimés">
				{shown.map((group) => (
					<StopGroup
						key={scopeOf(group)}
						group={group}
						form={form}
						onToggle={(stopId) => setForm((current) => toggleStop(current, group, stopId))}
						onClear={(ignore) => setForm((current) => clearGroup(current, group, ignore))}
					/>
				))}
				{alert.stopGroups.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">Aucune ligne citée.</p>
				) : null}
				{hiddenCount > 0 ? (
					<div className="border-t border-divider pt-3">
						<Button
							variant="link"
							className="px-0"
							onClick={() =>
								navigate({
									to: "/alerts",
									search: (current) => ({ ...current, all: showAll ? undefined : true }),
									replace: true,
								})
							}
						>
							{showAll ? "Masquer les sens sans suppression" : "Afficher les lignes sans suppression"}
						</Button>
					</div>
				) : null}
			</SectionCard>

			<SectionCard
				title="Courses supprimées"
				hint={plural(form.tripSets.filter((set) => set.enabled).length, "ensemble actif", "ensembles actifs")}
				actions={
					<TripSetDialog
						source={`/alerts/${encodeURIComponent(alert.alertNumber)}`}
						lines={alert.lines}
						onAdd={(set) => patch({ tripSets: [...form.tripSets, set] })}
					/>
				}
			>
				<TripSetList sets={form.tripSets} onChange={(tripSets) => patch({ tripSets })} />
			</SectionCard>

			<SectionCard
				title="Modifications associées"
				actions={
					<>
						<Button variant="outline" asChild>
							<Link
								to="/modifications/new"
								search={{ alert: alert.alertNumber }}
								className="text-foreground! no-underline"
								// Une saisie en cours se propose d'abord à l'enregistrement (cf. `requestCreation`).
								onClick={(event) => {
									if (!dirty) return;
									event.preventDefault();
									setConfirming("blank");
								}}
							>
								<PlusIcon data-icon="inline-start" />
								Nouvelle modification
							</Link>
						</Button>
						<ModificationPicker
							modifications={modifications.filter((entry) => !form.modifications.includes(entry.uid))}
							lines={lineIds}
							onPick={(uid) => patch({ modifications: [...form.modifications, uid] })}
						/>
					</>
				}
			>
				{form.modifications.map((uid) => {
					const entry = byUid.get(uid);
					const state = entry ? MODIFICATION_STATES[entry.state] : undefined;
					return (
						<div key={uid} className="flex min-h-13 flex-wrap items-center gap-2.5 border-t border-divider">
							<span className="font-mono text-[13px] font-semibold">{modificationId(uid)}</span>
							{entry ? <LineBadge line={entry.line} /> : null}
							<span className="min-w-0 flex-[1_1_220px]">
								{entry ? `→ ${entry.headsigns.join(" / ")}${entry.description ? ` · ${entry.description}` : ""}` : "…"}
							</span>
							{state && alert.modifications.includes(uid) ? (
								<StatusPill tone={state.tone}>{state.label}</StatusPill>
							) : null}
							{!alert.modifications.includes(uid) ? <Badge variant="outline">À enregistrer</Badge> : null}
							<Link to="/modifications/$uid" params={{ uid: String(uid) }} className="px-1.5 text-[13px] font-medium">
								Ouvrir
							</Link>
							<Button
								variant="ghost"
								size="icon-lg"
								aria-label={`Dissocier ${modificationId(uid)}`}
								onClick={() => patch({ modifications: form.modifications.filter((other) => other !== uid) })}
							>
								<XIcon />
							</Button>
						</div>
					);
				})}
				{form.modifications.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
						Aucune modification associée.
					</p>
				) : null}
			</SectionCard>

			<SectionCard title="Modifications suggérées" hint="un sens par ligne de l'impact" className="gap-2">
				{suggestions.map(({ route, direction }) => {
					const existing = form.modifications.filter((uid) => {
						const entry = byUid.get(uid);
						return entry?.routeId === route.routeId && entry.directionId === direction.directionId;
					});
					return (
						<div
							key={scopeOf({ routeId: route.routeId, directionId: direction.directionId })}
							className="flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-divider py-1"
						>
							<LineBadge line={route} />
							<span className="min-w-0 flex-[1_1_220px] text-[13px]">→ {direction.headsigns.join(" / ")}</span>
							<span className="text-[13px] text-muted-foreground">
								{existing.length > 0
									? `Déjà associée : ${existing.map(modificationId).join(", ")}`
									: plural(direction.patterns.length, "tracé")}
							</span>
							<Button
								variant="outline"
								size="sm"
								disabled={create.isPending || save.isPending}
								onClick={() => requestCreation({ routeId: route.routeId, directionId: direction.directionId })}
							>
								<PlusIcon data-icon="inline-start" />
								Créer la modification
							</Button>
						</div>
					);
				})}
				{suggestions.length === 0 ? (
					<p className="m-0 border-t border-divider pt-3.5 text-[13px] text-muted-foreground">
						Aucune ligne dans l'impact.
					</p>
				) : null}
			</SectionCard>

			<AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Supprimer l'alerte {alert.alertNumber} ?</AlertDialogTitle>
						<AlertDialogDescription>
							Ses périodes, ses arrêts supprimés et ses courses annulées disparaissent.
							{alert.modifications.length === 1
								? " La modification associée est conservée, mais n'y est plus rattachée."
								: alert.modifications.length > 1
									? ` Les ${alert.modifications.length} modifications associées sont conservées, mais n'y sont plus rattachées.`
									: ""}{" "}
							Cela ne se défait pas.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Annuler</AlertDialogCancel>
						<AlertDialogAction
							variant="destructive"
							onClick={() =>
								remove.mutate(undefined, {
									onSuccess: () => navigate({ to: "/alerts", search: {}, ignoreBlocker: true }),
								})
							}
						>
							Supprimer
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>

			<AlertDialog open={confirming !== null} onOpenChange={(open) => (open ? undefined : setConfirming(null))}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>Enregistrer l'alerte d'abord ?</AlertDialogTitle>
						<AlertDialogDescription>
							Des changements de l'alerte {alert.alertNumber} ne sont pas enregistrés. Ils le seront avant de créer la
							modification, qui s'y associera.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>Annuler</AlertDialogCancel>
						<AlertDialogAction
							disabled={save.isPending}
							onClick={() => {
								const creation = confirming;
								setConfirming(null);
								if (creation !== null) submit(() => startCreation(creation));
							}}
						>
							Enregistrer et créer
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

/** Les arrêts d'une ligne dans un sens, sur un schéma où chacun se bascule d'un clic. */
function StopGroup({
	group,
	form,
	onToggle,
	onClear,
}: {
	group: StopGroupDto;
	form: AlertForm;
	onToggle: (stopId: string) => void;
	onClear: (ignore: boolean) => void;
}) {
	const stops = group.stops.map((stop) => ({ ...stop, removed: isRemoved(form, group, stop) }));
	const removedCount = stops.filter((stop) => stop.removed).length;
	const ignored = form.ignored.includes(scopeOf(group));
	const corrected = Object.keys(form.overrides).some((key) => key.startsWith(`${scopeOf(group)}|`));
	const tag =
		group.replacedBy.length > 0
			? {
					label: `Remplacé par ${group.replacedBy.map(modificationId).join(", ")}`,
					className: "bg-info text-info-foreground",
				}
			: ignored
				? { label: "Analyse ignorée", className: "bg-neutral text-neutral-foreground" }
				: corrected
					? { label: "Corrigé", className: "bg-warning text-warning-foreground" }
					: group.analyzed
						? { label: "D'après l'analyse", className: "bg-neutral text-neutral-foreground" }
						: null;

	return (
		<div className="flex flex-col gap-2.5 border-t border-divider pt-3.5 pb-1.5">
			<div className="flex flex-wrap items-center gap-2">
				<LineBadge line={group.line} />
				<span>
					Direction <span className="font-semibold">{group.headsign}</span>
				</span>
				<span className="text-[13px] text-muted-foreground">
					{removedCount === 0 ? "aucun arrêt supprimé" : plural(removedCount, "arrêt supprimé", "arrêts supprimés")}
				</span>
				{tag ? (
					<span className={cn("rounded-sm px-2 py-0.5 text-xs font-medium", tag.className)}>{tag.label}</span>
				) : null}
				<span className="flex-1" />
				{group.analyzed && !ignored ? (
					<Button variant="ghost" size="sm" onClick={() => onClear(true)}>
						Tout desservir
					</Button>
				) : null}
				{ignored || corrected ? (
					<Button variant="ghost" size="sm" onClick={() => onClear(false)}>
						Rétablir l'analyse
					</Button>
				) : null}
			</div>
			<StopStrip stops={stops} color={group.line.color} onToggle={onToggle} />
		</div>
	);
}
