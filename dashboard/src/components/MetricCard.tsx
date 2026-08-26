import { Card, CardContent, CardDescription, CardHeader } from "@/components/ui/card";
import { formatCount } from "@/engineStats";

export function MetricCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <p className="font-mono text-3xl leading-none font-medium tabular-nums tracking-tight">
          {typeof value === "number" ? formatCount(value) : value}
        </p>
      </CardHeader>
      {hint ? (
        <CardContent>
          <p className="text-muted-foreground">{hint}</p>
        </CardContent>
      ) : null}
    </Card>
  );
}
