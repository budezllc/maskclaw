export function extractModelIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: Array<{ id?: string }> };
    return (parsed.data ?? []).map((item) => item.id).filter((id): id is string => Boolean(id));
  } catch {
    return [];
  }
}

export function modelsProbeUrl(url: string): string {
  const base = url.replace(/\/$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

export function completionsProbeUrl(url: string): string {
  const base = url.replace(/\/$/, "");
  return base.endsWith("/v1") ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}
