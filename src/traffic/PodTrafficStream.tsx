/**
 * PodTrafficStream
 *
 * A minimal per-pod streaming component that mirrors GenericGadgetRenderer
 * but bypasses processGadgetData so we get the RAW payload in onData,
 * not a stringified/React-node-ified version.
 *
 * GenericGadgetRenderer -> processGadgetData -> processDataColumn turns
 * src/dst objects into useless strings via JSON.stringify().replace(/['"]+/g,'').
 * We need the raw nested objects to extract addr, port, k8s fields.
 */

import { useEffect, useRef } from 'react';
import usePortForward from '../gadgets/igSocket';

interface PodTrafficStreamProps {
  podName: string;           // the IG gadget pod name (not workload pod)
  nodeName: string;
  imageName: string;
  gadgetRunningStatus: boolean;
  podsSelected: any[];
  podStreamsConnected: number;
  setPodStreamsConnected: React.Dispatch<React.SetStateAction<number>>;
  onData: (raw: any) => void;
}

export default function PodTrafficStream({
  podName,
  nodeName,
  imageName,
  gadgetRunningStatus,
  podsSelected,
  podStreamsConnected,
  setPodStreamsConnected,
  onData,
}: PodTrafficStreamProps) {
  // Each stream component opens its OWN port-forward to its specific pod —
  // exactly as GenericGadgetRenderer does on line 39-41.
  const { ig, isConnected } = usePortForward(
    `api/v1/namespaces/gadget/pods/${podName}/portforward?ports=8080`
  );

  const gadgetRef = useRef<any>(null);
  const gadgetRunningStatusRef = useRef(gadgetRunningStatus);
  const mountedRef = useRef(true);
  const onDataRef = useRef(onData);
  onDataRef.current = onData; // always up to date without re-triggering effects

  // Track connection — mirrors GenericGadgetRenderer lines 106-110
  useEffect(() => {
    if (isConnected) {
      setPodStreamsConnected(prev =>
        podsSelected.length < prev + 1 ? prev : prev + 1
      );
    }
  }, [isConnected, podsSelected.length, setPodStreamsConnected]);

  // Start/stop — mirrors GenericGadgetRenderer lines 116-138
  useEffect(() => {
    gadgetRunningStatusRef.current = gadgetRunningStatus;

    if (!gadgetRunningStatus) {
      gadgetRef.current?.stop?.();
      gadgetRef.current = null;
      return;
    }

    // Only run when ALL pod streams are connected (same gate as GenericGadgetRenderer)
    if (gadgetRunningStatus && podsSelected.length === podStreamsConnected) {
      if (!ig) return;

      gadgetRef.current = ig.runGadget(
        {
          version: 1,
          imageName,
          // IG hides enriched fields (flags & 4) by default.
          // These params opt-in to src/dst address and k8s identity fields.
          // Operator key format from IG source: operator.fields.<fullName>
          paramValues: {
          'operator.fields.src.addr': 'true',
          'operator.fields.dst.addr': 'true',
          'operator.fields.src.port': 'true',
          'operator.fields.dst.port': 'true',

          'operator.fields.src.k8s.name': 'true',
          'operator.fields.src.k8s.namespace': 'true',
          'operator.fields.dst.k8s.name': 'true',
          'operator.fields.dst.k8s.namespace': 'true',

          'operator.fields.src.pod': 'true',
          'operator.fields.dst.pod': 'true',

          'operator.fields.src.container': 'true',
          'operator.fields.dst.container': 'true',
        },
        },
        {
          onReady: () => {
            if (!gadgetRunningStatusRef.current) {
              gadgetRef.current?.stop?.();
            }
          },
          onDone: () => {},
          onError: (err: Error) => {
            console.error(`[PodTrafficStream:${podName}] onError:`, err);
          },
          onGadgetInfo: () => {},
          // RAW payload — no processGadgetData in the way
          onData: (_dsID: string, payload: unknown) => {
            if (!mountedRef.current) return;
            const items = Array.isArray(payload) ? payload : [payload];
            console.log('items ', items)
            items.forEach(raw => onDataRef.current(raw));
          },
        },
        (setupErr: Error) => {
          console.error(`[PodTrafficStream:${podName}] setup error:`, setupErr);
        }
      );
    }
  }, [gadgetRunningStatus, podStreamsConnected, podsSelected.length, ig, imageName, podName]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      gadgetRef.current?.stop?.();
    };
  }, []);

  return null;
}