"use client";

import { useEffect, useState } from "react";
import { Callout } from "@/components/settings/SettingsKit";

async function fetchWidgetUrl(): Promise<string> {
  const res = await fetch("/api/settings/fastn/token", { method: "POST" });
  const body = (await res.json().catch(() => ({}))) as { widgetUrl?: string; error?: string };
  if (!res.ok || !body.widgetUrl) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body.widgetUrl;
}

/**
 * The Fastn integrations widget for the caller's organization, in an iframe.
 * Connecting an app, turning an integration on and seeing its runs all happen
 * inside it, against this organization's own accounts. The browser only ever
 * holds a short-lived token for this organization.
 */
export function AppIntegrationsFrame() {
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchWidgetUrl().then(
      (url) => !cancelled && setWidgetUrl(url),
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Could not open app integrations"),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setError(null);
    setWidgetUrl(null);
    setAttempt((n) => n + 1);
  };

  if (error) {
    return (
      <Callout
        tone="error"
        title="App integrations could not load"
        action={
          <button type="button" onClick={retry} className="text-label-sm text-primary-base">
            Try again
          </button>
        }
      >
        {error}
      </Callout>
    );
  }
  if (!widgetUrl) return <div className="h-[640px] animate-pulse rounded-xl bg-bg-weak-50" />;
  return (
    <iframe
      title="App integrations"
      src={widgetUrl}
      className="h-[640px] w-full rounded-xl border border-stroke-soft-200"
      allow="clipboard-write"
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}
