import { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, CheckCircle2, ExternalLink, ToggleLeft, ToggleRight, Save } from 'lucide-react';
import { api, AppSettings } from '../api/client';
import { useApp } from '../context/AppContext';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import Card from '../components/ui/Card';

const DEFAULT_SETTINGS: AppSettings = {
  enable_groups: true,
  enable_points: true,
  checker_source_type: 'cpp.gcc14-64-msys2-g++23',
  solution_source_type: 'cpp.g++17',
  default_time_limit: 1000,
  default_memory_limit: 256,
};

export default function SettingsPage() {
  const { toast, setCredentialsSet } = useApp();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Default problem settings
  const [defaults, setDefaults] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [savingImport, setSavingImport] = useState(false);

  // Codeforces web login (for contest automation)
  const [cfLogin, setCfLogin] = useState('');
  const [cfPassword, setCfPassword] = useState('');
  const [hasCfPassword, setHasCfPassword] = useState(false);
  const [showCfPassword, setShowCfPassword] = useState(false);
  const [savingCf, setSavingCf] = useState(false);

  useEffect(() => {
    api.credentials.get().then((res) => {
      if (res.api_key) {
        setApiKey(res.api_key);
        setCredentialsSet(res.has_secret);
      }
      setCfLogin(res.cf_login || '');
      setHasCfPassword(!!res.has_cf_password);
    }).catch(() => {});
    api.settings.get().then((s) => setDefaults({ ...DEFAULT_SETTINGS, ...s })).catch(() => {});
  }, [setCredentialsSet]);

  const saveCf = async () => {
    setSavingCf(true);
    try {
      await api.credentials.setCf(cfLogin.trim(), cfPassword || undefined);
      if (cfPassword) setHasCfPassword(true);
      setCfPassword('');
      toast('success', 'Codeforces web login saved');
    } catch {
      toast('error', 'Failed to save Codeforces login');
    } finally {
      setSavingCf(false);
    }
  };

  const saveImportDefaults = async () => {
    setSavingImport(true);
    try {
      await api.settings.update({
        checker_source_type: defaults.checker_source_type,
        solution_source_type: defaults.solution_source_type,
        default_time_limit: Number(defaults.default_time_limit) || 1000,
        default_memory_limit: Number(defaults.default_memory_limit) || 256,
      });
      toast('success', 'Import defaults saved');
    } catch {
      toast('error', 'Failed to save import defaults');
    } finally {
      setSavingImport(false);
    }
  };

  const toggleDefault = async (key: 'enable_groups' | 'enable_points') => {
    const newValue = !defaults[key];
    const updated = { ...defaults, [key]: newValue };
    setDefaults(updated);
    setSavingDefaults(true);
    try {
      await api.settings.update({ [key]: newValue });
      toast('success', `${key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())} ${newValue ? 'enabled' : 'disabled'} by default`);
    } catch {
      setDefaults(defaults); // revert
      toast('error', 'Failed to save setting');
    } finally {
      setSavingDefaults(false);
    }
  };

  const handleSave = async () => {
    if (!apiKey.trim() || !apiSecret.trim()) {
      toast('error', 'Both API key and secret are required.');
      return;
    }
    setSaving(true);
    try {
      await api.credentials.set(apiKey.trim(), apiSecret.trim());
      setCredentialsSet(true);
      setSaved(true);
      toast('success', 'Credentials saved successfully!');
      setTimeout(() => setSaved(false), 3000);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save credentials');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-8">
      <div className="max-w-2xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-white">Settings</h1>
          <p className="text-gray-500 text-sm mt-1">Configure your Polygon API credentials</p>
        </div>

        {/* Credentials Card */}
        <Card title="Polygon API Credentials">
          <div className="space-y-5">
            <div className="p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 text-sm text-amber-300">
              <p className="font-medium mb-1">How to get your API credentials</p>
              <p className="text-amber-400/80">
                Visit your Polygon account settings page, navigate to the API section, and generate a new API key.
              </p>
              <a
                href="https://polygon.codeforces.com/api-key"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-2 text-amber-400 hover:text-amber-300 underline underline-offset-2"
              >
                polygon.codeforces.com/api-key
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>

            <Input
              label="API Key"
              placeholder="Your Polygon API key"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />

            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">API Secret</label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  placeholder="Your Polygon API secret"
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 pr-10 text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500/50 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors"
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            <div className="flex items-center gap-3 pt-2">
              <Button
                variant="primary"
                icon={<Key className="w-4 h-4" />}
                loading={saving}
                onClick={handleSave}
              >
                Save Credentials
              </Button>
              {saved && (
                <span className="flex items-center gap-1.5 text-sm text-green-400">
                  <CheckCircle2 className="w-4 h-4" />
                  Saved!
                </span>
              )}
            </div>
          </div>
        </Card>

        {/* Default Problem Settings */}
        <Card title="Default Problem Settings">
          <div className="space-y-1">
            <p className="text-xs text-gray-500 mb-4">
              These settings are automatically applied when opening a problem's Tests tab.
            </p>

            {([
              { key: 'enable_groups' as const, label: 'Enable Groups', desc: 'Auto-enable test groups on Polygon when opening a problem' },
              { key: 'enable_points' as const, label: 'Enable Points', desc: 'Auto-enable points scoring on Polygon when opening a problem' },
            ]).map(({ key, label, desc }) => (
              <button
                key={key}
                onClick={() => toggleDefault(key)}
                disabled={savingDefaults}
                className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#211e1a] transition-colors disabled:opacity-50"
              >
                <div className="text-left">
                  <p className="text-sm font-medium text-gray-200">{label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                </div>
                {defaults[key] ? (
                  <ToggleRight className="w-6 h-6 text-amber-400 flex-shrink-0" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-gray-600 flex-shrink-0" />
                )}
              </button>
            ))}
          </div>
        </Card>

        {/* Codeforces Web Login */}
        <Card title="Codeforces Web Login (contest automation)">
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-300">
              Used only to drive the Polygon website for the "Add to contest" feature (Polygon has no contest API).
              Stored in plaintext in <code className="font-mono">backend/config.json</code> (gitignored). Prefer a
              Codeforces account you're comfortable scripting; the password is never returned by the app once saved.
            </div>
            <Input
              label="Codeforces handle / email"
              placeholder="your Codeforces login"
              value={cfLogin}
              onChange={(e) => setCfLogin(e.target.value)}
            />
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-gray-400 uppercase tracking-wide">Password {hasCfPassword && <span className="text-green-400 normal-case">· saved</span>}</label>
              <div className="relative">
                <input
                  type={showCfPassword ? 'text' : 'password'}
                  placeholder={hasCfPassword ? '•••••••• (leave blank to keep)' : 'Codeforces password'}
                  value={cfPassword}
                  onChange={(e) => setCfPassword(e.target.value)}
                  className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-2 pr-10 text-gray-200 placeholder-gray-500 text-sm focus:outline-none focus:border-amber-500"
                />
                <button type="button" onClick={() => setShowCfPassword(!showCfPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
                  {showCfPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
            <Button variant="primary" size="sm" icon={<Save className="w-4 h-4" />} loading={savingCf} onClick={saveCf} disabled={!cfLogin.trim()}>
              Save Codeforces Login
            </Button>
          </div>
        </Card>

        {/* ZIP Import Defaults */}
        <Card title="ZIP Import Defaults">
          <div className="space-y-4">
            <p className="text-xs text-gray-500">
              Applied when importing problems from ZIP. Each import can optionally override these for a single batch.
            </p>
            <div className="grid grid-cols-2 gap-4">
              <Input
                label="Checker source type"
                value={defaults.checker_source_type}
                onChange={(e) => setDefaults({ ...defaults, checker_source_type: e.target.value })}
                placeholder="cpp.gcc14-64-msys2-g++23"
              />
              <Input
                label="Solution source type"
                value={defaults.solution_source_type}
                onChange={(e) => setDefaults({ ...defaults, solution_source_type: e.target.value })}
                placeholder="cpp.g++17"
              />
              <Input
                label="Default time limit (ms)"
                type="number"
                value={String(defaults.default_time_limit)}
                onChange={(e) => setDefaults({ ...defaults, default_time_limit: Number(e.target.value) })}
              />
              <Input
                label="Default memory limit (MB)"
                type="number"
                value={String(defaults.default_memory_limit)}
                onChange={(e) => setDefaults({ ...defaults, default_memory_limit: Number(e.target.value) })}
              />
            </div>
            <Button variant="primary" size="sm" icon={<Save className="w-4 h-4" />} loading={savingImport} onClick={saveImportDefaults}>
              Save Import Defaults
            </Button>
          </div>
        </Card>

        {/* Info Card */}
        <Card title="About">
          <div className="space-y-3 text-sm text-gray-400">
            <p>
              <span className="text-gray-300 font-medium">Polygon Middleman</span> is a local app that provides a
              full-featured interface for the Codeforces Polygon API. All API requests are proxied through a local
              backend server running on port 8000.
            </p>
            <p>Your credentials are stored locally in <code className="font-mono text-xs bg-[#2c2722] px-1.5 py-0.5 rounded">backend/config.json</code>.</p>
          </div>
        </Card>
      </div>
    </div>
  );
}
