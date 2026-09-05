/**
 * Pascal/Delphi breadth-tier coverage. The fixture deliberately combines unit
 * interface/implementation sections, qualified methods, a package, a program,
 * and an include fragment so extension routing cannot masquerade as parsing.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraph } from "../src/graph/build.js";
import { genericLangOf } from "../src/graph/generic.js";
import { supportedExtensions } from "../src/graph/source-files.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const RUNNER = `unit Runner;

interface

type
  TRunner = class
  public
    constructor Create;
    destructor Destroy; override;
    procedure Stop;
  end;

implementation

constructor TRunner.Create;
begin
  inherited Create;
end;

destructor TRunner.Destroy;
begin
  inherited;
end;

procedure TRunner.Stop;
begin
end;

end.
`;

// Mixed CRLF/LF and a non-ASCII comment exercise line/offset handling without
// relying on any application-specific source.
const CONTROLLER = `unit Controller;\r
\r
interface\r
\r
uses\r
  Runner;\n
type\r
  IRunnable = interface\r
    procedure Run;\r
  end;\r
\r
  TState = record\r
    Value: Integer;\r
    procedure Clear;\r
  end;\r
\r
  TController = class(TObject, IRunnable)\r
  private\r
    FRunner: TRunner;\r
  public\r
    procedure Run;\r
  end;\r
\r
procedure StartController;\r
\r
implementation\n
// Unicode comment: Привет\r
procedure TController.Run;\r
var\r
  LRunner: TRunner;\r
begin\r
  LRunner := TRunner.Create;\r
  LRunner.Stop();\r
  frunner.stop;\r
  StartController;\r
end;\r
\r
procedure TState.Clear;\r
begin\r
  Value := 0;\r
end;\r
\r
procedure StartController;\r
  procedure NestedStart;\r
  begin\r
  end;\r
begin\r
  NestedStart;\r
end;\r
\r
end.\r
`;

const PROGRAM = `program Demo;

uses
  Controller;

begin
  StartController;
end.
`;

const PACKAGE = `package SamplePackage;

requires
  rtl,
  Runner;

contains
  Controller in 'Controller.pas';

end.
`;

const INCLUDE = `procedure IncludedRoutine;
begin
end;
`;

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "graft-pascal-"));
  writeFileSync(join(dir, "Runner.pas"), RUNNER, "utf8");
  writeFileSync(join(dir, "Controller.pas"), CONTROLLER, "utf8");
  writeFileSync(join(dir, "Demo.dpr"), PROGRAM, "utf8");
  writeFileSync(join(dir, "SamplePackage.dpk"), PACKAGE, "utf8");
  writeFileSync(join(dir, "Shared.inc"), INCLUDE, "utf8");
  return dir;
}

function node(graph: GraphV1, id: string): NodeV1 | undefined {
  return graph.nodes.find((n) => n.id === id);
}

test("Pascal routes Delphi source, project, package, and include extensions", () => {
  for (const ext of [".pas", ".dpr", ".dpk", ".inc"]) {
    assert.equal(genericLangOf(`Source${ext.toUpperCase()}`)?.name, "pascal", ext);
    assert.ok(supportedExtensions().includes(ext), `${ext} should be advertised`);
  }
});

test("Pascal extracts modules, types, implementation spans, and deduplicated methods", async () => {
  const dir = fixture();
  try {
    const result = await buildGraph(dir);
    assert.deepEqual(result.languages, ["pascal"]);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.equal(node(graph, "Controller.pas#Controller")?.kind, "module");
    assert.equal(node(graph, "Demo.dpr#Demo")?.kind, "module");
    assert.equal(node(graph, "SamplePackage.dpk#SamplePackage")?.kind, "module");
    assert.equal(node(graph, "Controller.pas#TController")?.kind, "class");
    assert.equal(node(graph, "Controller.pas#TState")?.kind, "struct");
    assert.equal(node(graph, "Controller.pas#IRunnable")?.kind, "interface");

    const run = node(graph, "Controller.pas#TController.Run");
    assert.equal(run?.kind, "method");
    assert.equal(run?.owner, "TController");
    assert.match(run?.span ?? "", /^L\d+-L\d+$/);
    const [, startLine, endLine] = /^L(\d+)-L(\d+)$/.exec(run?.span ?? "") ?? [];
    assert.ok(Number(endLine) - Number(startLine) >= 5, "the span must cover the implementation body");
    assert.equal(
      graph.nodes.filter((n) => n.path === "Controller.pas" && n.owner === "TController" && n.name === "Run").length,
      1,
      "the interface declaration must collapse into the implementation",
    );
    assert.equal(node(graph, "Runner.pas#TRunner.Create")?.kind, "method");
    assert.equal(node(graph, "Runner.pas#TRunner.Destroy")?.kind, "method");
    assert.equal(node(graph, "Controller.pas#StartController.NestedStart")?.kind, "function");
    assert.equal(node(graph, "Shared.inc#IncludedRoutine")?.kind, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pascal resolves uses and case-insensitive typed member calls", async () => {
  const dir = fixture();
  try {
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;

    assert.ok(
      graph.edges.some((e) => e.relation === "imports" && e.source === "Controller.pas" && e.target === "Runner.pas"),
      "uses Runner should resolve to Runner.pas",
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "imports" && e.source === "SamplePackage.dpk" && e.target === "Controller.pas",
      ),
      "a package contains clause should resolve to its unit",
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" &&
          e.source === "Controller.pas#TController.Run" &&
          e.target === "Runner.pas#TRunner.Stop",
      ),
      "typed calls, including frunner.stop, should resolve case-insensitively",
    );
    assert.ok(
      graph.edges.some(
        (e) => e.relation === "calls" &&
          e.source === "Controller.pas#StartController" &&
          e.target === "Controller.pas#StartController.NestedStart",
      ),
      "parameterless nested calls should resolve",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pascal preserves cross-unit inherited calls without cross-language name collisions", async () => {
  const dir = fixture();
  try {
    writeFileSync(join(dir, "Child.pas"), `unit Child;
interface
uses runner, Controller;
type
  TChild = class(trunner)
  end;
procedure RunChild(Value: tchild);
implementation
procedure RunChild(Value: tchild);
begin
  Value.sTOP;
  startcontroller;
end;
end.
`, "utf8");
    writeFileSync(join(dir, "frontend.ts"), `export class TRunner {}
export function probe(runner: TRunner) {
  runner.Stop();
  StartController();
}
`, "utf8");
    const result = await buildGraph(dir);
    assert.deepEqual(result.errors, []);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    for (const [source, target, relation] of [
      ["Child.pas", "Runner.pas", "imports"],
      ["Child.pas#TChild", "Runner.pas#TRunner", "extends"],
      ["Child.pas#RunChild", "Runner.pas#TRunner.Stop", "calls"],
      ["Child.pas#RunChild", "Controller.pas#StartController", "calls"],
    ]) {
      assert.ok(graph.edges.some((e) => e.source === source && e.target === target && e.relation === relation),
        `${relation}: ${source} -> ${target}`);
    }
    assert.ok(node(graph, "frontend.ts#probe"), "the TypeScript caller must be indexed");
    assert.ok(!graph.edges.some((e) => e.source.startsWith("frontend.ts") && /\.pas(?:#|$)/i.test(e.target)),
      "TypeScript names must not resolve to Pascal functions or methods");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Pascal chunked parsing keeps symbols beyond 32 KB", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-pascal-large-"));
  try {
    const filler = Array.from({ length: 2200 }, (_, i) => `// filler ${i} Привет`).join("\r\n");
    const source = `unit LargeUnit;\r\ninterface\r\nimplementation\r\n${filler}\r\nprocedure TailRoutine;\r\nbegin\r\nend;\r\nend.\r\n`;
    assert.ok(source.length > 32 * 1024, "fixture must cross the historical parser boundary");
    writeFileSync(join(dir, "LargeUnit.pas"), source, "utf8");
    await buildGraph(dir);
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.equal(node(graph, "LargeUnit.pas#TailRoutine")?.kind, "function");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
