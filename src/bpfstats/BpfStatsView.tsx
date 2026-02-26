import { Icon } from '@iconify/react';
import { Loader, SectionBox, Table } from '@kinvolk/headlamp-plugin/lib/CommonComponents';
import K8s from '@kinvolk/headlamp-plugin/lib/K8s';
import {
  Box,
  Button,
  Chip,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Tooltip,
  Typography,
} from '@mui/material';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { IGNotFound } from '../common/NotFound';
import { isIGPod } from '../gadgets/helper';
import { isIGInstalled } from '../gadgets/conn';
import usePortForward from '../gadgets/igSocket';

const BPFSTATS_IMAGE = 'ghcr.io/inspektor-gadget/gadget/bpfstats:latest';

const RUNTIME_WARN_NS = 1_000_000;
const RUNTIME_CRIT_NS = 10_000_000;

const MAP_MEMORY_WARN_BYTES = 1_048_576;
const MAP_MEMORY_CRIT_BYTES = 10_485_760;

interface BpfRow {
  _key: string;
  nodeName: string;
  progID: number;
  progName: string;
  progType: string;
  gadgetID: string;
  gadgetName: string;
  gadgetImage: string;
  runCount: number;
  mapCount: number;
  mapMemory: number;
  runtime: number;
  comms: string;
  pids: string;
}

type SortField = 'runtime' | 'mapMemory' | 'runCount' | 'progName' | 'nodeName';
type SortDir = 'asc' | 'desc';

function formatNs(ns: number): string {
  if (ns === 0) return '0 ns';
  if (ns < 1_000) return `${ns} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(1)} µs`;
  if (ns < 1_000_000_000) return `${(ns / 1_000_000).toFixed(1)} ms`;
  return `${(ns / 1_000_000_000).toFixed(2)} s`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function runtimeSeverity(ns: number): 'critical' | 'warning' | 'ok' {
  if (ns >= RUNTIME_CRIT_NS) return 'critical';
  if (ns >= RUNTIME_WARN_NS) return 'warning';
  return 'ok';
}

function memorySeverity(bytes: number): 'critical' | 'warning' | 'ok' {
  if (bytes >= MAP_MEMORY_CRIT_BYTES) return 'critical';
  if (bytes >= MAP_MEMORY_WARN_BYTES) return 'warning';
  return 'ok';
}

function rowBg(row: BpfRow, theme: 'light' | 'dark'): string | undefined {
  const rs = runtimeSeverity(row.runtime);
  const ms = memorySeverity(row.mapMemory);
  const worst = rs === 'critical' || ms === 'critical' ? 'critical' : rs === 'warning' || ms === 'warning' ? 'warning' : 'ok';

  if (worst === 'ok') return undefined;
  if (theme === 'dark') {
    return worst === 'critical' ? 'rgba(211,47,47,0.18)' : 'rgba(237,108,2,0.14)';
  }
  return worst === 'critical' ? 'rgba(211,47,47,0.08)' : 'rgba(237,108,2,0.06)';
}

function resolveField(obj: any, keys: string[]): any {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return undefined;
}

function parseRawNs(v: any): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).trim();
  if (s === '' || s === '0' || s === '0ns') return 0;

  const match = s.match(/^([\d.]+)\s*(ns|µs|us|ms|s)$/i);
  if (match) {
    const n = parseFloat(match[1]);
    switch (match[2].toLowerCase()) {
      case 'ns': return n;
      case 'µs': case 'us': return n * 1_000;
      case 'ms': return n * 1_000_000;
      case 's':  return n * 1_000_000_000;
    }
  }
  const bare = parseFloat(s);
  return isNaN(bare) ? 0 : bare;
}

function parseRawBytes(v: any): number {
  if (v === undefined || v === null) return 0;
  if (typeof v === 'number') return isNaN(v) ? 0 : v;
  const s = String(v).trim();
  if (s === '' || s === '0' || s === '0 B' || s === '0B') return 0;
  const match = s.match(/^([\d.]+)\s*(B|KB|KiB|MB|MiB|GB|GiB)$/i);
  if (match) {
    const n = parseFloat(match[1]);
    switch (match[2].toUpperCase()) {
      case 'B':   return n;
      case 'KB':  case 'KIB': return n * 1_024;
      case 'MB':  case 'MIB': return n * 1_048_576;
      case 'GB':  case 'GIB': return n * 1_073_741_824;
    }
  }
  const bare = parseFloat(s);
  return isNaN(bare) ? 0 : bare;
}

interface NodeBpfStreamProps {
  podName: string;
  nodeName: string;
  running: boolean;
  onData: (row: BpfRow) => void;
  onConnectionChange: (node: string, connected: boolean) => void;
}

function NodeBpfStream({ podName, nodeName, running, onData, onConnectionChange }: NodeBpfStreamProps) {
  const { ig, isConnected } = usePortForward(
    `api/v1/namespaces/gadget/pods/${podName}/portforward?ports=8080`
  );
  const gadgetRef = useRef<any>(null);
  const mountedRef = useRef(true);
  const runningRef = useRef(running);
  runningRef.current = running;

  useEffect(() => {
    onConnectionChange(nodeName, isConnected);
  }, [isConnected, nodeName]);

  useEffect(() => {
    if (!ig || !running) {
      gadgetRef.current?.stop?.();
      gadgetRef.current = null;
      return;
    }

    gadgetRef.current?.stop?.();
    gadgetRef.current = null;

    gadgetRef.current = ig.runGadget(
      {
        version: 1,
        imageName: BPFSTATS_IMAGE,
        paramValues: {},
      },
      {
        onGadgetInfo: () => {},
        onReady: () => {},
        onDone: () => {},
        onError: (err: any) => console.error(`[bpfstats] node=${nodeName}`, err),
        onData: (_dsID: string, raw: any) => {
          if (!mountedRef.current || !runningRef.current) return;
          const items = Array.isArray(raw) ? raw : [raw];
          items.forEach(item => {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('[bpfstats] raw item keys:', Object.keys(item), item);
            }

            const row: BpfRow = {
              _key: `${nodeName}/${resolveField(item, ['progID', 'progId', 'id', 'prog_id']) ?? ''}`,
              nodeName,
              progID:    resolveField(item, ['progID', 'progId', 'id', 'prog_id']) ?? 0,
              progName:  resolveField(item, ['progName', 'name', 'prog_name']) ?? '',
              progType:  resolveField(item, ['progType', 'type', 'prog_type']) ?? '',
              gadgetID:  resolveField(item, ['gadgetID', 'gadgetId', 'gadget_id']) ?? '',
              gadgetName: resolveField(item, ['gadgetName', 'gadget_name']) ?? '',
              gadgetImage: resolveField(item, ['gadgetImage', 'gadget_image']) ?? '',
              runCount:  Number(resolveField(item, ['runcount', 'runCount', 'run_count']) ?? 0),
              mapCount:  Number(resolveField(item, ['mapCount', 'mapcount', 'map_count']) ?? 0),
              mapMemory: parseRawBytes(resolveField(item, ['mapMemory', 'mapmemory', 'map_memory', 'mapMemoryBytes', 'map_memory_bytes'])),
              runtime:   parseRawNs(resolveField(item, ['runtime', 'runtimeNs', 'runtime_ns', 'runtimeNanos'])),
              comms: Array.isArray(item.comms) ? item.comms.join(', ') : String(item.comms ?? ''),
              pids:  Array.isArray(item.pids)  ? item.pids.join(', ')  : String(item.pids  ?? ''),
            };
            onData(row);
          });
        },
      },
      (err: any) => console.error(`[bpfstats] setup error node=${nodeName}`, err)
    );

    return () => {
      gadgetRef.current?.stop?.();
      gadgetRef.current = null;
    };
  }, [ig, running, nodeName]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gadgetRef.current?.stop?.();
    };
  }, []);

  return null;
}

interface SummaryChipsProps {
  rows: BpfRow[];
  connectedNodes: string[];
}

function SummaryChips({ rows, connectedNodes }: SummaryChipsProps) {
  const critical = rows.filter(r => runtimeSeverity(r.runtime) === 'critical' || memorySeverity(r.mapMemory) === 'critical').length;
  const warning = rows.filter(r => runtimeSeverity(r.runtime) === 'warning' || memorySeverity(r.mapMemory) === 'warning').length;
  const totalMemory = rows.reduce((s, r) => s + r.mapMemory, 0);
  const activePrograms = rows.filter(r => r.runtime > 0 || r.runCount > 0).length;

  return (
    <Box display="flex" gap={1} flexWrap="wrap" mb={2}>
      <Chip
        icon={<Icon icon="mdi:server-network" />}
        label={`${connectedNodes.length} node${connectedNodes.length !== 1 ? 's' : ''} connected`}
        color="primary"
        variant="outlined"
        size="small"
      />
      <Chip
        icon={<Icon icon="mdi:chip" />}
        label={`${rows.length} eBPF programs`}
        variant="outlined"
        size="small"
      />
      <Chip
        icon={<Icon icon="mdi:lightning-bolt" />}
        label={`${activePrograms} active`}
        color={activePrograms > 0 ? 'success' : 'default'}
        variant="outlined"
        size="small"
      />
      <Chip
        icon={<Icon icon="mdi:database" />}
        label={`${formatBytes(totalMemory)} map memory`}
        variant="outlined"
        size="small"
      />
      {critical > 0 && (
        <Chip
          icon={<Icon icon="mdi:alert-circle" />}
          label={`${critical} high CPU/mem`}
          color="error"
          size="small"
        />
      )}
      {warning > 0 && (
        <Chip
          icon={<Icon icon="mdi:alert" />}
          label={`${warning} elevated`}
          color="warning"
          size="small"
        />
      )}
    </Box>
  );
}

export default function BpfStatsView() {
  const [nodes] = K8s.ResourceClasses.Node.useList();
  const [pods] = K8s.ResourceClasses.Pod.useList();

  const [running, setRunning] = useState(false);
  const [sortField, setSortField] = useState<SortField>('runtime');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [filterNode, setFilterNode] = useState<string>('all');
  const [filterType, setFilterType] = useState<string>('all');

  const rowMapRef = useRef<Map<string, BpfRow>>(new Map());
  const [rows, setRows] = useState<BpfRow[]>([]);
  const [connectedNodes, setConnectedNodes] = useState<string[]>([]);

  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      setRows(Array.from(rowMapRef.current.values()));
    }, 1000);
  }, []);

  const handleData = useCallback((row: BpfRow) => {
    rowMapRef.current.set(row._key, row);
    scheduleFlush();
  }, [scheduleFlush]);

  const handleConnectionChange = useCallback((node: string, connected: boolean) => {
    setConnectedNodes(prev => {
      if (connected && !prev.includes(node)) return [...prev, node];
      if (!connected) return prev.filter(n => n !== node);
      return prev;
    });
  }, []);

  useEffect(() => {
    if (!running) {
      rowMapRef.current.clear();
      setRows([]);
      setConnectedNodes([]);
    }
  }, [running]);

  useEffect(() => {
    return () => {
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  if (nodes === null || pods === null) {
    return <Loader title="Loading cluster info…" />;
  }

  const isIGInstallationFound = isIGInstalled(pods);
  if (!isIGInstallationFound) {
    return <IGNotFound />;
  }

  const igPodsByNode: Record<string, string> = {};
  nodes.forEach((node: any) => {
    const nodeName = node.metadata.name;
    const igPod = pods.find(
      (pod: any) => pod.spec.nodeName === nodeName && isIGPod(pod.jsonData ?? pod)
    );
    if (igPod) {
      igPodsByNode[nodeName] = (igPod.jsonData ?? igPod).metadata.name;
    }
  });

  const nodeNames = Object.keys(igPodsByNode);

  const filteredRows = rows.filter(r => {
    if (filterNode !== 'all' && r.nodeName !== filterNode) return false;
    if (filterType !== 'all' && r.progType !== filterType) return false;
    return true;
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    const mul = sortDir === 'desc' ? -1 : 1;
    if (sortField === 'runtime') return mul * (a.runtime - b.runtime);
    if (sortField === 'mapMemory') return mul * (a.mapMemory - b.mapMemory);
    if (sortField === 'runCount') return mul * (a.runCount - b.runCount);
    if (sortField === 'progName') return mul * a.progName.localeCompare(b.progName);
    if (sortField === 'nodeName') return mul * a.nodeName.localeCompare(b.nodeName);
    return 0;
  });

  const progTypes = Array.from(new Set(rows.map(r => r.progType).filter(Boolean)));

  const columns = [
    {
      header: 'Node',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" noWrap sx={{ maxWidth: 160 }}>
          {row.nodeName}
        </Typography>
      ),
    },
    {
      header: 'Prog ID',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" fontFamily="monospace">
          {row.progID}
        </Typography>
      ),
    },
    {
      header: 'Program Name',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" fontFamily="monospace" fontWeight="medium">
          {row.progName || '—'}
        </Typography>
      ),
    },
    {
      header: 'Type',
      accessorFn: (row: BpfRow) => (
        row.progType ? (
          <Chip label={row.progType} size="small" variant="outlined" />
        ) : (
          <Typography variant="body2" color="text.secondary">—</Typography>
        )
      ),
    },
    {
      header: 'Gadget',
      accessorFn: (row: BpfRow) => (
        row.gadgetName ? (
          <Tooltip title={row.gadgetImage || row.gadgetName} placement="top">
            <Chip
              icon={<Icon icon="custom-icon:ig" width={14} height={14} />}
              label={row.gadgetName}
              size="small"
              color="primary"
              variant="outlined"
            />
          </Tooltip>
        ) : (
          <Typography variant="body2" color="text.secondary">—</Typography>
        )
      ),
    },
    {
      header: 'Run Count',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" fontFamily="monospace">
          {row.runCount.toLocaleString()}
        </Typography>
      ),
    },
    {
      header: 'CPU Runtime',
      accessorFn: (row: BpfRow) => {
        const sev = runtimeSeverity(row.runtime);
        return (
          <Box display="flex" alignItems="center" gap={0.5}>
            {sev === 'critical' && (
              <Tooltip title="High CPU usage">
                <Icon icon="mdi:alert-circle" color="#d32f2f" width={16} />
              </Tooltip>
            )}
            {sev === 'warning' && (
              <Tooltip title="Elevated CPU usage">
                <Icon icon="mdi:alert" color="#ed6c02" width={16} />
              </Tooltip>
            )}
            <Typography
              variant="body2"
              fontFamily="monospace"
              color={
                sev === 'critical' ? 'error.main' : sev === 'warning' ? 'warning.main' : 'inherit'
              }
            >
              {formatNs(row.runtime)}
            </Typography>
          </Box>
        );
      },
    },
    {
      header: 'Map Memory',
      accessorFn: (row: BpfRow) => {
        const sev = memorySeverity(row.mapMemory);
        return (
          <Box display="flex" alignItems="center" gap={0.5}>
            {sev === 'critical' && (
              <Tooltip title="High map memory">
                <Icon icon="mdi:alert-circle" color="#d32f2f" width={16} />
              </Tooltip>
            )}
            {sev === 'warning' && (
              <Tooltip title="Elevated map memory">
                <Icon icon="mdi:alert" color="#ed6c02" width={16} />
              </Tooltip>
            )}
            <Typography
              variant="body2"
              fontFamily="monospace"
              color={
                sev === 'critical' ? 'error.main' : sev === 'warning' ? 'warning.main' : 'inherit'
              }
            >
              {formatBytes(row.mapMemory)}
            </Typography>
          </Box>
        );
      },
    },
    {
      header: 'Map Count',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" fontFamily="monospace">
          {row.mapCount}
        </Typography>
      ),
    },
    {
      header: 'Comms',
      accessorFn: (row: BpfRow) => (
        <Typography variant="body2" noWrap sx={{ maxWidth: 140 }}>
          {row.comms || '—'}
        </Typography>
      ),
    },
  ];

  return (
    <>
      {nodeNames.map(nodeName => (
        <NodeBpfStream
          key={nodeName}
          podName={igPodsByNode[nodeName]}
          nodeName={nodeName}
          running={running}
          onData={handleData}
          onConnectionChange={handleConnectionChange}
        />
      ))}

      <SectionBox
        title={
          <Box display="flex" alignItems="center" gap={1}>
            <Icon icon="mdi:chip" width={22} height={22} />
            <Typography variant="h5">eBPF Programs</Typography>
            {running && (
              <Chip
                icon={<Icon icon="mdi:circle" color="#4caf50" width={10} />}
                label="Live"
                size="small"
                color="success"
                variant="outlined"
                sx={{ ml: 1, fontWeight: 600 }}
              />
            )}
          </Box>
        }
      >
        {/* ── Controls bar ── */}
        <Box display="flex" alignItems="center" gap={2} mb={2} flexWrap="wrap">
          <Button
            variant="contained"
            color={running ? 'error' : 'primary'}
            startIcon={<Icon icon={running ? 'mdi:stop' : 'mdi:play'} />}
            onClick={() => setRunning(prev => !prev)}
            disabled={nodeNames.length === 0}
          >
            {running ? 'Stop' : 'Start'}
          </Button>

          {/* Sort field */}
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="sort-field-label">Sort by</InputLabel>
            <Select
              labelId="sort-field-label"
              value={sortField}
              label="Sort by"
              onChange={e => setSortField(e.target.value as SortField)}
            >
              <MenuItem value="runtime">CPU Runtime</MenuItem>
              <MenuItem value="mapMemory">Map Memory</MenuItem>
              <MenuItem value="runCount">Run Count</MenuItem>
              <MenuItem value="progName">Program Name</MenuItem>
              <MenuItem value="nodeName">Node</MenuItem>
            </Select>
          </FormControl>

          {/* Sort direction */}
          <Tooltip title={sortDir === 'desc' ? 'Highest first' : 'Lowest first'}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setSortDir(d => (d === 'desc' ? 'asc' : 'desc'))}
              startIcon={
                <Icon icon={sortDir === 'desc' ? 'mdi:sort-descending' : 'mdi:sort-ascending'} />
              }
            >
              {sortDir === 'desc' ? 'Desc' : 'Asc'}
            </Button>
          </Tooltip>

          {/* Filter by node */}
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="filter-node-label">Node</InputLabel>
            <Select
              labelId="filter-node-label"
              value={filterNode}
              label="Node"
              onChange={e => setFilterNode(e.target.value)}
            >
              <MenuItem value="all">All nodes</MenuItem>
              {nodeNames.map(n => (
                <MenuItem key={n} value={n}>
                  {n}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Filter by prog type */}
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel id="filter-type-label">Type</InputLabel>
            <Select
              labelId="filter-type-label"
              value={filterType}
              label="Type"
              onChange={e => setFilterType(e.target.value)}
            >
              <MenuItem value="all">All types</MenuItem>
              {progTypes.map(t => (
                <MenuItem key={t} value={t}>
                  {t}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          {nodeNames.length === 0 && (
            <Typography variant="body2" color="error">
              No IG pods found. Is Inspektor Gadget installed?
            </Typography>
          )}
        </Box>

        {/* ── Summary chips ── */}
        {rows.length > 0 && (
          <SummaryChips rows={rows} connectedNodes={connectedNodes} />
        )}

        {/* ── Not started hint ── */}
        {!running && rows.length === 0 && (
          <Box
            display="flex"
            flexDirection="column"
            alignItems="center"
            justifyContent="center"
            py={6}
            gap={1}
          >
            <Icon icon="mdi:chip" width={48} height={48} color="action" />
            <Typography variant="h6" color="text.secondary">
              No data yet
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Press <strong>Start</strong> to stream eBPF program stats from all nodes
            </Typography>
          </Box>
        )}

        {/* ── Headlamp native Table ── */}
        {(running || rows.length > 0) && (
          <Table
            columns={columns}
            data={sortedRows}
            loading={running && rows.length === 0}
            emptyMessage={
              running
                ? 'Waiting for data from nodes…'
                : 'No eBPF programs found matching current filters.'
            }
            rowProps={(row: BpfRow) => {
              const bg = rowBg(row, 'dark');
              return bg ? { sx: { backgroundColor: bg } } : {};
            }}
          />
        )}

        <Box textAlign="right" mt={1}>
          <Typography variant="caption" color="text.secondary">
            Powered by{' '}
            <a
              href="https://inspektor-gadget.io/docs/latest/gadgets/bpfstats"
              target="_blank"
              rel="noreferrer"
            >
              Inspektor Gadget · bpfstats
            </a>
          </Typography>
        </Box>
      </SectionBox>
    </>
  );
}