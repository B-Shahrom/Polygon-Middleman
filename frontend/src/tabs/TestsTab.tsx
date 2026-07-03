import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Plus, Eye, Upload, Archive, Layers, RefreshCw,
  FolderOpen, Trash2, Tag, Check, CheckSquare, Square,
  Edit3, X, FileText, ToggleLeft, ToggleRight, Wand2,
} from 'lucide-react';
import JSZip from 'jszip';
import { api } from '../api/client';
import { useApp } from '../context/AppContext';
import { Test } from '../types/polygon';
import Button from '../components/ui/Button';
import Badge from '../components/ui/Badge';
import Card from '../components/ui/Card';
import Modal from '../components/ui/Modal';
import { Textarea, Input, Select } from '../components/ui/Input';

const TESTSETS = [
  { value: 'tests', label: 'tests' },
  { value: 'pretests', label: 'pretests' },
];

interface Props { problemId: number }

interface PendingTest {
  index: number;
  input: string;
  filename?: string;
  group?: string;
  description?: string;
}

import { extractGroupFromFilename, extractIndexFromFilename } from '../utils/testParser';
import { deriveDependenciesFromScoring, derivePointsFromScoring } from '../utils/statementParser';

/** Truncate string for preview */
function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max) + '...';
}

export default function TestsTab({ problemId }: Props) {
  const { toast } = useApp();
  const [tests, setTests] = useState<Test[]>([]);
  const [loading, setLoading] = useState(true);
  const [testset, setTestset] = useState('tests');

  // Add test modal
  const [addOpen, setAddOpen] = useState(false);
  const [addIndex, setAddIndex] = useState(1);
  const [addInput, setAddInput] = useState('');
  const [addGroup, setAddGroup] = useState('');
  const [addPoints, setAddPoints] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addUseInStatements, setAddUseInStatements] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit test modal
  const [editOpen, setEditOpen] = useState(false);
  const [editTest, setEditTest] = useState<Test | null>(null);
  const [editInput, setEditInput] = useState('');
  const [editAnswer, setEditAnswer] = useState('');
  const [editGroup, setEditGroup] = useState('');
  const [editPoints, setEditPoints] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editUseInStatements, setEditUseInStatements] = useState(false);
  const [editLoading, setEditLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);

  // ZIP upload
  const [zipOpen, setZipOpen] = useState(false);
  const [pendingTests, setPendingTests] = useState<PendingTest[]>([]);
  const [zipUploading, setZipUploading] = useState(false);
  const [zipProgress, setZipProgress] = useState(0);
  const zipRef = useRef<HTMLInputElement>(null);

  // Individual file upload
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  // Preview cache for content preview column
  const [previews, setPreviews] = useState<Record<number, string>>({});

  // Inline cell editing
  const [inlineEdit, setInlineEdit] = useState<{ index: number; field: 'group' | 'points'; value: string } | null>(null);
  const [inlineSaving, setInlineSaving] = useState(false);
  const inlineRef = useRef<HTMLInputElement>(null);

  // Bulk selection
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkGroupOpen, setBulkGroupOpen] = useState(false);
  const [bulkGroupValue, setBulkGroupValue] = useState('');
  const [bulkActing, setBulkActing] = useState(false);

  // Enable groups / points toggles
  const [groupsEnabled, setGroupsEnabled] = useState(true);
  const [pointsEnabled, setPointsEnabled] = useState(true);
  const [togglingGroups, setTogglingGroups] = useState(false);
  const [togglingPoints, setTogglingPoints] = useState(false);

  // Test Groups management
  interface TestGroupInfo {
    pointsPolicy: string;
    feedbackPolicy: string;
    dependencies: string[];
  }
  const [testGroups, setTestGroups] = useState<Record<string, TestGroupInfo> | null>(null);
  const [testGroupsLoading, setTestGroupsLoading] = useState(false);
  const [testGroupModalOpen, setTestGroupModalOpen] = useState(false);
  const [testGroupIsNew, setTestGroupIsNew] = useState(false);
  const [testGroupName, setTestGroupName] = useState('');
  const [testGroupPointsPolicy, setTestGroupPointsPolicy] = useState('COMPLETE_GROUP');
  const [testGroupFeedbackPolicy, setTestGroupFeedbackPolicy] = useState('POINTS');
  const [testGroupDependencies, setTestGroupDependencies] = useState('');
  const [testGroupSaving, setTestGroupSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.problem.tests(problemId, testset) as { result: Test[] };
      const loaded = res.result || [];
      setTests(loaded);
      setSelected(new Set());
      // Build preview map from test input if available
      const previewMap: Record<number, string> = {};
      for (const t of loaded) {
        if (t.input) {
          previewMap[t.index] = truncate(t.input, 50);
        }
      }
      setPreviews(previewMap);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load tests');
    } finally {
      setLoading(false);
    }
  }, [problemId, testset, toast]);

  useEffect(() => { load(); }, [load]);

  // Auto-enable groups & points on Polygon based on default settings
  const autoEnabledRef = useRef(false);
  useEffect(() => {
    if (autoEnabledRef.current) return;
    autoEnabledRef.current = true;
    api.settings.get().then((settings) => {
      if (settings.enable_groups) {
        api.problem.enableGroups(problemId, testset, true).catch(() => {});
      }
      if (settings.enable_points) {
        api.problem.enablePoints(problemId, true).catch(() => {});
      }
      setGroupsEnabled(settings.enable_groups);
      setPointsEnabled(settings.enable_points);
    }).catch(() => {
      // Fallback: enable both if settings can't be fetched
      api.problem.enableGroups(problemId, testset, true).catch(() => {});
      api.problem.enablePoints(problemId, true).catch(() => {});
    });
  }, [problemId, testset]);

  // Lazy-load previews for tests that don't have input inline
  const loadPreview = useCallback(async (index: number) => {
    if (previews[index] !== undefined) return;
    try {
      const res = await api.problem.testInput(problemId, testset, index);
      const text = typeof res === 'string' ? res : String(res);
      setPreviews((prev) => ({ ...prev, [index]: truncate(text, 50) }));
    } catch {
      setPreviews((prev) => ({ ...prev, [index]: '(error)' }));
    }
  }, [problemId, testset, previews]);

  // Load previews for visible tests
  useEffect(() => {
    for (const t of tests) {
      if (previews[t.index] === undefined) {
        loadPreview(t.index);
      }
    }
  }, [tests]); // intentionally not depending on previews/loadPreview to avoid loops

  // ── Add Test ──────────────────────────────────────────────────────────────

  const handleAddTest = async () => {
    if (!addInput.trim()) { toast('error', 'Test input cannot be empty'); return; }
    setSaving(true);
    try {
      // Auto-set useInStatements for group 0 (samples)
      const autoSample = addGroup === '0' || addUseInStatements;
      await api.problem.saveTest({
        problemId,
        testset,
        testIndex: addIndex,
        testInput: addInput,
        checkExisting: true,
        ...(addGroup ? { testGroup: addGroup } : {}),
        ...(addPoints ? { testPoints: Number(addPoints) } : {}),
        ...(addDescription ? { testDescription: addDescription } : {}),
        ...(autoSample ? { testUseInStatements: true } : {}),
      });
      toast('success', `Test #${addIndex} added!`);
      setAddOpen(false);
      setAddInput('');
      setAddDescription('');
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to add test');
    } finally {
      setSaving(false);
    }
  };

  // ── Edit Test ─────────────────────────────────────────────────────────────

  const openEditModal = async (t: Test) => {
    setEditTest(t);
    setEditGroup(t.group || '');
    setEditPoints(t.points !== undefined ? String(t.points) : '');
    setEditDescription(t.description || '');
    setEditUseInStatements(t.useInStatements);
    setEditOpen(true);
    setEditLoading(true);
    try {
      const [inputRes, answerRes] = await Promise.allSettled([
        api.problem.testInput(problemId, testset, t.index),
        api.problem.testAnswer(problemId, testset, t.index),
      ]);
      const inputText = inputRes.status === 'fulfilled'
        ? (typeof inputRes.value === 'string' ? inputRes.value : String(inputRes.value))
        : '';
      const answerText = answerRes.status === 'fulfilled'
        ? (typeof answerRes.value === 'string' ? answerRes.value : String(answerRes.value))
        : '';
      setEditInput(inputText);
      setEditAnswer(answerText);
    } catch {
      toast('error', 'Failed to load test content');
    } finally {
      setEditLoading(false);
    }
  };

  const handleEditSave = async () => {
    if (!editTest) return;
    setEditSaving(true);
    try {
      // Auto-set useInStatements for group 0 (samples)
      const autoSample = editGroup === '0' || editUseInStatements;
      await api.problem.saveTest({
        problemId,
        testset,
        testIndex: editTest.index,
        testInput: editInput,
        checkExisting: false,
        ...(editGroup ? { testGroup: editGroup } : {}),
        ...(editPoints ? { testPoints: Number(editPoints) } : {}),
        ...(editDescription !== undefined ? { testDescription: editDescription } : {}),
        ...(autoSample ? { testUseInStatements: true } : {}),
      });
      toast('success', `Test #${editTest.index} saved!`);
      setEditOpen(false);
      setEditTest(null);
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save test');
    } finally {
      setEditSaving(false);
    }
  };

  // ── ZIP Upload ────────────────────────────────────────────────────────────

  const handleZipSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const zip = await JSZip.loadAsync(file);
      const items: PendingTest[] = [];
      const fileNames = Object.keys(zip.files).sort();
      for (const name of fileNames) {
        const entry = zip.files[name];
        if (entry.dir) continue;
        // Skip answer/output files
        const baseName = name.split('/').pop() || name;
        if (/^(output|answer)/i.test(baseName)) continue;
        const content = await entry.async('string');
        const idx = extractIndexFromFilename(baseName) ?? items.length + 1;
        const group = extractGroupFromFilename(baseName);
        items.push({ index: idx, input: content, filename: baseName, group, description: baseName });
      }
      // Re-number sequentially
      items.sort((a, b) => a.index - b.index);
      const nextIdx = tests.length > 0 ? Math.max(...tests.map((t) => t.index)) + 1 : 1;
      items.forEach((it, i) => { it.index = nextIdx + i; });
      setPendingTests(items);
      setZipOpen(true);
    } catch {
      toast('error', 'Failed to parse ZIP file');
    }
    e.target.value = '';
  };

  const handleZipUpload = async () => {
    setZipUploading(true);
    setZipProgress(0);
    let ok = 0;
    let skipped = 0;
    const skippedIndices: number[] = [];
    for (const t of pendingTests) {
      try {
        await api.problem.saveTest({
          problemId,
          testset,
          testIndex: t.index,
          testInput: t.input,
          checkExisting: true,
          ...(t.group ? { testGroup: t.group } : {}),
          ...(t.description ? { testDescription: t.description } : {}),
          // Auto-set samples for group 0
          ...(t.group === '0' ? { testUseInStatements: true } : {}),
        });
        ok++;
        setZipProgress(Math.round(((ok + skipped) / pendingTests.length) * 100));
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
        if (msg.includes('already exists') || msg.includes('duplicate') || msg.includes('same test') || msg.includes('checkexisting')) {
          skipped++;
          skippedIndices.push(t.index);
          setZipProgress(Math.round(((ok + skipped) / pendingTests.length) * 100));
        } else {
          toast('error', `Test #${t.index}: ${e instanceof Error ? e.message : 'Upload failed'}`);
        }
      }
    }
    setZipUploading(false);
    let message = `Uploaded ${ok}/${pendingTests.length} tests`;
    if (skipped > 0) {
      message += ` · ${skipped} skipped (duplicate content: #${skippedIndices.join(', #')})`;
      toast('warning', message);
    } else {
      toast('success', message);
    }
    setZipOpen(false);
    setPendingTests([]);
    await load();
  };

  // ── Individual File / Folder Upload ───────────────────────────────────────

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    const items: PendingTest[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const content = await file.text();
      const baseName = file.name;
      // Skip answer/output files
      if (/^(output|answer)/i.test(baseName)) continue;
      const idx = extractIndexFromFilename(baseName) ?? items.length + 1;
      const group = extractGroupFromFilename(baseName);
      items.push({ index: idx, input: content, filename: baseName, group, description: baseName });
    }
    items.sort((a, b) => a.index - b.index);
    const nextIdx = tests.length > 0 ? Math.max(...tests.map((t) => t.index)) + 1 : 1;
    items.forEach((it, i) => { it.index = nextIdx + i; });
    setPendingTests(items);
    setZipOpen(true);
    e.target.value = '';
  };

  // ── Bulk Actions ──────────────────────────────────────────────────────────

  const allSelected = tests.length > 0 && selected.size === tests.length;
  const someSelected = selected.size > 0 && selected.size < tests.length;

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(tests.map((t) => t.index)));
    }
  };

  const toggleSelect = (index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    setBulkActing(true);
    let ok = 0;
    const sorted = [...selected].sort((a, b) => b - a); // delete from end first
    for (const idx of sorted) {
      try {
        await api.problem.saveTest({
          problemId,
          testset,
          testIndex: idx,
          testInput: '',
          checkExisting: false,
        });
        ok++;
      } catch {
        toast('error', `Failed to delete test #${idx}`);
      }
    }
    setBulkActing(false);
    toast('success', `Deleted ${ok}/${selected.size} tests`);
    setSelected(new Set());
    await load();
  };

  const handleBulkSetGroup = async () => {
    if (selected.size === 0 || !bulkGroupValue.trim()) return;
    setBulkActing(true);
    const indices = [...selected].sort((a, b) => a - b).join(',');
    try {
      await api.problem.setTestGroup({
        problemId,
        testset,
        testGroup: bulkGroupValue.trim(),
        testIndices: indices,
      });
      toast('success', `Set group "${bulkGroupValue}" for ${selected.size} tests`);
      setBulkGroupOpen(false);
      setBulkGroupValue('');
      setSelected(new Set());
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to set group');
    } finally {
      setBulkActing(false);
    }
  };

  const handleToggleGroups = async () => {
    setTogglingGroups(true);
    try {
      await api.problem.enableGroups(problemId, testset, !groupsEnabled);
      setGroupsEnabled(!groupsEnabled);
      toast('success', `Groups ${!groupsEnabled ? 'enabled' : 'disabled'}`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to toggle groups');
    } finally {
      setTogglingGroups(false);
    }
  };

  const handleTogglePoints = async () => {
    setTogglingPoints(true);
    try {
      await api.problem.enablePoints(problemId, !pointsEnabled);
      setPointsEnabled(!pointsEnabled);
      toast('success', `Points ${!pointsEnabled ? 'enabled' : 'disabled'}`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to toggle points');
    } finally {
      setTogglingPoints(false);
    }
  };

  // ── Test Groups ─────────────────────────────────────────────────────────

  const loadTestGroups = async () => {
    setTestGroupsLoading(true);
    try {
      const res = await api.problem.viewTestGroup(problemId, testset) as { result: Record<string, TestGroupInfo> };
      const groups = res.result || {};

      // Auto-fix: ensure every group has pointsPolicy = COMPLETE_GROUP
      for (const [name, info] of Object.entries(groups)) {
        if (info.pointsPolicy !== 'COMPLETE_GROUP') {
          try {
            await api.problem.saveTestGroup({
              problemId,
              testset,
              group: name,
              pointsPolicy: 'COMPLETE_GROUP',
              feedbackPolicy: info.feedbackPolicy || 'NONE',
              ...(info.dependencies?.length ? { dependencies: info.dependencies.join(',') } : {}),
            });
            groups[name] = { ...info, pointsPolicy: 'COMPLETE_GROUP' };
          } catch {
            // Silently continue if one fails
          }
        }
      }

      setTestGroups(groups);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to load test groups');
    } finally {
      setTestGroupsLoading(false);
    }
  };

  const openEditGroupModal = (groupName: string, info: TestGroupInfo) => {
    setTestGroupIsNew(false);
    setTestGroupName(groupName);
    setTestGroupPointsPolicy(info.pointsPolicy || 'COMPLETE_GROUP');
    setTestGroupFeedbackPolicy(info.feedbackPolicy || 'NONE');
    setTestGroupDependencies((info.dependencies || []).map(s => s.trim()).join(','));
    setTestGroupModalOpen(true);
  };

  const openAddGroupModal = () => {
    setTestGroupIsNew(true);
    setTestGroupName('');
    setTestGroupPointsPolicy('COMPLETE_GROUP');
    setTestGroupFeedbackPolicy('POINTS');
    setTestGroupDependencies('');
    setTestGroupModalOpen(true);
  };

  const handleSaveTestGroup = async () => {
    if (!testGroupName.trim()) { toast('error', 'Group name is required'); return; }
    setTestGroupSaving(true);
    try {
      await api.problem.saveTestGroup({
        problemId,
        testset,
        group: testGroupName.trim(),
        pointsPolicy: testGroupPointsPolicy,
        feedbackPolicy: testGroupFeedbackPolicy,
        ...(testGroupDependencies.trim() ? { dependencies: testGroupDependencies.replace(/\s+/g, '').split(',').filter(Boolean).join(',') } : {}),
      });
      toast('success', `Group "${testGroupName}" saved!`);
      setTestGroupModalOpen(false);
      await loadTestGroups();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to save test group');
    } finally {
      setTestGroupSaving(false);
    }
  };

  // Focus inline input only when first opened (track with a ref)
  const inlineJustOpened = useRef(false);
  useEffect(() => {
    if (inlineEdit && inlineRef.current && inlineJustOpened.current) {
      inlineRef.current.focus();
      inlineRef.current.select();
      inlineJustOpened.current = false;
    }
  }, [inlineEdit]);

  const startInlineEdit = (index: number, field: 'group' | 'points', value: string) => {
    inlineJustOpened.current = true;
    setInlineEdit({ index, field, value });
  };

  const handleInlineSave = async () => {
    if (!inlineEdit || inlineSaving) return;
    const { index, field, value } = inlineEdit;
    const test = tests.find(t => t.index === index);
    if (!test) { setInlineEdit(null); return; }

    // Check if value actually changed
    const oldValue = field === 'group' ? (test.group || '') : (test.points !== undefined ? String(test.points) : '');
    if (value.trim() === oldValue.trim()) {
      setInlineEdit(null);
      return;
    }

    setInlineSaving(true);
    try {
      if (field === 'group') {
        await api.problem.setTestGroup({
          problemId,
          testset,
          testGroup: value.trim(),
          testIndices: String(index),
        });
        // Auto-set useInStatements for group 0 (samples)
        if (value.trim() === '0') {
          const inputRes = await api.problem.testInput(problemId, testset, index);
          const inputText = typeof inputRes === 'string' ? inputRes : String(inputRes);
          await api.problem.saveTest({
            problemId, testset, testIndex: index,
            testInput: inputText, checkExisting: false,
            testGroup: '0', testUseInStatements: true,
          });
        }
        // Update locally without full reload
        setTests(prev => prev.map(t => t.index === index ? { ...t, group: value.trim() } : t));
      } else {
        const inputRes = await api.problem.testInput(problemId, testset, index);
        const inputText = typeof inputRes === 'string' ? inputRes : String(inputRes);
        await api.problem.saveTest({
          problemId,
          testset,
          testIndex: index,
          testInput: inputText,
          checkExisting: false,
          ...(value.trim() ? { testPoints: Number(value) } : {}),
        });
        // Update locally without full reload
        setTests(prev => prev.map(t => t.index === index ? { ...t, points: value.trim() ? Number(value) : undefined } : t));
      }
      toast('success', `Test #${index} ${field} updated`);
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : `Failed to update ${field}`);
    } finally {
      setInlineSaving(false);
      setInlineEdit(null);
    }
  };

  // Derive dependencies from statement scoring section
  const [deriving, setDeriving] = useState(false);

  const handleDeriveDependencies = async () => {
    setDeriving(true);
    try {
      // Load statements to get scoring section
      const res = await api.problem.statements(problemId) as { result: Record<string, { scoring?: string }> };
      const stmts = res.result || {};
      const scoring = stmts['english']?.scoring || stmts[Object.keys(stmts)[0]]?.scoring || '';
      if (!scoring.trim()) {
        toast('error', 'No scoring section found in the statement. Add subtask info to the Scoring field first.');
        setDeriving(false);
        return;
      }

      // Parse scoring for dependency patterns (shared with the ZIP importer)
      const depMap = deriveDependenciesFromScoring(scoring);

      if (Object.keys(depMap).length === 0) {
        toast('error', 'Could not parse dependencies from scoring section. Expected format: "Subtask N ... depends on subtasks X, Y"');
        setDeriving(false);
        return;
      }

      // Apply dependencies to each group
      let applied = 0;
      for (const [group, deps] of Object.entries(depMap)) {
        try {
          await api.problem.saveTestGroup({
            problemId,
            testset,
            group,
            dependencies: deps.join(','),
          });
          applied++;
        } catch {
          toast('error', `Failed to set dependencies for group ${group}`);
        }
      }

      toast('success', `Derived dependencies for ${applied} group${applied > 1 ? 's' : ''}: ${Object.entries(depMap).map(([g, d]) => `${g} <- [${d.join(',')}]`).join(', ')}`);
      await loadTestGroups();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to derive dependencies');
    } finally {
      setDeriving(false);
    }
  };

  // Derive points from statement scoring section
  const [derivingPoints, setDerivingPoints] = useState(false);

  const handleDerivePoints = async () => {
    setDerivingPoints(true);
    try {
      // Load statements to get scoring section
      const res = await api.problem.statements(problemId) as { result: Record<string, { scoring?: string }> };
      const stmts = res.result || {};
      const scoring = stmts['english']?.scoring || stmts[Object.keys(stmts)[0]]?.scoring || '';
      if (!scoring.trim()) {
        toast('error', 'No scoring section found in the statement. Add subtask info to the Scoring field first.');
        setDerivingPoints(false);
        return;
      }

      // Parse scoring for group → points mapping (shared with the ZIP importer)
      const pointsMap = derivePointsFromScoring(scoring);

      if (Object.keys(pointsMap).length === 0) {
        toast('error', 'Could not parse points from scoring section. Expected tabular format with group & constraint & points columns.');
        setDerivingPoints(false);
        return;
      }

      // Apply: set points on the first test of each group
      let applied = 0;
      const groupFirstTest: Record<string, Test> = {};
      for (const t of tests) {
        if (t.group && pointsMap[t.group] !== undefined && !groupFirstTest[t.group]) {
          groupFirstTest[t.group] = t;
        }
      }

      for (const [group, pts] of Object.entries(pointsMap)) {
        const firstTest = groupFirstTest[group];
        if (!firstTest) continue;
        try {
          const inputRes = await api.problem.testInput(problemId, testset, firstTest.index);
          const inputText = typeof inputRes === 'string' ? inputRes : String(inputRes);
          await api.problem.saveTest({
            problemId,
            testset,
            testIndex: firstTest.index,
            testInput: inputText,
            checkExisting: false,
            testGroup: group,
            testPoints: pts,
          });
          applied++;
        } catch {
          toast('error', `Failed to set points for group ${group}`);
        }
      }

      toast('success', `Derived points for ${applied} group${applied > 1 ? 's' : ''}: ${Object.entries(pointsMap).map(([g, p]) => `G${g}=${p}pts`).join(', ')}`);
      await load();
    } catch (e: unknown) {
      toast('error', e instanceof Error ? e.message : 'Failed to derive points');
    } finally {
      setDerivingPoints(false);
    }
  };

  const manualCount = tests.filter((t) => t.manual).length;
  const genCount = tests.filter((t) => !t.manual).length;

  return (
    <div className="p-6 space-y-5">
      {/* Controls */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="w-36">
          <Select
            label="Testset"
            value={testset}
            onChange={(e) => setTestset(e.target.value)}
            options={TESTSETS}
          />
        </div>
        <div className="flex items-center gap-2 mt-4 flex-wrap">
          <Button variant="ghost" size="sm" icon={<RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />} onClick={load}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => {
            setAddIndex(tests.length > 0 ? Math.max(...tests.map((t) => t.index)) + 1 : 1);
            setAddGroup('');
            setAddPoints('');
            setAddDescription('');
            setAddUseInStatements(false);
            setAddInput('');
            setAddOpen(true);
          }}>
            Add Test
          </Button>
          <Button variant="secondary" size="sm" icon={<Archive className="w-3.5 h-3.5" />} onClick={() => zipRef.current?.click()}>
            Upload ZIP
          </Button>
          <Button variant="secondary" size="sm" icon={<FileText className="w-3.5 h-3.5" />} onClick={() => fileRef.current?.click()}>
            Upload Files
          </Button>
          <Button variant="secondary" size="sm" icon={<FolderOpen className="w-3.5 h-3.5" />} onClick={() => folderRef.current?.click()}>
            Upload Folder
          </Button>
          <div className="w-px h-6 bg-[#362f28] mx-1" />
          <button
            onClick={handleToggleGroups}
            disabled={togglingGroups}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2c2722] transition-colors disabled:opacity-50"
            title={groupsEnabled ? 'Disable groups' : 'Enable groups'}
          >
            {groupsEnabled ? (
              <ToggleRight className="w-4 h-4 text-amber-400" />
            ) : (
              <ToggleLeft className="w-4 h-4 text-gray-600" />
            )}
            Groups
          </button>
          <button
            onClick={handleTogglePoints}
            disabled={togglingPoints}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-[#2c2722] transition-colors disabled:opacity-50"
            title={pointsEnabled ? 'Disable points' : 'Enable points'}
          >
            {pointsEnabled ? (
              <ToggleRight className="w-4 h-4 text-amber-400" />
            ) : (
              <ToggleLeft className="w-4 h-4 text-gray-600" />
            )}
            Points
          </button>
          <input ref={zipRef} type="file" accept=".zip" className="sr-only" onChange={handleZipSelect} />
          <input ref={fileRef} type="file" multiple accept=".txt,.in,.inp,*" className="sr-only" onChange={handleFileSelect} />
          {/* @ts-expect-error webkitdirectory is not in React types */}
          <input ref={folderRef} type="file" webkitdirectory="" directory="" multiple className="sr-only" onChange={handleFileSelect} />
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 text-sm text-gray-500">
        <span>{tests.length} tests total</span>
        {manualCount > 0 && <span className="text-blue-400">{manualCount} manual</span>}
        {genCount > 0 && <span className="text-purple-400">{genCount} generated</span>}
        {selected.size > 0 && <span className="text-amber-400">{selected.size} selected</span>}
      </div>

      {/* Tests table */}
      <Card title="Tests">
        {loading ? (
          <p className="text-gray-600 text-sm">Loading...</p>
        ) : tests.length === 0 ? (
          <p className="text-gray-600 text-sm">No tests found. Add tests manually, upload files, or upload a ZIP archive.</p>
        ) : (
          <div className="divide-y divide-[#362f28]/40 -mx-5">
            {/* Header */}
            <div className="grid grid-cols-[2.5rem_3rem_5rem_1fr_10rem_5rem_5rem_5rem_4rem] px-5 py-1.5 text-[11px] text-gray-600 uppercase tracking-wide items-center">
              <span
                className="flex items-center justify-center cursor-pointer"
                onClick={toggleSelectAll}
              >
                {allSelected ? (
                  <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                ) : someSelected ? (
                  <div className="relative">
                    <Square className="w-3.5 h-3.5 text-gray-500" />
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="w-1.5 h-1.5 bg-amber-400 rounded-sm" />
                    </div>
                  </div>
                ) : (
                  <Square className="w-3.5 h-3.5 text-gray-600" />
                )}
              </span>
              <span>#</span>
              <span>Type</span>
              <span>Preview</span>
              <span>Description</span>
              <span>Group</span>
              <span>Points</span>
              <span>Sample</span>
              <span></span>
            </div>
            {/* Rows */}
            {tests.map((t, i) => (
              <div
                key={t.index}
                className={`grid grid-cols-[2.5rem_3rem_5rem_1fr_10rem_5rem_5rem_5rem_4rem] items-center px-5 py-1.5 hover:bg-[#2c2722] group transition-colors cursor-pointer ${
                  i % 2 === 0 ? 'bg-[#211e1a]' : 'bg-[#1e1b17]'
                } ${selected.has(t.index) ? '!bg-amber-500/10 border-l-2 border-l-amber-500' : ''}`}
                onClick={() => openEditModal(t)}
              >
                {/* Checkbox */}
                <span
                  className="flex items-center justify-center"
                  onClick={(e) => { e.stopPropagation(); toggleSelect(t.index); }}
                >
                  {selected.has(t.index) ? (
                    <CheckSquare className="w-3.5 h-3.5 text-amber-400" />
                  ) : (
                    <Square className="w-3.5 h-3.5 text-gray-600 group-hover:text-gray-400" />
                  )}
                </span>
                {/* Index */}
                <span className="font-mono text-xs text-gray-400">{t.index}</span>
                {/* Type */}
                <span>
                  <Badge variant={t.manual ? 'info' : 'indigo'}>
                    {t.manual ? 'M' : 'G'}
                  </Badge>
                </span>
                {/* Preview */}
                <span className="text-[11px] text-gray-500 font-mono truncate pr-3 min-w-0">
                  {previews[t.index] ?? '...'}
                </span>
                {/* Description */}
                <span className="text-[11px] text-gray-500 truncate pr-2 min-w-0">
                  {t.description || '\u2014'}
                </span>
                {/* Group — click to edit */}
                <span onClick={(e) => { e.stopPropagation(); startInlineEdit(t.index, 'group', t.group || ''); }}>
                  {inlineEdit && inlineEdit.index === t.index && inlineEdit.field === 'group' ? (
                    <input
                      ref={inlineRef}
                      className="w-full bg-[#1a1714] border border-amber-500 rounded px-1 py-0.5 text-xs text-gray-200 font-mono outline-none"
                      value={inlineEdit.value}
                      onChange={(e) => setInlineEdit({ ...inlineEdit, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSave(); if (e.key === 'Escape') setInlineEdit(null); }}
                      onBlur={handleInlineSave}
                      disabled={inlineSaving}
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="text-xs text-gray-500 font-mono cursor-text hover:text-amber-300 hover:bg-amber-500/10 px-1 py-0.5 rounded transition-colors">{t.group || '\u2014'}</span>
                  )}
                </span>
                {/* Points — click to edit */}
                <span onClick={(e) => { e.stopPropagation(); startInlineEdit(t.index, 'points', t.points !== undefined ? String(t.points) : ''); }}>
                  {inlineEdit && inlineEdit.index === t.index && inlineEdit.field === 'points' ? (
                    <input
                      ref={inlineRef}
                      type="number"
                      className="w-full bg-[#1a1714] border border-amber-500 rounded px-1 py-0.5 text-xs text-gray-200 font-mono outline-none"
                      value={inlineEdit.value}
                      onChange={(e) => setInlineEdit({ ...inlineEdit, value: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleInlineSave(); if (e.key === 'Escape') setInlineEdit(null); }}
                      onBlur={handleInlineSave}
                      disabled={inlineSaving}
                      onClick={(e) => e.stopPropagation()}
                      min={0}
                    />
                  ) : (
                    <span className="text-xs text-gray-500 font-mono cursor-text hover:text-amber-300 hover:bg-amber-500/10 px-1 py-0.5 rounded transition-colors">{t.points ?? '\u2014'}</span>
                  )}
                </span>
                {/* Sample */}
                <span className="text-xs">
                  {t.useInStatements ? (
                    <Badge variant="success">yes</Badge>
                  ) : (
                    <span className="text-gray-700">no</span>
                  )}
                </span>
                {/* Actions */}
                <div className="flex items-center gap-1">
                  <button
                    className="p-1 rounded hover:bg-[#362f28] text-gray-500 hover:text-gray-300 opacity-0 group-hover:opacity-100 transition-all"
                    title="Edit test"
                    onClick={(e) => { e.stopPropagation(); openEditModal(t); }}
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Test Groups */}
      <Card title="Test Groups">
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw className={`w-3.5 h-3.5 ${testGroupsLoading ? 'animate-spin' : ''}`} />}
              loading={testGroupsLoading}
              onClick={loadTestGroups}
            >
              Load Groups
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={openAddGroupModal}
            >
              Add Group
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Wand2 className="w-3.5 h-3.5" />}
              loading={deriving}
              onClick={handleDeriveDependencies}
              title="Parse the Scoring section of the statement to auto-fill group dependencies"
            >
              Derive Dependencies
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<Wand2 className="w-3.5 h-3.5" />}
              loading={derivingPoints}
              onClick={handleDerivePoints}
              title="Parse the Scoring section of the statement to auto-fill group points"
            >
              Derive Points
            </Button>
          </div>

          {testGroups === null ? (
            <p className="text-gray-600 text-sm">Click "Load Groups" to view test group configuration.</p>
          ) : Object.keys(testGroups).length === 0 ? (
            <p className="text-gray-600 text-sm">No test groups found.</p>
          ) : (
            <div className="divide-y divide-[#362f28]/40 -mx-5">
              {/* Header */}
              <div className="grid grid-cols-[6rem_10rem_10rem_1fr_5rem] px-5 py-1.5 text-[11px] text-gray-600 uppercase tracking-wide items-center">
                <span>Group</span>
                <span>Points Policy</span>
                <span>Feedback Policy</span>
                <span>Dependencies</span>
                <span></span>
              </div>
              {/* Rows */}
              {Object.entries(testGroups).map(([groupName, info], i) => (
                <div
                  key={groupName}
                  className={`grid grid-cols-[6rem_10rem_10rem_1fr_5rem] items-center px-5 py-1.5 hover:bg-[#2c2722] transition-colors ${
                    i % 2 === 0 ? 'bg-[#211e1a]' : 'bg-[#1e1b17]'
                  }`}
                >
                  <span className="font-mono text-xs text-gray-300">{groupName}</span>
                  <span>
                    <Badge variant="indigo">{info.pointsPolicy}</Badge>
                  </span>
                  <span>
                    <Badge variant="info">{info.feedbackPolicy}</Badge>
                  </span>
                  <span className="text-xs text-gray-500 font-mono">
                    {info.dependencies && info.dependencies.length > 0
                      ? info.dependencies.join(', ')
                      : '\u2014'}
                  </span>
                  <div className="flex items-center justify-end">
                    <button
                      className="p-1 rounded hover:bg-[#362f28] text-gray-500 hover:text-gray-300 transition-all"
                      title="Edit group"
                      onClick={() => openEditGroupModal(groupName, info)}
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Edit/Add Test Group Modal */}
      <Modal
        open={testGroupModalOpen}
        onClose={() => setTestGroupModalOpen(false)}
        title={testGroupIsNew ? 'Add Test Group' : `Edit Group "${testGroupName}"`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setTestGroupModalOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={testGroupSaving} onClick={handleSaveTestGroup}>
              {testGroupIsNew ? 'Add Group' : 'Save Changes'}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {testGroupIsNew ? (
            <Input
              label="Group Name"
              value={testGroupName}
              onChange={(e) => setTestGroupName(e.target.value)}
              placeholder="e.g. 1 or subtask1"
            />
          ) : (
            <div>
              <label className="block text-xs text-gray-500 mb-1">Group Name</label>
              <p className="text-sm text-gray-300 font-mono bg-[#2c2722] px-3 py-2 rounded-lg">{testGroupName}</p>
            </div>
          )}
          <Select
            label="Points Policy"
            value={testGroupPointsPolicy}
            onChange={(e) => setTestGroupPointsPolicy(e.target.value)}
            options={[
              { value: 'COMPLETE_GROUP', label: 'COMPLETE_GROUP' },
              { value: 'EACH_TEST', label: 'EACH_TEST' },
            ]}
          />
          <Select
            label="Feedback Policy"
            value={testGroupFeedbackPolicy}
            onChange={(e) => setTestGroupFeedbackPolicy(e.target.value)}
            options={[
              { value: 'NONE', label: 'NONE' },
              { value: 'POINTS', label: 'POINTS' },
              { value: 'ICPC', label: 'ICPC' },
              { value: 'COMPLETE', label: 'COMPLETE' },
            ]}
          />
          <Input
            label="Dependencies (comma-separated group names)"
            value={testGroupDependencies}
            onChange={(e) => setTestGroupDependencies(e.target.value)}
            placeholder="e.g. 1,2"
          />
        </div>
      </Modal>

      {/* Floating bulk action bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-6 left-1/2 z-40 flex items-center gap-3 bg-[#211e1a] border border-[#362f28] rounded-xl px-5 py-3 shadow-2xl shadow-black/40 animate-slide-up">
          <span className="text-sm text-gray-400">
            {selected.size} test{selected.size > 1 ? 's' : ''} selected
          </span>
          <div className="w-px h-6 bg-[#362f28]" />
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 className="w-3.5 h-3.5" />}
            loading={bulkActing}
            onClick={handleBulkDelete}
          >
            Delete Selected
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<Tag className="w-3.5 h-3.5" />}
            onClick={() => setBulkGroupOpen(true)}
          >
            Set Group
          </Button>
          <button
            className="p-1.5 rounded-lg hover:bg-[#2c2722] text-gray-500 hover:text-gray-300 transition-colors"
            onClick={() => setSelected(new Set())}
            title="Clear selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Add Test Modal */}
      <Modal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        title="Add Manual Test"
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={saving} onClick={handleAddTest}>Add Test</Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <Input
              label="Test Index"
              type="number"
              value={String(addIndex)}
              onChange={(e) => setAddIndex(Number(e.target.value))}
              min={1}
            />
            <Input
              label="Group (optional)"
              value={addGroup}
              onChange={(e) => setAddGroup(e.target.value)}
              placeholder="e.g. 2"
            />
            <Input
              label="Points (optional)"
              type="number"
              value={addPoints}
              onChange={(e) => setAddPoints(e.target.value)}
              min={0}
            />
          </div>
          <Input
            label="Description (optional)"
            value={addDescription}
            onChange={(e) => setAddDescription(e.target.value)}
            placeholder="e.g. corner case with max N"
          />
          <Textarea
            label="Test Input"
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            rows={8}
            mono
            placeholder="Paste test input here..."
          />
          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={addUseInStatements}
              onChange={(e) => setAddUseInStatements(e.target.checked)}
              className="rounded accent-amber-500"
            />
            <span className="text-sm text-gray-400">Use in statements (sample test)</span>
          </label>
        </div>
      </Modal>

      {/* Edit Test Modal */}
      <Modal
        open={editOpen}
        onClose={() => { setEditOpen(false); setEditTest(null); }}
        title={editTest ? `Edit Test #${editTest.index}` : 'Edit Test'}
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditOpen(false); setEditTest(null); }}>Cancel</Button>
            <Button variant="primary" loading={editSaving} disabled={editLoading} onClick={handleEditSave}>Save Changes</Button>
          </>
        }
      >
        {editLoading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-5 h-5 animate-spin text-gray-500" />
            <span className="ml-2 text-sm text-gray-500">Loading test content...</span>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid grid-cols-4 gap-4">
              <Input
                label="Group"
                value={editGroup}
                onChange={(e) => setEditGroup(e.target.value)}
                placeholder="e.g. 2"
              />
              <Input
                label="Points"
                type="number"
                value={editPoints}
                onChange={(e) => setEditPoints(e.target.value)}
                min={0}
              />
              <Input
                label="Description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                placeholder="optional"
              />
              <div className="flex items-end pb-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={editUseInStatements}
                    onChange={(e) => setEditUseInStatements(e.target.checked)}
                    className="rounded accent-amber-500"
                  />
                  <span className="text-sm text-gray-400">Sample</span>
                </label>
              </div>
            </div>
            <Textarea
              label="Test Input"
              value={editInput}
              onChange={(e) => setEditInput(e.target.value)}
              rows={10}
              mono
              placeholder="Test input..."
            />
            <Textarea
              label="Expected Output (Answer)"
              value={editAnswer}
              onChange={(e) => setEditAnswer(e.target.value)}
              rows={8}
              mono
              placeholder="Expected output (read-only if generated, editable for manual tests)..."
            />
          </div>
        )}
      </Modal>

      {/* ZIP / File Upload preview modal */}
      <Modal
        open={zipOpen}
        onClose={() => { if (!zipUploading) { setZipOpen(false); setPendingTests([]); } }}
        title={`Upload ${pendingTests.length} Tests`}
        size="lg"
        footer={
          <>
            <Button variant="ghost" disabled={zipUploading} onClick={() => { setZipOpen(false); setPendingTests([]); }}>Cancel</Button>
            <Button variant="primary" loading={zipUploading} onClick={handleZipUpload}>
              {zipUploading ? `Uploading ${zipProgress}%...` : `Upload ${pendingTests.length} Tests`}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {zipUploading && (
            <div className="w-full bg-[#2c2722] rounded-full h-2 overflow-hidden">
              <div
                className="bg-amber-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${zipProgress}%` }}
              />
            </div>
          )}
          <p className="text-sm text-gray-500">
            The following tests will be uploaded to testset <code className="font-mono text-amber-400">{testset}</code>:
          </p>
          <div className="max-h-64 overflow-y-auto space-y-1">
            {pendingTests.map((t) => (
              <div key={t.index} className="flex items-center gap-3 text-sm py-1.5 px-3 rounded bg-[#2c2722]">
                <span className="font-mono text-gray-400 w-10">#{t.index}</span>
                {t.group && (
                  <Badge variant="indigo">g{t.group}</Badge>
                )}
                <span className="text-gray-600 text-xs truncate min-w-0 flex-1">{t.filename}</span>
                <span className="ml-auto text-xs text-gray-600 flex-shrink-0">{t.input.length} chars</span>
              </div>
            ))}
          </div>
        </div>
      </Modal>

      {/* Bulk Set Group Modal */}
      <Modal
        open={bulkGroupOpen}
        onClose={() => setBulkGroupOpen(false)}
        title={`Set Group for ${selected.size} Tests`}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setBulkGroupOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              loading={bulkActing}
              disabled={!bulkGroupValue.trim()}
              onClick={handleBulkSetGroup}
            >
              Set Group
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <Input
            label="Group Name"
            value={bulkGroupValue}
            onChange={(e) => setBulkGroupValue(e.target.value)}
            placeholder="e.g. 1 or subtask1"
          />
          <p className="text-xs text-gray-500">
            This will assign all {selected.size} selected test{selected.size > 1 ? 's' : ''} to the specified group.
          </p>
        </div>
      </Modal>
    </div>
  );
}
