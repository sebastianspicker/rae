#!/usr/bin/env node
/** Enforce the former function complexity, code-line and parameter limits on maintained TypeScript. */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { repositoryFiles, repositoryRoot } from "./repository-files.js";
export interface FunctionMetrics {
  file: string;
  line: number;
  name: string;
  complexity: number;
  codeLines: number;
  parameters: number;
}
function isFunction(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}
const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);
export function measureFunctions(file: string, text: string): FunctionMetrics[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const results: FunctionMetrics[] = [];
  function visit(node: ts.Node): void {
    if (isFunction(node) && node.body) {
      let complexity = 1;
      function branch(child: ts.Node): void {
        if (isFunction(child)) return;
        if (DECISION_KINDS.has(child.kind)) complexity++;
        if (
          ts.isBinaryExpression(child) &&
          [
            ts.SyntaxKind.AmpersandAmpersandToken,
            ts.SyntaxKind.BarBarToken,
            ts.SyntaxKind.QuestionQuestionToken,
          ].includes(child.operatorToken.kind)
        )
          complexity++;
        ts.forEachChild(child, branch);
      }
      branch(node.body);
      const scanner = ts.createScanner(
        ts.ScriptTarget.Latest,
        true,
        ts.LanguageVariant.Standard,
        text,
        undefined,
        node.getStart(source),
        node.end - node.getStart(source),
      );
      const lines = new Set<number>();
      while (scanner.scan() !== ts.SyntaxKind.EndOfFileToken) {
        const start = source.getLineAndCharacterOfPosition(scanner.getTokenPos()).line;
        const end = source.getLineAndCharacterOfPosition(
          Math.max(scanner.getTokenPos(), scanner.getTextPos() - 1),
        ).line;
        for (let line = start; line <= end; line++) lines.add(line);
      }
      results.push({
        file,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        name: node.name?.getText(source) ?? "<anonymous>",
        complexity,
        codeLines: lines.size,
        parameters: node.parameters.length,
      });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return results;
}
export function complexityViolations(metrics: FunctionMetrics[]): FunctionMetrics[] {
  return metrics.filter(
    (item) => item.complexity > 12 || item.codeLines > 80 || item.parameters > 8,
  );
}
export function checkComplexity(): void {
  const files = repositoryFiles().filter(
    (file) =>
      /\.[cm]?tsx?$/.test(file) &&
      !file.endsWith(".d.ts") &&
      !/(^|\/)(test|tests|fixtures)(\/|$)|\.test\.[cm]?tsx?$/.test(file),
  );
  const failures = complexityViolations(
    files.flatMap((file) =>
      measureFunctions(file, readFileSync(resolve(repositoryRoot, file), "utf8")),
    ),
  );
  for (const item of failures)
    console.error(
      `${item.file}:${item.line} ${item.name}: complexity=${item.complexity}/12 codeLines=${item.codeLines}/80 parameters=${item.parameters}/8`,
    );
  if (failures.length)
    throw new Error(`${failures.length} functions exceed maintainability limits`);
  console.log(`Function maintainability checks passed for ${files.length} TypeScript files`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    checkComplexity();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
