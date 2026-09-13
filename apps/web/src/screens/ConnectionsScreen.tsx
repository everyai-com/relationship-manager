import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { errorMessage } from "../App";
import {
  api,
  type ConnectionSource,
  type ConnectionsPayload,
  type SourceAccount,
  type SourceToolkit,
  type SourcesPayload,
} from "../lib/api";
import { clock, day, relativeDay } from "../lib/format";
import { useAsync } from "../lib/useAsync";
import { SkeletonCards } from "../components/Avatar";
import { CopyField, EmptyState, ErrorRetry, Metric, PanelHeader, StatusPill, Surface } from "../components/ui";

type Notify = (message: string, tone?: "ok" | "error") => void;

/**
 * Connections — where the graph comes from, and the accounts behind it.
 *
 * Two halves. Above: the sources you can sign in to, with every account listed
 * (more than one per source is the normal case) and a Sync now that pulls from
 * the cloud. Below: how fresh each source actually is — measured from the
 * newest row in the graph, so a source that stopped producing reads as stale
 * with its real date, and the push log shows every write that ever landed.
 */
export function ConnectionsScreen({ notify }: { notify: Notify }) {
  const health = useAsync<ConnectionsPayload>(() => api.connections(), []);
  const sources = useAsync<SourcesPayload>(() => api.sources(), []);

  const pollRef = useRef<number | null>(null);
  const [waiting, setWaiting] = useState<{ id: number; toolkit: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setWaiting(null);
  }, []);

  useEffect(() => () => stopPolling(), [stopPolling]);

  /** Composio finishes the sign-in in its own tab; we only believe it when the account says so. */
  const watch = useCallback(
    (id: number, toolkit: string) => {
      let attempts = 0;
      setWaiting({ id, toolkit });
      pollRef.current = window.setInterval(async () => {
        attempts += 1;
        try {
          const { account } = await api.sourceAccount(id);
          if (account.status === "connected") {
            stopPolling();
            notify(`${toolkit} connected${account.label ? ` as ${account.label}` : ""}`);
            sources.reload();
          } else if (account.status === "error") {
            stopPolling();
            notify(`${toolkit}: Composio reported a problem with that account`, "error");
            sources.reload();
          } else if (attempts >= 40) {
            stopPolling();
            notify(`Still waiting on ${toolkit} — finish the sign-in, then reload`, "error");
          }
        } catch (err) {
          stopPolling();
          notify(errorMessage(err), "error");
          sources.reload();
        }
      }, 3000);
    },
    [notify, sources, stopPolling],
  );

  const connect = async (toolkit: SourceToolkit) => {
    setBusy(toolkit.slug);
    try {
      const started = await api.connectSource(toolkit.slug);
      if (started.redirect_url) window.open(started.redirect_url, "_blank", "noopener,noreferrer");
      notify(started.redirect_url ? `Finish signing in to ${toolkit.label} in the new tab` : `Connecting ${toolkit.label}…`);
      sources.reload();
      watch(started.account.id, toolkit.label);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  };

  const sync = async (toolkit: SourceToolkit) => {
    setSyncing(toolkit.slug);
    try {
      const out = await api.syncSources(toolkit.slug);
      const inserted = out.results.reduce((total, result) => total + result.inserted, 0);
      if (out.results.length > 0) {
        notify(`${toolkit.label}: ${inserted.toLocaleString()} rows pulled from ${out.results.length} account(s)`);
      }
      if (out.errors.length > 0) notify(out.errors[0]!.error, "error");
      health.reload();
      sources.reload();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSyncing(null);
    }
  };

  const update = async (account: SourceAccount, patch: { enabled?: boolean; is_default?: boolean }) => {
    try {
      await api.updateSourceAccount(account.id, patch);
      sources.reload();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  };

  const disconnect = async (account: SourceAccount, toolkit: string) => {
    if (!window.confirm(`Disconnect ${account.label || "this account"} from ${toolkit}? Data already in the graph stays.`)) return;
    try {
      await api.removeSourceAccount(account.id);
      notify(`${toolkit} account disconnected`);
      sources.reload();
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  };

  const data = health.data;

  return (
    <div className="screen">
      <Surface>
        <PanelHeader
          eyebrow="Setup"
          title="Connections"
          detail={data?.summary.freshness_rule ?? "Where the graph comes from, and how fresh it is."}
          action={
            <button
              className="icon-button"
              title="Reload"
              onClick={() => {
                health.reload();
                sources.reload();
              }}
            >
              <RefreshCw size={13} />
            </button>
          }
        />

        {health.error ? (
          <ErrorRetry message={health.error ?? undefined} onRetry={health.reload} />
        ) : !data ? (
          <SkeletonCards count={4} />
        ) : (
          <div className="grid-metrics conn-summary">
            <Metric label="Sources" value={data.summary.sources} />
            <Metric label="Fresh" value={data.summary.connected} tone="positive" />
            <Metric label="Stale" value={data.summary.stale} tone="warning" />
            <Metric label="Items in the graph" value={data.summary.items.toLocaleString()} />
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Accounts"
          title="Sign in to your sources"
          detail="Connect one account or several — work and personal mail, more than one calendar. Enabled accounts are pulled on Sync now and once a day."
        />

        {sources.error ? (
          <ErrorRetry message={sources.error ?? undefined} onRetry={sources.reload} />
        ) : !sources.data ? (
          <SkeletonCards count={3} />
        ) : (
          <div className="accounts-panel">
            {!sources.data.configured ? (
              <div className="banner info">
                <AlertTriangle size={13} /> Composio is not configured on this deployment — set{" "}
                <code>COMPOSIO_API_KEY</code> as a Worker secret to connect accounts here.
              </div>
            ) : null}

            {sources.data.toolkits.map((toolkit) => (
              <div className="toolkit" key={toolkit.slug}>
                <div className="toolkit-head">
                  <div>
                    <h3>{toolkit.label}</h3>
                    <p className="conn-detail">{toolkit.reads}</p>
                  </div>
                  <div className="toolkit-actions">
                    {toolkit.last_sync_at ? (
                      <span className="pill" title={toolkit.last_sync_at}>
                        synced {relativeDay(toolkit.last_sync_at)}
                      </span>
                    ) : null}
                    <button
                      className="button secondary"
                      disabled={syncing === toolkit.slug || toolkit.accounts.every((account) => !account.enabled)}
                      title={
                        toolkit.accounts.some((account) => account.enabled)
                          ? "Pull this source now, from the cloud"
                          : "Enable an account first"
                      }
                      onClick={() => void sync(toolkit)}
                    >
                      {syncing === toolkit.slug ? <span className="spinner" aria-hidden /> : <RefreshCw size={12} />} Sync now
                    </button>
                    <button className="button" disabled={busy === toolkit.slug} onClick={() => void connect(toolkit)}>
                      {busy === toolkit.slug ? <span className="spinner" aria-hidden /> : <Plus size={12} />} Add account
                    </button>
                  </div>
                </div>

                {toolkit.accounts.length === 0 ? (
                  <p className="conn-note">
                    No account connected. “Add account” opens {toolkit.label}&apos;s own sign-in — this app never sees the
                    password.
                  </p>
                ) : (
                  <div className="account-list">
                    {toolkit.accounts.map((account) => (
                      <div className="account-row" key={account.id}>
                        <label className="account-toggle" title={account.enabled ? "Included in syncs" : "Left out of syncs"}>
                          <input
                            type="checkbox"
                            checked={account.enabled}
                            onChange={(event) => void update(account, { enabled: event.target.checked })}
                          />
                          <span>{account.enabled ? "on" : "off"}</span>
                        </label>

                        <span className="account-label">{account.label || account.connection_id}</span>

                        <StatusPill status={account.status === "connected" ? "connected" : account.status} />
                        {!account.live ? (
                          <span className="pill" title="This row is kept from before — Composio no longer lists it">
                            not in Composio
                          </span>
                        ) : null}

                        <span className="account-spacer" />

                        {waiting?.id === account.id ? (
                          <span className="connect-waiting">
                            <span className="spinner" aria-hidden /> waiting for you to finish…
                          </span>
                        ) : null}

                        <button
                          className="icon-button compact"
                          title={account.is_default ? "This is the default account" : "Make default"}
                          onClick={() => void update(account, { is_default: true })}
                        >
                          {account.is_default ? <Star size={13} fill="currentColor" /> : <Star size={13} />}
                        </button>
                        {account.is_default ? <Check size={12} className="account-check" /> : null}

                        <button
                          className="icon-button compact"
                          title="Disconnect this account"
                          onClick={() => void disconnect(account, toolkit.label)}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Sources"
          title="What the graph is made of"
          detail="Counts come from the rows themselves — the same numbers the People and Reconnect screens read."
        />
        {health.error ? null : !data ? (
          <SkeletonCards count={6} />
        ) : data.sources.length === 0 ? (
          <EmptyState title="No sources recorded" body="Nothing has pushed into this deployment yet." />
        ) : (
          <div className="conn-grid">
            {data.sources.map((source) => (
              <SourceCard source={source} key={source.id} />
            ))}
          </div>
        )}
      </Surface>

      <Surface>
        <PanelHeader
          eyebrow="Activity"
          title="Recent pushes"
          detail="Every write into the graph, newest first — a connector can be late, but it cannot hide."
        />
        {health.error ? null : !data ? (
          <SkeletonCards count={3} />
        ) : data.syncs.length === 0 ? (
          <EmptyState title="Nothing has been pushed yet" />
        ) : (
          <div className="sync-timeline">
            {data.syncs.map((sync, index) => (
              <div className="sync-row" key={`${sync.source}-${sync.pushed_at}-${index}`}>
                <span className="sync-when" title={sync.pushed_at}>
                  {relativeDay(sync.pushed_at)} · {clock(sync.pushed_at)}
                </span>
                <span className="sync-source">{sync.source}</span>
                <span className="pill">{sync.inserted.toLocaleString()} rows</span>
                <span className="sync-detail">{sync.detail || "—"}</span>
              </div>
            ))}
          </div>
        )}
      </Surface>
    </div>
  );
}

function SourceCard({ source }: { source: ConnectionSource }) {
  const age = source.freshness_days;
  const stale = source.status !== "connected" && source.status !== "not_configured";
  const width = age === null ? 0 : Math.min(100, Math.max(4, Math.round((age / 14) * 100)));
  const counts = [
    source.graph.messages ? `${source.graph.messages.toLocaleString()} messages` : "",
    source.graph.events ? `${source.graph.events.toLocaleString()} events` : "",
    source.graph.meetings ? `${source.graph.meetings.toLocaleString()} calls` : "",
    source.graph.records ? `${source.graph.records.toLocaleString()} records` : "",
  ].filter(Boolean);

  return (
    <div className={`surface conn-card${source.id === "ai" ? " ai" : ""}`} style={{ boxShadow: "none" }}>
      <div className="conn-card-head">
        <h3>{source.label}</h3>
        <StatusPill status={source.status} />
      </div>

      <p className="conn-detail">{source.detail}</p>

      {source.id !== "ai" ? (
        <div className="freshness">
          <div className="freshness-track">
            <span className={`freshness-bar${stale ? " stale" : ""}`} style={{ width: `${width}%` }} />
            <span className="freshness-threshold" title="3-day threshold" />
          </div>
          <div className="freshness-label">
            {age === null ? (
              <span>No dated rows yet</span>
            ) : age <= 3 ? (
              <span>Newest row {age === 0 ? "today" : `${age}d old`} — fresh</span>
            ) : (
              <span>
                Newest row {day(source.newest_item_at)} ({age}d old)
              </span>
            )}
          </div>
        </div>
      ) : null}

      <div className="conn-pills">
        {counts.length > 0 ? counts.map((count) => <span className="pill" key={count}>{count}</span>) : null}
        {counts.length === 0 && source.item_count > 0 ? (
          <span className="pill warning" title="The connector's own count — no matching rows are in the graph, so nothing is claimed here">
            claims {source.item_count.toLocaleString()} · none counted
          </span>
        ) : null}
        <span className="pill" title={source.last_sync_at ?? undefined}>
          {source.last_sync_at ? `synced ${relativeDay(source.last_sync_at)}` : "never synced"}
        </span>
      </div>

      {source.refresh.command ? (
        <CopyField title={`Refresh ${source.label} (local)`} value={source.refresh.command} />
      ) : (
        <p className="conn-note">
          {source.refresh.kind === "none" && source.status !== "connected" ? <AlertTriangle size={12} /> : null}
          {source.refresh.note}
        </p>
      )}
      {source.refresh.command ? <p className="conn-note">{source.refresh.note}</p> : null}
    </div>
  );
}
