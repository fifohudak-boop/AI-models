"""Live updates for every open page (one WebSocket each). Events can name the model they're about,
so a page showing Mia doesn't show Mike's hunt."""

from __future__ import annotations

import asyncio
from typing import Any, Callable


class EventBus:
    def __init__(self) -> None:
        self._clients: set[asyncio.Queue] = set()

    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=2000)
        self._clients.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._clients.discard(queue)

    def emit(self, kind: str, data: Any, model: str | None = None) -> None:
        message = {"type": kind, "data": data, "model": model}
        for queue in list(self._clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:  # a stalled tab shouldn't slow anything down
                pass

    def for_model(self, model: str | None) -> Callable[[str, Any], None]:
        """An emit(kind, data) for code that doesn't know about models (the Reel Finder engine)."""
        return lambda kind, data: self.emit(kind, data, model)


bus = EventBus()
