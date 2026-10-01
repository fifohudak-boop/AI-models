from __future__ import annotations

import asyncio
from typing import Any


class EventBus:
    """Fans hunt events out to every open UI tab (each WebSocket gets its own queue)."""

    def __init__(self) -> None:
        self._clients: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    def emit(self, kind: str, data: Any) -> None:
        message = {"type": kind, "data": data}
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:  # a stalled tab shouldn't slow the hunt
                pass
