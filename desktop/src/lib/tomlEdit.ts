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

export const DETECTOR_KEYS: DetectorKey[] = [
  "email",
  "phone",
  "ssn",
  "credit_card",
  "jwt",
  "aws_key",
  "api_key",
];

export const DETECTOR_LABELS: Record<DetectorKey, string> = {
  email: "Email",
  phone: "Phone",
  ssn: "SSN",
  credit_card: "Credit card",
  jwt: "JWT",
  aws_key: "AWS key",
  api_key: "API key",
};

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
    bodyEnd += 1;
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
