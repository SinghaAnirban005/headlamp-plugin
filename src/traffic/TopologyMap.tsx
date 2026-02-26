/**
 * TopologyMap — SVG force-directed graph of pod-to-pod traffic
 *
 * Nodes  = pods (by namespace/name) + unknown-dst sentinels per source pod
 * Edges  = observed TCP connect/accept flows, thickness ∝ connection count
 * Color  = namespace (pods) / orange (unknown dst)
 *
 * IPs are not available from this IG WASM version — topology is built
 * purely from k8s identity (root k8s = source, dst.k8s = destination).
 */

import { Box, Chip, Typography } from '@mui/material';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TrafficEvent } from './TrafficPanel';

// ─── Graph data model ────────────────────────────────────────────────────────

export type NodeKind = 'pod' | 'external' | 'unknown' | 'service';

export interface GraphNode {
  id: string;
  label: string;
  sublabel?: string;
  kind: NodeKind;
  namespace?: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
  count: number;
  hasExternal: boolean;
  hasUnknown: boolean;
}

// ─── Build graph from events ──────────────────────────────────────────────────

// System namespaces whose unknown-dst traffic we suppress to reduce noise.
// kube-system components legitimately call external endpoints constantly.
const SYSTEM_NS = new Set(['kube-system', 'kube-public', 'kube-node-lease']);

function nodeId(ev: TrafficEvent, side: 'src' | 'dst'): string {
  if (side === 'src') {
    return ev.srcPod ? `pod::${ev.srcNamespace}/${ev.srcPod}` : '';
  }
  // Pod destination (accept side of a connection)
  if (ev.dstPod) return `pod::${ev.dstNamespace}/${ev.dstPod}`;
  // Service destination — IG resolves these as s/namespace/name in kubectl output
  if (ev.dstSvc) return `svc::${ev.dstNamespace}/${ev.dstSvc}`;
  // Unknown dst — per-source sentinel, suppress for system namespaces
  if (ev.isUnknownDst && ev.srcPod && !SYSTEM_NS.has(ev.srcNamespace)) {
    return `unk::${ev.srcNamespace}/${ev.srcPod}`;
  }
  return '';
}

function nodeKind(id: string): NodeKind {
  if (id.startsWith('pod::')) return 'pod';
  if (id.startsWith('svc::')) return 'service';
  if (id.startsWith('ext::')) return 'external';
  return 'unknown';
}

function nodeLabel(id: string): { label: string; sublabel?: string } {
  if (id.startsWith('pod::')) {
    const rest = id.slice(5);
    const slash = rest.indexOf('/');
    if (slash === -1) return { label: rest || '(unknown)' };
    return { label: rest.slice(slash + 1) || '(unknown)', sublabel: rest.slice(0, slash) || undefined };
  }
  if (id.startsWith('svc::')) {
    const rest = id.slice(5);
    const slash = rest.indexOf('/');
    if (slash === -1) return { label: rest || '(svc)', sublabel: 'service' };
    return { label: rest.slice(slash + 1) || '(svc)', sublabel: rest.slice(0, slash) || undefined };
  }
  if (id.startsWith('ext::')) return { label: id.slice(5) || '(external)', sublabel: 'external' };
  if (id.startsWith('unk::')) {
    const rest = id.slice(5);
    const slash = rest.indexOf('/');
    const pod = slash >= 0 ? rest.slice(slash + 1) : rest;
    return { label: '? egress', sublabel: pod || undefined };
  }
  return { label: '(unknown)' };
}

export function buildGraph(
  events: TrafficEvent[],
  nsFilter?: string
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  let relevant = events.filter(e => e.type === 'connect' || e.type === 'accept');

  if (nsFilter) {
    relevant = relevant.filter(e =>
      e.srcNamespace === nsFilter ||
      e.dstNamespace === nsFilter
    );
  }

  for (const ev of relevant) {
    const src = nodeId(ev, 'src');
    const dst = nodeId(ev, 'dst');

    if (!src || !dst || src === dst) continue;

    if (!nodeMap.has(src)) {
      const { label, sublabel } = nodeLabel(src);
      nodeMap.set(src, {
        id: src, label, sublabel, kind: nodeKind(src),
        namespace: ev.srcNamespace,
        x: Math.random() * 600 + 100, y: Math.random() * 400 + 100,
        vx: 0, vy: 0, pinned: false,
      });
    }
    if (!nodeMap.has(dst)) {
      const { label, sublabel } = nodeLabel(dst);
      nodeMap.set(dst, {
        id: dst, label, sublabel, kind: nodeKind(dst),
        namespace: ev.dstNamespace,
        x: Math.random() * 600 + 100, y: Math.random() * 400 + 100,
        vx: 0, vy: 0, pinned: false,
      });
    }

    const eid = `${src}\u2192${dst}`;
    const existing = edgeMap.get(eid);
    if (existing) {
      existing.count++;
      if (ev.isExternal) existing.hasExternal = true;
      if (ev.isUnknownDst) existing.hasUnknown = true;
    } else {
      edgeMap.set(eid, {
        source: src, target: dst, count: 1,
        hasExternal: ev.isExternal, hasUnknown: ev.isUnknownDst,
      });
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    edges: Array.from(edgeMap.values()),
  };
}

const NS_PALETTE = [
  '#6366f1', '#22c55e', '#06b6d4', '#f59e0b',
  '#8b5cf6', '#10b981', '#3b82f6', '#ec4899',
  '#14b8a6', '#f97316',
];

const FIXED_NS_COLORS: Record<string, string> = {
  'kube-system': '#22c55e',
  'frontend':    '#6366f1',
  'backend':     '#06b6d4',
};

const nsColorCache = new Map<string, string>(Object.entries(FIXED_NS_COLORS));
let nsColorIdx = 0;

function nsColor(namespace: string | undefined): string {
  if (!namespace) return '#6b7280';
  if (!nsColorCache.has(namespace)) {
    while (Object.values(FIXED_NS_COLORS).includes(NS_PALETTE[nsColorIdx % NS_PALETTE.length])) nsColorIdx++;
    nsColorCache.set(namespace, NS_PALETTE[nsColorIdx % NS_PALETTE.length]);
    nsColorIdx++;
  }
  return nsColorCache.get(namespace)!;
}

function nodeColor(node: GraphNode): string {
  if (node.kind === 'external') return '#ef4444';
  if (node.kind === 'unknown') return '#f59e0b';
  if (node.kind === 'service') return '#06b6d4';
  return nsColor(node.namespace);
}

function edgeColor(edge: GraphEdge): string {
  if (edge.hasExternal) return '#ef4444';
  if (edge.hasUnknown) return '#f59e0b';
  return '#94a3b8';
}

const REPULSION = 8000;
const SPRING_LEN = 180;
const SPRING_K   = 0.03;
const DAMPING    = 0.78;
const CENTER_PULL = 0.006;
const ITER_PER_FRAME = 2;

function runSimulationStep(nodes: GraphNode[], edges: GraphEdge[], cx: number, cy: number) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j];
      const dx = b.x - a.x || 0.01, dy = b.y - a.y || 0.01;
      const dist2 = dx * dx + dy * dy;
      const dist = Math.sqrt(dist2) || 1;
      const force = REPULSION / dist2;
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  const nodeById = new Map(nodes.map(n => [n.id, n]));
  for (const edge of edges) {
    const a = nodeById.get(edge.source), b = nodeById.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
    const force = (dist - SPRING_LEN) * SPRING_K;
    const fx = (dx / dist) * force, fy = (dy / dist) * force;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx += (cx - n.x) * CENTER_PULL;
    n.vy += (cy - n.y) * CENTER_PULL;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

const NODE_R = 22;
const LABEL_CHARS = 15;

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function NodeEl({ node, selected, onClick, onDragStart }: {
  node: GraphNode; selected: boolean;
  onClick: () => void; onDragStart: (e: React.PointerEvent) => void;
}) {
  const color = nodeColor(node);
  const isUnknown = node.kind === 'unknown';
  const isExternal = node.kind === 'external';
  const isService = node.kind === 'service';
  const iconText = isExternal ? 'EXT' : isUnknown ? '?' : isService ? 'SVC' : node.label.slice(0, 1).toUpperCase();

  return (
    <g
      transform={`translate(${node.x},${node.y})`}
      style={{ cursor: 'grab' }}
      onClick={onClick}
      onPointerDown={onDragStart}
    >
      <title>{`${node.kind}: ${node.sublabel ? node.sublabel + '/' : ''}${node.label}`}</title>

      {(selected || isUnknown || isExternal) && (
        <circle r={NODE_R + 6} fill="none" stroke={color}
          strokeWidth={selected ? 2.5 : 1} opacity={selected ? 0.5 : 0.3}
          strokeDasharray={isUnknown && !selected ? '3 3' : undefined}
        />
      )}

      <circle r={NODE_R} fill={color} fillOpacity={selected ? 0.25 : 0.12}
        stroke={color} strokeWidth={selected ? 2.5 : 1.5}
      />

      <text textAnchor="middle" dominantBaseline="central"
        fontSize={isExternal || isService ? 8 : 11} fontWeight="700" fontFamily="monospace" fill={color}
      >
        {iconText}
      </text>

      {/* Pod name label */}
      <text y={NODE_R + 11} textAnchor="middle" fontSize="9" fontFamily="monospace"
        fill="currentColor" opacity={0.9}
      >
        {truncate(node.label, LABEL_CHARS)}
      </text>

      {/* Namespace sublabel — dimmer, smaller, colored */}
      {node.sublabel && (
        <text y={NODE_R + 21} textAnchor="middle" fontSize="7.5" fontFamily="monospace"
          fill={color} opacity={0.65}
        >
          {truncate(node.sublabel, LABEL_CHARS)}
        </text>
      )}
    </g>
  );
}

function EdgeEl({ edge, nodes, selected }: {
  edge: GraphEdge; nodes: Map<string, GraphNode>; selected: boolean;
}) {
  const src = nodes.get(edge.source), dst = nodes.get(edge.target);
  if (!src || !dst) return null;

  const color = edgeColor(edge);
  const strokeWidth = Math.min(1.5 + Math.log2(edge.count + 1), 6);

  const mx = (src.x + dst.x) / 2, my = (src.y + dst.y) / 2;
  const dx = dst.x - src.x, dy = dst.y - src.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const curvature = 24;
  const cpx = mx - (dy / len) * curvature, cpy = my + (dx / len) * curvature;

  const angle = Math.atan2(dst.y - cpy, dst.x - cpx);
  const ax = dst.x - Math.cos(angle) * (NODE_R + 2);
  const ay = dst.y - Math.sin(angle) * (NODE_R + 2);

  const markerId = `arr-${edge.source.replace(/\W/g, '_')}-${edge.target.replace(/\W/g, '_')}`;

  return (
    <g opacity={selected ? 1 : 0.55}>
      <defs>
        <marker id={markerId} viewBox="0 -4 8 8" refX="8" refY="0" markerWidth="5" markerHeight="5" orient="auto">
          <path d="M0,-4L8,0L0,4" fill={color} />
        </marker>
      </defs>
      <path
        d={`M${src.x},${src.y} Q${cpx},${cpy} ${ax},${ay}`}
        fill="none" stroke={color} strokeWidth={strokeWidth}
        markerEnd={`url(#${markerId})`}
      />
      {edge.count > 1 && (
        <text x={cpx} y={cpy - 5} textAnchor="middle" fontSize="8"
          fontFamily="monospace" fill={color} opacity={0.9}
        >
          {edge.count}
        </text>
      )}
    </g>
  );
}

function Legend({ namespaces }: { namespaces: string[] }) {
  return (
    <Box sx={{
      position: 'absolute', bottom: 12, left: 12,
      bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider',
      borderRadius: 1, p: 1, opacity: 0.92, minWidth: 130,
    }}>
      <Typography sx={{ fontSize: '0.6rem', fontFamily: 'monospace', fontWeight: 700, color: 'text.secondary', mb: 0.5 }}>
        LEGEND
      </Typography>
      {namespaces.map(ns => (
        <Box key={ns} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.3 }}>
          <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: nsColor(ns), flexShrink: 0 }} />
          <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>{ns}</Typography>
        </Box>
      ))}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.3 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#06b6d4', flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>service</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.3 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#ef4444', flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>external IP</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: '#f59e0b', border: '1px dashed #f59e0b', flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>unknown egress</Typography>
      </Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Box sx={{ width: 20, height: 2, bgcolor: '#94a3b8', flexShrink: 0 }} />
        <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>flow (thickness = count)</Typography>
      </Box>
    </Box>
  );
}

// ─── Node detail panel ────────────────────────────────────────────────────────

function NodeDetail({ node, edges, nodeMap, onClose }: {
  node: GraphNode; edges: GraphEdge[];
  nodeMap: Map<string, GraphNode>; onClose: () => void;
}) {
  const outgoing = edges.filter(e => e.source === node.id);
  const incoming = edges.filter(e => e.target === node.id);
  const color = nodeColor(node);

  return (
    <Box sx={{
      position: 'absolute', top: 12, right: 12, width: 250,
      bgcolor: 'background.paper', border: `1px solid ${color}`,
      borderRadius: 1.5, p: 1.5, boxShadow: 4,
    }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
        <Box>
          <Typography sx={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.8rem', color }}>
            {node.label}
          </Typography>
          {node.sublabel && (
            <Typography sx={{ fontFamily: 'monospace', fontSize: '0.65rem', color: 'text.secondary' }}>
              {node.sublabel}
            </Typography>
          )}
        </Box>
        <Chip label={node.kind.toUpperCase()} size="small"
          sx={{ fontSize: '0.6rem', height: 18, bgcolor: `${color}22`, color, border: `1px solid ${color}55`, fontWeight: 700 }}
        />
      </Box>

      {outgoing.length > 0 && (
        <>
          <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', fontWeight: 700, color: 'text.secondary', mt: 0.75 }}>
            OUTGOING ({outgoing.reduce((s, e) => s + e.count, 0)} flows)
          </Typography>
          {outgoing.map(e => {
            const dst = nodeMap.get(e.target);
            return (
              <Box key={e.target} sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.4 }}>
                <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: e.hasUnknown ? '#f59e0b' : e.hasExternal ? '#ef4444' : 'text.primary' }}>
                  → {dst?.label ?? e.target}
                </Typography>
                <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>
                  {e.count}×
                </Typography>
              </Box>
            );
          })}
        </>
      )}

      {incoming.length > 0 && (
        <>
          <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', fontWeight: 700, color: 'text.secondary', mt: 0.75 }}>
            INCOMING ({incoming.reduce((s, e) => s + e.count, 0)} flows)
          </Typography>
          {incoming.map(e => {
            const src = nodeMap.get(e.source);
            return (
              <Box key={e.source} sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.4 }}>
                <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.primary' }}>
                  ← {src?.label ?? e.source}
                </Typography>
                <Typography sx={{ fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary' }}>
                  {e.count}×
                </Typography>
              </Box>
            );
          })}
        </>
      )}

      <Chip label="× close" size="small" onClick={onClose}
        sx={{ mt: 1.5, cursor: 'pointer', fontSize: '0.6rem', height: 18 }}
      />
    </Box>
  );
}

interface TopologyMapProps {
  events: TrafficEvent[];
  nsFilter?: string;
}

export default function TopologyMap({ events, nsFilter }: TopologyMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 500 });
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const animRef = useRef<number>();
  const dragging = useRef<{ id: string; ox: number; oy: number } | null>(null);
  const nodesRef = useRef<GraphNode[]>([]);
  const edgesRef = useRef<GraphEdge[]>([]);

  useLayoutEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(entries => {
      const e = entries[0];
      setSize({ w: e.contentRect.width, h: e.contentRect.height });
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const { nodes: newNodes, edges: newEdges } = buildGraph(events, nsFilter);
    const existingById = new Map(nodesRef.current.map(n => [n.id, n]));
    const merged = newNodes.map(n => {
      const ex = existingById.get(n.id);
      return ex
        ? { ...n, x: ex.x, y: ex.y, vx: ex.vx, vy: ex.vy, pinned: ex.pinned }
        : { ...n, x: size.w / 2 + (Math.random() - 0.5) * 160, y: size.h / 2 + (Math.random() - 0.5) * 160 };
    });
    nodesRef.current = merged;
    edgesRef.current = newEdges;
    setNodes(merged);
    setEdges(newEdges);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, nsFilter]);

  useEffect(() => {
    let frame = 0;
    const loop = () => {
      for (let i = 0; i < ITER_PER_FRAME; i++) {
        runSimulationStep(nodesRef.current, edgesRef.current, size.w / 2, size.h / 2);
      }
      frame++;
      const pad = NODE_R + 35;
      for (const n of nodesRef.current) {
        n.x = Math.max(pad, Math.min(size.w - pad, n.x));
        n.y = Math.max(pad, Math.min(size.h - pad, n.y));
      }
      if (frame % 2 === 0) setTick(t => t + 1);
      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, [size]);

  useEffect(() => { setNodes([...nodesRef.current]); }, [tick]);

  const onPointerDown = useCallback((e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    const node = nodesRef.current.find(n => n.id === id);
    if (!node) return;
    node.pinned = true;
    dragging.current = { id, ox: e.clientX - node.x, oy: e.clientY - node.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const node = nodesRef.current.find(n => n.id === dragging.current!.id);
    if (!node) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    node.x = e.clientX - rect.left;
    node.y = e.clientY - rect.top;
    node.vx = 0; node.vy = 0;
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    const node = nodesRef.current.find(n => n.id === dragging.current!.id);
    if (node) node.pinned = false;
    dragging.current = null;
  }, []);

  const nodeMap = new Map(nodes.map(n => [n.id, n]));
  const namespaces = Array.from(new Set(
    nodes.filter(n => n.kind === 'pod').map(n => n.namespace).filter(Boolean) as string[]
  ));
  const selNode = selectedNode ? nodeMap.get(selectedNode) : null;

  if (events.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
          No traffic data yet — topology will appear as events stream in.
        </Typography>
      </Box>
    );
  }

  if (nodes.length === 0) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <Typography sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
          No connect/accept events in current filter — try removing namespace filter.
        </Typography>
      </Box>
    );
  }

  return (
    <Box ref={containerRef} sx={{ position: 'relative', width: '100%', height: '100%', overflow: 'hidden' }}
      onPointerMove={onPointerMove} onPointerUp={onPointerUp}
    >
      <svg width={size.w} height={size.h} style={{ display: 'block', userSelect: 'none' }}
        onClick={() => setSelectedNode(null)}
      >
        {edges.map(edge => (
          <EdgeEl key={`${edge.source}→${edge.target}`} edge={edge} nodes={nodeMap}
            selected={selectedNode === edge.source || selectedNode === edge.target}
          />
        ))}
        {nodes.map(node => (
          <NodeEl key={node.id} node={node} selected={selectedNode === node.id}
            onClick={() => setSelectedNode(prev => prev === node.id ? null : node.id)}
            onDragStart={e => onPointerDown(e, node.id)}
          />
        ))}
      </svg>

      <Legend namespaces={namespaces} />

      {selNode && (
        <NodeDetail node={selNode} edges={edges} nodeMap={nodeMap} onClose={() => setSelectedNode(null)} />
      )}

      <Typography sx={{ position: 'absolute', top: 10, right: 10, fontSize: '0.65rem', fontFamily: 'monospace', color: 'text.secondary', opacity: 0.5 }}>
        drag · click to inspect · thickness = flow count
      </Typography>
    </Box>
  );
}