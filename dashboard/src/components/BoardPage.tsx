import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDownIcon, PlayIcon, RotateCcwIcon, SquareIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ProbeResult } from "@/api";
import { CopyValue } from "@/components/CopyValue";
import { MetricCard } from "@/components/MetricCard";
import { copyText } from "@/copyText";
import { clientBaseUrls, type ClientBaseUrls } from "@/clientTarget";
import { formatCount, formatMs, lastRequestHop, trackStatsByRoute, type StatsViewModel } from "@/engineStats";
import { clientModelLabel, type RouteRow } from "@/models";
import type { HostNetwork } from "@/api";
import type { Surface } from "@/surface";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function BoardPage({
  engineUp,
  listenUrl,
  surface,
  hostNetwork,
  routes,
  backendIdsByRoute = {},
  modelId,
  stats,
  logs,
  probes,
  busy,
  resetting,
  onStart,
  onStop,
  onRestart,
  onReset,
  onProbe,
  onDismissProbes,
}: {
  engineUp: boolean;
  listenUrl: string;
  surface: Surface;
  hostNetwork: HostNetwork | null;
  routes: RouteRow[];
  backendIdsByRoute?: Record<string, string[]>;
  modelId: string;
  stats: StatsViewModel | null;
  logs: string[];
  probes: ProbeResult[];
  busy: boolean;
  resetting: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onReset: () => void;
  onProbe: () => void;
  onDismissProbes: () => void;
}) {
  const byRoute = trackStatsByRoute(
    routes.map((route) => route.id),
    stats,
    backendIdsByRoute,
  );
  const targets: ClientBaseUrls = clientBaseUrls({ surface, listenUrl, hostNetwork });
  const hop = lastRequestHop(logs);
  const modelChoices = useMemo(() => {
    const ids = routes.map((route) => route.id);
    if (modelId && !ids.includes(modelId)) {
      return [modelId, ...ids];
    }
    return ids.length > 0 ? ids : modelId ? [modelId] : [];
  }, [modelId, routes]);
  const [clientOpen, setClientOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState(() =>
    modelChoices.includes(modelId) ? modelId : (modelChoices[0] ?? modelId),
  );
  const modelInputRef = useRef<HTMLInputElement>(null);
  const modelItems = useMemo(
    () => Object.fromEntries(modelChoices.map((id) => [id, clientModelLabel(id)])),
    [modelChoices],
  );
  useEffect(() => {
    if (modelChoices.includes(selectedModel)) {
      return;
    }
    setSelectedModel(modelChoices.includes(modelId) ? modelId : (modelChoices[0] ?? modelId));
  }, [modelChoices, modelId, selectedModel]);

  async function copyModelId(id: string) {
    await copyText(id);
    toast.success(`Copied model ${id}`);
  }
  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6">
      <header className="flex min-w-0 flex-col gap-4">
        <h1 className="font-heading text-3xl">HOME</h1>
        <div className="flex flex-wrap items-center gap-2">
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium",
              engineUp
                ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-300"
                : "border-red-500/40 bg-red-500/15 text-red-300",
            )}
          >
            <span
              aria-hidden="true"
              className={cn("size-2.5 rounded-full", engineUp ? "bg-emerald-400" : "bg-red-400")}
            />
            {engineUp ? "Engine live" : "Engine down"}
          </p>
          {engineUp ? (
            <Button type="button" variant="destructive" disabled={busy} onClick={onStop}>
              <SquareIcon data-icon="inline-start" />
              Stop
            </Button>
          ) : (
            <Button type="button" disabled={busy} onClick={onStart}>
              <PlayIcon data-icon="inline-start" />
              Start
            </Button>
          )}
          <Button type="button" variant="outline" disabled={busy} onClick={onRestart}>
            Restart
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onProbe}>
            Test connections
          </Button>
          <Button type="button" variant="outline" disabled={resetting} onClick={onReset}>
            <RotateCcwIcon data-icon="inline-start" />
            Reset stats
          </Button>
        </div>
        {probes.length > 0 ? (
          <div
            role="region"
            aria-label="Connection results"
            className="border-amber-500/40 bg-amber-400/15 text-amber-50 w-full max-w-3xl rounded-lg border px-4 py-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-medium text-amber-100">Connection results</p>
                <p className="text-amber-100/70 text-sm">Cloud and local endpoints this box talks to.</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label="Dismiss connection results"
                className="text-amber-100 hover:bg-amber-400/20 hover:text-amber-50"
                onClick={onDismissProbes}
              >
                <XIcon />
              </Button>
            </div>
            <ul className="mt-3 flex flex-col gap-2">
              {probes.map((probe) => (
                <li key={probe.url} className="flex flex-wrap items-baseline gap-2">
                  <Badge variant={probe.ok ? "secondary" : "destructive"}>{probe.label}</Badge>
                  <span className="font-mono text-sm break-all">{probe.url}</span>
                  <span className="text-amber-100/70 text-sm">{probe.detail}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </header>

      <Card>
        <CardHeader className="p-0">
          <button
            type="button"
            aria-expanded={clientOpen}
            aria-controls="client-target-panel"
            className="flex w-full items-center justify-between gap-3 px-(--card-spacing) text-left"
            onClick={() => setClientOpen((open) => !open)}
          >
            <CardTitle>Client target</CardTitle>
            <ChevronDownIcon
              aria-hidden="true"
              className={cn("size-4 shrink-0 text-muted-foreground transition-transform", clientOpen && "rotate-180")}
            />
          </button>
        </CardHeader>
        {clientOpen ? (
          <>
            <CardDescription className="px-(--card-spacing)">
              Point any OpenAI-compatible client at this box: set its base URL to one of the
              addresses below.
            </CardDescription>
            <CardContent id="client-target-panel" className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-muted-foreground">Base URL</p>
              <p className="font-mono">{targets.baseUrl}</p>
              {targets.alternateBaseUrl ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  Alternate (IP): <span className="text-foreground font-mono">{targets.alternateBaseUrl}</span>
                </p>
              ) : null}
            </div>
            <CopyValue label="base URL" value={targets.baseUrl} />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-muted-foreground">Base URL v1</p>
              <p className="font-mono">{targets.baseUrlV1}</p>
              {targets.alternateBaseUrlV1 ? (
                <p className="text-muted-foreground mt-1 text-sm">
                  Alternate (IP):{" "}
                  <span className="text-foreground font-mono">{targets.alternateBaseUrlV1}</span>
                </p>
              ) : null}
            </div>
            <CopyValue label="base URL v1" value={targets.baseUrlV1} buttonLabel="Copy V1" />
          </div>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p id="client-model-label" className="text-muted-foreground">
                Model
              </p>
              <Select
                value={selectedModel}
                items={modelItems}
                modal={false}
                inputRef={modelInputRef}
                onValueChange={(value) => {
                  if (typeof value !== "string" || !value) {
                    return;
                  }
                  setSelectedModel(value);
                  void copyModelId(value);
                }}
              >
                <SelectTrigger
                  aria-labelledby="client-model-label"
                  className="mt-1 w-full max-w-md font-mono"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="start" alignItemWithTrigger={false}>
                  <SelectGroup>
                    {modelChoices.map((id) => (
                      <SelectItem key={id} value={id} className="font-mono">
                        {clientModelLabel(id)}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <CopyValue
              label="model"
              value={selectedModel}
              getValue={() => modelInputRef.current?.value?.trim() || selectedModel}
              aria-label="Copy model"
            />
          </div>
          {hop ? (
            <div>
              <p className="text-muted-foreground">Last request</p>
              <p className="font-mono">
                {hop.requested} → {hop.selected}
              </p>
            </div>
          ) : null}
            </CardContent>
          </>
        ) : (
          <div id="client-target-panel" hidden />
        )}
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Requests" value={stats?.totalRequests ?? 0} />
        <MetricCard label="Errors" value={stats?.totalErrors ?? 0} />
        <MetricCard label="Classifier" value={stats?.classifierRequests ?? 0} />
        <MetricCard label="Fallbacks" value={stats?.routingFallbacks.count ?? 0} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Prompt tokens" value={stats?.totalTokens.prompt_tokens ?? 0} />
        <MetricCard label="Completion" value={stats?.totalTokens.completion_tokens ?? 0} />
        <MetricCard label="Cached" value={stats?.totalTokens.cached_tokens ?? 0} />
        <MetricCard
          label="Routing overhead"
          value={formatMs(stats?.routingOverhead.avgMs ?? null)}
          hint={stats ? `${formatCount(stats.routingOverhead.count)} decisions` : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tracks</CardTitle>
          <CardDescription>Each row is a route id clients can send as model.</CardDescription>
        </CardHeader>
        <CardContent>
          {routes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No routes yet</EmptyTitle>
                <EmptyDescription>Start the engine, then this table fills from /v1/models.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Track</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Calls</TableHead>
                  <TableHead>Errors</TableHead>
                  <TableHead>Avg latency</TableHead>
                  <TableHead>Context</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {routes.map((route) => {
                  const model = byRoute[route.id];
                  return (
                    <TableRow key={route.id}>
                      <TableCell className="whitespace-nowrap font-mono">{route.track}</TableCell>
                      <TableCell>
                        <div className="font-mono break-all">{route.id}</div>
                        {model && model.id !== route.id ? (
                          <div className="font-mono text-muted-foreground">{model.id}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="whitespace-normal font-mono tabular-nums">
                        {model ? formatCount(model.calls) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-normal font-mono tabular-nums">
                        {model ? formatCount(model.errors) : "—"}
                      </TableCell>
                      <TableCell className="whitespace-normal font-mono tabular-nums">
                        {formatMs(model?.avgLatencyMs ?? null)}
                      </TableCell>
                      <TableCell className="whitespace-normal font-mono tabular-nums">
                        {route.contextWindow ? formatCount(route.contextWindow) : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
          <CardDescription>Routing log and engine console on this box.</CardDescription>
        </CardHeader>
        <CardContent>
          <pre className="max-h-64 max-w-full overflow-x-hidden overflow-y-auto font-mono text-xs break-all whitespace-pre-wrap">
            {logs.length > 0 ? logs.join("\n") : "No movements yet."}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
