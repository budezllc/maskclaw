const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export function parseEngineEnv(text: string): Record<string, string> {
  const stored: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim();
    if (!stripped || stripped.startsWith("#") || !stripped.includes("=")) continue;
    const eq = stripped.indexOf("=");
    const name = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (ENV_NAME.test(name)) stored[name] = value;
  }
  return stored;
}

export function formatEngineEnv(stored: Record<string, string>): string {
  const lines = ["# MaskClaw engine environment. Keep this file private.", ""];
  for (const [name, value] of Object.entries(stored)) {
    lines.push(`${name}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function secretStatus(
  namesFromToml: string[],
  stored: Record<string, string>,
): { name: string; set: boolean }[] {
  const names = [...namesFromToml];
  for (const key of Object.keys(stored)) {
    if (!names.includes(key)) names.push(key);
  }
  return names.map((name) => ({ name, set: Boolean(stored[name]) }));
}

export function applySecretUpdates(
  stored: Record<string, string>,
  values: Record<string, string>,
): Record<string, string> {
  const next = { ...stored };
  let wrote = false;
  for (const [name, value] of Object.entries(values)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(`invalid env name ${name}`);
    }
    const trimmed = value.trim();
    if (trimmed) {
      next[name] = trimmed;
      wrote = true;
    }
  }
  if (!wrote) {
    throw new Error("enter at least one API key");
  }
  return next;
}
