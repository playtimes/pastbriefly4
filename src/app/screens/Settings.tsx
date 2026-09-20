import React, { useEffect, useState } from "react";
import { api, type SettingsStatus, type SettingsInput } from "../api.ts";

// The Config dashboard page: the mock/live toggle plus editable provider
// credentials. Secrets are write-only — the server reports whether each one is
// configured but never returns its value, and a blank field leaves it unchanged.
export function Settings(): React.ReactElement {
  const [status, setStatus] = useState<SettingsStatus | null>(null);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.settings().then(setStatus).catch((e) => setError(e?.message || "Could not load settings."));
  }, []);

  async function switchMode(mode: "mock" | "live"): Promise<void> {
    if (!status || status.mode === mode || switching) return;
    setSwitching(true);
    setError("");
    try {
      setStatus(await api.setMode(mode));
    } catch (e: any) {
      setError(e?.message || "Could not switch mode.");
    } finally {
      setSwitching(false);
    }
  }

  if (!status) return <p className="text-muted">{error || "Loading…"}</p>;

  return (
    <div className="flex flex-col gap-8 max-w-2xl">
      <section className="flex flex-col gap-2">
        <p className="kicker">Configuration</p>
        <h1 className="text-3xl md:text-4xl">Config</h1>
        <p className="text-muted text-sm">
          Choose whether providers run offline or live, and set the API credentials the live pipeline uses. Keys are
          stored locally on the server and are never shown again once saved.
        </p>
      </section>

      <section className="surface p-5 flex flex-col gap-4">
        <h2 className="text-xl">Provider mode</h2>
        <p className="text-muted text-sm">
          Mock runs everything offline for preview. Live uses your API keys and can incur real cost. The choice is saved
          and survives a restart.
        </p>
        <div className="flex gap-2">
          {(["mock", "live"] as const).map((m) => (
            <button
              key={m}
              onClick={() => switchMode(m)}
              disabled={switching}
              className={`px-4 py-2 rounded-lg text-sm font-semibold border transition disabled:opacity-60 ${
                status.mode === m ? "bg-accent text-[#f7f4ee] border-transparent" : "border-line text-muted hover:text-ink"
              }`}
            >
              {m === "mock" ? "Mock (offline)" : "Live"}
            </button>
          ))}
        </div>
        {error && <span className="text-sm text-[#c76b4a]">{error}</span>}
      </section>

      <Credentials status={status} onSaved={setStatus} />
    </div>
  );
}

// The editable credentials form. Secrets use masked inputs; a blank field means
// "leave the current value unchanged". Only whether a value is configured is ever
// shown — never the value itself.
function Credentials({ status, onSaved }: { status: SettingsStatus; onSaved: (s: SettingsStatus) => void }): React.ReactElement {
  const [form, setForm] = useState<SettingsInput>({});
  const [voiceId, setVoiceId] = useState(status.elevenlabs.voiceId);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const field = (key: keyof SettingsInput, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  async function save(): Promise<void> {
    setSaving(true);
    setError("");
    try {
      const next = await api.saveSettings({ ...form, elevenlabsVoiceId: voiceId });
      onSaved(next);
      setVoiceId(next.elevenlabs.voiceId);
      setForm({}); // clear the secret inputs so nothing lingers in the DOM
      setSaved(true);
    } catch (e: any) {
      setError(e?.message || "Could not save configuration.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="surface p-5 flex flex-col gap-4">
      <h2 className="text-xl">Provider credentials</h2>
      <p className="text-muted text-sm">
        Live mode needs OpenAI, ElevenLabs and Higgsfield keys; YouTube is optional. Leave a field blank to keep its
        current value.
      </p>

      <div className="flex flex-col gap-4">
        <Secret label="OpenAI API key" configured={status.openai.apiKeySet} value={form.openaiApiKey ?? ""} onChange={(v) => field("openaiApiKey", v)} />
        <Secret label="ElevenLabs API key" configured={status.elevenlabs.apiKeySet} value={form.elevenlabsApiKey ?? ""} onChange={(v) => field("elevenlabsApiKey", v)} />
        <div className="flex flex-col gap-1.5">
          <label className="text-sm text-ink">ElevenLabs Voice ID</label>
          <input
            value={voiceId}
            onChange={(e) => { setVoiceId(e.target.value); setSaved(false); }}
            placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
            className="w-full rounded-lg bg-field border border-line px-3 py-2 text-sm text-ink outline-none transition focus:border-accent/55"
          />
        </div>
        <Secret label="Higgsfield API key" configured={status.higgsfield.apiKeySet} value={form.higgsfieldApiKey ?? ""} onChange={(v) => field("higgsfieldApiKey", v)} />
        <Secret label="Higgsfield API secret" configured={status.higgsfield.apiSecretSet} value={form.higgsfieldApiSecret ?? ""} onChange={(v) => field("higgsfieldApiSecret", v)} />
        <Secret label="YouTube Data API key" configured={status.youtube.apiKeySet} value={form.youtubeApiKey ?? ""} onChange={(v) => field("youtubeApiKey", v)} />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={save}
          disabled={saving}
          className="px-4 py-2 rounded-lg text-sm font-semibold bg-accent text-[#f7f4ee] transition hover:bg-accent-hover disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save configuration"}
        </button>
        {saved && <span className="text-sm text-accent">Configuration saved.</span>}
        {error && <span className="text-sm text-[#c76b4a]">{error}</span>}
      </div>
    </section>
  );
}

// One masked credential input. Shows only whether a value is already configured;
// the stored value (and any suffix of it) is never sent to the browser.
function Secret({ label, configured, value, onChange }: { label: string; configured: boolean; value: string; onChange: (v: string) => void }): React.ReactElement {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <label className="text-sm text-ink">{label}</label>
        {configured ? (
          <span className="text-xs text-accent">Configured</span>
        ) : (
          <span className="text-xs text-[#c76b4a]">Not set</span>
        )}
      </div>
      <input
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="new-password"
        placeholder={configured ? "Leave blank to keep current value" : "Not set"}
        className="w-full rounded-lg bg-field border border-line px-3 py-2 text-sm text-ink outline-none transition focus:border-accent/55"
      />
    </div>
  );
}
