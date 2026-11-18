/**
 * 分層流程圖（design D4）：依 dependsOn 拓樸分層，每層一欄，節點絕對定位，連線用一層 SVG 貝茲曲線。
 * 建立器預覽（compact）與工作流頁面共用。
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { layerWorkflow } from '../../../../../shared/multiAgent';
import type { WorkflowDef, WorkflowNode } from '../../types/types';

type Layout = {
  positions: Record<string, { x: number; y: number }>;
  width: number;
  height: number;
};

function computeLayout(def: WorkflowDef, size: { w: number; h: number; gapX: number; gapY: number; pad: number }): Layout | null {
  const layers = layerWorkflow(def);
  if (!layers) return null;
  const tallest = Math.max(...layers.map((layer) => layer.length));
  const columnHeight = tallest * size.h + (tallest - 1) * size.gapY;
  const positions: Layout['positions'] = {};
  layers.forEach((layer, col) => {
    const height = layer.length * size.h + (layer.length - 1) * size.gapY;
    const top = size.pad + (columnHeight - height) / 2;
    layer.forEach((id, row) => {
      positions[id] = { x: size.pad + col * (size.w + size.gapX), y: top + row * (size.h + size.gapY) };
    });
  });
  return {
    positions,
    width: size.pad * 2 + layers.length * size.w + (layers.length - 1) * size.gapX,
    height: size.pad * 2 + columnHeight,
  };
}

type WorkflowGraphProps = {
  def: WorkflowDef;
  nodeWidth: number;
  nodeHeight: number;
  gapX?: number;
  gapY?: number;
  padding?: number;
  renderNode: (node: WorkflowNode) => ReactNode;
  /** 連線是否以動畫顯示（上游執行中） */
  activeEdge?: (from: string, to: string) => boolean;
  /** 可拖曳平移 */
  pannable?: boolean;
  className?: string;
};

export default function WorkflowGraph({
  def,
  nodeWidth,
  nodeHeight,
  gapX = 72,
  gapY = 28,
  padding = 24,
  renderNode,
  activeEdge,
  pannable = false,
  className,
}: WorkflowGraphProps) {
  const layout = useMemo(
    () => computeLayout(def, { w: nodeWidth, h: nodeHeight, gapX, gapY, pad: padding }),
    [def, nodeWidth, nodeHeight, gapX, gapY, padding],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // 圖比容器小時置中
  const [center, setCenter] = useState({ x: 0, y: 0 });
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || !layout) return undefined;
    const update = () => setCenter({
      x: Math.max(0, (el.clientWidth - layout.width) / 2),
      y: Math.max(0, (el.clientHeight - layout.height) / 2),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout]);

  if (!layout) return null;

  const edges = def.nodes.flatMap((node) => node.dependsOn.map((dep) => ({ from: dep, to: node.id })));

  return (
    <div
      ref={containerRef}
      className={`relative overflow-auto ${pannable ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''} ${className ?? ''}`}
      onPointerDown={pannable ? (event) => {
        if ((event.target as HTMLElement).closest('[data-graph-node]')) return;
        const el = containerRef.current!;
        drag.current = { x: event.clientX, y: event.clientY, left: el.scrollLeft, top: el.scrollTop };
        setDragging(true);
        el.setPointerCapture(event.pointerId);
      } : undefined}
      onPointerMove={pannable ? (event) => {
        if (!drag.current) return;
        const el = containerRef.current!;
        el.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
        el.scrollTop = drag.current.top - (event.clientY - drag.current.y);
      } : undefined}
      onPointerUp={pannable ? () => { drag.current = null; setDragging(false); } : undefined}
    >
      <div className="relative" style={{ width: layout.width, height: layout.height, marginLeft: center.x, marginTop: center.y }}>
        <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden>
          {edges.map(({ from, to }) => {
            const a = layout.positions[from];
            const b = layout.positions[to];
            const x1 = a.x + nodeWidth;
            const y1 = a.y + nodeHeight / 2;
            const x2 = b.x;
            const y2 = b.y + nodeHeight / 2;
            const mid = (x1 + x2) / 2;
            const active = activeEdge?.(from, to) ?? false;
            return (
              <path
                key={`${from}-${to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                fill="none"
                strokeWidth={1.5}
                strokeDasharray={active ? '5 4' : undefined}
                className={active ? 'animate-edge-flow stroke-primary/70' : 'stroke-border'}
              />
            );
          })}
        </svg>
        {def.nodes.map((node) => {
          const pos = layout.positions[node.id];
          return (
            <div
              key={node.id}
              data-graph-node
              className="absolute"
              style={{ left: pos.x, top: pos.y, width: nodeWidth, height: nodeHeight }}
            >
              {renderNode(node)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
