import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { MetricCard } from "@/components/MetricCard";
import type { MaskclawStatsView } from "@/stats";

export function MaskPage({ maskclaw }: { maskclaw: MaskclawStatsView | null }) {
  if (!maskclaw) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>Waiting for MaskClaw stats</EmptyTitle>
          <EmptyDescription>The sidecar has not answered /v1/maskclaw/stats yet.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  if (!maskclaw.enabled) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="font-heading text-3xl">MASKED</h1>
        <p className="text-muted-foreground">Masking is off.</p>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6">
      <h1 className="font-heading text-3xl">MASKED</h1>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Masked" value={maskclaw.matches} />
        <MetricCard label="Requests" value={maskclaw.requests} />
        <MetricCard label="With hits" value={maskclaw.requestsWithMatches} />
        <MetricCard label="Force local" value={maskclaw.forceLocalOverrides} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Sessions" value={maskclaw.sessionsActive} />
        <MetricCard label="In RAM" value={maskclaw.uniqueValues} />
        <MetricCard label="Restore miss" value={maskclaw.restoreMisses} />
        <MetricCard label="Critical" value={maskclaw.critical} />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Residual" value={maskclaw.residual} />
        <MetricCard label="Dictionary" value={maskclaw.dictionaryCount} />
        <MetricCard label="Regex rules" value={maskclaw.regexCount} />
        <MetricCard label="Allowlist" value={maskclaw.allowlistCount} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>By kind</CardTitle>
          <CardDescription>Placeholder types written this process lifetime.</CardDescription>
        </CardHeader>
        <CardContent>
          {maskclaw.byKind.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing masked yet</EmptyTitle>
                <EmptyDescription>Send a request through the sidecar to see kinds here.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {maskclaw.byKind.map(([kind, count]) => (
                <li key={kind}>
                  <Card size="sm">
                    <CardHeader>
                      <CardDescription className="font-mono uppercase">{kind}</CardDescription>
                      <p className="font-mono text-3xl leading-none font-medium tabular-nums tracking-tight">{count}</p>
                    </CardHeader>
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">force_local {maskclaw.forceLocal}</Badge>
        {maskclaw.localRouteId ? (
          <Badge variant="secondary">local route {maskclaw.localRouteId}</Badge>
        ) : null}
        <Badge variant="outline">ttl {maskclaw.sessionTtlSecs}s</Badge>
      </div>
    </div>
  );
}
