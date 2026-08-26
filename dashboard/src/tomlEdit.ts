/** Pin-local route ids the Models screen can enable. Unsloth is first in LOCAL_ORDER, which used to leak into maskclaw.toml. */
export const LOCAL_ROUTE_IDS = ["unsloth-local", "lmstudio-local", "gemma-local"] as const;

export function extractApiKeyEnvs(toml: string): string[] {
  const names = [...toml.matchAll(/api_key_env\s*=\s*"([A-Z][A-Z0-9_]*)"/g)].map((match) => match[1]);
  return [...new Set(names)];
}

export function extractBaseUrls(toml: string): string[] {
  const urls = [...toml.matchAll(/base_url\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
  return [...new Set(urls)];
}

export function tomlContainsLiteralSecret(toml: string): boolean {
  return /(?:^|\n)\s*api_key\s*=\s*"(sk-|AKIA|ghp_|glpat-)/m.test(toml);
}

const DETECTOR_DEFAULTS = {
  email: true,
  phone: true,
  ssn: true,
  credit_card: true,
  jwt: true,
  aws_key: true,
  api_key: true,
} as const;

export type DetectorKey = keyof typeof DETECTOR_DEFAULTS;

function splitLines(toml: string): string[] {
  return toml.split(/\r?\n/);
}

function isCommentOrBlank(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length === 0 || trimmed.startsWith("#");
}

function isSectionHeader(line: string): boolean {
  return /^\s*\[/.test(line) && !isCommentOrBlank(line);
}

/** Last uncommented `[detectors]` table and its assignment lines. */
export function detectorsSectionBounds(toml: string): { header: number; bodyStart: number; bodyEnd: number } | null {
  const lines = splitLines(toml);
  let header = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === "[detectors]") {
      header = i;
    }
  }
  if (header < 0) {
    return null;
  }
  let bodyStart = header + 1;
  while (bodyStart < lines.length && isCommentOrBlank(lines[bodyStart])) {
    bodyStart += 1;
  }
  let bodyEnd = bodyStart;
  while (bodyEnd < lines.length && !isSectionHeader(lines[bodyEnd])) {
    if (!isCommentOrBlank(lines[bodyEnd])) {
      bodyEnd += 1;
    } else {
      bodyEnd += 1;
    }
  }
  return { header, bodyStart, bodyEnd };
}

function readDetectorAssignments(lines: string[], start: number, end: number): Partial<Record<DetectorKey, boolean>> {
  const out: Partial<Record<DetectorKey, boolean>> = {};
  for (let i = start; i < end; i += 1) {
    const line = lines[i];
    if (isCommentOrBlank(line) || isSectionHeader(line)) {
      continue;
    }
    const match = line.match(/^\s*([a-z_]+)\s*=\s*(true|false)\s*$/);
    if (!match) {
      continue;
    }
    const key = match[1] as DetectorKey;
    if (key in DETECTOR_DEFAULTS) {
      out[key] = match[2] === "true";
    }
  }
  return out;
}

/** Built-in detectors default on; overlay explicit `[detectors]` assignments from toml. */
export function parseDetectors(toml: string): Record<DetectorKey, boolean> {
  const out: Record<DetectorKey, boolean> = { ...DETECTOR_DEFAULTS };
  const bounds = detectorsSectionBounds(toml);
  if (!bounds) {
    return out;
  }
  const lines = splitLines(toml);
  const assigned = readDetectorAssignments(lines, bounds.bodyStart, bounds.bodyEnd);
  for (const key of Object.keys(DETECTOR_DEFAULTS) as DetectorKey[]) {
    if (typeof assigned[key] === "boolean") {
      out[key] = assigned[key] as boolean;
    }
  }
  return out;
}

export function setDetectorLine(toml: string, key: string, enabled: boolean): string {
  if (!(key in DETECTOR_DEFAULTS)) {
    return toml;
  }
  const flag = enabled ? "true" : "false";
  const lines = splitLines(toml);
  const bounds = detectorsSectionBounds(toml);
  const detectorKey = key as DetectorKey;

  if (!bounds) {
    const trimmed = toml.trimEnd();
    const prefix = trimmed.length > 0 ? `${trimmed}\n\n` : "";
    return `${prefix}[detectors]\n${detectorKey} = ${flag}\n`;
  }

  let replaced = false;
  for (let i = bounds.bodyStart; i < bounds.bodyEnd; i += 1) {
    const line = lines[i];
    if (isCommentOrBlank(line)) {
      continue;
    }
    const match = line.match(/^(\s*([a-z_]+)\s*=\s*)(?:true|false)(\s*)$/);
    if (!match || match[2] !== detectorKey) {
      continue;
    }
    lines[i] = `${match[1]}${flag}${match[3] ?? ""}`;
    replaced = true;
    break;
  }

  if (!replaced) {
    lines.splice(bounds.bodyEnd, 0, `${detectorKey} = ${flag}`);
  }

  return lines.join("\n");
}

/** Live `*-local` route ids still present in routes.toml. */
export function localRouteIdsInToml(toml: string): string[] {
  return LOCAL_ROUTE_IDS.filter((id) => new RegExp(`(?:^|\\n)\\s*id\\s*=\\s*"${id}"`, "m").test(toml));
}

function quoteTomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isTableHeader(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith("[") && !trimmed.startsWith("#");
}

/** Set or remove a top-level `key = "..."` assignment (before the first table). */
export function setTopLevelTomlString(toml: string, key: string, value: string): string {
  const lines = splitLines(toml);
  const assign = new RegExp(`^(\\s*)${key}\\s*=`);
  const next: string[] = [];
  let sawTable = false;
  let replaced = false;
  for (const line of lines) {
    if (!sawTable && isTableHeader(line)) {
      if (!replaced && value) {
        next.push(`${key} = ${quoteTomlString(value)}`);
        replaced = true;
      }
      sawTable = true;
    }
    if (!sawTable && assign.test(line)) {
      replaced = true;
      if (!value) {
        continue;
      }
      next.push(`${key} = ${quoteTomlString(value)}`);
      continue;
    }
    next.push(line);
  }
  if (!replaced && value) {
    const trimmed = next.join("\n").trimEnd();
    return trimmed.length > 0 ? `${trimmed}\n${key} = ${quoteTomlString(value)}\n` : `${key} = ${quoteTomlString(value)}\n`;
  }
  return next.join("\n");
}

/**
 * Keep maskclaw.toml `local_route_id` pointed at an enabled local pin.
 * Stale `unsloth-local` survives unchecking Unsloth because Models only rewrites routes.toml.
 */
export function syncMaskclawLocalRoute(maskclawToml: string, routesToml: string): string {
  const live = localRouteIdsInToml(routesToml);
  const currentMatch = maskclawToml.match(/^\s*local_route_id\s*=\s*"([^"]*)"/m);
  const current = currentMatch?.[1]?.trim() ?? "";
  const next = live.includes(current) ? current : (live[0] ?? "");
  return setTopLevelTomlString(maskclawToml, "local_route_id", next);
}

export function tailJsonl(raw: string, maxLines: number): string[] {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.slice(-maxLines);
}
