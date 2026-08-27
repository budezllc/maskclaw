import { useEffect, useMemo, useRef, useState } from "react";
import { CpuIcon, HouseIcon, Settings2Icon, ShieldIcon, ServerIcon } from "lucide-react";
import { ThemeProvider } from "next-themes";
import { toast } from "sonner";
import {
  ENGINE_LISTEN_URL,
  connectWifi,
  connectEthernet,
  fetchControlSnapshot,
  tryFetchEngineStats,
  fetchHealth,
  fetchHostNetwork,
  fetchHostSession,
  fetchModels,
  fetchSecrets,
  hostLogin,
  hostLogout,
  probeBackend,
  probeBackends,
  resetEngineStats,
  restartEngine,
  saveToml,
  setDashboardPassword,
  setHostname as putHostname,
  startEngine,
  stopEngine,
  writeSecrets,
  type HostNetwork,
  type HostSession,
  type ProbeResult,
} from "@/api";
import { BoardPage } from "@/components/BoardPage";
import { BoxPage, LoginScreen, SetupPasswordScreen } from "@/components/BoxPage";
import { EngineSettingsPage } from "@/components/EngineSettingsPage";
import { MaskPage } from "@/components/MaskPage";
import { ModelsPage } from "@/components/ModelsPage";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Skeleton } from "@/components/ui/skeleton";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { adaptStats, type StatsViewModel } from "@/engineStats";
import { pageFromHash, type Page } from "@/hashNav";
import { defaultModelFromPayload, parseRoutes, routeIdsFromToml, routeRowsFromIds, type RouteRow } from "@/models";
import { createPollGate, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, runPollTick } from "@/poll";
import { adaptMaskclawStats, tryFetchStats, type DetectorToggles, type MaskclawStatsView } from "@/stats";
import { assertNoSecretsInToml, secretValuesRecord, secretsFromSetup } from "@/secretMapping";
import { showBoxAdmin, surfaceFromEnv } from "@/surface";
import { backendIdsByRoute } from "@/setupHydrate";
import { setDetectorLine } from "@/tomlEdit";
import { buildDeployment } from "@/tomlBuilder";
import type { SetupForm } from "@/setupTypes";

export function App() {
  const surface = surfaceFromEnv();
  const appliance = showBoxAdmin(surface);
  const [page, setPage] = useState<Page>(() => pageFromHash(window.location.hash, surface));
  const [engineUp, setEngineUp] = useState(false);
  const [listenUrl, setListenUrl] = useState(ENGINE_LISTEN_URL);
  const [routes, setRoutes] = useState<RouteRow[]>([]);
  const [modelsPayload, setModelsPayload] = useState<unknown>(null);
  const [stats, setStats] = useState<StatsViewModel | null>(null);
  const [maskclaw, setMaskclaw] = useState<MaskclawStatsView | null>(null);
  const [routesToml, setRoutesToml] = useState("");
  const [liveRoutesToml, setLiveRoutesToml] = useState("");
  const [maskclawToml, setMaskclawToml] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [probes, setProbes] = useState<ProbeResult[]>([]);
  const [secrets, setSecrets] = useState<{ name: string; set: boolean }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [hostSession, setHostSession] = useState<HostSession>({ ok: true, passwordSet: false, loggedIn: false });
  const [hostNetwork, setHostNetwork] = useState<HostNetwork | null>(null);
  const hydratedToml = useRef(false);

  useEffect(() => {
    const onHash = () => {
      const next = pageFromHash(window.location.hash, surface);
      if (next !== "board") {
        setProbes([]);
      }
      setPage(next);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [surface]);

  useEffect(() => {
    let cancelled = false;
    const gate = createPollGate();
    const tick = async () => {
      await gate.run(async () => {
        try {
          const sessionPromise = appliance
            ? fetchHostSession().catch(() => ({
                ok: false,
                passwordSet: false,
                loggedIn: false,
              }))
            : Promise.resolve({ ok: true, passwordSet: true, loggedIn: true } satisfies HostSession);

          const [polled, control, session] = await Promise.all([
            runPollTick({
              fetchHealth,
              fetchStats: tryFetchEngineStats,
              fetchModels,
              fetchMaskclawStats: tryFetchStats,
              timeoutMs: appliance ? 8000 : POLL_TIMEOUT_MS,
            }),
            fetchControlSnapshot().catch(() => null),
            sessionPromise,
          ]);
          if (cancelled) return;

          const engineOk = (control?.engineUp ?? false) || polled.health.ok;
          setEngineUp(engineOk);
          if (polled.stats !== null) setStats(adaptStats(polled.stats));
          if (polled.models !== null) {
            setModelsPayload(polled.models);
            setRoutes(parseRoutes(polled.models));
          } else if (control?.routesToml) {
            const fallback = routeRowsFromIds(routeIdsFromToml(control.routesToml));
            if (fallback.length > 0) {
              setRoutes(fallback);
            }
          }
          if (polled.maskclawStats !== null) {
            setMaskclaw(adaptMaskclawStats(polled.maskclawStats));
          }

          if (appliance) {
            setHostSession(session);
            setLocked(!session.ok);
          }

          if (control) {
            setListenUrl(control.listenUrl);
            setLogs(control.logs);
            setLiveRoutesToml(control.routesToml);
            if (!hydratedToml.current) {
              setRoutesToml(control.routesToml);
              setMaskclawToml(control.maskclawToml);
              hydratedToml.current = true;
            }
          }
          const listed = await fetchSecrets().catch(() => null);
          if (cancelled) return;
          if (listed) setSecrets(listed);
          if (appliance && session.ok) {
            const net = await fetchHostNetwork().catch(() => null);
            if (cancelled) return;
            if (net) setHostNetwork(net);
          }
          setError(engineOk ? null : control?.lastError ?? "Engine not responding");
        } catch (caught) {
          if (!cancelled) {
            setError(caught instanceof Error ? caught.message : "sidecar unavailable");
          }
        } finally {
          if (!cancelled) setReady(true);
        }
      });
    };
    void tick();
    const id = window.setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [appliance]);

  const modelId = useMemo(
    () => defaultModelFromPayload(modelsPayload, routes.map((route) => route.id)),
    [modelsPayload, routes],
  );
  const trackBackendIds = useMemo(() => backendIdsByRoute(liveRoutesToml), [liveRoutesToml]);

  function go(next: Page) {
    if (next !== "board") {
      setProbes([]);
    }
    window.location.hash = next;
    setPage(next);
  }

  function applyControl(next: { listenUrl: string; engineUp: boolean; lastError: string | null; routesToml: string; maskclawToml: string; logs: string[] }) {
    setListenUrl(next.listenUrl);
    setEngineUp(next.engineUp);
    setLogs(next.logs);
    setRoutesToml(next.routesToml);
    setLiveRoutesToml(next.routesToml);
    setMaskclawToml(next.maskclawToml);
    setError(next.engineUp ? null : next.lastError);
  }

  async function runControl(action: () => Promise<{ listenUrl: string; engineUp: boolean; lastError: string | null; routesToml: string; maskclawToml: string; logs: string[] }>, ok: string) {
    setBusy(true);
    try {
      applyControl(await action());
      toast.success(ok);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "control failed");
    } finally {
      setBusy(false);
    }
  }

  async function onReset() {
    setResetting(true);
    try {
      await resetEngineStats();
      toast.success("Engine stats reset");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "reset failed");
    } finally {
      setResetting(false);
    }
  }

  async function onProbe() {
    setBusy(true);
    try {
      setProbes(await probeBackends());
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "probe failed");
    } finally {
      setBusy(false);
    }
  }

  async function onApplySetup(form: SetupForm) {
    setBusy(true);
    try {
      const built = buildDeployment(form);
      const secretsList = secretsFromSetup(form);
      assertNoSecretsInToml(built.toml, secretsList);
      const values = secretValuesRecord(form);
      if (Object.keys(values).length > 0) {
        setSecrets(await writeSecrets(values));
      }
      applyControl(await saveToml("routes", built.toml));
      setSecrets(await fetchSecrets());
      toast.success("Saved models");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "save models failed";
      toast.error(message);
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function onDetector(key: keyof DetectorToggles, enabled: boolean) {
    const next = setDetectorLine(maskclawToml, key, enabled);
    setMaskclawToml(next);
    await runControl(() => saveToml("maskclaw", next), "Saved MaskClaw");
  }

  async function onHostLogin(password: string) {
    setBusy(true);
    setLoginError(null);
    try {
      setHostSession(await hostLogin(password));
      setLocked(false);
      toast.success("Signed in");
    } catch (caught) {
      setLoginError(caught instanceof Error ? caught.message : "sign in failed");
    } finally {
      setBusy(false);
    }
  }

  async function onHostPassword(password: string, current?: string, setupToken?: string) {
    setBusy(true);
    setLoginError(null);
    try {
      const next = await setDashboardPassword(password, current, fetch, setupToken);
      setHostSession(next);
      if (next.ok) {
        setLocked(false);
      }
      toast.success("Dashboard password saved");
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : "password failed";
      setLoginError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  async function onHostLogout() {
    setBusy(true);
    try {
      const next = await hostLogout();
      setHostSession(next);
      if (next.passwordSet) {
        setLocked(true);
      }
      toast.success("Signed out");
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "sign out failed");
    } finally {
      setBusy(false);
    }
  }

  async function runHostNetwork(action: () => Promise<HostNetwork>, ok: string) {
    setBusy(true);
    try {
      setHostNetwork(await action());
      toast.success(ok);
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : "network failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false} storageKey="maskclaw-theme">
      <TooltipProvider>
        <SidebarProvider className="min-w-0 overflow-x-hidden">
          <Sidebar>
            <SidebarHeader>
              <div className="px-2 py-1">
                <p className="font-heading text-lg">MASKCLAW</p>
              </div>
            </SidebarHeader>
            <SidebarContent>
              <SidebarGroup>
                <SidebarGroupLabel>MaskClaw</SidebarGroupLabel>
                <SidebarGroupContent>
                  <SidebarMenu>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={page === "board"} onClick={() => go("board")}>
                        <HouseIcon />
                        HOME
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={page === "mask"} onClick={() => go("mask")}>
                        <ShieldIcon />
                        MASKED
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={page === "models"} onClick={() => go("models")}>
                        <CpuIcon />
                        MODELS
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    <SidebarMenuItem>
                      <SidebarMenuButton isActive={page === "settings"} onClick={() => go("settings")}>
                        <Settings2Icon />
                        SETTINGS
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                    {appliance ? (
                      <SidebarMenuItem>
                        <SidebarMenuButton isActive={page === "box"} onClick={() => go("box")}>
                          <ServerIcon />
                          BOX
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    ) : null}
                  </SidebarMenu>
                </SidebarGroupContent>
              </SidebarGroup>
            </SidebarContent>
            <SidebarFooter>
              <div className="flex flex-col gap-2 px-2 pb-2">
                <ThemeToggle />
                <Badge variant="outline">{surface === "appliance" ? "appliance" : "maskclaw.local"}</Badge>
              </div>
            </SidebarFooter>
          </Sidebar>
          <SidebarInset className="min-w-0 overflow-x-hidden">
            <header className="flex items-center gap-2 border-b px-4 py-3">
              <SidebarTrigger />
            </header>
            <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              <div className="flex min-w-0 max-w-full flex-col gap-4 p-6">
                {locked ? (
                  !hostSession.passwordSet ? (
                    <SetupPasswordScreen
                      busy={busy}
                      error={loginError}
                      onSetPassword={(password, setupToken) => void onHostPassword(password, undefined, setupToken)}
                    />
                  ) : (
                    <LoginScreen busy={busy} error={loginError} onLogin={(password) => void onHostLogin(password)} />
                  )
                ) : null}
                {error && !locked && !engineUp ? (
                  <Alert variant="destructive">
                    <AlertTitle>Engine unavailable</AlertTitle>
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                ) : null}
                {!ready && !locked ? (
                  <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <Skeleton className="h-24" />
                    <Skeleton className="h-24" />
                    <Skeleton className="h-24" />
                    <Skeleton className="h-24" />
                  </div>
                ) : null}
                {ready && !locked && page === "board" ? (
                  <BoardPage
                    engineUp={engineUp}
                    listenUrl={listenUrl}
                    surface={surface}
                    hostNetwork={hostNetwork}
                    routes={routes}
                    backendIdsByRoute={trackBackendIds}
                    modelId={modelId}
                    stats={stats}
                    logs={logs}
                    probes={probes}
                    busy={busy}
                    resetting={resetting}
                    onStart={() => void runControl(() => startEngine(), "Engine started")}
                    onStop={() => void runControl(() => stopEngine(), "Engine stopped")}
                    onRestart={() => void runControl(() => restartEngine(), "Engine restarted")}
                    onReset={() => void onReset()}
                    onProbe={() => void onProbe()}
                    onDismissProbes={() => setProbes([])}
                  />
                ) : null}
                {ready && !locked && page === "mask" ? (
                  <MaskPage maskclaw={maskclaw} routeIds={routes.map((route) => route.id)} />
                ) : null}
                {ready && !locked && page === "models" ? (
                  <ModelsPage
                    routesToml={routesToml}
                    secretFlags={secrets}
                    busy={busy}
                    onApply={onApplySetup}
                    onProbe={probeBackend}
                  />
                ) : null}
                {ready && !locked && page === "settings" ? (
                  <EngineSettingsPage
                    maskclaw={maskclaw}
                    routesToml={routesToml}
                    maskclawToml={maskclawToml}
                    onRoutesToml={setRoutesToml}
                    onMaskclawToml={setMaskclawToml}
                    onSaveRoutes={() => void runControl(() => saveToml("routes", routesToml), "Saved routes")}
                    onSaveMaskclaw={() => void runControl(() => saveToml("maskclaw", maskclawToml), "Saved MaskClaw")}
                    onDetector={(key, enabled) => void onDetector(key, enabled)}
                    busy={busy}
                  />
                ) : null}
                {ready && !locked && page === "box" ? (
                  <BoxPage
                    session={hostSession}
                    network={hostNetwork}
                    busy={busy}
                    onSetPassword={(password, current) => void onHostPassword(password, current)}
                    onLogout={() => void onHostLogout()}
                    onSetHostname={(hostname) => void runHostNetwork(() => putHostname(hostname), "Hostname saved")}
                    onEthernet={() => void runHostNetwork(() => connectEthernet(), "Using Ethernet")}
                    onWifi={(ssid, password) => void runHostNetwork(() => connectWifi(ssid, password), "Joining Wi-Fi")}
                  />
                ) : null}
              </div>
            </div>
          </SidebarInset>
          <Toaster />
        </SidebarProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
