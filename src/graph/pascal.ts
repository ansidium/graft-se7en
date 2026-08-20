/**
 * Delphi/Pascal extraction on top of Isopod/tree-sitter-pascal.
 *
 * Pascal needs more than the generic tags.scm path: a unit declares routines in
 * `interface` and implements them again under qualified names, identifiers are
 * case-insensitive, and parameterless calls have no dedicated call node. This
 * adapter keeps those language rules isolated while sharing the breadth tier's
 * preloaded web-tree-sitter runtime.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contentHash } from "../util/id.js";
import type { ExtractResult, RawEdge } from "./extract.js";
import type { TsNode } from "./generic.js";
import type { Kind, NodeV1 } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WASM_PATH = join(HERE, "..", "..", "scripts", "grammars", "tree-sitter-pascal.wasm");

/** Read the vendored grammar from the repository/package. */
export function readPascalWasm(): Buffer | null {
  try {
    return readFileSync(WASM_PATH);
  } catch {
    return null;
  }
}

interface TypeDef {
  node: TsNode;
  typeNode: TsNode;
  name: string;
  kind: Extract<Kind, "class" | "struct" | "interface">;
  id?: string;
  parents: string[];
}

interface RoutineDef {
  whole: TsNode;
  header: TsNode;
  name: string;
  owner: string | null;
  keyword: "procedure" | "function" | "constructor" | "destructor";
  kind: "function" | "method";
  arity: number;
  variadic: boolean;
  key: string;
  parentStart: number | null;
  implementation: boolean;
  exported: boolean;
  id?: string;
}

function children(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < (node.namedChildCount ?? 0); i++) {
    const child = node.namedChild?.(i);
    if (child) out.push(child);
  }
  return out;
}

function visit(node: TsNode, fn: (node: TsNode) => void): void {
  fn(node);
  for (const child of children(node)) visit(child, fn);
}

function descendants(node: TsNode, type: string): TsNode[] {
  const out: TsNode[] = [];
  visit(node, (candidate) => {
    if (candidate.type === type) out.push(candidate);
  });
  return out;
}

function field(node: TsNode, name: string): TsNode | null {
  return node.childForFieldName?.(name) ?? null;
}

function ancestor(node: TsNode | null, type: string): TsNode | null {
  for (let current = node?.parent ?? null; current; current = current.parent) {
    if (current.type === type) return current;
  }
  return null;
}

function directAncestor(node: TsNode, type: string): TsNode | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type === type) return current;
  }
  return null;
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/;\s*$/, "").trim();
}

function searchBody(text: string, max = 5000): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function normalizedName(name: string): string {
  return name.toLocaleLowerCase("en-US");
}

/** Identifier path without generic arguments: `TBox<T>.Add<U>` → TBox, Add. */
function entityParts(node: TsNode | null): string[] {
  if (!node) return [];
  if (node.type === "identifier") return [node.text];
  if (node.type === "genericDot" || node.type === "exprDot") {
    return [...entityParts(field(node, "lhs")), ...entityParts(field(node, "rhs"))];
  }
  if (node.type === "genericTpl" || node.type === "exprTpl") {
    return entityParts(field(node, "entity") ?? children(node)[0] ?? null);
  }
  if (node.type === "moduleName") {
    return children(node).filter((child) => child.type === "identifier").map((child) => child.text);
  }
  const named = field(node, "name") ?? field(node, "entity");
  if (named) return entityParts(named);
  const ids: string[] = [];
  visit(node, (child) => {
    if (child.type === "identifier") ids.push(child.text);
  });
  return ids;
}

function typeName(node: TsNode | null): string | null {
  if (!node) return null;
  const ref = descendants(node, "typeref")[0] ?? node;
  const parts = entityParts(ref);
  return parts.length ? parts.join(".") : null;
}

function moduleInfo(root: TsNode, source: string): { name: string; whole: TsNode | null; signature: string } | null {
  const module = children(root).find((child) => ["unit", "program", "library"].includes(child.type));
  if (module) {
    const nameNode = children(module).find((child) => child.type === "moduleName") ?? null;
    const name = entityParts(nameNode).join(".");
    if (name) return { name, whole: module, signature: clean(source.slice(module.startIndex, source.indexOf(";", module.startIndex) + 1)) };
  }
  // The upstream grammar does not currently model Delphi package projects.
  const match = /^\s*package\s+([\p{L}_][\p{L}\p{N}_.]*)\s*;/iu.exec(source);
  return match ? { name: match[1], whole: null, signature: clean(match[0]) } : null;
}

function classifyType(node: TsNode): TypeDef["kind"] | null {
  if (node.type === "declIntf") return "interface";
  const directTypes = new Set(children(node).map((child) => child.type));
  if (directTypes.has("kRecord")) return "struct";
  if (directTypes.has("kInterface") || directTypes.has("kDispInterface")) return "interface";
  if (directTypes.has("kClass") || directTypes.has("kObjcclass")) return "class";
  return null;
}

function collectTypes(root: TsNode): TypeDef[] {
  const out: TypeDef[] = [];
  for (const decl of descendants(root, "declType")) {
    const nameNode = field(decl, "name");
    const name = entityParts(nameNode).join(".");
    const value = field(decl, "type");
    if (!name || !value) continue;
    const kind = classifyType(value);
    if (!kind) continue;
    const parents = children(value)
      .filter((child) => child.type === "typeref")
      .map((child) => typeName(child))
      .filter((parent): parent is string => !!parent);
    out.push({ node: decl, typeNode: value, name, kind, parents });
  }
  return out;
}

function owningType(node: TsNode, byStart: ReadonlyMap<number, TypeDef>): TypeDef | null {
  const decl = directAncestor(node, "declType");
  return decl ? byStart.get(decl.startIndex) ?? null : null;
}

function routineKeyword(header: TsNode): RoutineDef["keyword"] | null {
  const types = new Set(children(header).map((child) => child.type));
  if (types.has("kConstructor")) return "constructor";
  if (types.has("kDestructor")) return "destructor";
  if (types.has("kFunction")) return "function";
  if (types.has("kProcedure")) return "procedure";
  return null;
}

function parameterTypes(header: TsNode): string[] {
  const args = field(header, "args");
  if (!args) return [];
  const result: string[] = [];
  for (const arg of descendants(args, "declArg")) {
    const type = typeName(field(arg, "type")) ?? "?";
    const typeNode = field(arg, "type");
    const names = children(arg).filter(
      (child) => child.type === "identifier" && (!typeNode || child.endIndex <= typeNode.startIndex),
    );
    for (let i = 0; i < Math.max(1, names.length); i++) result.push(normalizedName(type));
  }
  return result;
}

function nearestParentDef(node: TsNode, excludeDirectHeader = false): TsNode | null {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "defProc") continue;
    if (excludeDirectHeader && field(current, "header")?.startIndex === node.startIndex) continue;
    return current;
  }
  return null;
}

function declarationExported(header: TsNode, owner: TypeDef | null): boolean {
  if (owner?.kind === "interface") return true;
  const section = directAncestor(header, "declSection");
  if (section) return !/^\s*(?:private|protected|strict\s+private|strict\s+protected)\b/i.test(section.text);
  if (owner) return true;
  return ancestor(header, "interface") !== null;
}

function routineFrom(
  whole: TsNode,
  header: TsNode,
  implementation: boolean,
  typeByStart: ReadonlyMap<number, TypeDef>,
): RoutineDef | null {
  const nameNode = field(header, "name");
  const parts = entityParts(nameNode);
  const keyword = routineKeyword(header);
  if (!keyword || parts.length === 0) return null;
  const typeOwner = owningType(header, typeByStart);
  const owner = parts.length > 1 ? parts.slice(0, -1).join(".") : typeOwner?.name ?? null;
  const name = parts.at(-1)!;
  const parent = nearestParentDef(whole);
  const params = parameterTypes(header);
  const keyScope = owner ? normalizedName(owner) : parent ? `@${parent.startIndex}` : "";
  const key = [keyScope, keyword, normalizedName(name), params.join(",")].join("|");
  return {
    whole,
    header,
    name,
    owner,
    keyword,
    kind: owner || keyword === "constructor" || keyword === "destructor" ? "method" : "function",
    arity: params.length,
    variadic: /\bvarargs\b/i.test(header.text),
    key,
    parentStart: parent?.startIndex ?? null,
    implementation,
    exported: implementation ? false : declarationExported(header, typeOwner),
  };
}

function collectRoutines(root: TsNode, types: TypeDef[]): RoutineDef[] {
  const typeByStart = new Map(types.map((type) => [type.node.startIndex, type]));
  const implementations: RoutineDef[] = [];
  for (const def of descendants(root, "defProc")) {
    const header = field(def, "header") ?? children(def).find((child) => child.type === "declProc") ?? null;
    if (!header) continue;
    const routine = routineFrom(def, header, true, typeByStart);
    if (routine) implementations.push(routine);
  }

  const declarations: RoutineDef[] = [];
  for (const header of descendants(root, "declProc")) {
    if (header.parent?.type === "defProc" && field(header.parent, "header")?.startIndex === header.startIndex) continue;
    const routine = routineFrom(header, header, false, typeByStart);
    if (routine) declarations.push(routine);
  }

  const declarationByKey = new Map<string, RoutineDef>();
  for (const declaration of declarations) {
    const prior = declarationByKey.get(declaration.key);
    if (!prior || (!prior.exported && declaration.exported)) declarationByKey.set(declaration.key, declaration);
  }
  for (const implementation of implementations) {
    implementation.exported = declarationByKey.get(implementation.key)?.exported ?? false;
  }
  const implemented = new Set(implementations.map((routine) => routine.key));
  return [
    ...implementations,
    ...[...declarationByKey.values()].filter((declaration) => !implemented.has(declaration.key)),
  ].sort((a, b) => a.whole.startIndex - b.whole.startIndex || Number(b.implementation) - Number(a.implementation));
}

function mint(base: string, minted: Set<string>): string {
  let id = base;
  let suffix = 2;
  while (minted.has(id)) id = `${base}~${suffix++}`;
  minted.add(id);
  return id;
}

function makeNode(
  id: string,
  name: string,
  kind: Kind,
  rel: string,
  source: string,
  whole: TsNode | null,
  signature: string | null,
  exported = true,
  owner?: string,
  arity?: number,
  variadic?: boolean,
): NodeV1 {
  const text = whole ? source.slice(whole.startIndex, whole.endIndex) : source;
  return {
    id,
    name,
    kind,
    path: rel,
    span: whole ? `L${whole.startPosition.row + 1}-L${whole.endPosition.row + 1}` : `L1-L${source.split("\n").length}`,
    signature,
    exported,
    origin: "ast",
    body_hash: contentHash(text),
    body_text: searchBody(text),
    summary_state: "pending",
    summary: null,
    crux: null,
    ...(owner ? { owner } : {}),
    ...(arity !== undefined ? { arity } : {}),
    ...(variadic ? { variadic: true } : {}),
  };
}

function fileResidual(source: string, symbols: NodeV1[]): string {
  const lines = source.split("\n");
  const covered = new Uint8Array(lines.length + 2);
  for (const symbol of symbols) {
    if (symbol.kind === "module") continue;
    const match = /^L(\d+)-L(\d+)$/.exec(symbol.span);
    if (!match) continue;
    for (let line = Number(match[1]); line <= Number(match[2]) && line < covered.length; line++) covered[line] = 1;
  }
  return searchBody(lines.filter((_, index) => !covered[index + 1]).join(" "), 16000);
}

function collectUses(root: TsNode, source: string): string[] {
  const names = new Set<string>();
  for (const uses of descendants(root, "declUses")) {
    for (const child of children(uses)) {
      if (child.type !== "moduleName") continue;
      const name = entityParts(child).join(".");
      if (name) names.add(name);
    }
  }
  // Delphi package projects are still an ERROR node in the upstream grammar.
  for (const keyword of ["requires", "contains"] as const) {
    const match = new RegExp(`\\b${keyword}\\s+([\\s\\S]*?);`, "i").exec(source);
    if (!match) continue;
    for (const entry of match[1].split(",")) {
      const name = /^\s*([\p{L}_][\p{L}\p{N}_.]*)/u.exec(entry)?.[1];
      if (name) names.add(name);
    }
  }
  return [...names];
}

function declarationBindings(node: TsNode): Array<[string, string]> {
  const typeNode = field(node, "type");
  const type = typeName(typeNode);
  if (!type) return [];
  const names = children(node).filter(
    (child) => child.type === "identifier" && (!typeNode || child.endIndex <= typeNode.startIndex),
  );
  return names.map((name) => [normalizedName(name.text), type]);
}

function nearestRoutine(node: TsNode, routinesByStart: ReadonlyMap<number, RoutineDef>): RoutineDef | null {
  for (let current: TsNode | null = node; current; current = current.parent) {
    if (current.type === "defProc") {
      const found = routinesByStart.get(current.startIndex);
      if (found) return found;
    }
  }
  return null;
}

function callEntity(node: TsNode): { name: string; receiver?: string; argCount?: number } | null {
  let entity = node;
  let argCount: number | undefined;
  if (node.type === "exprCall") {
    entity = field(node, "entity") ?? children(node)[0] ?? node;
    const args = field(node, "args") ?? children(node).find((child) => child.type === "exprArgs");
    argCount = args?.namedChildCount ?? 0;
  }
  if (entity.type === "exprTpl" || entity.type === "genericTpl") entity = field(entity, "entity") ?? children(entity)[0] ?? entity;
  if (entity.type === "identifier") return { name: entity.text, argCount };
  if (entity.type === "exprDot" || entity.type === "genericDot") {
    const lhs = field(entity, "lhs");
    const rhs = field(entity, "rhs");
    const name = entityParts(rhs).at(-1);
    return name && lhs ? { name, receiver: lhs.text, argCount } : null;
  }
  if (entity.type === "inherited") {
    const name = children(entity).find((child) => child.type === "identifier")?.text;
    return name ? { name, receiver: "inherited", argCount } : null;
  }
  return null;
}

function receiverIdentifier(text: string): string | null {
  const matches = text.match(/[\p{L}_][\p{L}\p{N}_]*/gu);
  return matches?.at(-1) ?? null;
}

function collectCalls(
  root: TsNode,
  rel: string,
  moduleId: string | null,
  routines: RoutineDef[],
  types: TypeDef[],
  edges: RawEdge[],
): void {
  const routinesByStart = new Map(routines.filter((routine) => routine.implementation).map((routine) => [routine.whole.startIndex, routine]));
  const typesByName = new Map(types.map((type) => [normalizedName(type.name), type]));
  const typeByStart = new Map(types.map((type) => [type.node.startIndex, type]));
  const methodsByOwner = new Map<string, Set<string>>();
  for (const routine of routines) {
    if (!routine.owner) continue;
    const key = normalizedName(routine.owner);
    const names = methodsByOwner.get(key) ?? new Set<string>();
    names.add(normalizedName(routine.name));
    methodsByOwner.set(key, names);
  }
  const globalBindings = new Map<string, string>();
  for (const decl of [...descendants(root, "declVar"), ...descendants(root, "declArg")]) {
    if (ancestor(decl, "defProc") || ancestor(decl, "declType")) continue;
    for (const [name, type] of declarationBindings(decl)) globalBindings.set(name, type);
  }

  const fieldBindingsByOwner = new Map<string, Array<[string, string]>>();
  for (const type of types) {
    const bindings: Array<[string, string]> = [];
    for (const decl of descendants(type.typeNode, "declField")) bindings.push(...declarationBindings(decl));
    fieldBindingsByOwner.set(normalizedName(type.name), bindings);
  }
  const declaredTypeNames = new Map<string, string>();
  for (const bindings of [globalBindings, ...[...fieldBindingsByOwner.values()].map((pairs) => new Map(pairs))]) {
    for (const type of bindings.values()) declaredTypeNames.set(normalizedName(type), type);
  }

  const bindingCache = new Map<number, Map<string, string>>();
  const bindingsFor = (routine: RoutineDef | null): Map<string, string> => {
    if (!routine) return globalBindings;
    const cached = bindingCache.get(routine.whole.startIndex);
    if (cached) return cached;
    const bindings = new Map(globalBindings);
    if (routine.owner) {
      for (const [name, type] of fieldBindingsByOwner.get(normalizedName(routine.owner)) ?? []) bindings.set(name, type);
    }
    for (const kind of ["declArg", "declVar"] as const) {
      for (const decl of descendants(routine.whole, kind)) {
        if (nearestRoutine(decl, routinesByStart)?.whole.startIndex !== routine.whole.startIndex) continue;
        for (const [name, type] of declarationBindings(decl)) bindings.set(name, type);
      }
    }
    bindingCache.set(routine.whole.startIndex, bindings);
    return bindings;
  };

  const parentOf = new Map(types.map((type) => [normalizedName(type.name), type.parents[0] ?? null]));
  const seen = new Set<string>();
  const emit = (node: TsNode, info: ReturnType<typeof callEntity>): void => {
    if (!info) return;
    const routine = nearestRoutine(node, routinesByStart);
    const source = routine?.id ?? moduleId ?? rel;
    const key = `${source}\0${node.startIndex}\0${normalizedName(info.name)}`;
    if (seen.has(key)) return;
    seen.add(key);
    const bindings = bindingsFor(routine);
    let recvType: string | undefined;
    if (info.receiver) {
      const receiver = receiverIdentifier(info.receiver);
      if (receiver) {
        const normalized = normalizedName(receiver);
        if (normalized === "self" && routine?.owner) recvType = routine.owner;
        else if (normalized === "inherited" && routine?.owner) recvType = parentOf.get(normalizedName(routine.owner)) ?? undefined;
        else recvType = bindings.get(normalized) ?? typesByName.get(normalized)?.name ?? declaredTypeNames.get(normalized);
      }
      edges.push({
        source,
        relation: "calls",
        file: rel,
        name: info.name,
        viaMember: true,
        ...(recvType ? { recvType } : {}),
        ...(info.argCount !== undefined ? { argCount: info.argCount } : {}),
        caseInsensitive: true,
      });
      return;
    }
    const owner = routine?.owner;
    if (owner && methodsByOwner.get(normalizedName(owner))?.has(normalizedName(info.name))) {
      edges.push({
        source,
        relation: "calls",
        file: rel,
        name: info.name,
        viaMember: true,
        recvType: owner,
        ...(info.argCount !== undefined ? { argCount: info.argCount } : {}),
        caseInsensitive: true,
      });
    } else {
      edges.push({
        source,
        relation: "calls",
        file: rel,
        name: info.name,
        ...(info.argCount !== undefined ? { argCount: info.argCount } : {}),
        caseInsensitive: true,
      });
    }
  };

  visit(root, (node) => {
    if (node.type === "exprCall") emit(node, callEntity(node));
    else if (node.type === "statement") {
      const entity = children(node)[0];
      if (entity && ["identifier", "exprDot", "exprTpl", "inherited"].includes(entity.type)) emit(entity, callEntity(entity));
    } else if (node.type === "assignment") {
      const rhs = field(node, "rhs");
      if (rhs?.type === "exprDot") emit(rhs, callEntity(rhs));
    }
  });
}

/** Extract one Pascal-family source file from an already parsed tree. */
export function extractPascal(rel: string, source: string, root: TsNode): ExtractResult {
  const nodes: NodeV1[] = [
    {
      id: rel,
      name: rel.split("/").pop() ?? rel,
      kind: "file",
      path: rel,
      span: `L1-L${Math.max(1, root.endPosition.row + 1)}`,
      signature: null,
      exported: true,
      origin: "ast",
      body_hash: contentHash(source),
      chars: source.length,
      summary_state: "pending",
      summary: null,
      crux: null,
    },
  ];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const module = moduleInfo(root, source);
  let moduleId: string | null = null;
  if (module) {
    moduleId = mint(`${rel}#${module.name}`, minted);
    nodes.push(makeNode(moduleId, module.name, "module", rel, source, module.whole, module.signature));
    rawEdges.push({ source: rel, relation: "contains", targetId: moduleId, file: rel, caseInsensitive: true });
  }

  const types = collectTypes(root);
  const typeByName = new Map<string, TypeDef>();
  for (const type of types) {
    type.id = mint(`${rel}#${type.name}`, minted);
    typeByName.set(normalizedName(type.name), type);
    nodes.push(makeNode(type.id, type.name, type.kind, rel, source, type.node, clean(type.node.text)));
    rawEdges.push({ source: moduleId ?? rel, relation: "contains", targetId: type.id, file: rel, caseInsensitive: true });
    type.parents.forEach((parent, index) => {
      const relation = type.kind === "class" && index > 0 ? "implements" : "extends";
      rawEdges.push({ source: type.id!, relation, name: parent, file: rel, caseInsensitive: true });
    });
  }

  const routines = collectRoutines(root, types);
  const routineByStart = new Map<number, RoutineDef>();
  for (const routine of routines) {
    const parentRoutine = routine.parentStart !== null ? routineByStart.get(routine.parentStart) : undefined;
    const idScope = routine.owner
      ? `${routine.owner}.${routine.name}`
      : parentRoutine?.id
        ? `${parentRoutine.id.slice(parentRoutine.id.indexOf("#") + 1)}.${routine.name}`
        : routine.name;
    routine.id = mint(`${rel}#${idScope}`, minted);
    routineByStart.set(routine.whole.startIndex, routine);
    nodes.push(
      makeNode(
        routine.id,
        routine.name,
        routine.kind,
        rel,
        source,
        routine.whole,
        clean(routine.header.text),
        routine.exported,
        routine.owner ?? undefined,
        routine.arity,
        routine.variadic,
      ),
    );
    const ownerType = routine.owner ? typeByName.get(normalizedName(routine.owner)) : undefined;
    rawEdges.push({
      source: ownerType?.id ?? parentRoutine?.id ?? moduleId ?? rel,
      relation: "contains",
      targetId: routine.id,
      file: rel,
      caseInsensitive: true,
    });
  }

  for (const specifier of collectUses(root, source)) {
    rawEdges.push({ source: rel, relation: "imports", specifier, file: rel, caseInsensitive: true });
  }
  collectCalls(root, rel, moduleId, routines, types, rawEdges);
  nodes[0].body_text = fileResidual(source, nodes.slice(1));
  return { nodes, rawEdges };
}
