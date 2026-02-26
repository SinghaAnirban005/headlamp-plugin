/**
 * TrafficPanel — Interactive TCP Traffic Visualization
 *
 * Architecture mirrors GadgetDetails + GenericGadgetRenderer exactly:
 *
 *  GadgetDetails flow:
 *   1. K8s nodes + pods loaded
 *   2. useGadgetConn(nodes, pods) → ONE ig connection to first node's gadget pod
 *   3. ig.getGadgetInfo() → prepareGadgetInfo() → populates dataColumns + dataSources
 *   4. NodeSelection sets podsSelected[] (one IG pod per k8s node)
 *   5. For EACH pod in podsSelected, a GenericGadgetRenderer mounts:
 *      - It calls usePortForward() with THAT POD's specific URL (not the shared one)
 *      - It increments podStreamsConnected when its own ws connects
 *   6. When podStreamsConnected === podsSelected.length:
 *      gadgetRunningStatus=true → gadgetStartStopHandler() → ig.runGadget()
 *
 *  Key insight: runGadget is called PER NODE via a SEPARATE per-pod connection.
 *  The `ig` from useGadgetConn is only used for getGadgetInfo/createInstance/etc.
 *  The actual data streaming happens inside GenericGadgetRenderer via its own
 *  usePortForward() to the specific pod.
 *
 *  For TrafficPanel we reuse GenericGadgetRenderer directly with custom callbacks
 *  instead of trying to call runGadget ourselves.
 */

import K8s from '@kinvolk/headlamp-plugin/lib/K8s';
import {
  Box,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useGadgetConn } from '../gadgets/conn';
import { isIGPod } from '../gadgets/helper';
import PodTrafficStream from './PodTrafficStream';
import TopologyMap from './TopologyMap';

// ─── Constants ────────────────────────────────────────────────────────────────

const TRACE_TCP_IMAGE = 'ghcr.io/inspektor-gadget/gadget/trace_tcp:latest';
const MAX_EVENTS = 500;

const PRIVATE_RANGES = [
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^127\.\d+\.\d+\.\d+$/,
  /^::1$/,
  /^$/,
];

function isPrivateIP(ip: string): boolean {
  return PRIVATE_RANGES.some(r => r.test(ip ?? ''));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TrafficEvent {
  id: string;
  timestamp: string;
  type: 'connect' | 'close' | 'accept' | 'unknown';
  srcNamespace: string;
  srcPod: string;
  dstNamespace: string;
  dstPod: string;      // pod name if dst is a Pod
  dstSvc: string;      // service name if dst is a Service
  dstKind: string;     // "Pod" | "Service" | "" — from dst.k8s.kind
  src: string;
  dst: string;
  srcIP: string;
  dstIP: string;
  dstPort: number;
  proto: string;
  isExternal: boolean;
  isUnknownDst: boolean;
  error: string;
  _raw: any;
}

// ─── Raw event parser ─────────────────────────────────────────────────────────
// Actual payload shape (confirmed from debug):
// {
//   type: "connect" | "close" | "accept",
//   k8s: { namespace, podName, containerName, node, owner: {} },
//   src: { addr?: string, port?: number, k8s?: { namespace, podName, ... } },
//   dst: { addr?: string, port?: number, k8s?: { namespace, podName, ... } },
//   proc: { ... },
//   error: { ... }
// }
//
// src and dst are OBJECTS, not "ip:port" strings.
// k8s at root level = the SOURCE pod's k8s identity (the process making the call).
// src.k8s / dst.k8s may carry endpoint-level identity when available.

function parseProcessedRow(row: Record<string, any>): TrafficEvent | null {
  try {
    const srcObj = row['src'] ?? {};
    const dstObj = row['dst'] ?? {};
    const k8sRoot = row['k8s'] ?? {};

    const srcPod: string = k8sRoot.podName ?? k8sRoot.pod ?? '';
    const srcNamespace: string = k8sRoot.namespace ?? '';

    const dstK8s = (dstObj.k8s && Object.keys(dstObj.k8s).length > 0) ? dstObj.k8s : null;
    const dstKind: string = dstK8s?.kind ?? '';
    const dstName: string = dstK8s?.name ?? dstK8s?.podName ?? '';
    const dstNamespace: string = dstK8s?.namespace ?? '';
    const dstPod: string = dstKind === 'Pod' || (!dstKind && dstName) ? dstName : '';
    const dstSvc: string = dstKind === 'Service' ? dstName : '';

    const typeRaw = String(row['type'] ?? '').toLowerCase();
    const type = (['connect', 'close', 'accept'].includes(typeRaw)
      ? typeRaw
      : 'unknown') as TrafficEvent['type'];

    const hasError = row['error'] && row['error'] !== '' && row['error'] !== 'Success';
    const errorMsg: string = row['error'] ?? '';

    const isUnknownDst = !dstPod && !dstSvc && type !== 'close';
    const isExternal = false;

    const dstLabel = dstSvc
      ? `${dstNamespace}/${dstSvc}`
      : dstPod ? `${dstNamespace}/${dstPod}` : (hasError ? `error:${errorMsg}` : 'unknown');

    return {
      id: `${Date.now()}-${Math.random()}`,
      timestamp: row['timestamp'] ?? new Date().toISOString(),
      type,
      srcNamespace,
      srcPod,
      dstNamespace,
      dstPod,
      dstSvc,
      dstKind,
      src: srcPod ? `${srcNamespace}/${srcPod}` : '',
      dst: dstLabel,
      srcIP: '',
      dstIP: '',
      dstPort: dstObj.port ?? 0,
      proto: 'TCP',
      isExternal,
      isUnknownDst,
      error: errorMsg,
      _raw: row,
    };
  } catch (e) {
    return null;
  }
}

function Center({ children }: { children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', height: '100%', gap: 1 }}>
      {children}
    </Box>
  );
}

function LiveDot({ on, error }: { on: boolean; error: boolean }) {
  const c = error ? '#ef4444' : on ? '#22c55e' : '#6b7280';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 0.5, borderRadius: '20px', border: `1px solid ${c}`, background: `${c}18` }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: c, ...(on && !error ? { '@keyframes pulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.3 } }, animation: 'pulse 1.5s infinite' } : {}) }} />
      <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: c, fontFamily: 'monospace' }}>
        {error ? 'Error' : on ? 'Live' : 'Idle'}
      </Typography>
    </Box>
  );
}

function StatsBar({ evs }: { evs: TrafficEvent[] }) {
  const ext = evs.filter(e => e.isExternal).length;
  const unk = evs.filter(e => e.isUnknownDst).length;
  const S = (label: string, val: number, color?: string) => (
    <Box key={label} sx={{ textAlign: 'center', px: 2, borderRight: '1px solid', borderColor: 'divider', '&:last-child': { borderRight: 0 } }}>
      <Typography sx={{ fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 700, color: color ?? 'text.primary' }}>{val}</Typography>
      <Typography sx={{ fontSize: '0.6rem', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</Typography>
    </Box>
  );
  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', borderBottom: '1px solid', borderColor: 'divider', py: 1.25 }}>
      {S('Total', evs.length)}
      {S('Connect', evs.filter(e => e.type === 'connect').length, '#3b82f6')}
      {S('Accept', evs.filter(e => e.type === 'accept').length, '#22c55e')}
      {S('Close', evs.filter(e => e.type === 'close').length, '#6b7280')}
      {S('External', ext, ext > 0 ? '#ef4444' : undefined)}
      {S('Unknown Dst', unk, unk > 0 ? '#f59e0b' : undefined)}
    </Box>
  );
}

const TYPE_COLOR: Record<string, string> = {
  connect: '#3b82f6', accept: '#22c55e', close: '#6b7280', unknown: '#a855f7',
};

function EventRow({ ev, idx }: { ev: TrafficEvent; idx: number }) {
  const flags: { label: string; color: string }[] = [];
  if (ev.isUnknownDst) flags.push({ label: 'Unknown Dst', color: '#f59e0b' });
  if (ev.error && ev.error !== 'Success') flags.push({ label: ev.error, color: '#ef4444' });

  return (
    <Box sx={{
      display: 'grid',
      gridTemplateColumns: '78px 1fr 1fr 90px auto',
      gap: 1, alignItems: 'center', px: 2, py: 0.9,
      borderBottom: '1px solid', borderColor: 'divider',
      background: flags.length ? 'linear-gradient(90deg,rgba(239,68,68,.06) 0%,transparent 100%)' : idx % 2 === 0 ? 'transparent' : 'action.hover',
      '&:hover': { bgcolor: 'action.selected' }, transition: 'background .12s',
    }}>
      <Chip label={ev.type.toUpperCase()} size="small" sx={{ fontSize: '0.62rem', fontFamily: 'monospace', fontWeight: 700, bgcolor: `${TYPE_COLOR[ev.type]}22`, color: TYPE_COLOR[ev.type], border: `1px solid ${TYPE_COLOR[ev.type]}55`, height: 20 }} />

      <Box sx={{ overflow: 'hidden' }}>
        <Typography sx={{ fontFamily: 'monospace', fontSize: '0.74rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {ev.srcPod || '—'}
        </Typography>
        {ev.srcNamespace && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: '0.62rem' }}>{ev.srcNamespace}</Typography>}
      </Box>

      <Box sx={{ overflow: 'hidden' }}>
        <Typography sx={{ fontFamily: 'monospace', fontSize: '0.74rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: ev.isUnknownDst ? '#f59e0b' : 'text.primary' }}>
          {ev.dstPod || (ev.isUnknownDst ? '(unknown)' : '—')}
        </Typography>
        {ev.dstNamespace && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: '0.62rem' }}>{ev.dstNamespace}</Typography>}
      </Box>

      <Typography sx={{ fontFamily: 'monospace', fontSize: '0.62rem', color: 'text.secondary', whiteSpace: 'nowrap' }}>
        {new Date(ev.timestamp).toLocaleTimeString()}
      </Typography>

      <Box sx={{ display: 'flex', gap: 0.4, justifyContent: 'flex-end' }}>
        {flags.map(f => (
          <Chip key={f.label} label={f.label} size="small" sx={{ fontSize: '0.58rem', height: 17, bgcolor: `${f.color}20`, color: f.color, border: `1px solid ${f.color}55`, fontWeight: 700 }} />
        ))}
      </Box>
    </Box>
  );
}

// ─── Debug overlay ────────────────────────────────────────────────────────────

function DebugPanel({ igConnected, infoFetched, podsSelected, podStreamsConnected, running, dataColumns, rawSample, gadgetInfoRaw }: {
  igConnected: boolean; infoFetched: boolean; podsSelected: any[]; podStreamsConnected: number; running: boolean; dataColumns: Record<string, string[]>; rawSample: any; gadgetInfoRaw: any;
}) {
  const [open, setOpen] = useState(false);

  // Extract all field names from gadgetInfo dataSources (including sub-fields)
  const allFields: string[] = gadgetInfoRaw
    ? (gadgetInfoRaw.dataSources ?? []).flatMap((ds: any) =>
        (ds.fields ?? []).map((f: any) => `${f.fullName} [flags:${f.flags}]`)
      )
    : [];

  return (
    <Box sx={{ position: 'fixed', bottom: 16, right: 16, zIndex: 9999 }}>
      <Chip label="debug" size="small" onClick={() => setOpen(v => !v)} sx={{ cursor: 'pointer', fontFamily: 'monospace', fontSize: '0.65rem', opacity: 0.6 }} />
      {open && (
        <Box sx={{ position: 'absolute', bottom: 28, right: 0, width: 420, bgcolor: 'background.paper', border: '1px solid', borderColor: 'warning.main', borderRadius: 1, p: 1.5, boxShadow: 8, fontFamily: 'monospace', fontSize: '0.68rem', maxHeight: '80vh', overflowY: 'auto' }}>
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, mb: 0.5 }}>TrafficPanel debug</Typography>
          <Box sx={{ color: igConnected ? '#22c55e' : '#ef4444' }}>IG connected: {String(igConnected)}</Box>
          <Box sx={{ color: infoFetched ? '#22c55e' : '#f59e0b' }}>GadgetInfo fetched: {String(infoFetched)}</Box>
          <Box>Pods selected: {podsSelected.length} | Streams connected: {podStreamsConnected}</Box>
          <Box sx={{ color: running ? '#22c55e' : '#6b7280' }}>Running: {String(running)}</Box>
          <Box sx={{ mt: 0.5, fontWeight: 700 }}>DataColumns keys: {Object.keys(dataColumns).join(', ') || '(none)'}</Box>
          {Object.entries(dataColumns).map(([dsId, cols]) => (
            <Box key={dsId} sx={{ color: '#94a3b8', wordBreak: 'break-all' }}>
              [{dsId}]: {(cols ?? []).join(', ')}
            </Box>
          ))}
          {allFields.length > 0 && (
            <>
              <Box sx={{ mt: 0.75, fontWeight: 700 }}>ALL gadgetInfo fields (with flags):</Box>
              {allFields.map((f, i) => (
                <Box key={i} sx={{ color: '#94a3b8', fontSize: '0.62rem' }}>{f}</Box>
              ))}
            </>
          )}
          {rawSample && (
            <>
              <Box sx={{ mt: 0.75, fontWeight: 700 }}>Top-level keys:</Box>
              <Box sx={{ color: '#94a3b8', wordBreak: 'break-all' }}>{Object.keys(rawSample).join(', ')}</Box>
              <Box sx={{ mt: 0.5, fontWeight: 700 }}>src object:</Box>
              <Box sx={{ color: '#94a3b8', wordBreak: 'break-all', maxHeight: 80, overflow: 'auto' }}>{JSON.stringify(rawSample.src)}</Box>
              <Box sx={{ mt: 0.5, fontWeight: 700 }}>dst object:</Box>
              <Box sx={{ color: '#94a3b8', wordBreak: 'break-all', maxHeight: 80, overflow: 'auto' }}>{JSON.stringify(rawSample.dst)}</Box>
              <Box sx={{ mt: 0.5, fontWeight: 700 }}>k8s object:</Box>
              <Box sx={{ color: '#94a3b8', wordBreak: 'break-all', maxHeight: 80, overflow: 'auto' }}>{JSON.stringify(rawSample.k8s)}</Box>
              <Box sx={{ mt: 0.5, fontWeight: 700 }}>FULL raw payload:</Box>
              <Box sx={{ color: '#94a3b8', wordBreak: 'break-all', maxHeight: 120, overflow: 'auto', fontSize: '0.6rem' }}>{JSON.stringify(rawSample, null, 1)}</Box>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TrafficPanel() {
  const [k8sNodes] = K8s.ResourceClasses.Node.useList();
  const [k8sPods] = K8s.ResourceClasses.Pod.useList();

  // useGadgetConn — used ONLY for getGadgetInfo (same as GadgetDetails)
  const ig = useGadgetConn(k8sNodes, k8sPods);

  // Mirror of GadgetContext state (we don't use the context Provider here,
  // we manage it locally since this is a standalone page)
  const [podsSelected, setPodsSelected] = useState<any[]>([]);
  const [podStreamsConnected, setPodStreamsConnected] = useState(0);
  const [gadgetRunningStatus, setGadgetRunningStatus] = useState(false);
  const [dataColumns, setDataColumns] = useState<Record<string, string[]>>({});
  const [dataSources, setDataSources] = useState<any[]>([]);
  const [isGadgetInfoFetched, setIsGadgetInfoFetched] = useState(false);
  const [loading, setLoading] = useState(false);

  // Our custom data store — replaces bufferedGadgetData/gadgetData
  const [events, setEvents] = useState<TrafficEvent[]>([]);
  const [rawSample, setRawSample] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  // View / filter state
  const [viewMode, setViewMode] = useState<'table' | 'topology'>('table');
  const [nsFilter, setNsFilter] = useState('');
  const [podFilter, setPodFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('all');
  const [onlyExternal, setOnlyExternal] = useState(false);
  const [onlyUnknown, setOnlyUnknown] = useState(false);

  const [gadgetInfoRaw, setGadgetInfoRaw] = useState<any>(null);

  const infoRequestedRef = useRef(false);

  // ── Step 1: getGadgetInfo — mirrors GadgetDetails useEffect exactly ───────
  useEffect(() => {
    if (!ig || infoRequestedRef.current) return;
    infoRequestedRef.current = true;

    ig.getGadgetInfo(
      { version: 1, imageName: TRACE_TCP_IMAGE },
      (info: any) => {
        setGadgetInfoRaw(info); // store raw for debug
        console.log('[TrafficPanel] gadgetInfo params:', JSON.stringify(info.params, null, 2));
        console.log('[TrafficPanel] gadgetInfo dataSources[0].fields:', 
          info.dataSources?.[0]?.fields?.map((f: any) => `${f.fullName}[${f.flags}]`));
        // prepareGadgetInfo logic from GadgetContext
        const fields: Record<string, string[]> = {};
        (info.dataSources ?? []).forEach((ds: any, i: number) => {
          fields[ds.id ?? i] = (ds.fields ?? [])
            .filter((f: any) => (f.flags & 4) === 0)
            .map((f: any) => f.fullName)
            .filter((name: string) => name !== 'k8s');
        });
        setDataColumns(fields);
        setDataSources(info.dataSources ?? []);
        setIsGadgetInfoFetched(true);
      },
      (err: Error) => {
        console.error('[TrafficPanel] getGadgetInfo error:', err);
        setError(`getGadgetInfo failed: ${err?.message ?? String(err)}`);
        infoRequestedRef.current = false; // allow retry
      }
    );
  }, [ig]);

  // ── Step 2: NodeSelection equivalent — auto-select all IG pods ──────────
  // Mirrors what NodeSelection does: find IG pods on each node, set podsSelected
  useEffect(() => {
    if (!k8sNodes || !k8sPods || k8sNodes.length === 0) return;

    const igPods = k8sNodes.reduce<any[]>((acc, node) => {
      const nodePods = k8sPods.filter(
        pod => pod.jsonData.spec.nodeName === node.jsonData.metadata.name && isIGPod(pod.jsonData)
      );
      return [...acc, ...nodePods];
    }, []);

    setPodsSelected(igPods);
  }, [k8sNodes, k8sPods]);

  // ── Step 3: Start gadget when all pod streams are connected ───────────────
  // Mirrors GenericGadgetRenderer's useEffect on [gadgetRunningStatus, podStreamsConnected]
  useEffect(() => {
    if (isGadgetInfoFetched && podsSelected.length > 0 && !gadgetRunningStatus) {
      setGadgetRunningStatus(true);
    }
  }, [isGadgetInfoFetched, podsSelected.length]);

  // ── Raw onData handler — receives payload before any processGadgetData ──────
  const onRawData = useCallback((raw: any) => {
    // Only update debug sample for connect/accept — close events have no addr info
    if (raw?.type === 'connect' || raw?.type === 'accept') {
      setRawSample(raw);
    }
    const ev = parseProcessedRow(raw);
    if (!ev) return;
    setEvents(prev => {
      const next = [ev, ...prev];
      return next.length > MAX_EVENTS ? next.slice(0, MAX_EVENTS) : next;
    });
  }, []);

  const namespaces = Array.from(
    new Set(events.flatMap(e => [e.srcNamespace, e.dstNamespace].filter(Boolean)))
  ).sort();

  const filtered = events.filter(ev => {
    if (nsFilter && ev.srcNamespace !== nsFilter && ev.dstNamespace !== nsFilter) return false;
    if (podFilter && !ev.srcPod.toLowerCase().includes(podFilter.toLowerCase()) && !ev.dstPod.toLowerCase().includes(podFilter.toLowerCase())) return false;
    if (typeFilter !== 'all' && ev.type !== typeFilter) return false;
    if (onlyExternal && !ev.isExternal) return false;
    if (onlyUnknown && !ev.isUnknownDst) return false;
    return true;
  });

  const isLoading = k8sNodes === null || k8sPods === null;
  const running = gadgetRunningStatus && podStreamsConnected > 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 130px)', bgcolor: 'background.paper', borderRadius: 2, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>

      {/* Header */}
      <Box sx={{ px: 3, py: 1.75, borderBottom: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, fontFamily: 'monospace', letterSpacing: '-0.02em' }}>Network Traffic</Typography>
          <LiveDot on={running} error={!!error} />
          {isGadgetInfoFetched && podsSelected.length > 0 && (
            <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>
              {podStreamsConnected}/{podsSelected.length} node streams
            </Typography>
          )}
        </Box>

        <Box sx={{ display: 'flex', gap: 1.25, alignItems: 'center', flexWrap: 'wrap' }}>
          <FormControl size="small" sx={{ minWidth: 150 }}>
            <InputLabel>Namespace</InputLabel>
            <Select value={nsFilter} label="Namespace" onChange={e => setNsFilter(e.target.value)}>
              <MenuItem value="">All</MenuItem>
              {namespaces.map(ns => <MenuItem key={ns} value={ns}>{ns}</MenuItem>)}
            </Select>
          </FormControl>

          <TextField size="small" label="Pod" value={podFilter} onChange={e => setPodFilter(e.target.value)}
            sx={{ width: 150 }} InputProps={{ sx: { fontFamily: 'monospace', fontSize: '0.82rem' } }} />

          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel>Type</InputLabel>
            <Select value={typeFilter} label="Type" onChange={e => setTypeFilter(e.target.value)}>
              <MenuItem value="all">All</MenuItem>
              <MenuItem value="connect">Connect</MenuItem>
              <MenuItem value="accept">Accept</MenuItem>
              <MenuItem value="close">Close</MenuItem>
            </Select>
          </FormControl>

          <Chip label="External" size="small" onClick={() => setOnlyExternal(v => !v)}
            sx={{ cursor: 'pointer', bgcolor: onlyExternal ? '#ef444422' : undefined, color: onlyExternal ? '#ef4444' : undefined, border: `1px solid ${onlyExternal ? '#ef4444' : 'transparent'}`, fontWeight: onlyExternal ? 700 : 400 }} />
          <Chip label="Unknown Dst" size="small" onClick={() => setOnlyUnknown(v => !v)}
            sx={{ cursor: 'pointer', bgcolor: onlyUnknown ? '#f59e0b22' : undefined, color: onlyUnknown ? '#f59e0b' : undefined, border: `1px solid ${onlyUnknown ? '#f59e0b' : 'transparent'}`, fontWeight: onlyUnknown ? 700 : 400 }} />
          <Chip label="Clear" size="small" onClick={() => setEvents([])} sx={{ cursor: 'pointer' }} />
          <Chip
            label={gadgetRunningStatus ? 'Pause' : 'Resume'}
            size="small" color={gadgetRunningStatus ? 'default' : 'primary'}
            disabled={!isGadgetInfoFetched || podsSelected.length === 0}
            onClick={() => setGadgetRunningStatus(v => !v)}
            sx={{ cursor: 'pointer', fontWeight: 600 }}
          />
        </Box>
      </Box>

      <StatsBar evs={filtered} />

      {/* View tabs */}
      <Box sx={{ borderBottom: '1px solid', borderColor: 'divider', px: 1 }}>
        <Tabs value={viewMode} onChange={(_e, v) => setViewMode(v)}
          sx={{ minHeight: 34, '& .MuiTab-root': { minHeight: 34, fontSize: '0.7rem', fontFamily: 'monospace', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.07em', py: 0 } }}>
          <Tab value="table" label="Event Log" />
          <Tab value="topology" label="Topology Map" />
        </Tabs>
      </Box>

      {/* Table view */}
      {viewMode === 'table' && (
        <>
          <Box sx={{ display: 'grid', gridTemplateColumns: '78px 1fr 1fr 90px auto', gap: 1, px: 2, py: 0.6, bgcolor: 'action.hover', borderBottom: '1px solid', borderColor: 'divider' }}>
            {['TYPE', 'SOURCE', 'DESTINATION', 'TIME', 'FLAGS'].map(h => (
              <Typography key={h} sx={{ fontSize: '0.62rem', fontFamily: 'monospace', fontWeight: 700, color: 'text.secondary', letterSpacing: '0.1em' }}>{h}</Typography>
            ))}
          </Box>
          <Box sx={{ flex: 1, overflowY: 'auto' }}>
            {isLoading ? (
              <Center><Typography color="text.secondary">Loading cluster resources…</Typography></Center>
            ) : !ig ? (
              <Center>
                <Typography color="text.secondary" sx={{ fontFamily: 'monospace' }}>Waiting for Inspektor Gadget connection…</Typography>
                <Typography variant="caption" color="text.secondary">Ensure the gadget DaemonSet is running in namespace gadget.</Typography>
              </Center>
            ) : error ? (
              <Center>
                <Typography color="error" sx={{ fontFamily: 'monospace', fontSize: '0.82rem', textAlign: 'center', maxWidth: 500 }}>{error}</Typography>
                <Chip label="Retry" size="small" color="primary"
                  onClick={() => { setError(null); infoRequestedRef.current = false; setIsGadgetInfoFetched(false); }}
                  sx={{ cursor: 'pointer', mt: 0.5 }} />
              </Center>
            ) : !isGadgetInfoFetched ? (
              <Center><Typography color="text.secondary" sx={{ fontFamily: 'monospace' }}>Loading gadget info…</Typography></Center>
            ) : filtered.length === 0 ? (
              <Center>
                <Typography color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                  {running ? 'Listening for TCP events…' : 'Paused.'}
                </Typography>
                {events.length > 0 && (
                  <Typography variant="caption" color="text.secondary">{events.length} event(s) hidden by filters.</Typography>
                )}
              </Center>
            ) : (
              filtered.map((ev, i) => <EventRow key={ev.id} ev={ev} idx={i} />)
            )}
          </Box>
        </>
      )}

      {/* Topology view */}
      {viewMode === 'topology' && (
        <Box sx={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <TopologyMap events={filtered} nsFilter={nsFilter || undefined} />
        </Box>
      )}

      {/* Footer */}
      <Box sx={{ px: 2, py: 0.6, borderTop: '1px solid', borderColor: 'divider', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography sx={{ fontSize: '0.68rem', fontFamily: 'monospace', color: 'text.secondary' }}>
          gadget: trace_tcp
        </Typography>
        <Typography sx={{ fontSize: '0.68rem', fontFamily: 'monospace', color: 'text.secondary' }}>
          {viewMode === 'table'
            ? `${filtered.length} / ${events.length} events`
            : `${events.filter(e => e.type === 'connect' || e.type === 'accept').length} flows in graph`}
        </Typography>
      </Box>

      {/* PodTrafficStream — one per IG pod, streams raw payloads via its own port-forward */}
      {isGadgetInfoFetched && podsSelected.map(pod => (
        <PodTrafficStream
          key={pod?.jsonData?.metadata?.name}
          podName={pod?.jsonData?.metadata?.name}
          nodeName={pod?.jsonData?.spec?.nodeName}
          imageName={TRACE_TCP_IMAGE}
          gadgetRunningStatus={gadgetRunningStatus}
          podsSelected={podsSelected}
          podStreamsConnected={podStreamsConnected}
          setPodStreamsConnected={setPodStreamsConnected}
          onData={onRawData}
        />
      ))}

      {/* Debug — remove before PR */}
      <DebugPanel
        igConnected={!!ig}
        infoFetched={isGadgetInfoFetched}
        podsSelected={podsSelected}
        podStreamsConnected={podStreamsConnected}
        running={running}
        dataColumns={dataColumns}
        rawSample={rawSample}
        gadgetInfoRaw={gadgetInfoRaw}
      />
    </Box>
  );
}