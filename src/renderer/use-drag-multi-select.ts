import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

const CARD_ATTRIBUTE = "data-drag-select-id";
const DRAG_THRESHOLD_PX = 6;
const SAMPLE_DISTANCE_PX = 12;

type DragSession = {
  pointerId: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startId: string;
  selecting: boolean;
  dragging: boolean;
  touched: Set<string>;
};

type DragMultiSelectOptions = {
  enabled?: boolean;
  isSelected: (id: string) => boolean;
  setSelected: (id: string, selected: boolean) => void;
};

export function withSelectionState(current: Set<string>, id: string, selected: boolean): Set<string> {
  if (current.has(id) === selected) return current;
  const next = new Set(current);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}

function selectableCardAtPoint(container: HTMLElement, clientX: number, clientY: number): HTMLElement | null {
  const element = document.elementFromPoint(clientX, clientY);
  const card = element instanceof Element ? element.closest<HTMLElement>(`[${CARD_ATTRIBUTE}]`) : null;
  return card && container.contains(card) ? card : null;
}

function nearestScrollContainer(container: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = container;
  while (current) {
    const overflowY = getComputedStyle(current).overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && current.scrollHeight > current.clientHeight) return current;
    current = current.parentElement;
  }
  return null;
}

function nudgeScroll(container: HTMLElement, clientY: number) {
  const scrollContainer = nearestScrollContainer(container);
  if (!scrollContainer) return;
  const rect = scrollContainer.getBoundingClientRect();
  const edge = Math.min(48, rect.height / 5);
  if (clientY < rect.top + edge) scrollContainer.scrollBy({ top: -Math.max(8, rect.top + edge - clientY), behavior: "auto" });
  if (clientY > rect.bottom - edge) scrollContainer.scrollBy({ top: Math.max(8, clientY - (rect.bottom - edge)), behavior: "auto" });
}

export function useDragMultiSelect({ enabled = true, isSelected, setSelected }: DragMultiSelectOptions) {
  const sessionRef = useRef<DragSession | null>(null);
  const suppressClickRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);

  const applyCard = useCallback((card: HTMLElement | null, session: DragSession) => {
    const id = card?.dataset.dragSelectId;
    if (!id || session.touched.has(id)) return;
    session.touched.add(id);
    setSelected(id, session.selecting);
  }, [setSelected]);

  const applySegment = useCallback((container: HTMLElement, session: DragSession, clientX: number, clientY: number) => {
    const distance = Math.hypot(clientX - session.lastX, clientY - session.lastY);
    const steps = Math.max(1, Math.ceil(distance / SAMPLE_DISTANCE_PX));
    for (let index = 1; index <= steps; index += 1) {
      const progress = index / steps;
      const x = session.lastX + (clientX - session.lastX) * progress;
      const y = session.lastY + (clientY - session.lastY) * progress;
      applyCard(selectableCardAtPoint(container, x, y), session);
    }
    session.lastX = clientX;
    session.lastY = clientY;
  }, [applyCard]);

  const resetSession = useCallback(() => {
    sessionRef.current = null;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    if (enabled) return;
    resetSession();
  }, [enabled, resetSession]);

  useEffect(() => {
    const cancel = () => resetSession();
    window.addEventListener("blur", cancel);
    return () => window.removeEventListener("blur", cancel);
  }, [resetSession]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!enabled || event.button !== 0 || event.pointerType !== "mouse") return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target || target.closest("button, a, input, select, textarea, [contenteditable='true']")) return;
    const card = target.closest<HTMLElement>(`[${CARD_ATTRIBUTE}]`);
    const startId = card?.dataset.dragSelectId;
    if (!card || !startId || !event.currentTarget.contains(card)) return;
    suppressClickRef.current = false;
    sessionRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      startId,
      selecting: !isSelected(startId),
      dragging: false,
      touched: new Set(),
    };
  }, [enabled, isSelected]);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (!session.dragging) {
      if (Math.hypot(event.clientX - session.startX, event.clientY - session.startY) < DRAG_THRESHOLD_PX) return;
      session.dragging = true;
      setIsDragging(true);
      event.currentTarget.setPointerCapture(event.pointerId);
      const startCard = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${CARD_ATTRIBUTE}]`)]
        .find((card) => card.dataset.dragSelectId === session.startId) ?? null;
      applyCard(startCard, session);
    }
    event.preventDefault();
    nudgeScroll(event.currentTarget, event.clientY);
    applySegment(event.currentTarget, session, event.clientX, event.clientY);
  }, [applyCard, applySegment]);

  const finishPointer = useCallback((event: ReactPointerEvent<HTMLElement>, cancelled: boolean) => {
    const session = sessionRef.current;
    if (!session || session.pointerId !== event.pointerId) return;
    if (session.dragging && !cancelled) {
      applySegment(event.currentTarget, session, event.clientX, event.clientY);
      suppressClickRef.current = true;
      window.setTimeout(() => { suppressClickRef.current = false; }, 0);
      event.preventDefault();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    resetSession();
  }, [applySegment, resetSession]);

  const consumeSuppressedClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    isDragging,
    consumeSuppressedClick,
    dragProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, false),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finishPointer(event, true),
      onDragStart: (event: ReactDragEvent<HTMLElement>) => event.preventDefault(),
    },
  };
}
