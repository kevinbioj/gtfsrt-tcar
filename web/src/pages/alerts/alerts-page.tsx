import type { AlertDto } from "@dto";
import { Link, useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { CircleCheckIcon, SearchIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { LineBadge, LineOption } from "@/components/line-badge";
import { FilterBar, PageHeader } from "@/components/page-header";
import { ALERT_PHASES, ALERT_PUBLICATIONS, StatusPill } from "@/components/status-pill";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { describePeriods, searchable } from "@/lib/format";
import { causeColor, causeLabel } from "@/lib/labels";
import { useAlerts, useModifications, useRoutes } from "@/lib/queries";
import { useSearchText } from "@/lib/search-text";
import { alertsRoute } from "@/router";

import { AlertDetail } from "./alert-detail";

/** Où en est une alerte, pour la liste : en cours, à venir, ou terminée. */
export type AlertStatus = "current" | "planned" | "ended";

export const STATUSES: Record<AlertStatus, { label: string; color: string }> = {
	current: { label: "En cours", color: "#1D56C8" },
	planned: { label: "À venir", color: "#B54708" },
	ended: { label: "Terminées / supprimées", color: "#5B626A" },
};

/**
 * En cours : dans ses dates, fût-ce hors de ses heures. Terminée : échue, ou retirée du flux — elle n'y
 * reviendra pas, quelles que soient ses dates.
 */
function statusOf(alert: AlertDto): AlertStatus {
	if (alert.publication === "withdrawn" || alert.phase === "expired") return "ended";
	return alert.phase === "planned" ? "planned" : "current";
}

/**
 * Les alertes de service : reçues du flux TCAR, analysées, corrigées puis republiées. La liste à
 * gauche, filtrée par état, par cause et par ligne ; le détail de celle qu'on a choisie à droite.
 */
export function AlertsPage() {
	const search = alertsRoute.useSearch();
	const { alert: selectedNumber, todo, status = "ALL", cause = "ALL", line = "all" } = search;
	const navigate = useNavigate({ from: "/alerts" });
	const alerts = useAlerts();
	const modifications = useModifications();
	const routes = useRoutes();
	const filter = (change: Partial<typeof search>, replace = false) =>
		navigate({ search: (current) => ({ ...current, ...change }), replace });
	const [query, setQuery] = useSearchText(search.q ?? "", (q) => filter({ q: q || undefined }, true));

	const list = alerts.data ?? [];
	const causes = useMemo(() => {
		const counts = new Map<string, number>();
		for (const alert of list) {
			const key = alert.published.cause ?? "UNKNOWN_CAUSE";
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts].sort((a, b) => b[1] - a[1]);
	}, [list]);
	const statuses = (Object.keys(STATUSES) as AlertStatus[]).map(
		(key) => [key, list.filter((alert) => statusOf(alert) === key).length] as const,
	);
	// Les lignes que cite au moins une alerte, dans l'ordre du réseau.
	const lines = useMemo(() => {
		const cited = new Set(list.flatMap((alert) => alert.lines.map((entry) => entry.routeId)));
		return (routes.data ?? []).filter((route) => cited.has(route.routeId));
	}, [list, routes.data]);

	// Les alertes à traiter d'abord, les traitées ensuite — chacune dans l'ordre du flux.
	const visible = list
		.filter((alert) => !todo || alert.checkedAt === null)
		.sort((a, b) => Number(a.checkedAt !== null) - Number(b.checkedAt !== null))
		.filter(
			(alert) =>
				(status === "ALL" || statusOf(alert) === status) &&
				(cause === "ALL" || (alert.published.cause ?? "UNKNOWN_CAUSE") === cause) &&
				(line === "all" || alert.lines.some((entry) => entry.routeId === line)) &&
				(query.length === 0 ||
					searchable(
						[alert.alertNumber, alert.published.headerText, ...alert.lines.map((line) => line.line)].join(" "),
					).includes(searchable(query))),
		);
	const selected = list.find((alert) => alert.alertNumber === selectedNumber) ?? visible[0];

	return (
		<>
			<PageHeader title="Alertes de service">
				<InputGroup className="h-10 max-w-[300px] min-w-[180px] flex-[0_1_300px] bg-card">
					<InputGroupAddon>
						<SearchIcon />
					</InputGroupAddon>
					<InputGroupInput
						type="search"
						aria-label="Rechercher une alerte"
						placeholder="Alerte, ligne, numéro…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
				</InputGroup>
			</PageHeader>

			<FilterBar>
				<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
					<Switch checked={todo === true} onCheckedChange={(on) => filter({ todo: on ? true : undefined })} />
					<span>À traiter seulement</span>
					<span className="font-mono text-xs text-subtle">
						{list.filter((alert) => alert.checkedAt === null).length}
					</span>
				</label>
				<Separator orientation="vertical" className="h-6!" />
				<ChipFilter
					label="État"
					value={status}
					onChange={(next) => filter({ status: next === "ALL" ? undefined : (next as AlertStatus) })}
					total={list.length}
					options={statuses.map(([key, count]) => ({
						key,
						label: STATUSES[key].label,
						color: STATUSES[key].color,
						count,
					}))}
				/>
				<Separator orientation="vertical" className="h-6!" />
				<ChipFilter
					label="Cause"
					value={cause}
					onChange={(next) => filter({ cause: next === "ALL" ? undefined : next })}
					total={list.length}
					options={causes.map(([key, count]) => ({ key, label: causeLabel(key), color: causeColor(key), count }))}
				/>
				<Separator orientation="vertical" className="h-6!" />
				<label className="flex items-center gap-2 text-[13px] font-medium text-strong">
					Ligne
					<Select value={line} onValueChange={(next) => filter({ line: next === "all" ? undefined : next })}>
						<SelectTrigger className="min-w-40">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectGroup>
								<SelectItem value="all">Toutes les lignes</SelectItem>
								{lines.map((entry) => (
									<SelectItem key={entry.routeId} value={entry.routeId}>
										<LineOption route={entry} />
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</label>
			</FilterBar>

			<div className="flex flex-wrap items-start gap-5 px-6 pt-5 pb-10">
				<section
					aria-label="Liste des alertes"
					className="flex min-w-0 flex-[1_1_320px] flex-col gap-2 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:max-w-[420px] lg:overflow-y-auto lg:pr-1"
				>
					{alerts.isPending
						? [0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-28 rounded-lg" />)
						: visible.map((alert) => (
								<AlertCard
									key={alert.alertNumber}
									alert={alert}
									selected={alert.alertNumber === selected?.alertNumber}
								/>
							))}
					{!alerts.isPending && visible.length === 0 ? (
						<p className="m-0 rounded-lg border border-dashed border-input px-4 py-6 text-center text-muted-foreground">
							Aucune alerte pour ce filtre.
						</p>
					) : null}
				</section>

				<section aria-label="Détail de l'alerte" className="min-w-0 flex-[999_1_520px]">
					{selected ? (
						<AlertDetail key={selected.alertNumber} alert={selected} modifications={modifications.data ?? []} />
					) : alerts.isPending ? (
						<Skeleton className="h-96 rounded-lg" />
					) : (
						<Empty className="rounded-lg border bg-card">
							<EmptyHeader>
								<EmptyTitle>Aucune alerte</EmptyTitle>
								<EmptyDescription>Le flux TCAR n'en porte aucune pour l'instant.</EmptyDescription>
							</EmptyHeader>
						</Empty>
					)}
				</section>
			</div>
		</>
	);
}

function AlertCard({ alert, selected }: { alert: AlertDto; selected: boolean }) {
	const publication = ALERT_PUBLICATIONS[alert.publication];
	const phase = ALERT_PHASES[alert.phase];
	return (
		<Link
			from="/alerts"
			search={(current) => ({ ...current, alert: alert.alertNumber, all: undefined })}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex w-full flex-col gap-2 rounded-lg border bg-card px-4 py-3.5 text-left text-foreground! no-underline",
				selected ? "border-[#B9CDF3] bg-[#F7F9FE] shadow-[inset_3px_0_0_#1D56C8]" : "hover:border-input",
				alert.checkedAt !== null && !selected && "bg-muted opacity-75",
			)}
		>
			<span className="flex w-full items-center gap-2">
				<span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
					<span
						className="inline-flex items-center gap-1.5 font-mono text-[11px] font-semibold tracking-wider whitespace-nowrap uppercase"
						style={{ color: causeColor(alert.published.cause) }}
					>
						<span
							aria-hidden="true"
							className="size-2 flex-none rounded-full"
							style={{ background: causeColor(alert.published.cause) }}
						/>
						{causeLabel(alert.published.cause)}
					</span>
					<span className="font-mono text-[11px] whitespace-nowrap text-muted-foreground">N° {alert.alertNumber}</span>
				</span>
				{alert.checkedAt !== null ? (
					<span title="Traitée" className="ml-auto inline-flex flex-none text-success">
						<CircleCheckIcon aria-label="Traitée" className="size-4" />
					</span>
				) : null}
			</span>
			<span className="flex flex-wrap items-center gap-1.5">
				<StatusPill tone={phase.tone}>{phase.label}</StatusPill>
				<StatusPill tone={publication.tone}>{publication.label}</StatusPill>
			</span>
			<span className="text-[15px] font-semibold text-foreground">{alert.published.headerText}</span>
			<span className="flex flex-wrap items-center gap-1.5">
				{alert.lines.slice(0, 8).map((line) => (
					<LineBadge key={line.routeId} line={line} />
				))}
				{alert.lines.length > 8 ? (
					<span className="text-xs text-muted-foreground">+{alert.lines.length - 8}</span>
				) : null}
				<span className="text-xs text-muted-foreground">{describePeriods(alert.periods)}</span>
			</span>
			{alert.warnings.length > 0 ? (
				<span className="inline-flex items-center gap-1.5 text-xs font-semibold text-warning-foreground">
					<TriangleAlertIcon aria-hidden="true" className="size-3.5" />
					Analyse à vérifier
				</span>
			) : null}
		</Link>
	);
}

/**
 * Un filtre en pastilles : « Toutes », puis une par valeur, chacune à sa couleur et avec son compte. Un
 * second clic sur la pastille choisie revient à « Toutes ».
 */
function ChipFilter({
	label,
	value,
	onChange,
	total,
	options,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	total: number;
	options: { key: string; label: string; color: string; count: number }[];
}) {
	return (
		<>
			<span className="mr-1 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{label}</span>
			<ToggleGroup
				type="single"
				variant="outline"
				spacing={2}
				className="flex-wrap"
				value={value}
				onValueChange={(next) => onChange(next || "ALL")}
				aria-label={`Filtrer par ${label.toLowerCase()}`}
			>
				{[{ key: "ALL", label: "Toutes", color: "#15181B", count: total }, ...options].map((option) => (
					<ToggleGroupItem
						key={option.key}
						value={option.key}
						style={{ "--chip": option.color } as React.CSSProperties}
						className="h-8 rounded-full px-3 data-[state=on]:border-(--chip) data-[state=on]:bg-(--chip) data-[state=on]:text-white data-[state=on]:hover:bg-(--chip) data-[state=on]:hover:text-white"
					>
						{option.key === "ALL" ? null : (
							<span
								aria-hidden="true"
								className="size-2 rounded-full bg-(--chip) group-data-[state=on]/toggle:bg-white"
							/>
						)}
						{option.label}
						<span className="font-mono text-xs opacity-85">{option.count}</span>
					</ToggleGroupItem>
				))}
			</ToggleGroup>
		</>
	);
}
