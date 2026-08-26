import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { HostNetwork, HostSession } from "@/api";

export function LoginScreen({
  busy,
  error,
  onLogin,
}: {
  busy: boolean;
  error: string | null;
  onLogin: (password: string) => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>This box requires a dashboard password.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onLogin(password);
            }}
          >
            <Field>
              <FieldLabel htmlFor="dash-login">Password</FieldLabel>
              <Input
                id="dash-login"
                type="password"
                value={password}
                autoComplete="current-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button type="submit" disabled={busy || password.length === 0}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function SetupPasswordScreen({
  busy,
  error,
  onSetPassword,
}: {
  busy: boolean;
  error: string | null;
  onSetPassword: (password: string, setupToken: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [setupToken, setSetupToken] = useState("");
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Set dashboard password</CardTitle>
          <CardDescription>
            SSH to this box first and read the setup token from /etc/motd. Required before anyone on
            the LAN can use this dashboard. This is not the SSH admin login.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              onSetPassword(password, setupToken);
            }}
          >
            <Field>
              <FieldLabel htmlFor="dash-setup-token">Setup token</FieldLabel>
              <Input
                id="dash-setup-token"
                type="text"
                value={setupToken}
                autoComplete="off"
                onChange={(event) => setSetupToken(event.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor="dash-setup">Password</FieldLabel>
              <Input
                id="dash-setup"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
            <p className="text-muted-foreground text-sm">At least 8 characters.</p>
            {error ? <p className="text-destructive text-sm">{error}</p> : null}
            <Button type="submit" disabled={busy || password.length < 8 || setupToken.trim().length === 0}>
              Set password
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

export function BoxPage({
  session,
  network,
  busy,
  onSetPassword,
  onLogout,
  onSetHostname,
  onEthernet,
  onWifi,
}: {
  session: HostSession;
  network: HostNetwork | null;
  busy: boolean;
  onSetPassword: (password: string, current?: string) => void;
  onLogout: () => void;
  onSetHostname: (hostname: string) => void;
  onEthernet: () => void;
  onWifi: (ssid: string, password: string) => void;
}) {
  const [password, setPassword] = useState("");
  const [current, setCurrent] = useState("");
  const [hostname, setHostname] = useState(network?.hostname ?? "");
  const [ssid, setSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");

  useEffect(() => {
    if (network?.hostname) {
      setHostname(network.hostname);
    }
  }, [network?.hostname]);

  return (
    <div className="flex min-w-0 max-w-full flex-col gap-6">
      <h1 className="font-heading text-3xl">BOX</h1>

      <Card>
        <CardHeader>
          <CardTitle>Dashboard password</CardTitle>
          <CardDescription>
            Required for LAN access to this dashboard. This is not the SSH admin login.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {session.passwordSet
              ? session.loggedIn
                ? "Password is set. You are signed in."
                : "Password is set."
              : "No dashboard password yet."}
          </p>
          <FieldGroup>
            {session.passwordSet ? (
              <Field>
                <FieldLabel htmlFor="dash-current">Current password</FieldLabel>
                <Input
                  id="dash-current"
                  type="password"
                  value={current}
                  autoComplete="current-password"
                  onChange={(event) => setCurrent(event.target.value)}
                />
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="dash-new">{session.passwordSet ? "New password" : "Password"}</FieldLabel>
              <Input
                id="dash-new"
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </FieldGroup>
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={busy || password.length < 8}
              onClick={() => onSetPassword(password, session.passwordSet ? current : undefined)}
            >
              {session.passwordSet ? "Change password" : "Set password"}
            </Button>
            {session.passwordSet ? (
              <Button type="button" variant="outline" disabled={busy} onClick={onLogout}>
                Sign out
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>HTTPS certificate</CardTitle>
          <CardDescription>
            This box uses a local CA. Browsers show “Not secure” until you trust that CA once on this
            PC.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div>
            <a
              className="border-border bg-background hover:bg-muted hover:text-foreground inline-flex h-9 items-center justify-center rounded-md border px-2.5 text-sm font-medium shadow-xs"
              href="/host/ca.crt"
              download="maskclaw-caddy-root.crt"
            >
              Download CA
            </a>
          </div>
          <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
            <li>
              Click <span className="text-foreground">Download CA</span> (saves{" "}
              <code className="text-foreground">maskclaw-caddy-root.crt</code>).
            </li>
            <li>Open the downloaded file (double-click).</li>
            <li>
              Click <span className="text-foreground">Install Certificate…</span>
            </li>
            <li>
              Choose <span className="text-foreground">Current User</span> (or Local Machine if you
              have Admin), then Next.
            </li>
            <li>
              Select{" "}
              <span className="text-foreground">
                Place all certificates in the following store
              </span>
              , click Browse, and pick{" "}
              <span className="text-foreground">Trusted Root Certification Authorities</span>. Do
              not leave “Automatically select the certificate store” — that puts it in the wrong
              place and Chrome will still warn.
            </li>
            <li>Finish, confirm Yes on the security warning.</li>
            <li>Fully quit the browser (all windows) and reopen this site.</li>
          </ol>
          <p className="text-muted-foreground text-sm">
            Or in PowerShell:{" "}
            <code className="text-foreground">
              certutil -addstore -f -user Root $env:USERPROFILE\\Downloads\\maskclaw-caddy-root.crt
            </code>{" "}
            then restart the browser.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network and hostname</CardTitle>
          <CardDescription>Ethernet, Wi-Fi, and the name this box uses on the LAN.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {network ? (
            <>
              <ul className="flex flex-col gap-1 text-sm">
                {network.interfaces.map((iface) => (
                  <li key={iface.name}>
                    {iface.type} {iface.name}
                    {iface.connected ? " · connected" : " · down"}
                    {iface.ip ? ` · ${iface.ip}` : ""}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground text-sm">
                {network.addresses.length ? network.addresses.join(", ") : "No addresses yet."}
              </p>
              <Field>
                <FieldLabel htmlFor="box-hostname">Hostname</FieldLabel>
                <Input
                  id="box-hostname"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                />
              </Field>
              <div>
                <Button type="button" disabled={busy || hostname.trim().length === 0} onClick={() => onSetHostname(hostname)}>
                  Save hostname
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" disabled={busy} onClick={onEthernet}>
                  Use Ethernet
                </Button>
              </div>
              {network.wifiAvailable ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="wifi-ssid">Wi-Fi network</FieldLabel>
                    <Input
                      id="wifi-ssid"
                      value={ssid}
                      list="wifi-ssids"
                      onChange={(event) => setSsid(event.target.value)}
                    />
                    <datalist id="wifi-ssids">
                      {network.wifi.networks.map((item) => (
                        <option key={item.ssid} value={item.ssid} />
                      ))}
                    </datalist>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="wifi-pass">Wi-Fi password</FieldLabel>
                    <Input
                      id="wifi-pass"
                      type="password"
                      value={wifiPassword}
                      autoComplete="off"
                      onChange={(event) => setWifiPassword(event.target.value)}
                    />
                  </Field>
                  <div>
                    <Button type="button" disabled={busy || ssid.trim().length === 0} onClick={() => onWifi(ssid, wifiPassword)}>
                      Join Wi-Fi
                    </Button>
                  </div>
                  {network.wifi.connectedSsid ? (
                    <p className="text-muted-foreground text-sm">Connected to {network.wifi.connectedSsid}</p>
                  ) : null}
                </FieldGroup>
              ) : (
                <p className="text-muted-foreground text-sm">Wi-Fi is not available on this box.</p>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-sm">Loading network…</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
