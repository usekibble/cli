import { TextDecoder } from "node:util";
import { normalizeCursorCallId } from "./cursor-call-id.js";

export interface CursorMcpCall {
  id: string;
  name: string;
  completedAtMs: number;
  /** Local immutable step identity, used to deduplicate inherited history. */
  recordId?: string;
}

/** Local-only selections. Paths must be mapped to inventory names, never uploaded. */
export interface CursorAgentMetadata {
  conversationId: string;
  messageId: string;
  requestId?: string;
  startedAtMs?: number;
  completedAtMs?: number;
  commands: string[];
  skillPaths: string[];
  mcpCalls?: CursorMcpCall[];
}

const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_BLOBS = 10_000;
const MAX_FIELDS = 200_000;
const MAX_DEPTH = 8;
const decoder = new TextDecoder("utf-8", { fatal: true });
const failure = () => new Error("Could not read complete Cursor selection metadata; collection stopped.");

type Field = { number: number; wire: number; bytes?: Buffer; integer?: bigint };

/**
 * Projects installed Cursor 3.19.13 protobuf metadata without decoding content.
 * read must return binary payloads (decode legacy hex storage before calling).
 * states are decoded composerData.conversationState protobuf buffers.
 * Missing referenced blobs abort collection.
 * Callback errors are sanitized because database errors can contain content.
 */
export function readCursorAgentMetadata(
  states: readonly { conversationId: string; state: Buffer }[],
  read: (key: string) => Buffer | null,
): CursorAgentMetadata[] {
  let totalBytes = 0, fieldCount = 0, blobCount = 0;
  const loaded = new Map<string, Buffer>();
  const results = new Map<string, CursorAgentMetadata>();
  const observedCalls = new Map<string, CursorMcpCall>();

  function load(key: string): Buffer {
    if (loaded.has(key)) return loaded.get(key)!;
    if (++blobCount > MAX_BLOBS) throw failure();
    const bytes = read(key);
    if (bytes !== null) {
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BLOB_BYTES) throw failure();
      totalBytes += bytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw failure();
    } else throw failure();
    loaded.set(key, bytes);
    return bytes;
  }

  function pointer(bytes: Buffer): string {
    if (bytes.length !== 32) throw failure();
    const hex = bytes.toString("hex");
    if (!/^[0-9a-f]{64}$/.test(hex)) throw failure();
    return `agentKv:blob:${hex}`;
  }

  function fields(bytes: Buffer, depth: number): Field[] {
    if (depth > MAX_DEPTH || bytes.length > MAX_BLOB_BYTES) throw failure();
    let position = 0;
    const result: Field[] = [];
    function varint(): bigint {
      let value = 0n;
      for (let count = 0; count < 10; count++) {
        const byte = bytes[position++];
        if (byte === undefined || (count === 9 && byte > 1)) throw failure();
        value |= BigInt(byte & 127) << BigInt(count * 7);
        if (!(byte & 128)) return value;
      }
      throw failure();
    }
    while (position < bytes.length) {
      if (++fieldCount > MAX_FIELDS) throw failure();
      const tag = varint();
      if (tag > 0xffffffffn) throw failure();
      const number = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!number) throw failure();
      if (wire === 0) result.push({ number, wire, integer: varint() });
      else if (wire === 2) {
        const length = varint();
        if (length > BigInt(bytes.length - position)) throw failure();
        const end = position + Number(length);
        result.push({ number, wire, bytes: bytes.subarray(position, end) });
        position = end;
      } else if (wire === 1 || wire === 5) {
        position += wire === 1 ? 8 : 4;
        if (position > bytes.length) throw failure();
        result.push({ number, wire });
      } else throw failure();
    }
    return result;
  }

  function many(list: Field[], number: number, wire = 2): Field[] {
    const found = list.filter(field => field.number === number);
    if (found.some(field => field.wire !== wire)) throw failure();
    return found;
  }
  function one(list: Field[], number: number, wire = 2): Field | undefined {
    const found = many(list, number, wire);
    if (found.length > 1) throw failure();
    return found[0];
  }
  function string(field: Field | undefined, max: number): string | undefined {
    if (!field) return undefined;
    if (!field.bytes || field.bytes.length > max) throw failure();
    const value = decoder.decode(field.bytes);
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw failure();
    return value;
  }
  function timestamp(list: Field[], number: number): number | undefined {
    const value = one(list, number, 0)?.integer;
    if (value === undefined) return undefined;
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw failure();
    return Number(value);
  }
  function callId(field: Field | undefined): string | undefined {
    if (!field) return undefined;
    if (!field.bytes || field.bytes.length > 1031) throw failure();
    const raw = decoder.decode(field.bytes);
    if (!raw) return undefined;
    const id = normalizeCursorCallId(raw);
    if (!id) throw failure();
    return id;
  }
  function mcpCalls(agent: Field[], conversationId: string): CursorMcpCall[] {
    const calls = new Map<string, CursorMcpCall>();
    for (const stepPointer of many(agent, 2)) {
      const stepKey = pointer(stepPointer.bytes!);
      const step = fields(load(stepKey), 3);
      const toolField = one(step, 2);
      if (!toolField) continue;
      if (one(step, 1) || one(step, 3)) throw failure();
      const tool = fields(toolField.bytes!, 4);
      const mcpField = one(tool, 15);
      if (!mcpField) continue;
      const mcp = fields(mcpField.bytes!, 5);
      const argsField = one(mcp, 1);
      if (!argsField || !one(mcp, 2)) continue;
      const completedAtMs = timestamp(tool, 60);
      if (completedAtMs === undefined || completedAtMs <= 0) continue;
      const args = fields(argsField.bytes!, 6);
      const outerId = callId(one(tool, 57)), innerId = callId(one(args, 3));
      if (outerId && innerId && outerId !== innerId) throw failure();
      const id = outerId ?? innerId;
      // provider_identifier is Cursor's server display name. server_identifier
      // can contain a scoped/opaque identity and is deliberately not decoded.
      const nameField = one(args, 4);
      if (!nameField?.bytes?.length) continue;
      const name = string(nameField, 128);
      if (!id || !name || /[/\\]/.test(name)) continue;
      const row = { id, name, completedAtMs };
      const key = JSON.stringify([conversationId, id]);
      const prior = observedCalls.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw failure();
      observedCalls.set(key, row);
      calls.set(id, { ...row, recordId: stepKey.slice("agentKv:blob:".length) });
    }
    return [...calls.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  try {
    if (states.length > MAX_BLOBS) throw failure();
    const uniqueStates = new Map<string, { bytes: Buffer; fields: Field[] }>();
    const children = new Set<string>();
    const depths = new Map<string, number>();
    const edges = new Map<string, Set<string>>();
    function register(conversationId: string, stateBytes: Buffer, depth: number): void {
      if (depth > MAX_DEPTH) throw failure();
      if (!Buffer.isBuffer(stateBytes)) throw failure();
      const prior = uniqueStates.get(conversationId);
      if (prior) {
        if (!prior.bytes.equals(stateBytes)) throw failure();
        return;
      }
      if (uniqueStates.size >= MAX_BLOBS) throw failure();
      totalBytes += stateBytes.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw failure();
      const state = fields(stateBytes, 0);
      uniqueStates.set(conversationId, { bytes: stateBytes, fields: state });
      depths.set(conversationId, depth);
    }
    for (const { conversationId, state: stateBytes } of states) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(conversationId)) throw failure();
      register(conversationId, stateBytes, 0);
    }
    // Map iteration also visits newly registered embedded children. All paths
    // share the same byte, field and blob budgets as the supplied conversations.
    for (const [conversationId, { fields: state }] of uniqueStates) {
      // Both maps use child composer IDs. Values may contain only lifecycle
      // metadata, while the child's conversation lives in its own supplied row.
      // Do not interpret inherited child context as another human selection.
      const inline = new Set<string>();
      const childIds = new Set<string>();
      edges.set(conversationId, childIds);
      for (const number of [16, 31]) {
        const mapKeys = new Set<string>();
        for (const childField of many(state, number)) {
          const entry = fields(childField.bytes!, 1);
          const childId = string(one(entry, 1), 1024);
          const value = one(entry, 2);
          if (!childId || !value || mapKeys.has(childId)) throw failure();
          mapKeys.add(childId);
          children.add(childId);
          childIds.add(childId);
          // Cursor's inline state takes precedence over a reference for the
          // same child. A standalone state must agree with any embedded state.
          if (number === 31 && inline.has(childId)) continue;
          if (number === 16) inline.add(childId);
          const persisted = fields(number === 16 ? value.bytes! : load(pointer(value.bytes!)), 2);
          const nested = one(persisted, 1);
          if (nested) register(childId, nested.bytes!, depths.get(conversationId)! + 1);
        }
      }
    }
    const heights = new Map<string, number>(), visiting = new Set<string>();
    function checkGraph(id: string, depth: number): number {
      if (visiting.has(id) || depth > MAX_DEPTH) throw failure();
      const known = heights.get(id);
      if (known !== undefined) {
        if (depth + known > MAX_DEPTH) throw failure();
        return known;
      }
      visiting.add(id);
      let height = 0;
      for (const child of edges.get(id) ?? []) height = Math.max(height, 1 + checkGraph(child, depth + 1));
      visiting.delete(id);
      heights.set(id, height);
      return height;
    }
    for (const id of uniqueStates.keys()) checkGraph(id, 0);
    for (const [conversationId, { fields: state }] of uniqueStates) {
      const visitedTurns = new Set<string>();
      for (const turnPointer of many(state, 8)) {
        const turnKey = pointer(turnPointer.bytes!);
        if (visitedTurns.has(turnKey)) continue;
        visitedTurns.add(turnKey);
        const turn = fields(load(turnKey)!, 1);
        const agentField = one(turn, 1);
        const shellField = one(turn, 2);
        if (agentField && shellField) throw failure();
        if (!agentField) continue;
        const agent = fields(agentField.bytes!, 2);
        const userPointer = one(agent, 1);
        if (!userPointer) throw failure();
        const user = fields(load(pointer(userPointer.bytes!))!, 3);
        const messageId = string(one(user, 2), 1024);
        if (!messageId) throw failure();
        const row: CursorAgentMetadata = {
          conversationId, messageId,
          requestId: string(one(agent, 3), 1024),
          startedAtMs: timestamp(user, 25), completedAtMs: timestamp(user, 26),
          commands: [], skillPaths: [],
        };
        const calls = mcpCalls(agent, conversationId);
        if (calls.length) row.mcpCalls = calls;
        // Simulated followups are not explicit user selections.
        const simulated = one(user, 5, 0)?.integer;
        if (simulated !== undefined && simulated > 1n) throw failure();
        if (simulated === 1n && !calls.length) continue;
        const contextField = simulated === 1n || children.has(conversationId) ? undefined : one(user, 3);
        if (contextField) {
          const context = fields(contextField.bytes!, 4);
          for (const commandField of many(context, 12)) {
            const command = fields(commandField.bytes!, 5);
            const name = string(one(command, 1), 256);
            if (!name) throw failure();
            row.commands.push(name);
          }
          for (const selectedRule of many(context, 10)) {
            const selection = fields(selectedRule.bytes!, 5);
            const ruleField = one(selection, 1);
            if (!ruleField) throw failure();
            const rule = fields(ruleField.bytes!, 6);
            const typeField = one(rule, 3);
            if (!typeField) continue;
            const type = fields(typeField.bytes!, 7);
            const manual = one(type, 4);
            if (!manual) continue;
            if ([1, 2, 3].some(number => one(type, number))) throw failure();
            fields(manual.bytes!, 8);
            const path = string(one(rule, 1), 4096);
            if (path && /(?:^|[/\\])SKILL\.md$/.test(path)) row.skillPaths.push(path);
          }
        }
        row.commands = [...new Set(row.commands)].sort();
        row.skillPaths = [...new Set(row.skillPaths)].sort();
        const key = JSON.stringify([conversationId, messageId]);
        const previous = results.get(key);
        if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw failure();
        results.set(key, row);
      }
    }
    return [...results.values()];
  } catch { throw failure(); }
}
