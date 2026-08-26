import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { DETECTOR_KEYS, DETECTOR_LABELS, type MaskclawStatsView } from "@/stats";
import { parseDetectors } from "@/tomlEdit";

export function EngineSettingsPage({
  maskclaw: _maskclaw,
  routesToml,
  maskclawToml,
  onRoutesToml,
  onMaskclawToml,
  onSaveRoutes,
  onSaveMaskclaw,
  onDetector,
  busy,
}: {
  maskclaw: MaskclawStatsView | null;
  routesToml: string;
  maskclawToml: string;
  onRoutesToml: (value: string) => void;
  onMaskclawToml: (value: string) => void;
  onSaveRoutes: () => void;
  onSaveMaskclaw: () => void;
  onDetector: (key: (typeof DETECTOR_KEYS)[number], enabled: boolean) => void;
  busy: boolean;
}) {
  // Drive switches from the toml editor buffer, not live /stats (which lags restart).
  const detectors = parseDetectors(maskclawToml);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6">
      <h1 className="font-heading text-3xl">SETTINGS</h1>

      <Card>
        <CardHeader>
          <CardTitle>Built-in detectors</CardTitle>
          <CardDescription>Updates maskclaw.toml and restarts the engine.</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {DETECTOR_KEYS.map((key) => (
              <Field key={key} orientation="horizontal">
                <FieldLabel htmlFor={`detector-${key}`}>{DETECTOR_LABELS[key]}</FieldLabel>
                <Switch
                  id={`detector-${key}`}
                  checked={detectors[key]}
                  disabled={busy}
                  onCheckedChange={(checked) => onDetector(key, checked)}
                />
              </Field>
            ))}
          </FieldGroup>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>routes.toml</CardTitle>
          <CardDescription>Clients, targets, and routes served on port 4000.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={routesToml}
            onChange={(event) => onRoutesToml(event.target.value)}
            rows={18}
            className="max-w-full min-w-0 font-mono text-xs"
          />
          <div>
            <Button type="button" disabled={busy} onClick={onSaveRoutes}>
              Save routes
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>maskclaw.toml</CardTitle>
          <CardDescription>Detectors, dictionaries, regex, and force_local policy.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Textarea
            value={maskclawToml}
            onChange={(event) => onMaskclawToml(event.target.value)}
            rows={18}
            className="max-w-full min-w-0 font-mono text-xs"
          />
          <div>
            <Button type="button" disabled={busy} onClick={onSaveMaskclaw}>
              Save MaskClaw
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
