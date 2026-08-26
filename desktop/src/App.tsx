import { useCallback, useEffect, useState } from "react";
import type { AppSnapshot } from "./api";
import { getSnapshot, openExternalUrl } from "./api";
import { Dashboard } from "./components/Dashboard";
import { MaskClawApp } from "./components/maskclaw/MaskClawApp";
import { Settings } from "./components/Settings";
import { SetupWizard } from "./components/SetupWizard";
import { applyAppearance, nextAppearance, persistAppearance, readAppearance, themeToggleLabel, type Appearance } from "./lib/theme";
import { appDisplayName, isMaskclawFlavor } from "./lib/engineFlavor";
import { type MaskclawPane } from "./lib/maskclawNav";
import { RAIL_ITEMS, X_PROFILE_HANDLE, X_PROFILE_URL, type Pane } from "./lib/railNav";

function RailIcon({ name }: { name: "home" | "setup" | "settings" }) {
  if (name === "home") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path fill="currentColor" d="M12 4.2 4 10.5V20h5.2v-6h5.6v6H20v-9.5L12 4.2z" />
      </svg>
    );
  }
  if (name === "setup") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M4 7h2.2a2.8 2.8 0 0 0 5.6 0H20V5H11.8a2.8 2.8 0 0 0-5.6 0H4v2zm8.2 12H4v-2h8.2a2.8 2.8 0 0 0 5.6 0H20v2h-2.2a2.8 2.8 0 0 0-5.6 0z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M10.1 3h3.8l.4 2.2a6.7 6.7 0 0 1 1.9.8l2.1-1 1.9 3.3-1.7 1.5a6.8 6.8 0 0 1 0 1.8l1.7 1.5-1.9 3.3-2.1-1a6.7 6.7 0 0 1-1.9.8L13.9 21h-3.8l-.4-2.2a6.7 6.7 0 0 1-1.9-.8l-2.1 1-1.9-3.3 1.7-1.5a6.8 6.8 0 0 1 0-1.8L3.8 9.1l1.9-3.3 2.1 1a6.7 6.7 0 0 1 1.9-.8L10.1 3zM12 9.2A2.8 2.8 0 1 0 12 14.8 2.8 2.8 0 0 0 12 9.2z"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        fill="currentColor"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.74l7.727-8.829L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117z"
      />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Appearance }) {
  if (theme === "dark") {
    return (
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 5.2a.9.9 0 0 0 .9-.9V2.9a.9.9 0 1 0-1.8 0v1.4a.9.9 0 0 0 .9.9zm0 13.6a.9.9 0 0 0-.9.9v1.4a.9.9 0 1 0 1.8 0v-1.4a.9.9 0 0 0-.9-.9zM6.4 6.4a.9.9 0 0 0 1.27-1.27L6.7 4.16A.9.9 0 0 0 5.43 5.43zm11.2 11.2a.9.9 0 0 0-1.27 1.27l.97.97A.9.9 0 0 0 18.57 18.57zM5.2 12a.9.9 0 0 0-.9-.9H2.9a.9.9 0 1 0 0 1.8h1.4a.9.9 0 0 0 .9-.9zm15.8-.9h-1.4a.9.9 0 1 0 0 1.8h1.4a.9.9 0 1 0 0-1.8zM6.4 17.6 5.43 18.57A.9.9 0 0 0 6.7 19.84l.97-.97A.9.9 0 0 0 6.4 17.6zm11.2-11.2.97-.97A.9.9 0 0 0 17.3 4.16l-.97.97A.9.9 0 0 0 17.6 6.4zM12 8.2A3.8 3.8 0 1 0 12 15.8 3.8 3.8 0 0 0 12 8.2z"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="currentColor"
        d="M14.6 3.4a.8.8 0 0 0-1.12.08 7.4 7.4 0 1 0 7.04 7.04.8.8 0 0 0-1.16-.64 5.6 5.6 0 0 1-7.16-7.16.8.8 0 0 0 .64-1.16 7.3 7.3 0 0 0-1.76-.2 8.8 8.8 0 1 0 9.56 9.56 7.3 7.3 0 0 0 .2-1.76.8.8 0 0 0-1.24-.76z"
      />
    </svg>
  );
}

export function App() {
  const [snap, setSnap] = useState<AppSnapshot | null>(null);
  const [pane, setPane] = useState<Pane>("board");
  const [maskPane, setMaskPane] = useState<MaskclawPane>("board");
  const [bootError, setBootError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Appearance>(() => readAppearance());

  const refresh = useCallback(async () => {
    const next = await getSnapshot();
    setSnap(next);
    return next;
  }, []);

  useEffect(() => {
    refresh()
      .then((next) => {
        if (next.needs_setup) {
          setPane("setup");
          setMaskPane("models");
        }
      })
      .catch((err: unknown) => {
        setBootError(err instanceof Error ? err.message : String(err));
      });
  }, [refresh]);

  useEffect(() => {
    document.title = appDisplayName(snap?.engine_flavor);
    const root = document.documentElement;
    if (isMaskclawFlavor(snap?.engine_flavor)) {
      root.classList.add("mc-root");
    } else {
      root.classList.remove("mc-root");
    }
    return () => root.classList.remove("mc-root");
  }, [snap?.engine_flavor]);

  if (bootError) {
    return (
      <div className="board">
        <p className="err">{bootError}</p>
      </div>
    );
  }

  if (!snap) {
    return (
      <div className="board">
        <p>Reading the yard board…</p>
      </div>
    );
  }

  if (isMaskclawFlavor(snap.engine_flavor)) {
    return (
      <MaskClawApp
        snap={snap}
        pane={maskPane}
        onPane={setMaskPane}
        onChange={setSnap}
        refresh={refresh}
        theme={theme}
        onTheme={setTheme}
      />
    );
  }

  return (
    <div className="app-shell">
      <aside className="yard-rail">
        <nav className="rail-nav">
          {RAIL_ITEMS.map((item) => (
            <button
              key={item.pane}
              type="button"
              className={pane === item.pane ? "active" : ""}
              title={item.label}
              aria-label={item.label}
              data-tip={item.label}
              onClick={() => setPane(item.pane)}
            >
              <RailIcon name={item.icon} />
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <a
            href={X_PROFILE_URL}
            target="_blank"
            rel="noopener noreferrer"
            title={X_PROFILE_HANDLE}
            aria-label={`X profile ${X_PROFILE_HANDLE}`}
            data-tip={X_PROFILE_HANDLE}
            onClick={(event) => {
              event.preventDefault();
              void openExternalUrl(X_PROFILE_URL);
            }}
          >
            <XIcon />
          </a>
          <button
            type="button"
            title={themeToggleLabel(theme)}
            aria-label={themeToggleLabel(theme)}
            data-tip={themeToggleLabel(theme)}
            onClick={() => {
              const next = nextAppearance(theme);
              persistAppearance(next);
              applyAppearance(next);
              setTheme(next);
            }}
          >
            <ThemeIcon theme={theme} />
          </button>
        </div>
      </aside>
      <main className="board">
        {pane === "board" && <Dashboard snap={snap} onChange={setSnap} refresh={refresh} />}
        {pane === "setup" && (
          <SetupWizard
            configToml={snap.config_toml}
            appName={appDisplayName(snap.engine_flavor)}
            onDone={async (next) => {
              setSnap(next);
              setPane("board");
            }}
          />
        )}
        {pane === "settings" && <Settings snap={snap} onChange={setSnap} />}
      </main>
    </div>
  );
}
