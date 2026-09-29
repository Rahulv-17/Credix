"""Compile the Credix graph and expose it as ``graph`` for the LangGraph CLI.

PHASE 2 — placeholder. This is a single pass-through node so ``langgraph dev``
and ``langgraph.json`` validate today. The real Turn-1 graph (nodes/, router,
checkpointer, specialist subgraphs) replaces ``_build`` in Phase 2.
"""

from typing import TypedDict

from langgraph.graph import END, START, StateGraph


class _PlaceholderState(TypedDict, total=False):
    input: str
    output: str


def _passthrough(state: _PlaceholderState) -> dict:
    return {"output": state.get("input", "")}


def _build():
    g = StateGraph(_PlaceholderState)
    g.add_node("passthrough", _passthrough)
    g.add_edge(START, "passthrough")
    g.add_edge("passthrough", END)
    return g.compile()


graph = _build()
