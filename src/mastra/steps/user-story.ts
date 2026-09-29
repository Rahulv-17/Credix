/**
 * Step: user-story
 *
 * Replaces: src/credit_credix/graph/nodes/user_story.py
 *
 * TODO:
 * - LLM call to build a 2-3 sentence narrative about the user
 * - Inputs: intent, entities, bureau summary (CIBIL score, DPD, enquiry count),
 *           user_memory (past goals, constraints — from memory store)
 * - Output: { user_story: string }
 * - user_story is injected into every specialist agent's system prompt
 *   so the specialist knows WHO they're talking to without re-reading the full profile
 * - Keep it factual and brief — the specialist does the deep reasoning
 */
