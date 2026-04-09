import { useState, useEffect, useRef } from 'react';
import { Package, Download, Hammer, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Package as PkgType } from '../types/polygon';
import Button from '../components/ui/Button';
import { PackageStateBadge } from '../components/ui/Badge';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';
import { Select } from '../components/ui/Input';

const PKG_TYPES = [
  { value: 'standard', label: 'Standard (no generated tests, Windows executables)' },
  { value: 'linux', label: 'Linux (with generated tests, no compiled binaries)' },
  { value: 'windows', label: 'Windows (with generated tests and compiled binaries)' },
];

function formatDate(unix: number) {
  return new Date(unix * 1000).toLocaleString();
}

interface Props { problemId: number }

export default function PackagesTab({ problemId }: Props) {
  const { toast } = useApp();
  const [packages, setPackages] = useState<PkgType[]>([]);
  const [loading, setLoading] = useState(true);
  const [buildOpen, setBuildOpen] = useState(false);
  const [buildFull, setBuildFull] = useState(false);
  const [buildVerify, setBuildVerify] = useState(false);
  const [building, setBuilding] = useState(false);
  const [downloadType, setDownloadType] = useState('standard');
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.problem.packages(problemId) as { result: PkgType[] };
      setPackages(res.result || []);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load packages');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [problemId]);

  // Poll if any package is pending/running
  useEffect(() => {
    const hasPending = packages.some((p) => p.state === 'PENDING' || p.state === 'RUNNING');
    if (hasPending && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const res = await api.problem.packages(problemId) as { result: PkgType[] };
        const updated = res.result || [];
        setPackages(updated);
        const stillPending = updated.some((p) => p.state === 'PENDING' || p.state === 'RUNNING');
        if (!stillPending && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          toast('success', 'Package build completed!');
        }
      }, 5000);
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [packages]);

  const handleBuild = async () => {
    setBuilding(true);
    try {
      await api.problem.buildPackage(problemId, buildFull, buildVerify);
      toast('info', 'Package build started. Polling for completion...');
      setBuildOpen(false);
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to start package build');
    } finally {
      setBuilding(false);
    }
  };

  const handleDownload = (pkg: PkgType) => {
    api.problem.downloadPackage(problemId, pkg.id, downloadType);
  };

  const readyPackages = packages.filter((p) => p.state === 'READY');

  return (
    <div className="p-6 space-y-5">
      {/* Build controls */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={load}>
          Refresh
        </Button>
        <Button variant="primary" size="sm" icon={<Hammer className="w-4 h-4" />} onClick={() => setBuildOpen(true)}>
          Build Package
        </Button>
        {readyPackages.length > 0 && (
          <div className="flex items-center gap-2 ml-auto">
            <select
              value={downloadType}
              onChange={(e) => setDownloadType(e.target.value)}
              className="bg-[#211e1a] border border-[#362f28] rounded-lg px-3 py-1.5 text-sm text-gray-300 focus:outline-none focus:border-amber-500"
            >
              <option value="standard">standard</option>
              <option value="linux">linux</option>
              <option value="windows">windows</option>
            </select>
            <Button
              variant="secondary"
              size="sm"
              icon={<Download className="w-3.5 h-3.5" />}
              onClick={() => handleDownload(readyPackages[readyPackages.length - 1])}
            >
              Download Latest
            </Button>
          </div>
        )}
      </div>

      {/* Packages list */}
      <Card title={`Packages (${packages.length})`}>
        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : packages.length === 0 ? (
          <p className="text-gray-600 text-sm">No packages built yet. Click "Build Package" to create one.</p>
        ) : (
          <div className="divide-y divide-[#362f28]/50 -mx-5">
            <div className="grid grid-cols-[4rem_8rem_6rem_6rem_1fr_6rem] px-5 py-2 text-xs text-gray-600 uppercase tracking-wide">
              <span>ID</span>
              <span>Created</span>
              <span>Revision</span>
              <span>Type</span>
              <span>State</span>
              <span></span>
            </div>
            {[...packages].reverse().map((pkg) => (
              <div key={pkg.id} className="grid grid-cols-[4rem_8rem_6rem_6rem_1fr_6rem] items-center px-5 py-3 hover:bg-[#2c2722] group transition-colors">
                <span className="font-mono text-sm text-gray-500">#{pkg.id}</span>
                <span className="text-xs text-gray-600">{formatDate(pkg.creationTimeSeconds)}</span>
                <span className="font-mono text-xs text-gray-500">r{pkg.revision}</span>
                <span className="text-xs text-gray-500">{pkg.type}</span>
                <div className="flex items-center gap-2">
                  <PackageStateBadge state={pkg.state} />
                  {(pkg.state === 'PENDING' || pkg.state === 'RUNNING') && (
                    <RefreshCw className="w-3.5 h-3.5 text-blue-400 animate-spin" />
                  )}
                  {pkg.comment && <span className="text-xs text-gray-600 truncate">{pkg.comment}</span>}
                </div>
                {pkg.state === 'READY' && (
                  <Button
                    variant="ghost"
                    size="xs"
                    icon={<Download className="w-3 h-3" />}
                    onClick={() => handleDownload(pkg)}
                    className="opacity-0 group-hover:opacity-100"
                  >
                    Download
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Build modal */}
      <Modal
        open={buildOpen}
        onClose={() => setBuildOpen(false)}
        title="Build Package"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBuildOpen(false)}>Cancel</Button>
            <Button variant="primary" icon={<Hammer className="w-4 h-4" />} loading={building} onClick={handleBuild}>
              Start Build
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="space-y-3">
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={buildFull}
                onChange={(e) => setBuildFull(e.target.checked)}
                className="mt-0.5 rounded accent-amber-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-300">Full Package</span>
                <p className="text-xs text-gray-600 mt-0.5">Includes standard, linux, and windows packages. Takes longer.</p>
              </div>
            </label>
            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={buildVerify}
                onChange={(e) => setBuildVerify(e.target.checked)}
                className="mt-0.5 rounded accent-amber-500"
              />
              <div>
                <span className="text-sm font-medium text-gray-300">Verify Solutions</span>
                <p className="text-xs text-gray-600 mt-0.5">Run all solutions on all tests to verify tags are valid.</p>
              </div>
            </label>
          </div>
          <div className="p-3 rounded-lg bg-[#2c2722] text-xs text-gray-500">
            <p><strong className="text-gray-400">Standard:</strong> Windows executables, no generated tests.</p>
            <p className="mt-1"><strong className="text-gray-400">Linux:</strong> Generated tests, no compiled binaries.</p>
            <p className="mt-1"><strong className="text-gray-400">Windows:</strong> Generated tests + compiled binaries.</p>
          </div>
        </div>
      </Modal>
    </div>
  );
}
