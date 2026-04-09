import { useState, useEffect } from 'react';
import { Key, Eye, EyeOff, CheckCircle2, ExternalLink } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import Button from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import Card from '../components/ui/Card';

export default function SettingsPage() {
  const { toast, setCredentialsSet } = useApp();
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.credentials.get().then((res) => {
      if (res.api_key) {
        setApiKey(res.api_key);
        setCredentialsSet(res.has_secret);
      }
    }).catch(() => {});
  }, [setCredentialsSet]);

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
