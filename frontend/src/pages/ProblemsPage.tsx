import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, RefreshCw, Star, Lock, Edit3, Eye,
  AlertCircle, Upload, ChevronLeft, ChevronRight, Archive
} from 'lucide-react';
import { api, ApiError } from '../api/client';
import { useApp } from '../context/AppContext';
import { Problem } from '../types/polygon';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Modal from '../components/ui/Modal';
import { Input } from '../components/ui/Input';
import UploadWizard from '../wizard/UploadWizard';
import ZipImport from '../wizard/ZipImport';

export default function ProblemsPage() {
  const navigate = useNavigate();
  const { problems, setProblems, setSelectedProblem, toast, credentialsSet, username, setUsername } = useApp();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showDeleted, setShowDeleted] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [zipImportOpen, setZipImportOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(20);

  const loadProblems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.problems.list({ showDeleted }) as { result: Problem[] };
      const list = res.result || [];
      setProblems(list);
      // Auto-detect Polygon username from first owned problem
      if (!username && list.length > 0) {
        const owned = list.find(p => p.accessType === 'OWNER');
        if (owned) setUsername(owned.owner);
      }
    } catch (e: unknown) {
      if (e instanceof ApiError && e.message.toLowerCase().includes('credentials')) return;
      toast('error', e instanceof Error ? e.message : 'Failed to load problems');
    } finally {
      setLoading(false);
    }
  }, [showDeleted, setProblems, toast, credentialsSet, username, setUsername]);

  // Load immediately on mount and whenever showDeleted changes;
  // also re-fires when loadProblems identity changes (e.g. after credentialsSet flip)
  useEffect(() => {
    loadProblems();
  }, [loadProblems]);

  const filtered = problems.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      String(p.id).includes(search) ||
      p.owner.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.ceil(filtered.length / pageSize);
  const paged = filtered.slice(page * pageSize, (page + 1) * pageSize);

  // Reset page when search/filter changes
  useEffect(() => { setPage(0); }, [search, showDeleted]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await api.problems.create(newName.trim()) as { result?: Problem };
      toast('success', `Problem "${newName}" created!`);
      setCreateOpen(false);
      setNewName('');
      await loadProblems();
      // Navigate to the new problem; fall back to a fresh list search if result.id missing
      let newId = res.result?.id;
      if (!newId) {
        const listRes = await api.problems.list({}) as { result?: Problem[] };
        const all = listRes.result || [];
        const target = newName.trim();
        const match =
          all.find((p) => p.name === target) ??
          all.find((p) => p.name.toLowerCase() === target.toLowerCase());
        newId = match?.id;
      }
      if (newId) navigate(`/problems/${newId}`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to create problem');
    } finally {
      setCreating(false);
    }
  };

  const openProblem = (p: Problem) => {
    setSelectedProblem(p);
    navigate(`/problems/${p.id}`);
  };

  const accessIcon = (access: string) => {
    if (access === 'OWNER') return <Star className="w-3.5 h-3.5 text-yellow-400" />;
    if (access === 'WRITE') return <Edit3 className="w-3.5 h-3.5 text-blue-400" />;
    return <Eye className="w-3.5 h-3.5 text-gray-500" />;
  };

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-[#362f28] bg-[#110f0d]">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold text-white">Problems</h1>
            <p className="text-gray-500 text-xs mt-0.5">{problems.length} problems available</p>
          </div>
          <div className="flex items-center gap-2">
            {!credentialsSet && (
              <div className="flex items-center gap-2 text-sm text-yellow-400 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-3 py-1.5">
                <AlertCircle className="w-4 h-4" />
                Set API credentials in Settings
              </div>
            )}
            <Button
              variant="ghost"
              size="sm"
              icon={<RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />}
              onClick={loadProblems}
              disabled={!credentialsSet}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Archive className="w-4 h-4" />}
              onClick={() => setZipImportOpen(true)}
              disabled={!credentialsSet}
            >
              Import ZIP
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload className="w-4 h-4" />}
              onClick={() => setWizardOpen(true)}
              disabled={!credentialsSet}
            >
              Upload Wizard
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setCreateOpen(true)}
              disabled={!credentialsSet}
            >
              New Problem
            </Button>
          </div>
        </div>

        {/* Search bar */}
        <div className="mt-4 flex items-center gap-3">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
            <input
              type="text"
              placeholder="Search by name, ID, or owner..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-full bg-[#211e1a] border border-[#362f28] rounded-lg pl-9 pr-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-500 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showDeleted}
              onChange={(e) => setShowDeleted(e.target.checked)}
              className="rounded accent-amber-500"
            />
            Show deleted
          </label>
        </div>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-48 text-gray-500">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" />
            Loading problems...
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-600">
            <LayoutList className="w-10 h-10 mb-3 opacity-30" />
            {search ? 'No problems match your search.' : 'No problems found. Create one or check your credentials.'}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 bg-[#1a1714] border-b border-[#362f28] z-10">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-20">ID</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Name</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide">Owner</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Access</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-24">Revision</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500 uppercase tracking-wide w-28">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#362f28]/50 stagger-children">
              {paged.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => openProblem(p)}
                  className="hover:bg-[#211e1a] cursor-pointer transition-colors group"
                >
                  <td className="px-4 py-3.5 font-mono text-sm text-gray-500">#{p.id}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-2">
                      {p.favourite && <Star className="w-3.5 h-3.5 text-yellow-400 fill-yellow-400" />}
                      <span className="text-sm font-medium text-gray-200 group-hover:text-white transition-colors">
                        {p.name}
                      </span>
                      {p.deleted && <Badge variant="danger">deleted</Badge>}
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-sm text-gray-500">{p.owner}</td>
                  <td className="px-4 py-3.5">
                    <span className="flex items-center gap-1.5 text-sm">
                      {accessIcon(p.accessType)}
                      <span className="text-gray-500 text-xs">{p.accessType}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3.5 font-mono text-sm text-gray-500">r{p.revision}</td>
                  <td className="px-4 py-3.5">
                    <div className="flex items-center gap-1.5">
                      {p.modified && <Badge variant="warning">modified</Badge>}
                      {p.latestPackage && (
                        <Badge variant="success">pkg r{p.latestPackage}</Badge>
                      )}
                      {!p.modified && !p.latestPackage && (
                        <Badge variant="default">clean</Badge>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {!loading && filtered.length > 0 && (
        <div className="flex-shrink-0 px-6 py-3 border-t border-[#362f28] bg-[#110f0d] flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-gray-500">
            <span>
              {page * pageSize + 1}–{Math.min((page + 1) * pageSize, filtered.length)} of {filtered.length}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-xs">Per page:</span>
              <select
                value={pageSize}
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
                className="bg-[#211e1a] border border-[#362f28] rounded px-2 py-1 text-xs text-gray-300 focus:outline-none focus:border-amber-500"
              >
                {[10, 20, 50, 100].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(Math.max(0, page - 1))}
              disabled={page === 0}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#211e1a] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 7) {
                pageNum = i;
              } else if (page < 3) {
                pageNum = i;
              } else if (page > totalPages - 4) {
                pageNum = totalPages - 7 + i;
              } else {
                pageNum = page - 3 + i;
              }
              return (
                <button
                  key={pageNum}
                  onClick={() => setPage(pageNum)}
                  className={`w-8 h-8 rounded-lg text-xs font-medium transition-colors ${
                    page === pageNum
                      ? 'bg-amber-600 text-white'
                      : 'text-gray-500 hover:text-gray-300 hover:bg-[#211e1a]'
                  }`}
                >
                  {pageNum + 1}
                </button>
              );
            })}
            <button
              onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
              disabled={page >= totalPages - 1}
              className="p-1.5 rounded-lg text-gray-500 hover:text-gray-300 hover:bg-[#211e1a] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Create Problem Modal */}
      <Modal
        open={createOpen}
        onClose={() => { setCreateOpen(false); setNewName(''); }}
        title="Create New Problem"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={creating} onClick={handleCreate}>Create</Button>
          </>
        }
      >
        <Input
          label="Problem Name"
          placeholder="e.g. A Plus B"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
          autoFocus
        />
      </Modal>

      {/* Upload Wizard */}
      <UploadWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />

      {/* ZIP Import */}
      <ZipImport open={zipImportOpen} onClose={() => setZipImportOpen(false)} />
    </div>
  );
}

function LayoutList({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
    </svg>
  );
}
