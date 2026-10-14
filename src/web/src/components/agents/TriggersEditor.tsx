import { useEffect, useState } from "react";
import { orgParam } from "../../org";
import type { Snapshot, TriggerInput, TriggerKind } from "../../../../core/types";
import { GITHUB_EVENTS, ISSUE_TYPES, SLACK_EVENTS } from "../../../../core/types";
import { api, type TriggerStatus } from "../../api";
import { Button, Dot, ErrorText, inputClass, timeAgo, useAction } from "../ui";

const KINDS: { kind: TriggerKind; label: string; hint: string }[] = [
  { kind: "assigned", label: "Given to this agent", hint: "Starts when someone hands this agent an issue." },
  { kind: "issue_created", label: "New issue", hint: "Starts whenever someone opens an issue." },
  { kind: "issue_moved", label: "Stage change", hint: "Starts when an issue reaches one of the chosen stages." },
  { kind: "label_added", label: "Label added", hint: "Runs when one of the chosen labels is added to an issue." },
  { kind: "issue_commented", label: "New comment", hint: "Starts when a person comments on an issue." },
  { kind: "schedule", label: "Schedule", hint: "Runs on a schedule, in the time zone you pick." },
  { kind: "webhook", label: "Webhook", hint: "Runs when another tool POSTs to this agent's secret URL. The body becomes context." },
  { kind: "github", label: "GitHub", hint: "Runs on pull request events: from a GitHub webhook, or seen by Cadence on PRs it follows (no public URL needed)." },
  { kind: "slack", label: "Slack", hint: "Runs on Slack activity in channels the Cadence bot is in. Each thread gets its own workspace; replies in it continue the same chat." },
];

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const ZONES: string[] = (() => {
  const all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  return [...new Set([browserZone(), "UTC", ...all])];
})();

const blank = (kind: TriggerKind): TriggerInput => {
  switch (kind) {
    case "issue_created":
      return { kind, stageIds: [], types: [] };
    case "issue_moved":
      return { kind, toStageIds: [] };
    case "label_added":
      return { kind, labelIds: [] };
    case "schedule":
      return { kind, cron: "0 9 * * 1-5", description: "Weekdays at 9:00", timezone: browserZone() };
    case "webhook":
      return { kind, secret: "" };
    case "github":
      return { kind, events: ["pr_merged"], secret: "" };
    case "slack":
      return { kind, events: ["mention"], channelIds: [], emoji: [] };
    default:
      return { kind } as TriggerInput;
  }
};

function toggle<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function Pills<T extends string>({ options, selected, onChange, render }: { options: T[]; selected: T[]; onChange: (v: T[]) => void; render: (v: T) => React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          onClick={() => onChange(toggle(selected, o))}
          className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${selected.includes(o) ? "bg-zinc-700 text-zinc-100" : "text-zinc-500 ring-1 ring-zinc-800 hover:text-zinc-300"}`}
        >
          {render(o)}
        </button>
      ))}
    </div>
  );
}

function ScheduleConfig({ trigger, onChange }: { trigger: Extract<TriggerInput, { kind: "schedule" }>; onChange: (t: TriggerInput) => void }) {
  const [text, setText] = useState("");
  const action = useAction();
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input className={inputClass} placeholder='Plain English, e.g. "every weekday at 9am"' value={text} onChange={(e) => setText(e.target.value)} />
        <Button
          disabled={!text.trim() || action.busy}
          onClick={() =>
            action.run(async () => {
              const out = await api.cronFromText(text);
              onChange({ ...trigger, cron: out.cron, description: out.description });
            })
          }
        >
          Generate
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input className={`${inputClass} font-mono`} value={trigger.cron} onChange={(e) => onChange({ ...trigger, cron: e.target.value })} />
        <input className={inputClass} placeholder="Description" value={trigger.description} onChange={(e) => onChange({ ...trigger, description: e.target.value })} />
      </div>
      <select className={inputClass} value={trigger.timezone ?? ""} onChange={(e) => onChange({ ...trigger, timezone: e.target.value || undefined })} title="Time zone">
        <option value="">Server's time zone</option>
        {ZONES.map((z) => (
          <option key={z}>{z}</option>
        ))}
      </select>
      <ErrorText>{action.error}</ErrorText>
    </div>
  );
}

function SlackConfig({ trigger, onChange }: { trigger: Extract<TriggerInput, { kind: "slack" }>; onChange: (t: TriggerInput) => void }) {
  const [channels, setChannels] = useState<{ id: string; name: string; is_member: boolean }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [emoji, setEmoji] = useState(trigger.emoji.join(", "));
  useEffect(() => {
    api.slackChannels().then(setChannels, (e: Error) => setError(e.message));
  }, []);
  const label = { message: "any message", mention: "@Cadence mention", reaction: "reaction" } as const;
  return (
    <div className="space-y-2">
      <Pills options={[...SLACK_EVENTS]} selected={trigger.events} onChange={(events) => onChange({ ...trigger, events })} render={(v) => label[v]} />
      <label className="flex items-center gap-1.5 text-xs text-zinc-400" title="Messages other apps and bots post. Cadence's own messages never trigger, and bots never wake a thread an agent is in.">
        <input type="checkbox" checked={trigger.includeBots === true} onChange={(e) => onChange({ ...trigger, includeBots: e.target.checked })} /> Include messages from other bots and apps
      </label>
      {channels ? (
        <>
          <Pills
            options={channels.filter((c) => c.is_member || trigger.channelIds.includes(c.id)).map((c) => c.id)}
            selected={trigger.channelIds}
            onChange={(channelIds) => onChange({ ...trigger, channelIds })}
            render={(id) => `#${channels.find((c) => c.id === id)?.name ?? id}`}
          />
          <p className="text-xs text-zinc-600">Leave empty for every channel the bot is in. Invite @Cadence to a channel to see it here.</p>
        </>
      ) : (
        <p className="text-xs text-zinc-500">{error ? `${error} ` : "Loading channels..."}</p>
      )}
      {trigger.events.includes("reaction") && (
        <input
          className={inputClass}
          placeholder="Only these emoji, comma separated (e.g. bug, eyes); empty for any"
          value={emoji}
          onChange={(e) => setEmoji(e.target.value)}
          onBlur={() => onChange({ ...trigger, emoji: emoji.split(",").map((x) => x.trim().replace(/:/g, "")).filter(Boolean) })}
        />
      )}
    </div>
  );
}

function SecretUrl({ label, url, secret }: { label: string; url: string | null; secret?: string }) {
  if (!url) return <p className="text-xs text-zinc-500">Save the agent to generate its URL and secret.</p>;
  return (
    <div className="space-y-1 text-xs">
      <p className="text-zinc-500">{label}</p>
      <code className="block overflow-x-auto rounded bg-zinc-950 p-2 text-zinc-300">{url}</code>
      {secret && (
        <>
          <p className="text-zinc-500">Webhook secret (set it in GitHub; content type application/json)</p>
          <code className="block overflow-x-auto rounded bg-zinc-950 p-2 text-zinc-300">{secret}</code>
        </>
      )}
    </div>
  );
}

export function TriggersEditor({ triggers, onChange, snapshot, agentId }: { triggers: TriggerInput[]; onChange: (t: TriggerInput[]) => void; snapshot: Snapshot; agentId: string | null }) {
  const [adding, setAdding] = useState(false);
  const update = (i: number, t: TriggerInput) => onChange(triggers.map((x, j) => (j === i ? t : x)));
  const [status, setStatus] = useState<TriggerStatus | null>(null);
  useEffect(() => {
    if (agentId) api.triggerStatus(agentId).then(setStatus, () => undefined);
  }, [agentId, JSON.stringify(triggers)]);
  const remove = (i: number) => onChange(triggers.filter((_, j) => j !== i));
  const available = KINDS.filter((k) => k.kind === "schedule" || k.kind === "webhook" || !triggers.some((t) => t.kind === k.kind));
  const origin = window.location.origin;

  return (
    <div className="space-y-2">
      {triggers.length === 0 && <p className="text-sm text-zinc-500">No triggers. This agent only runs when you start it.</p>}
      {triggers.map((t, i) => {
        const meta = KINDS.find((k) => k.kind === t.kind)!;
        return (
          <div key={t.id ?? i} className="space-y-2 rounded-lg bg-zinc-900 p-3 ring-1 ring-zinc-800">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{meta.label}</span>
              <button className="ml-auto text-xs text-zinc-500 hover:text-red-400" onClick={() => remove(i)}>
                Remove
              </button>
            </div>
            <p className="text-xs text-zinc-500">{meta.hint}</p>
            {t.kind === "issue_created" && (
              <>
                <Pills options={snapshot.stages.map((s) => s.id)} selected={t.stageIds} onChange={(stageIds) => update(i, { ...t, stageIds })} render={(id) => snapshot.stages.find((s) => s.id === id)?.name} />
                <Pills options={[...ISSUE_TYPES]} selected={t.types} onChange={(types) => update(i, { ...t, types })} render={(v) => v} />
                <p className="text-xs text-zinc-600">Leave empty to match any stage or type.</p>
              </>
            )}
            {t.kind === "issue_moved" && (
              <Pills options={snapshot.stages.map((s) => s.id)} selected={t.toStageIds} onChange={(toStageIds) => update(i, { ...t, toStageIds })} render={(id) => snapshot.stages.find((s) => s.id === id)?.name} />
            )}
            {t.kind === "label_added" && (
              <Pills
                options={snapshot.labels.map((l) => l.id)}
                selected={t.labelIds}
                onChange={(labelIds) => update(i, { ...t, labelIds })}
                render={(id) => {
                  const l = snapshot.labels.find((x) => x.id === id)!;
                  return (
                    <>
                      <Dot color={l.color} className="size-1.5" />
                      {l.name}
                    </>
                  );
                }}
              />
            )}
            {t.kind === "schedule" && <ScheduleConfig trigger={t} onChange={(nt) => update(i, nt)} />}
            {(() => {
              const est = status?.estimates.find((e) => e.triggerId === t.id);
              const sch = status?.schedules.find((s) => s.triggerId === t.id);
              if (!est && !sch) return null;
              return (
                <p className="text-[11px] text-zinc-500">
                  {est && (est.perDay === null ? est.basis : `About ${est.perDay} run${est.perDay === 1 ? "" : "s"} a day. ${est.basis}.`)}
                  {sch?.next && ` Next: ${new Date(sch.next).toLocaleString()}.`}
                  {sch?.lastRunAt && ` Last ran ${timeAgo(sch.lastRunAt)}.`}
                </p>
              );
            })()}
            {t.kind === "webhook" && <SecretUrl label="POST JSON or text to:" url={agentId && t.secret ? `${origin}/api/hooks/agents/${agentId}/${t.secret}${orgParam()}` : null} />}
            {t.kind === "slack" && <SlackConfig trigger={t} onChange={(nt) => update(i, nt)} />}
            {t.kind === "github" && (
              <>
                <Pills options={[...GITHUB_EVENTS]} selected={t.events} onChange={(events) => update(i, { ...t, events })} render={(v) => v.replace(/^pr_/, "PR ").replace(/_/g, " ")} />
                <input
                  className={inputClass}
                  placeholder="Only by these GitHub users, comma separated (empty for anyone)"
                  defaultValue={(t.authors ?? []).join(", ")}
                  onBlur={(e) => update(i, { ...t, authors: e.target.value.split(/[\s,]+/).map((x) => x.trim().replace(/^@/, "")).filter(Boolean) })}
                />
                <SecretUrl label="GitHub webhook payload URL:" url={agentId && t.secret ? `${origin}/api/hooks/github/${agentId}${orgParam()}` : null} secret={t.secret} />
              </>
            )}
          </div>
        );
      })}
      {adding ? (
        <div className="grid grid-cols-2 gap-1 rounded-lg bg-zinc-900 p-1 ring-1 ring-zinc-800">
          {available.map((k) => (
            <button
              key={k.kind}
              className="rounded px-2 py-1.5 text-left text-sm hover:bg-zinc-800"
              onClick={() => {
                onChange([...triggers, blank(k.kind)]);
                setAdding(false);
              }}
            >
              {k.label}
            </button>
          ))}
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setAdding(true)}>
          + Add trigger
        </Button>
      )}
    </div>
  );
}
