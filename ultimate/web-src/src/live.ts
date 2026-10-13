// Live updates from the app (hunt progress, references being analysed, AI Studio jobs…), over one
// WebSocket. Pages subscribe with useLive(); events say which model they're about.
import { useEffect, useRef } from 'react';
import type { ServerEvent } from './types';

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let model = '';
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function open() {
  clearTimeout(retryTimer);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?model=${encodeURIComponent(model)}`);
  socket = ws;
  ws.onmessage = (msg) => {
    let event: ServerEvent;
    try {
      event = JSON.parse(msg.data);
    } catch {
      return;
    }
    for (const fn of [...listeners]) fn(event);
  };
  ws.onopen = () => {
    for (const fn of [...listeners]) fn({ type: 'connected', model, data: null });
  };
  ws.onclose = () => {
    if (socket === ws) retryTimer = setTimeout(open, 1500);
  };
}

// (Re)connect for this model: the server first sends what's going on for it (a running hunt).
export function connectLive(modelId: string) {
  if (socket && model === modelId && socket.readyState <= WebSocket.OPEN) return;
  model = modelId;
  const old = socket;
  socket = null;
  old?.close();
  open();
}

export function useLive(handler: Listener) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn: Listener = (event) => ref.current(event);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);
}
