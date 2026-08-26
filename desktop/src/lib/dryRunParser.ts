export interface DryRunError {
  kind: "parse" | "validate" | "unknown";
  path?: string;
  technical: string;
  userMessage: string;
}

const PARSE_PREFIX = /failed to parse TOML:\s*/i;

function splitConfigPrefix(text: string): { path?: string; rest: string } {
  const marker = /invalid server config\s+/i.exec(text);
  if (!marker) return { rest: text };
  const after = text.slice(marker.index + marker[0].length);
  const sep = after.search(/:\s+(?!\\)/);
  if (sep < 0) return { rest: after };
  return { path: after.slice(0, sep).trim(), rest: after.slice(sep + 1).trim() };
}

export function parseDryRunStderr(stderr: string, exitCode: number): DryRunError | null {
  const text = stderr.trim();
  if (exitCode === 0 && !text) return null;
  if (exitCode === 0) return null;

  const { path, rest } = splitConfigPrefix(text);

  if (PARSE_PREFIX.test(rest) || PARSE_PREFIX.test(text)) {
    const inner = rest.replace(PARSE_PREFIX, "").trim();
    return {
      kind: "parse",
      path,
      technical: text,
      userMessage: rewriteParse(inner),
    };
  }

  if (path || /deny_unknown_fields|unknown field|missing field/i.test(text)) {
    return {
      kind: "validate",
      path,
      technical: text,
      userMessage: rewriteValidate(rest || text),
    };
  }

  return {
    kind: "unknown",
    path,
    technical: text || `switchyard-server exited with code ${exitCode}`,
    userMessage:
      "The routing file did not start. Check the highlighted field or open Raw config in Settings.",
  };
}

function rewriteParse(inner: string): string {
  if (/deny_unknown_fields/i.test(inner)) {
    return "This file has a key Switchyard does not use. Remove the extra line and try again.";
  }
  if (/missing field\s+`?(\w+)`?/i.test(inner)) {
    const field = /missing field\s+`?(\w+)`?/i.exec(inner)?.[1];
    return `The routing file is missing “${field}”. Add it or re-run Setup.`;
  }
  return `The routing file could not be read. ${plainInner(inner)}`;
}

function rewriteValidate(inner: string): string {
  if (/deny_unknown_fields/i.test(inner)) {
    return "This file has a key Switchyard does not use. Remove the extra line and try again.";
  }
  if (/missing field targets/i.test(inner)) {
    return "The routing file needs a targets section. Re-run Setup to rebuild it.";
  }
  if (/unknown field/i.test(inner)) {
    return "This file has a key Switchyard does not use. Remove the extra line and try again.";
  }
  if (/api_key_env/i.test(inner) && /empty|missing|not set/i.test(inner)) {
    return "A cloud or local key is missing. Paste it in Setup — keys are not stored in the routing file.";
  }
  return plainInner(inner);
}

function plainInner(inner: string): string {
  return inner.replace(/\s+/g, " ").replace(/deny_unknown_fields[^.]*\.?/gi, "").trim();
}

export function formatDryRunForWizard(error: DryRunError): string {
  return error.userMessage;
}
